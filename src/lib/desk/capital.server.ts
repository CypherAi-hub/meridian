import { getSql, ensureDbReady } from "../db";
import {
  parseCapitalPolicy,
  planProfitDistribution,
  fundedReadiness,
  type CapitalPolicy,
} from "./capital.ts";
import { sniperSuiteReport } from "./sniper.server";
import { parseMintAccount, solanaRpc } from "./providers/solana";
import { quotePaperSwap } from "./providers/jupiter";
import { USDC } from "./schema.ts";
const ID = "capital-policy";
type Checks = {
  checkedAt: number;
  recipientExists: boolean;
  recipientSystemAccount: boolean;
  mintExists: boolean;
  mintSupported: boolean;
  mintDecimals: number | null;
  mintAuthorityDisabled: boolean;
  freezeAuthorityDisabled: boolean;
  routeAvailable: boolean;
  routeError: string | null;
  slot: number | null;
  ownershipProven: false;
  tokenNameVerified: false;
  error?: string;
};
async function policyRow() {
  await ensureDbReady();
  const sql = await getSql();
  return (
    (
      await sql.query<{
        revision: number;
        policy: CapitalPolicy;
        checks: Checks | null;
        updated_at_ms: number;
      }>("select revision,policy,checks,updated_at_ms from meridian_capital_policy where id=$1", [
        ID,
      ])
    )[0] ?? null
  );
}
export async function configureCapital(input: unknown) {
  const policy = parseCapitalPolicy(input);
  await ensureDbReady();
  const sql = await getSql();
  return sql.transaction(async (tx) => {
    await tx.query("select pg_advisory_xact_lock($1)", [13802014]);
    const previous = (
      await tx.query<{ revision: number }>(
        "select revision from meridian_capital_policy where id=$1",
        [ID],
      )
    )[0];
    const revision = (previous?.revision ?? 0) + 1,
      now = Date.now();
    await tx.query(
      `insert into meridian_capital_policy(id,revision,policy,checks,updated_at_ms) values($1,$2,$3::jsonb,null,$4) on conflict(id) do update set revision=excluded.revision,policy=excluded.policy,checks=null,updated_at_ms=excluded.updated_at_ms`,
      [ID, revision, JSON.stringify(policy), now],
    );
    await tx.query(
      "insert into meridian_capital_policy_audit(revision,policy,configured_at_ms) values($1,$2::jsonb,$3)",
      [revision, JSON.stringify(policy), now],
    );
    return { revision, mode: "PAPER", policy };
  });
}
export async function checkCapitalAddresses() {
  const row = await policyRow();
  if (!row) throw Error("Configure payout preferences first");
  const p = parseCapitalPolicy(row.policy);
  const checks: Checks = {
    checkedAt: Date.now(),
    recipientExists: false,
    recipientSystemAccount: false,
    mintExists: false,
    mintSupported: false,
    mintDecimals: null,
    mintAuthorityDisabled: false,
    freezeAuthorityDisabled: false,
    routeAvailable: false,
    routeError: null,
    slot: null,
    ownershipProven: false,
    tokenNameVerified: false,
  };
  try {
    const result = await solanaRpc<{
      result?: {
        context: { slot: number };
        value: Array<{ owner: string; executable: boolean; data: [string, string] } | null>;
      };
      error?: { message: string };
    }>({
      jsonrpc: "2.0",
      id: 1,
      method: "getMultipleAccounts",
      params: [[p.recipient, p.profitMint], { encoding: "base64", commitment: "confirmed" }],
    });
    if (result.error) throw Error(result.error.message);
    const [recipient, mint] = result.result?.value ?? [];
    checks.slot = result.result?.context.slot ?? null;
    checks.recipientExists = !!recipient;
    checks.recipientSystemAccount =
      recipient?.owner === "11111111111111111111111111111111" && !recipient.executable;
    checks.mintExists = !!mint;
    const parsed = mint?.data?.[0] ? parseMintAccount(mint.data[0], mint.owner) : null;
    checks.mintSupported = !!parsed;
    checks.mintDecimals = parsed?.decimals ?? null;
    checks.mintAuthorityDisabled = parsed?.mintAuth === false;
    checks.freezeAuthorityDisabled = parsed?.freezeAuth === false;
    if (parsed) {
      const q = await quotePaperSwap({
        inputMint: USDC,
        outputMint: p.profitMint,
        amount: "1000000",
        inDecimals: 6,
        outDecimals: parsed.decimals,
        notionalUsd: 1,
      });
      checks.routeAvailable =
        q.available &&
        q.inMint === USDC &&
        q.outMint === p.profitMint &&
        q.inAmount === "1000000" &&
        /^\d+$/.test(q.outAmount) &&
        BigInt(q.outAmount) > 0n;
      checks.routeError = checks.routeAvailable
        ? null
        : (q.failureReason ?? q.error ?? "No supported route");
    }
  } catch (e) {
    checks.error = e instanceof Error ? e.message : String(e);
  }
  const sql = await getSql();
  await sql.query(
    "update meridian_capital_policy set checks=$1::jsonb where id=$2 and revision=$3",
    [JSON.stringify(checks), ID, row.revision],
  );
  return checks;
}
export async function capitalReport() {
  const row = await policyRow(),
    books = await sniperSuiteReport();
  const previews = row
    ? books.map((book) => ({
        experimentId: book.state.experimentId ?? "paper-sniper-v1",
        name: book.name,
        ...planProfitDistribution(row.policy, {
          freeUsdcAtomic: String(Math.max(0, Math.floor(book.state.cash * 1e6))),
          protectedPrincipalAtomic: String(Math.round(book.state.config.startCash * 1e6)),
          netRealizedPnlAtomic: String(Math.trunc(book.metrics.realizedUsd * 1e6)),
          profitAlreadyDistributedAtomic: "0",
          profitReservedAtomic: "0",
          operatingReserveAtomic: "0",
        }),
        balancesAreSimulated: true,
      }))
    : [];
  return {
    configured: !!row,
    policy: row?.policy ?? null,
    revision: row?.revision ?? 0,
    checks: row?.checks ?? null,
    readiness: fundedReadiness({
      verifiedForwardProfitable: false,
      independentlyAudited: false,
      walletOwnershipVerified: false,
      signerProvisioned: false,
      liveLimitsApproved: false,
      payoutRouteVerified: false,
      recipientTokenAccountVerified: false,
      securityAndAuthenticationVerified: false,
    }),
    previews,
    signatures: [],
    fundingWallet: null,
    distinction:
      "The recipient is the future earnings destination, not a bot deposit address. Experimental paper balances are not money, a wallet balance, or withdrawable earnings.",
    futureFlow: [
      "User links a dedicated trading wallet after validation and review",
      "Fund that wallet with approved trading capital and SOL for fees",
      "Execute only the approved strategy within live limits",
      "Reconcile realized net profit, outstanding exposure, principal and fee reserves",
      "Quote conversion of distributable profit into the configured mint",
      "Transfer tokens to the recipient token account and confirm on chain",
    ],
  };
}

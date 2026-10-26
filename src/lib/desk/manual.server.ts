import { getSql, ensureDbReady } from "../db";
import {
  newManualBook,
  manualMetrics,
  queueManualOrder,
  advanceManual,
  type ManualBook,
} from "./manual.ts";
import { isSolanaAddress } from "./capital.ts";
import { WSOL } from "./schema.ts";
import { quotePaperSwap } from "./providers/jupiter";
import { solanaRpc, parseMintAccount } from "./providers/solana";
import { terminalToken } from "./terminal-market.server";
const ID = "manual-paper-v1",
  LOCK = 13802015;
async function load() {
  await ensureDbReady();
  const sql = await getSql();
  return (
    (
      await sql.query<{ state: ManualBook }>("select state from omni_terminal_book where id=$1", [
        ID,
      ])
    )[0]?.state ?? { ...newManualBook(Date.now()), watchlist: [WSOL], selectedMint: WSOL }
  );
}
async function mutate(
  work: (book: ManualBook) => ManualBook | Promise<ManualBook>,
  tryLock = false,
) {
  await ensureDbReady();
  const sql = await getSql();
  return sql.transaction(async (tx) => {
    const [locked] = await tx.query<{ ok: boolean }>(
      tryLock
        ? "select pg_try_advisory_xact_lock($1) as ok"
        : "select pg_advisory_xact_lock($1) is null as ok",
      [LOCK],
    );
    if (tryLock && !locked.ok) return null;
    const s = (
      await tx.query<{ state: ManualBook }>("select state from omni_terminal_book where id=$1", [
        ID,
      ])
    )[0]?.state ?? { ...newManualBook(Date.now()), watchlist: [WSOL], selectedMint: WSOL };
    const next = await work(s);
    await tx.query(
      "insert into omni_terminal_book(id,state,updated_at_ms) values($1,$2::jsonb,$3) on conflict(id) do update set state=excluded.state,updated_at_ms=excluded.updated_at_ms",
      [ID, JSON.stringify(next), Date.now()],
    );
    return next;
  });
}
export async function manualReport() {
  const state = await load();
  return {
    state,
    metrics: manualMetrics(state, Date.now()),
    mode: "PAPER",
    assumptions: {
      minimumDelayMs: 2000,
      adverseSlippageBps: 100,
      additionalFeeBps: 25,
      networkFeeUsd: 0.02,
    },
    readOnly: false,
  };
}
export async function manualControl(input: {
  action: string;
  mint?: string;
  side?: string;
  requestId?: string;
  amountUsdc?: string;
  percent?: number;
}) {
  if (!isSolanaAddress(input.mint))
    throw Error("A valid Solana token contract address is required");
  const mint = input.mint;
  if (input.action === "watch" || input.action === "select" || input.action === "unwatch")
    return mutate((s) => {
      s = structuredClone(s);
      if (input.action === "unwatch") s.watchlist = s.watchlist.filter((m) => m !== mint);
      else {
        if (s.watchlist.length >= 40 && !s.watchlist.includes(mint))
          throw Error("Watchlist limit reached");
        if (!s.watchlist.includes(mint)) s.watchlist.push(mint);
        s.selectedMint = mint;
      }
      return s;
    });
  if (input.action !== "order" || !["BUY", "SELL"].includes(input.side ?? ""))
    throw Error("Unsupported manual paper action");
  const rpc = await solanaRpc<{
    result?: { value: { owner: string; data: [string, string] } | null };
    error?: { message: string };
  }>({
    jsonrpc: "2.0",
    id: 1,
    method: "getAccountInfo",
    params: [mint, { encoding: "base64", commitment: "confirmed" }],
  });
  const account = rpc.result?.value,
    parsed = account ? parseMintAccount(account.data[0], account.owner) : null;
  if (!parsed || parsed.decimals > 18)
    throw Error("This mint is unverified or uses an unsupported token program");
  const t = await terminalToken(mint).catch(() => null);
  return mutate((s) =>
    queueManualOrder(
      s,
      {
        requestId: input.requestId ?? "",
        side: input.side as "BUY" | "SELL",
        mint,
        symbol: t?.symbol ?? mint.slice(0, 6),
        decimals: parsed.decimals,
        amountUsdc: input.amountUsdc,
        percent: input.percent,
      },
      Date.now(),
    ),
  );
}
export async function advanceManualSession() {
  if (process.env.MERIDIAN_WORKER !== "1") return null;
  return mutate((s) => advanceManual(s, Date.now(), quotePaperSwap, Date.now), true);
}
export async function manualWatchMints() {
  const s = await load();
  return [
    ...new Set([
      ...s.positions.map((p) => p.mint),
      ...s.orders.filter((o) => o.status === "PENDING").map((o) => o.mint),
    ]),
  ];
}

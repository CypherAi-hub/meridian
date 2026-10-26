import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename, readdir } from "node:fs/promises";
import { join } from "node:path";
import { BN } from "@coral-xyz/anchor";
import {
  PUMP_SDK,
  GLOBAL_PDA,
  PUMP_FEE_CONFIG_PDA,
  bondingCurvePda,
  PUMP_PROGRAM_ID,
  PUMP_FEE_PROGRAM_ID,
  getBuyV3TokenAmountFromQuoteAmount,
  getSellSolAmountFromTokenAmount,
  type Global,
  type FeeConfig,
  type BondingCurve,
} from "@pump-fun/pump-sdk";
import {
  PUMP_AMM_SDK,
  buyQuoteInput,
  sellBaseInput,
  type SwapSolanaState,
} from "@pump-fun/pump-swap-sdk";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  unpackMint,
  unpackAccount,
  getExtensionTypes,
  ExtensionType,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
  type Keypair,
  type TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { JupiterQuoteLane, type QuotePriority } from "./jupiter-quote-lane.ts";
export type { QuotePriority } from "./jupiter-quote-lane.ts";

export type Quote = {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  minOutAmount: string;
  impactBps: number | null;
  observedAt: number;
  /** Actual provider request start, when captured; never the queue admission time. */
  requestedAt?: number;
  contextSlot: number | null;
  route: string[];
  requestId?: string;
  /** Jupiter's platform fee is already embedded in the quote; do not subtract it twice. */
  feeBps?: number;
  feeMint?: string;
  source?: "JUPITER" | "PUMP_ONCHAIN" | "PUMPSWAP_ONCHAIN";
  /** Actual accessible quote reserves, never virtual reserves, when available. */
  liquidityLamports?: string;
};

export const EXTERNAL_INTEGRATIONS = {
  jupiter: {
    version: "Swap V2",
    endpoint: "https://api.jup.ag/swap/v2/order",
    mode: "QUOTE_ONLY",
    docs: "https://developers.jup.ag/docs/api-reference/swap/order",
  },
  pump: {
    sdk: "@pump-fun/pump-sdk@4.3.1",
    program: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
    supported: ["buy_exact_quote_in_v3", "sell_v3"],
    limitation: "Unsigned builders only; cashback and unverified state rejected.",
  },
  pumpSwap: {
    sdk: "@pump-fun/pump-swap-sdk@2.2.0",
    program: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
    supported: ["buy_exact_quote_in_v2", "sell_v2"],
    limitation: "Requires verified on-chain SwapSolanaState.",
  },
  live: {
    status: "NOT_ENABLED_BY_CLI",
    limitation:
      "Guarded signing/submission primitive exists; unattended live operation is not certified.",
  },
} as const;

export function rawAmount(value: unknown, allowZero = false): bigint {
  if (typeof value !== "string" && typeof value !== "bigint")
    throw new Error("AMOUNT_MUST_BE_INTEGER_STRING_OR_BIGINT");
  const text = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(text)) throw new Error("INVALID_UNSIGNED_INTEGER");
  const result = BigInt(text);
  if ((!allowZero && result === 0n) || result > 18_446_744_073_709_551_615n)
    throw new Error("AMOUNT_OUTSIDE_U64");
  return result;
}

function bps(value: number, maximum = 10_000) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
    throw new Error("INVALID_BASIS_POINTS");
  return value;
}
function address(value: string) {
  return new PublicKey(value).toBase58();
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("MALFORMED_PROVIDER_RESPONSE");
  return value as Record<string, unknown>;
}

/** Quote-only client: never supplies a taker, loads a wallet, signs, or sends a transaction. */
export class JupiterQuoteClient {
  private readonly apiKey: string | undefined;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly clock: () => number;
  private readonly lane: JupiterQuoteLane;
  constructor(
    options: {
      apiKey?: string;
      fetch?: typeof fetch;
      timeoutMs?: number;
      now?: () => number;
      minimumIntervalMs?: number;
      maxPending?: number;
      lane?: JupiterQuoteLane;
    } = {},
  ) {
    this.apiKey = options.apiKey ?? process.env.JUPITER_API_KEY;
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 6_000;
    this.clock = options.now ?? Date.now;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 2_147_483_647
    )
      throw new Error("INVALID_TIMEOUT");
    // Quote timestamps can be injected independently in contract tests. The local
    // pacing lane uses its own wall clock and cannot govern another API consumer.
    this.lane =
      options.lane ??
      new JupiterQuoteLane({
        minimumIntervalMs: options.minimumIntervalMs,
        maxPending: options.maxPending,
      });
  }
  async quote(input: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    slippageBps?: number;
    priority?: QuotePriority;
  }): Promise<Quote> {
    if (!this.apiKey) throw new Error("JUPITER_API_KEY_REQUIRED");
    const inputMint = address(input.inputMint),
      outputMint = address(input.outputMint);
    if (inputMint === outputMint) throw new Error("SAME_INPUT_OUTPUT_MINT");
    const amount = rawAmount(input.amount),
      slippage = bps(input.slippageBps ?? 100);
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: amount.toString(),
      slippageBps: String(slippage),
      swapMode: "ExactIn",
      maxSupportedTransactionVersion: "0",
    });
    return this.lane.schedule(input.priority ?? "analysis", this.timeoutMs, async (signal) => {
      try {
        const requestedAt = this.clock();
        if (!Number.isSafeInteger(requestedAt) || requestedAt < 0)
          throw Error("JUPITER_QUOTE_CLOCK_INVALID");
        const response = await this.fetcher(`${EXTERNAL_INTEGRATIONS.jupiter.endpoint}?${params}`, {
          headers: {
            "x-api-key": this.apiKey!,
            accept: "application/json",
          },
          signal,
        });
        this.lane.observeResponse(response.status, response.headers);
        if (!response.ok) {
          try {
            await response.body?.cancel();
          } catch {
            /* Do not expose provider response bodies. */
          }
          throw new Error(`JUPITER_HTTP_${response.status}`);
        }
        if (signal.aborted) throw Error("JUPITER_QUOTE_TIMEOUT");
        const data = record(await response.json());
        if (signal.aborted) throw Error("JUPITER_QUOTE_TIMEOUT");
        const observedAt = this.clock();
        if (!Number.isSafeInteger(observedAt) || observedAt < requestedAt)
          throw Error("JUPITER_QUOTE_CLOCK_INVALID");
        if (data.error || data.errorCode) throw new Error("JUPITER_QUOTE_UNAVAILABLE");
        if (
          data.inputMint !== inputMint ||
          data.outputMint !== outputMint ||
          rawAmount(data.inAmount) !== amount
        ) {
          throw new Error("JUPITER_QUOTE_REQUEST_MISMATCH");
        }
        const out = rawAmount(data.outAmount);
        // The provider threshold must be at least our configured minimum. A missing threshold
        // is not evidence of a route executable within the slippage cap.
        const minimum = rawAmount(data.otherAmountThreshold);
        const configuredMinimum = (out * BigInt(10_000 - slippage)) / 10_000n;
        if (minimum > out || minimum < configuredMinimum)
          throw new Error("JUPITER_SLIPPAGE_CAP_VIOLATION");
        // Current V2 docs: priceImpact is percentage points (-0.1 means -0.1%).
        // priceImpactPct is deprecated and deliberately not used as a fallback.
        const impact =
          typeof data.priceImpact === "number" && Number.isFinite(data.priceImpact)
            ? Math.ceil(Math.abs(data.priceImpact) * 100)
            : null;
        const route = Array.isArray(data.routePlan)
          ? data.routePlan.flatMap((leg) => {
              const swap = record(record(leg).swapInfo);
              return typeof swap.label === "string" ? [swap.label] : [];
            })
          : [];
        if (!route.length && typeof data.router === "string") route.push(data.router);
        if (!route.length) throw new Error("JUPITER_ROUTE_MISSING");
        return {
          inputMint,
          outputMint,
          inAmount: amount.toString(),
          outAmount: out.toString(),
          minOutAmount: minimum.toString(),
          source: "JUPITER",
          impactBps: impact,
          requestedAt,
          observedAt,
          contextSlot: null,
          route,
          ...(typeof data.requestId === "string" ? { requestId: data.requestId } : {}),
          ...(typeof data.feeBps === "number" && Number.isFinite(data.feeBps)
            ? { feeBps: data.feeBps }
            : {}),
          ...(typeof data.feeMint === "string" ? { feeMint: data.feeMint } : {}),
        };
      } catch (error) {
        if (signal.aborted) throw new Error("JUPITER_QUOTE_TIMEOUT");
        // Only fixed local validation codes escape this boundary. Transport/JSON
        // errors may contain URLs, response bodies or keys and must stay private.
        const safeCodes = new Set([
          "AMOUNT_MUST_BE_INTEGER_STRING_OR_BIGINT",
          "INVALID_UNSIGNED_INTEGER",
          "AMOUNT_OUTSIDE_U64",
          "MALFORMED_PROVIDER_RESPONSE",
          "JUPITER_QUOTE_UNAVAILABLE",
          "JUPITER_QUOTE_REQUEST_MISMATCH",
          "JUPITER_SLIPPAGE_CAP_VIOLATION",
          "JUPITER_ROUTE_MISSING",
          "JUPITER_QUOTE_TIMEOUT",
          "JUPITER_QUOTE_CLOCK_INVALID",
        ]);
        if (
          error instanceof Error &&
          (safeCodes.has(error.message) || /^JUPITER_HTTP_\d{1,3}$/.test(error.message))
        )
          throw Error(error.message);
        throw Error("JUPITER_QUOTE_PROVIDER_UNAVAILABLE");
      }
    });
  }
}

export type PumpSnapshot = {
  mint: string; global: Global; feeConfig: FeeConfig; bondingCurve: BondingCurve; mintSupply: bigint;
  curveBaseTokenBalance: bigint; observedAt: number; contextSlot: number;
};
function impactAgainstSpot(out: bigint, idealOut: bigint) {
  if (idealOut <= 0n) return null;
  const loss = idealOut > out ? idealOut - out : 0n;
  return Number((loss * 10_000n + idealOut - 1n) / idealOut);
}
/** Reserve-based paper quote using official SDK integer fee math; not an on-chain simulation. */
export function quotePumpSnapshot(snapshot: PumpSnapshot, input: {
  inputMint: string; outputMint: string; amount: bigint; slippageBps?: number;
}): Quote {
  const inputMint = address(input.inputMint), outputMint = address(input.outputMint), mint = address(snapshot.mint);
  const buy = inputMint === NATIVE_MINT.toBase58() && outputMint === mint;
  const sell = outputMint === NATIVE_MINT.toBase58() && inputMint === mint;
  if (!buy && !sell) throw new Error('PUMP_ONLY_SOL_PAIRS_SUPPORTED');
  const curve = snapshot.bondingCurve;
  if (!curve.quoteMint.equals(NATIVE_MINT) && !curve.quoteMint.equals(PublicKey.default)) throw new Error('PUMP_NON_SOL_QUOTE_UNSUPPORTED');
  if (curve.complete || curve.virtualTokenReserves.isZero()) throw new Error('PUMP_CURVE_MIGRATED_ROUTE_REQUIRED');
  if (curve.isCashbackCoin) throw new Error('PUMP_V3_CASHBACK_UNSUPPORTED_USE_VERIFIED_V2');
  const amount = rawAmount(input.amount), slippage = bps(input.slippageBps ?? 100);
  const args = { global: snapshot.global, feeConfig: snapshot.feeConfig, mintSupply: new BN(snapshot.mintSupply.toString()),
    bondingCurve: curve, amount: bn(amount) };
  const outBN = buy ? getBuyV3TokenAmountFromQuoteAmount({ ...args, curveBaseTokenBalance: new BN(snapshot.curveBaseTokenBalance.toString()) })
    : getSellSolAmountFromTokenAmount(args);
  const out = rawAmount(outBN.toString());
  if (buy && outBN.gte(curve.realTokenReserves)) throw new Error('PUMP_SYNTHETIC_MIGRATION_QUOTE_UNSUPPORTED');
  if (sell && outBN.gt(curve.realQuoteReserves)) throw new Error('PUMP_SELL_EXCEEDS_ACCESSIBLE_RESERVES');
  const virtualBase = BigInt(curve.virtualTokenReserves.toString()), virtualQuote = BigInt(curve.virtualQuoteReserves.toString());
  const ideal = buy ? amount * virtualBase / virtualQuote : amount * virtualQuote / virtualBase;
  return { inputMint, outputMint, inAmount: amount.toString(), outAmount: out.toString(),
    minOutAmount: (out * BigInt(10_000 - slippage) / 10_000n).toString(), impactBps: impactAgainstSpot(out, ideal),
    observedAt: snapshot.observedAt, contextSlot: snapshot.contextSlot, route: ['Pump bonding curve · official SDK reserve quote'],
    source: 'PUMP_ONCHAIN', liquidityLamports: curve.realQuoteReserves.toString() };
}

/** Fetches every pricing account in one confirmed RPC context. No wallet, API key, or signing is required. */
export class PumpQuoteClient {
  constructor(private readonly connection: Connection, private readonly clock: () => number = Date.now) {}
  async snapshot(mintAddress: string, minContextSlot?: number): Promise<PumpSnapshot> {
    const mint = new PublicKey(mintAddress), curveAddress = bondingCurvePda(mint);
    const programs = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];
    const atas = programs.map((program) => getAssociatedTokenAddressSync(mint, curveAddress, true, program));
    const response = await this.connection.getMultipleAccountsInfoAndContext(
      [GLOBAL_PDA, PUMP_FEE_CONFIG_PDA, curveAddress, mint, ...atas], { commitment: 'confirmed', minContextSlot });
    const [globalInfo, feeInfo, curveInfo, mintInfo] = response.value;
    if (!globalInfo || !feeInfo || !curveInfo || !mintInfo) throw new Error('PUMP_PRICING_ACCOUNT_MISSING');
    if (!globalInfo.owner.equals(PUMP_PROGRAM_ID) || !curveInfo.owner.equals(PUMP_PROGRAM_ID) || !feeInfo.owner.equals(PUMP_FEE_PROGRAM_ID)) {
      throw new Error('PUMP_PRICING_ACCOUNT_OWNER_MISMATCH');
    }
    if (!programs.some((program) => mintInfo.owner.equals(program))) throw new Error('TOKEN_PROGRAM_UNSUPPORTED');
    const mintState = unpackMint(mint, mintInfo, mintInfo.owner);
    if (!mintState.isInitialized) throw new Error('MINT_NOT_INITIALIZED');
    const extensions = getExtensionTypes(mintState.tlvData);
    const passiveExtensions = new Set([ExtensionType.MetadataPointer, ExtensionType.TokenMetadata]);
    if (extensions.some((extension) => !passiveExtensions.has(extension))) throw new Error('TOKEN_EXTENSION_PRICING_UNSUPPORTED');
    const tokenIndex = programs.findIndex((program) => mintInfo.owner.equals(program));
    const vaultInfo = response.value[4 + tokenIndex];
    if (!vaultInfo) throw new Error('PUMP_CURVE_TOKEN_VAULT_MISSING');
    const vault = unpackAccount(atas[tokenIndex], vaultInfo, programs[tokenIndex]);
    if (!vault.mint.equals(mint) || !vault.owner.equals(curveAddress)) throw new Error('PUMP_CURVE_TOKEN_VAULT_MISMATCH');
    return { mint: mint.toBase58(), global: PUMP_SDK.decodeGlobal(globalInfo), feeConfig: PUMP_SDK.decodeFeeConfig(feeInfo),
      bondingCurve: PUMP_SDK.decodeBondingCurve(curveInfo), mintSupply: mintState.supply, curveBaseTokenBalance: vault.amount,
      observedAt: this.clock(), contextSlot: response.context.slot };
  }
  async quote(input: { inputMint: string; outputMint: string; amount: bigint; slippageBps?: number; minContextSlot?: number }) {
    const mint = input.inputMint === NATIVE_MINT.toBase58() ? input.outputMint : input.inputMint;
    return quotePumpSnapshot(await this.snapshot(mint, input.minContextSlot), input);
  }
}

/** A verified SDK state is supplied by a protocol-specific account reader; it must include current dynamic fees. */
export function quotePumpSwapSnapshot(state: SwapSolanaState, input: {
  side: 'BUY' | 'SELL'; amount: bigint; slippageBps?: number; observedAt: number; contextSlot: number;
}): Quote {
  if (!state.pool.quoteMint.equals(NATIVE_MINT)) throw new Error('PUMPSWAP_ONLY_SOL_PAIRS_SUPPORTED');
  if (!state.feeConfig) throw new Error('PUMPSWAP_DYNAMIC_FEE_CONFIG_MISSING');
  const amount = rawAmount(input.amount), slippage = bps(input.slippageBps ?? 100);
  const common = { baseReserve: state.poolBaseAmount, quoteReserve: state.poolQuoteAmount,
    virtualQuoteReserves: state.pool.virtualQuoteReserves, globalConfig: state.globalConfig, baseMintAccount: state.baseMintAccount,
    baseMint: state.baseMint, coinCreator: state.pool.coinCreator, creator: state.pool.creator, feeConfig: state.feeConfig,
    quoteMint: state.pool.quoteMint, isMayhemMode: state.pool.isMayhemMode, creatorFeeBps: state.pool.creatorFeeBps,
    quoteTransferFee: state.quoteTransferFee, slippage: 0 };
  const outBN = input.side === 'BUY'
    ? buyQuoteInput({ ...common, quote: bn(amount), tradeV2: true }).base
    : sellBaseInput({ ...common, base: bn(amount), feeBucketsTotal: state.pool.protocolFees.add(state.pool.creatorFees) }).uiQuote;
  const out = rawAmount(outBN.toString()), base = BigInt(state.poolBaseAmount.toString());
  const quote = BigInt(state.poolQuoteAmount.add(state.pool.virtualQuoteReserves).toString());
  const liquidity = state.poolQuoteAmount.sub(state.pool.protocolFees).sub(state.pool.creatorFees);
  if (liquidity.isNeg() || (input.side === 'SELL' && outBN.gt(liquidity))) throw new Error('PUMPSWAP_SELL_EXCEEDS_ACCESSIBLE_RESERVES');
  return { inputMint: input.side === 'BUY' ? NATIVE_MINT.toBase58() : state.baseMint.toBase58(),
    outputMint: input.side === 'BUY' ? state.baseMint.toBase58() : NATIVE_MINT.toBase58(), inAmount: amount.toString(), outAmount: out.toString(),
    minOutAmount: (out * BigInt(10_000 - slippage) / 10_000n).toString(),
    impactBps: impactAgainstSpot(out, input.side === 'BUY' ? amount * base / quote : amount * quote / base),
    observedAt: input.observedAt, contextSlot: input.contextSlot, route: ['PumpSwap · official SDK reserve quote'],
    source: 'PUMPSWAP_ONCHAIN', liquidityLamports: liquidity.toString() };
}

export type VerifiedProtocolState = {
  observedAt: number; now: number; maxAgeMs: number;
  mintAndTokenProgramsVerified: boolean; tokenSecurityPassed: boolean;
};
function verified(state: VerifiedProtocolState) {
  if (!Number.isFinite(state.observedAt) || !Number.isFinite(state.now) || !Number.isFinite(state.maxAgeMs) || state.maxAgeMs <= 0 ||
      state.now < state.observedAt || state.now - state.observedAt > state.maxAgeMs ||
      !state.mintAndTokenProgramsVerified || !state.tokenSecurityPassed) throw new Error('PROTOCOL_STATE_UNVERIFIED_OR_STALE');
}
const bn = (v: bigint) => new BN(rawAmount(v).toString());

/** Unsigned SDK instruction only. Account existence, fee recipient and security must be verified by caller. */
export async function buildPumpV3Instruction(input: {
  side: 'BUY' | 'SELL'; mint: PublicKey; user: PublicKey; tokenProgram: PublicKey; quoteMint: PublicKey;
  quoteTokenProgram: PublicKey; buybackFeeRecipient: PublicKey; amountIn: bigint; minimumOut: bigint;
  isCashbackCoin: boolean; state: VerifiedProtocolState;
}): Promise<TransactionInstruction> {
  verified(input.state);
  if (input.isCashbackCoin) throw new Error('PUMP_V3_CASHBACK_UNSUPPORTED_USE_VERIFIED_V2');
  const shared = { user: input.user, mint: input.mint, tokenProgram: input.tokenProgram,
    quoteMint: input.quoteMint, quoteTokenProgram: input.quoteTokenProgram, buybackFeeRecipient: input.buybackFeeRecipient };
  if (input.side === 'BUY') return PUMP_SDK.getBuyExactQuoteInV3InstructionRaw({ ...shared,
    spendableQuoteIn: bn(input.amountIn), minTokensOut: bn(input.minimumOut), partialFill: false });
  return PUMP_SDK.getSellV3InstructionRaw({ ...shared, amount: bn(input.amountIn), quoteAmount: bn(input.minimumOut) });
}

export async function buildPumpSwapInstructions(input: {
  side: 'BUY' | 'SELL'; swapState: SwapSolanaState; amountIn: bigint; minimumOut: bigint; state: VerifiedProtocolState;
}): Promise<TransactionInstruction[]> {
  verified(input.state);
  return input.side === 'BUY'
    ? PUMP_AMM_SDK.buyExactQuoteInV2Instructions(input.swapState, bn(input.amountIn), bn(input.minimumOut))
    : PUMP_AMM_SDK.sellV2Instructions(input.swapState, bn(input.amountIn), bn(input.minimumOut));
}

export type LivePolicy = {
  mode: 'PAPER' | 'LIVE'; enabled: boolean; acknowledgement: string; dedicatedWallet: string;
  maxWalletLamports: bigint; maxTradeLamports: bigint; reserveLamports: bigint;
  maxFeeLamports: bigint; maxPriorityFeeLamports: bigint; allowedPrograms: string[];
};
export function assertLivePolicy(policy: LivePolicy, wallet: string, balance: bigint, debit: bigint, fee: bigint, priorityFee: bigint) {
  if (policy.mode !== 'LIVE' || !policy.enabled || policy.acknowledgement !== 'I_ACCEPT_REAL_FUNDS_AT_RISK') throw new Error('LIVE_DISABLED');
  if (!policy.dedicatedWallet || address(policy.dedicatedWallet) !== wallet) throw new Error('DEDICATED_WALLET_MISMATCH');
  for (const value of [policy.maxWalletLamports, policy.maxTradeLamports, policy.reserveLamports, policy.maxFeeLamports,
    policy.maxPriorityFeeLamports]) rawAmount(value);
  for (const value of [balance, debit, fee, priorityFee]) rawAmount(value, true);
  if (balance > policy.maxWalletLamports) throw new Error('WALLET_EXCEEDS_LIMITED_FUNDS_CAP');
  if (debit > policy.maxTradeLamports) throw new Error('LIVE_TRADE_CAP');
  if (fee > policy.maxFeeLamports || priorityFee > policy.maxPriorityFeeLamports) throw new Error('LIVE_FEE_CAP');
  if (balance - debit - fee < policy.reserveLamports) throw new Error('LIVE_RESERVE_REQUIRED');
}

export type LiveOrder = {
  id: string; status: 'PREPARED' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'UNKNOWN' | 'EXPIRED';
  signature: string; transactionBase64: string; blockhash: string; lastValidBlockHeight: number;
  createdAt: number; updatedAt: number; error?: string;
  actual?: { feeLamports: string; nativeDeltaLamports: string; tokenDeltas: Record<string, string>; slot: number };
};
export interface LiveOrderStore {
  get(id: string): Promise<LiveOrder | null>;
  pending(): Promise<LiveOrder[]>;
  /** Atomic insert-if-absent. Must be durable before any broadcast. */
  claim(order: LiveOrder): Promise<boolean>;
  put(order: LiveOrder): Promise<void>;
}
/** Stores signed bytes, never a private key. Put this directory outside version control. */
export class FileLiveOrderStore implements LiveOrderStore {
  constructor(private readonly directory: string) {}
  private path(id: string) { return join(this.directory, createHash('sha256').update(id).digest('hex') + '.json'); }
  async get(id: string) {
    try { return JSON.parse(await readFile(this.path(id), 'utf8')) as LiveOrder; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async pending() {
    await mkdir(this.directory, { recursive: true });
    const orders = await Promise.all((await readdir(this.directory)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map(async (name) => JSON.parse(await readFile(join(this.directory, name), 'utf8')) as LiveOrder));
    return orders.filter((order) => !['CONFIRMED', 'FAILED', 'EXPIRED'].includes(order.status));
  }
  async claim(order: LiveOrder) {
    await mkdir(this.directory, { recursive: true });
    try { await writeFile(this.path(order.id), JSON.stringify(order), { flag: 'wx', mode: 0o600 }); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
  }
  async put(order: LiveOrder) {
    const path = this.path(order.id), temp = path + `.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, JSON.stringify(order), { mode: 0o600 }); await rename(temp, path);
  }
}

/**
 * Guarded primitive for explicitly enabled direct transactions. The normal paper CLI does not
 * instantiate it. Never retries with a new blockhash or a new signature after ambiguous submission.
 * Caller must use a single executor per wallet and a durable order store.
 */
export class GuardedLiveExecutor {
  private readonly inflight = new Map<string, Promise<LiveOrder>>();
  private serial: Promise<unknown> = Promise.resolve();
  constructor(private readonly connection: Connection, private readonly signer: Keypair,
    private readonly policy: LivePolicy, private readonly store: LiveOrderStore,
    private readonly governor: (proposal: { id: string; debitLamports: bigint; feeLamports: bigint }) => Promise<{ allowed: boolean; reasons: string[] }>,
    private readonly auditInstructions: (instructions: TransactionInstruction[]) => Promise<{ maxNativeDebitLamports: bigint }>,
    private readonly now: () => number = Date.now) {}

  submit(input: { id: string; instructions: TransactionInstruction[]; maxNativeDebitLamports: bigint;
    priorityFeeLamports: bigint; computeUnitLimit?: number }): Promise<LiveOrder> {
    // Fail before every possible RPC, including reads and reconciliation, in paper mode.
    if (this.policy.mode !== 'LIVE' || !this.policy.enabled) return Promise.reject(new Error('LIVE_DISABLED'));
    const existing = this.inflight.get(input.id); if (existing) return existing;
    const job = this.serial.then(() => this.submitOnce(input)).finally(() => this.inflight.delete(input.id));
    this.serial = job.catch(() => undefined);
    this.inflight.set(input.id, job); return job;
  }
  private async submitOnce(input: { id: string; instructions: TransactionInstruction[]; maxNativeDebitLamports: bigint;
    priorityFeeLamports: bigint; computeUnitLimit?: number }): Promise<LiveOrder> {
    if (!input.id || input.id.length > 200 || !input.instructions.length) throw new Error('INVALID_ORDER');
    const old = await this.store.get(input.id); if (old) return this.reconcile(input.id);
    if ((await this.store.pending()).length) throw new Error('PREVIOUS_ORDER_REQUIRES_RECONCILIATION');
    const wallet = this.signer.publicKey.toBase58();
    const rawBalance = await this.connection.getBalance(this.signer.publicKey, 'confirmed');
    if (!Number.isSafeInteger(rawBalance)) throw new Error('UNSAFE_RPC_BALANCE_PRECISION');
    const balance = BigInt(rawBalance);
    assertLivePolicy(this.policy, wallet, balance, input.maxNativeDebitLamports, 0n, input.priorityFeeLamports);
    const audit = await this.auditInstructions(input.instructions);
    if (audit.maxNativeDebitLamports !== input.maxNativeDebitLamports) throw new Error('TRANSACTION_DEBIT_AUDIT_MISMATCH');
    const units = input.computeUnitLimit ?? 250_000;
    if (!Number.isSafeInteger(units) || units < 10_000 || units > 1_400_000) throw new Error('INVALID_COMPUTE_LIMIT');
    const allowed = new Set(this.policy.allowedPrograms);
    if (input.instructions.some((ix) => !allowed.has(ix.programId.toBase58()) || ix.programId.equals(ComputeBudgetProgram.programId))) {
      throw new Error('INSTRUCTION_PROGRAM_NOT_ALLOWED');
    }
    const block = await this.connection.getLatestBlockhash('confirmed');
    const microLamports = input.priorityFeeLamports * 1_000_000n / BigInt(units);
    const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports }), ...input.instructions];
    const message = new TransactionMessage({ payerKey: this.signer.publicKey, recentBlockhash: block.blockhash, instructions }).compileToV0Message();
    const fee = await this.connection.getFeeForMessage(message, 'confirmed');
    if (fee.value === null || !Number.isSafeInteger(fee.value)) throw new Error('FEE_ESTIMATE_UNAVAILABLE');
    assertLivePolicy(this.policy, wallet, balance, input.maxNativeDebitLamports, BigInt(fee.value), input.priorityFeeLamports);
    const verdict = await this.governor({ id: input.id, debitLamports: input.maxNativeDebitLamports, feeLamports: BigInt(fee.value) });
    if (!verdict.allowed) throw new Error('RISK_GOVERNOR_VETO:' + verdict.reasons.join(','));
    const transaction = new VersionedTransaction(message); transaction.sign([this.signer]);
    const simulation = await this.connection.simulateTransaction(transaction, { sigVerify: true, commitment: 'confirmed' });
    if (simulation.value.err) throw new Error('TRANSACTION_SIMULATION_FAILED');
    const order: LiveOrder = { id: input.id, status: 'PREPARED', signature: bs58.encode(transaction.signatures[0]),
      transactionBase64: Buffer.from(transaction.serialize()).toString('base64'), blockhash: block.blockhash,
      lastValidBlockHeight: block.lastValidBlockHeight, createdAt: this.now(), updatedAt: this.now() };
    // A second worker that loses this atomic claim must only reconcile the first signature.
    if (!await this.store.claim(order)) return this.reconcile(input.id);
    try {
      if ((await this.store.pending()).some((pending) => pending.id !== input.id)) throw new Error('CONCURRENT_WALLET_ORDER');
      const rawCurrentBalance = await this.connection.getBalance(this.signer.publicKey, 'confirmed');
      if (!Number.isSafeInteger(rawCurrentBalance)) throw new Error('UNSAFE_RPC_BALANCE_PRECISION');
      const currentBalance = BigInt(rawCurrentBalance);
      assertLivePolicy(this.policy, wallet, currentBalance, input.maxNativeDebitLamports, BigInt(fee.value), input.priorityFeeLamports);
      const finalVerdict = await this.governor({ id: input.id, debitLamports: input.maxNativeDebitLamports, feeLamports: BigInt(fee.value) });
      if (!finalVerdict.allowed) { order.status = 'FAILED'; order.error = 'FINAL_RISK_GOVERNOR_VETO'; }
      else if (await this.connection.getBlockHeight('confirmed') > block.lastValidBlockHeight) { order.status = 'EXPIRED'; order.error = 'BLOCKHASH_EXPIRED_BEFORE_SUBMIT'; }
      else {
        const signature = await this.connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false, maxRetries: 0 });
        if (signature !== order.signature) { order.status = 'UNKNOWN'; order.error = 'RPC_SIGNATURE_MISMATCH'; }
        else order.status = 'SUBMITTED';
      }
    } catch { order.status = 'UNKNOWN'; order.error = 'SUBMISSION_OUTCOME_UNKNOWN_RECONCILE_SIGNATURE'; }
    order.updatedAt = this.now(); await this.store.put(order);
    return this.reconcile(input.id);
  }

  async reconcile(id: string): Promise<LiveOrder> {
    if (this.policy.mode !== 'LIVE' || !this.policy.enabled) throw new Error('LIVE_DISABLED');
    const order = await this.store.get(id); if (!order) throw new Error('ORDER_NOT_FOUND');
    if (['CONFIRMED', 'FAILED', 'EXPIRED'].includes(order.status)) return order;
    const response = await this.connection.getSignatureStatuses([order.signature], { searchTransactionHistory: true });
    const status = response.value[0];
    if (status && ['confirmed', 'finalized'].includes(status.confirmationStatus ?? '')) {
      const tx = await this.connection.getTransaction(order.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      if (tx?.meta) {
        const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
        const wallet = this.signer.publicKey.toBase58(); let index = -1;
        for (let i = 0; i < keys.length; i++) if (keys.get(i)?.toBase58() === wallet) { index = i; break; }
        if (index < 0) throw new Error('CONFIRMED_WALLET_NOT_FOUND');
        const tokenDeltas: Record<string, bigint> = {};
        for (const [sign, balances] of [[-1n, tx.meta.preTokenBalances], [1n, tx.meta.postTokenBalances]] as const) {
          for (const entry of balances ?? []) if (entry.owner === wallet) tokenDeltas[entry.mint] = (tokenDeltas[entry.mint] ?? 0n) + sign * BigInt(entry.uiTokenAmount.amount);
        }
        // RPC lamport balances are JS numbers. Never report invented precision beyond MAX_SAFE_INTEGER.
        const before = tx.meta.preBalances[index], after = tx.meta.postBalances[index];
        if (!Number.isSafeInteger(before) || !Number.isSafeInteger(after) || !Number.isSafeInteger(tx.meta.fee)) throw new Error('UNSAFE_RPC_BALANCE_PRECISION');
        order.actual = { feeLamports: String(tx.meta.fee), nativeDeltaLamports: (BigInt(after) - BigInt(before)).toString(),
          tokenDeltas: Object.fromEntries(Object.entries(tokenDeltas).map(([mint, amount]) => [mint, amount.toString()])), slot: tx.slot };
        if (tx.meta.err) { order.status = 'FAILED'; order.error = 'ONCHAIN_TRANSACTION_FAILED'; }
        else { order.status = 'CONFIRMED'; delete order.error; }
      }
    } else if (!status && await this.connection.getBlockHeight('finalized') > order.lastValidBlockHeight) {
      order.status = 'EXPIRED'; order.error = 'EXPIRED_ABSENT_FROM_HISTORY';
    }
    order.updatedAt = this.now(); await this.store.put(order); return order;
  }
}

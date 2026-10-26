import type { FieldObs, QuoteObs, TokenSnapshot } from "./schema.ts";
import { USDC } from "./schema.ts";

export const SNIPER_VERSION = "paper-sniper-v1";
export const SNIPER_CONFIG = Object.freeze({
  startCash: 1000,
  orderUsd: 25,
  maxPositions: 3,
  maxAgeMs: 15 * 60_000,
  minLiquidityUsd: 35_000,
  minVolume5mUsd: 5000,
  minBuyShare: 0.6,
  maxTop10: 0.35,
  maxDataAgeMs: 45_000,
  latencyMs: 2000,
  orderTimeoutMs: 90_000,
  maxHoldMs: 5 * 60_000,
  takeProfit: 0.15,
  stopLoss: 0.08,
  slippageBps: 100,
  feeBps: 25,
  networkFeeUsd: 0.02,
  maxSessionLossUsd: 50,
  minValidationTrades: 100,
  maxTrades: 1000,
});
export type SniperConfig = { [K in keyof typeof SNIPER_CONFIG]: number };
export type SniperStrategy = "launch-flow" | "safety-baseline" | "confirmed-flow";
export const SNIPER_EXPERIMENTS = [
  {
    id: "paper-sniper-v1",
    name: "Strict launch flow",
    strategy: "launch-flow" as SniperStrategy,
    config: {},
  },
  {
    id: "paper-flow-10k-v1",
    name: "Early pool flow",
    strategy: "launch-flow" as SniperStrategy,
    config: { minLiquidityUsd: 10000 },
  },
  {
    id: "paper-confirmed-10k-v1",
    name: "Confirmed early flow",
    strategy: "confirmed-flow" as SniperStrategy,
    config: { minLiquidityUsd: 10000 },
  },
] as const;
export function sniperExperiment(id: string) {
  const preset = SNIPER_EXPERIMENTS.find((x) => x.id === id);
  if (!preset) throw Error("Unknown paper experiment");
  return preset;
}
export type Candidate = {
  mint: string;
  symbol: string;
  firstSeen: number;
  createdAt: number | null;
  lastSeen: number;
  reasons: string[];
  attempted: boolean;
  pricePath?: Array<{ at: number; value: number }>;
};
export type PaperTrade = {
  id: string;
  mint: string;
  symbol: string;
  decimals: number;
  signalAt: number;
  dueAt: number;
  status: "pending" | "open" | "closed" | "expired";
  signal: TokenSnapshot;
  entryAt?: number;
  entryQuote?: QuoteObs;
  rawQty?: string;
  costUsd?: number;
  exitDueAt?: number;
  exitReason?: string;
  exitAt?: number;
  exitQuote?: QuoteObs;
  proceedsUsd?: number;
  pnlUsd?: number;
  markUsd?: number;
  markAt?: number;
  error?: string;
  attempts: number;
};
export type SniperState = {
  version: typeof SNIPER_VERSION;
  experimentId?: string;
  strategy?: SniperStrategy;
  config: SniperConfig;
  enabled: boolean;
  startedAt: number;
  updatedAt: number;
  ticks: number;
  cash: number;
  candidates: Candidate[];
  trades: PaperTrade[];
  errors: string[];
};
export type SwapRequest = {
  inputMint: string;
  outputMint: string;
  amount: string;
  inDecimals: number;
  outDecimals: number;
  notionalUsd: number;
};
export type QuoteAdapter = (request: SwapRequest) => Promise<QuoteObs>;
export function newSniper(now: number, id = SNIPER_VERSION): SniperState {
  const preset = sniperExperiment(id);
  return {
    version: SNIPER_VERSION,
    experimentId: id,
    strategy: preset.strategy,
    config: { ...SNIPER_CONFIG, ...preset.config },
    enabled: true,
    startedAt: now,
    updatedAt: now,
    ticks: 0,
    cash: SNIPER_CONFIG.startCash,
    candidates: [],
    trades: [],
    errors: [],
  };
}
function fresh(obs: FieldObs<unknown>, now: number, config: SniperConfig) {
  return (
    obs.value !== null &&
    obs.status !== "UNKNOWN" &&
    obs.status !== "ERROR" &&
    obs.status !== "STALE" &&
    !obs.stale &&
    obs.eventTime <= now &&
    obs.ingestedAt <= now &&
    now - obs.eventTime <= config.maxDataAgeMs &&
    now - obs.ingestedAt <= config.maxDataAgeMs
  );
}
export function sniperRejects(
  t: TokenSnapshot,
  now: number,
  c: SniperConfig = SNIPER_CONFIG,
): string[] {
  const reasons: string[] = [];
  if (!t.mintSafety?.supported || !t.mintSafety.initialized)
    reasons.push("MINT_PROGRAM_NOT_VERIFIED");
  if (t.createdAt == null || t.createdAt > now || now - t.createdAt > c.maxAgeMs)
    reasons.push("AGE_UNKNOWN_OR_TOO_OLD");
  if (!Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 18)
    reasons.push("INVALID_DECIMALS");
  for (const key of [
    "priceUsd",
    "liquidityUsd",
    "volume5mUsd",
    "buys5m",
    "sells5m",
    "top10Pct",
    "mintAuth",
    "freezeAuth",
  ] as const) {
    if (!fresh(t[key], now, c)) reasons.push(`MISSING_OR_STALE_${key}`);
  }
  if (!(Number(t.priceUsd.value) > 0)) reasons.push("INVALID_PRICE");
  if ((t.liquidityUsd.value ?? 0) < c.minLiquidityUsd) reasons.push("LOW_LIQUIDITY");
  if ((t.volume5mUsd.value ?? 0) < c.minVolume5mUsd) reasons.push("LOW_VOLUME");
  const buys = t.buys5m.value ?? 0,
    sells = t.sells5m.value ?? 0;
  if (buys <= 0 || buys / Math.max(1, buys + sells) < c.minBuyShare) reasons.push("WEAK_BUY_FLOW");
  if ((t.top10Pct.value ?? 1) > c.maxTop10) reasons.push("HOLDER_CONCENTRATION");
  if (t.mintAuth.value !== false || t.freezeAuth.value !== false)
    reasons.push("CONTRACT_AUTHORITY_UNKNOWN_OR_ENABLED");
  return reasons;
}
function quoteValid(q: QuoteObs, r: SwapRequest, now: number, notBefore: number, c: SniperConfig) {
  return (
    q.available &&
    ["QUOTE_ONLY", "ROUTABLE"].includes(q.routeState ?? "") &&
    q.inMint === r.inputMint &&
    q.outMint === r.outputMint &&
    q.inAmount === r.amount &&
    /^\d+$/.test(q.outAmount) &&
    BigInt(q.outAmount) > 0n &&
    BigInt(q.outAmount) <= 18446744073709551615n &&
    q.eventTime >= notBefore &&
    q.eventTime <= now &&
    q.ingestedAt >= notBefore &&
    q.ingestedAt <= now &&
    now - q.eventTime <= c.maxDataAgeMs
  );
}
function slippedRaw(raw: string, bps: number) {
  return ((BigInt(raw) * BigInt(10000 - bps)) / 10000n).toString();
}
export function sniperMetrics(s: SniperState, asOf = s.updatedAt) {
  const closed = s.trades.filter((t) => t.status === "closed");
  const open = s.trades.filter((t) => t.status === "open");
  const realized = closed.reduce((n, t) => n + (t.pnlUsd ?? 0), 0);
  // Missing or stale exit marks are valued at zero; they are never a fabricated fill.
  const marked = open.reduce(
    (n, t) => n + (t.markAt && asOf - t.markAt <= s.config.maxDataAgeMs ? (t.markUsd ?? 0) : 0),
    0,
  );
  const equity = s.cash + marked;
  const net = equity - s.config.startCash;
  const blocked = open.filter(
    (t) => !t.markAt || asOf - t.markAt > s.config.maxDataAgeMs || t.error,
  ).length;
  return {
    closed: closed.length,
    open: open.length,
    pending: s.trades.filter((t) => t.status === "pending").length,
    expired: s.trades.filter((t) => t.status === "expired").length,
    wins: closed.filter((t) => (t.pnlUsd ?? 0) > 0).length,
    realizedUsd: realized,
    equityUsd: equity,
    netUsd: net,
    blockedExits: blocked,
    winRate: closed.length
      ? closed.filter((t) => (t.pnlUsd ?? 0) > 0).length / closed.length
      : null,
    evidence: "UNPROVEN" as const,
    blockers: [
      ...(closed.length < s.config.minValidationTrades ? ["INSUFFICIENT_CLOSED_TRADES"] : []),
      ...(net <= 0 ? ["NOT_NET_PROFITABLE"] : []),
      ...(blocked ? ["UNRESOLVED_EXIT_QUOTES"] : []),
      "NO_UNTOUCHED_FORWARD_VALIDATION",
      "QUOTE_SIMULATION_IS_NOT_A_LIVE_FILL",
    ],
  };
}

/** Runs only quote requests. No wallet, signer, swap transaction, or broadcast exists here. */
export async function advanceSniper(
  state: SniperState,
  tokens: TokenSnapshot[],
  now: number,
  quote: QuoteAdapter,
  clock = () => now,
): Promise<SniperState> {
  const s: SniperState = structuredClone(state),
    c = s.config;
  s.updatedAt = now;
  s.ticks++;
  const byMint = new Map(tokens.map((t) => [t.address, t]));
  for (const trade of s.trades) {
    if (trade.status !== "open" && trade.status !== "pending") continue;
    if (trade.status === "pending" && now - trade.signalAt > c.orderTimeoutMs) {
      trade.status = "expired";
      trade.error = "ENTRY_TIMEOUT";
      continue;
    }
    const t = byMint.get(trade.mint);
    if (trade.status === "pending") {
      if (!s.enabled || now < trade.dueAt) continue;
      if (!t || sniperRejects(t, now, c).length) {
        trade.error = "ENTRY_FILTERS_NOT_MET";
        continue;
      }
      const cost = c.orderUsd * (1 + c.feeBps / 10000) + c.networkFeeUsd;
      if (s.cash < cost) {
        trade.status = "expired";
        trade.error = "INSUFFICIENT_CASH";
        continue;
      }
      const r: SwapRequest = {
        inputMint: USDC,
        outputMint: trade.mint,
        amount: String(Math.round(c.orderUsd * 1e6)),
        inDecimals: 6,
        outDecimals: trade.decimals,
        notionalUsd: c.orderUsd,
      };
      trade.attempts++;
      try {
        const q = await quote(r),
          at = clock();
        if (!quoteValid(q, r, at, trade.dueAt, c) || at - trade.signalAt > c.orderTimeoutMs) {
          trade.error = q.failureReason ?? "INVALID_ENTRY_QUOTE";
          continue;
        }
        const qty = slippedRaw(q.outAmount, c.slippageBps);
        if (BigInt(qty) === 0n) {
          trade.error = "ZERO_QUANTITY";
          continue;
        }
        trade.entryQuote = q;
        trade.rawQty = qty;
        trade.entryAt = at;
        trade.costUsd = cost;
        trade.status = "open";
        trade.error = undefined;
        s.cash -= cost;
      } catch (e) {
        trade.error = e instanceof Error ? e.message : "QUOTE_ERROR";
      }
      continue;
    }
    const r: SwapRequest = {
      inputMint: trade.mint,
      outputMint: USDC,
      amount: trade.rawQty!,
      inDecimals: trade.decimals,
      outDecimals: 6,
      notionalUsd: c.orderUsd,
    };
    trade.attempts++;
    try {
      const q = await quote(r),
        at = clock();
      if (!quoteValid(q, r, at, trade.entryAt!, c)) {
        trade.error = q.failureReason ?? "EXIT_QUOTE_UNAVAILABLE";
        continue;
      }
      const proceeds =
        (Number(slippedRaw(q.outAmount, c.slippageBps)) / 1e6) * (1 - c.feeBps / 10000) -
        c.networkFeeUsd;
      trade.markUsd = Math.max(0, proceeds);
      trade.markAt = at;
      trade.error = undefined;
      const ret = proceeds / trade.costUsd! - 1;
      if (
        !trade.exitDueAt &&
        (ret >= c.takeProfit ||
          ret <= -c.stopLoss ||
          at - trade.entryAt! >= c.maxHoldMs ||
          !s.enabled)
      ) {
        trade.exitReason = !s.enabled
          ? "PAUSED_LIQUIDATION"
          : ret >= c.takeProfit
            ? "TAKE_PROFIT"
            : ret <= -c.stopLoss
              ? "STOP_LOSS"
              : "TIME_EXIT";
        trade.exitDueAt = at + c.latencyMs;
      }
      // The triggering quote cannot fill its own delayed order.
      if (trade.exitDueAt && at >= trade.exitDueAt && q.eventTime >= trade.exitDueAt) {
        trade.status = "closed";
        trade.exitQuote = q;
        trade.exitAt = at;
        trade.proceedsUsd = proceeds;
        trade.pnlUsd = proceeds - trade.costUsd!;
        s.cash += proceeds;
      }
    } catch (e) {
      trade.error = e instanceof Error ? e.message : "QUOTE_ERROR";
    }
  }
  s.updatedAt = clock();
  const reserved =
    s.trades.filter((t) => t.status === "pending").length *
    (c.orderUsd * (1 + c.feeBps / 10000) + c.networkFeeUsd);
  let available = s.cash - reserved;
  let slots =
    c.maxPositions - s.trades.filter((t) => t.status === "open" || t.status === "pending").length;
  const lossLimit = sniperMetrics(s).realizedUsd <= -c.maxSessionLossUsd;
  for (const t of tokens) {
    let candidate = s.candidates.find((x) => x.mint === t.address);
    if (!candidate) {
      candidate = {
        mint: t.address,
        symbol: t.symbol,
        firstSeen: now,
        lastSeen: now,
        createdAt: t.createdAt,
        reasons: [],
        attempted: false,
      };
      s.candidates.push(candidate);
    }
    candidate.lastSeen = now;
    candidate.reasons = sniperRejects(t, now, c);
    if (s.strategy === "confirmed-flow") {
      const reference = candidate.pricePath
        ?.filter((p) => p.at <= now - 20000 && now - p.at <= 120000)
        .at(-1);
      const change =
        reference && t.priceUsd.value != null ? t.priceUsd.value / reference.value - 1 : null;
      if (change == null || change < 0.01 || change > 0.12)
        candidate.reasons.push("MOMENTUM_NOT_CONFIRMED");
    }
    if (fresh(t.priceUsd, now, c) && t.priceUsd.value! > 0) {
      const path = candidate.pricePath ?? [];
      if (path.at(-1)?.at !== t.priceUsd.eventTime)
        path.push({ at: t.priceUsd.eventTime, value: t.priceUsd.value! });
      candidate.pricePath = path.filter((p) => now - p.at <= 120000).slice(-24);
    }
    if (
      !s.enabled ||
      lossLimit ||
      s.trades.length >= SNIPER_CONFIG.maxTrades ||
      s.trades.some((tr) => tr.mint === t.address) ||
      slots <= 0 ||
      available < c.orderUsd + 1 ||
      candidate.attempted ||
      candidate.reasons.length
    )
      continue;
    // Full decision snapshot persists independently of future observations.
    s.trades.push({
      id: `${s.experimentId ?? SNIPER_VERSION}:${t.address}:${now}`,
      mint: t.address,
      symbol: t.symbol,
      decimals: t.decimals,
      signalAt: now,
      dueAt: now + c.latencyMs,
      status: "pending",
      signal: structuredClone(t),
      attempts: 0,
    });
    candidate.attempted = true;
    slots--;
    available -= c.orderUsd * (1 + c.feeBps / 10000) + c.networkFeeUsd;
  }
  s.candidates = s.candidates.filter((x) => now - x.lastSeen < 24 * 3600_000).slice(-5000);
  return s;
}

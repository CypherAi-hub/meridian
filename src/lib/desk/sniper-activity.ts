import { sniperMetrics, type SniperState, type PaperTrade } from "./sniper.ts";
import type { TokenSnapshot } from "./schema.ts";

export type ActivityKind =
  | "WATCH"
  | "SKIP"
  | "ELIGIBLE"
  | "SIGNAL"
  | "BUY"
  | "EXIT_SIGNAL"
  | "SELL"
  | "EXPIRED"
  | "QUOTE_ISSUE"
  | "SCAN"
  | "CONTROL";
export type ActivityDraft = {
  key: string;
  session: string;
  at: number;
  kind: ActivityKind;
  mint?: string;
  symbol?: string;
  detail: {
    reasons?: string[];
    checked?: number;
    eligible?: number;
    equityUsd?: number;
    netUsd?: number;
    costUsd?: number;
    proceedsUsd?: number;
    pnlUsd?: number;
    rawQty?: string;
    reason?: string;
    enabled?: boolean;
    tradeId?: string;
  };
};
export type ActivityEvent = ActivityDraft & { id: string };
export const ACTIVITY_KINDS: ActivityKind[] = [
  "WATCH",
  "SKIP",
  "ELIGIBLE",
  "SIGNAL",
  "BUY",
  "EXIT_SIGNAL",
  "SELL",
  "EXPIRED",
  "QUOTE_ISSUE",
  "SCAN",
  "CONTROL",
];

export function reasonLabel(reason: string): string {
  if (reason.startsWith("MISSING_OR_STALE_")) {
    const field = reason.slice("MISSING_OR_STALE_".length);
    const labels: Record<string, string> = {
      priceUsd: "price",
      liquidityUsd: "liquidity",
      volume5mUsd: "five-minute volume",
      buys5m: "buy count",
      sells5m: "sell count",
      top10Pct: "holder distribution",
      mintAuth: "mint authority",
      freezeAuth: "freeze authority",
    };
    return `Missing or stale ${labels[field] ?? field}`;
  }
  const labels: Record<string, string> = {
    MINT_PROGRAM_NOT_VERIFIED: "Token program not verified",
    AGE_UNKNOWN_OR_TOO_OLD: "Outside the launch window or age unknown",
    INVALID_DECIMALS: "Unsupported token decimals",
    INVALID_PRICE: "No usable price",
    LOW_LIQUIDITY: "Liquidity below the strategy minimum",
    LOW_VOLUME: "Trading volume below the strategy minimum",
    WEAK_BUY_FLOW: "Buy pressure below the strategy minimum",
    HOLDER_CONCENTRATION: "Holder concentration too high or unknown",
    CONTRACT_AUTHORITY_UNKNOWN_OR_ENABLED: "Mint or freeze authority enabled or unknown",
    MOMENTUM_NOT_CONFIRMED: "Waiting for observed momentum confirmation",
    TAKE_PROFIT: "Take-profit threshold",
    STOP_LOSS: "Stop-loss threshold",
    TIME_EXIT: "Maximum holding time",
    PAUSED_LIQUIDATION: "Entries paused; exiting position",
    ENTRY_TIMEOUT: "No valid entry before the order expired",
    ENTRY_FILTERS_NOT_MET: "Entry checks no longer pass",
    BUDGET: "Waiting for the shared quote budget",
  };
  return labels[reason] ?? reason.replaceAll("_", " ").toLowerCase();
}

/** Observe committed-engine transitions; this never changes the book or creates trades. */
export function sniperActivity(
  prior: SniperState,
  next: SniperState,
  tokens: TokenSnapshot[],
): ActivityDraft[] {
  const session = next.experimentId ?? next.version;
  const events: ActivityDraft[] = [];
  const emit = (
    kind: ActivityKind,
    key: string,
    at: number,
    detail: ActivityDraft["detail"],
    token?: { mint: string; symbol: string },
  ) => {
    events.push({
      key: `${session}:${key}`,
      session,
      at,
      kind,
      ...(token ? { mint: token.mint, symbol: token.symbol } : {}),
      detail,
    });
  };
  const currentMints = new Set(tokens.map((t) => t.address));
  const before = new Map(prior.candidates.map((c) => [c.mint, c]));
  for (const c of next.candidates) {
    if (!currentMints.has(c.mint)) continue;
    const old = before.get(c.mint);
    if (!old) emit("WATCH", `watch:${c.mint}:${c.firstSeen}`, c.firstSeen, {}, c);
    const reasons = [...c.reasons].sort();
    if (!old || JSON.stringify([...old.reasons].sort()) !== JSON.stringify(reasons))
      emit(
        reasons.length ? "SKIP" : "ELIGIBLE",
        `decision:${c.mint}:${c.lastSeen}`,
        c.lastSeen,
        { reasons },
        c,
      );
  }
  const oldTrades = new Map(prior.trades.map((t) => [t.id, t]));
  for (const t of next.trades) {
    const old = oldTrades.get(t.id);
    const detail = { tradeId: t.id };
    if (!old && t.status === "pending")
      emit("SIGNAL", `signal:${t.id}`, t.signalAt, { ...detail, costUsd: next.config.orderUsd }, t);
    if (t.status === "open" && old?.status !== "open")
      emit(
        "BUY",
        `buy:${t.id}`,
        t.entryAt!,
        { ...detail, costUsd: t.costUsd, rawQty: t.rawQty },
        t,
      );
    if (t.exitDueAt && !old?.exitDueAt)
      emit(
        "EXIT_SIGNAL",
        `exit-signal:${t.id}`,
        t.exitDueAt - next.config.latencyMs,
        { ...detail, reason: t.exitReason },
        t,
      );
    if (t.status === "closed" && old?.status !== "closed")
      emit(
        "SELL",
        `sell:${t.id}`,
        t.exitAt!,
        {
          ...detail,
          costUsd: t.costUsd,
          proceedsUsd: t.proceedsUsd,
          pnlUsd: t.pnlUsd,
          rawQty: t.rawQty,
          reason: t.exitReason,
        },
        t,
      );
    if (t.status === "expired" && old?.status !== "expired")
      emit("EXPIRED", `expired:${t.id}`, next.updatedAt, { ...detail, reason: t.error }, t);
    if (t.error && t.error !== old?.error && (t.status === "pending" || t.status === "open"))
      emit(
        "QUOTE_ISSUE",
        `issue:${t.id}:${next.ticks}`,
        next.updatedAt,
        { ...detail, reason: t.error },
        t,
      );
  }
  if (
    tokens.length &&
    (prior.ticks === 0 ||
      Math.floor(prior.updatedAt / 60000) !== Math.floor(next.updatedAt / 60000))
  ) {
    const checked = next.candidates.filter((c) => currentMints.has(c.mint));
    const metrics = sniperMetrics(next, next.updatedAt);
    emit("SCAN", `scan:${next.ticks}`, next.updatedAt, {
      checked: checked.length,
      eligible: checked.filter((c) => !c.reasons.length).length,
      equityUsd: metrics.equityUsd,
      netUsd: metrics.netUsd,
      enabled: next.enabled,
    });
  }
  return events;
}

export type LiveTrade = Omit<PaperTrade, "signal" | "entryQuote" | "exitQuote">;
export type LiveBook = {
  id: string;
  name: string;
  enabled: boolean;
  initialized: boolean;
  updatedAt: number;
  ticks: number;
  metrics: ReturnType<typeof sniperMetrics>;
  orderUsd: number;
  maxPositions: number;
  lastCheckAt: number | null;
  recentChecks: number;
  eligible: number;
  reasons: Array<{ code: string; count: number }>;
  trades: LiveTrade[];
};
export type LiveBotReport = {
  mode: "PAPER";
  engine: "RULE_BASED";
  serverAt: number;
  events: ActivityEvent[];
  cursor: string;
  hasMore: boolean;
  recordingStartedAt: number | null;
  books: LiveBook[];
  worker: { status: string; lastTickAt: number | null; error: string | null; host: string };
  sources: Array<{ id: string; status: string; detail: string }>;
};

export function liveBookReport(
  report: {
    name: string;
    initialized: boolean;
    state: SniperState;
    metrics: ReturnType<typeof sniperMetrics>;
  },
  now: number,
): LiveBook {
  const { state: s } = report;
  const recent = s.candidates.filter((c) => now - c.lastSeen <= 90000);
  const counts = new Map<string, number>();
  for (const c of recent)
    for (const reason of c.reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return {
    id: s.experimentId ?? s.version,
    name: report.name,
    enabled: s.enabled,
    initialized: report.initialized,
    updatedAt: s.updatedAt,
    ticks: s.ticks,
    metrics: report.metrics,
    orderUsd: s.config.orderUsd,
    maxPositions: s.config.maxPositions,
    lastCheckAt: s.candidates.length ? Math.max(...s.candidates.map((c) => c.lastSeen)) : null,
    recentChecks: recent.length,
    eligible: recent.filter((c) => !c.reasons.length).length,
    reasons: [...counts]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count),
    trades: [
      ...s.trades.filter((t) => t.status === "open" || t.status === "pending"),
      ...s.trades.filter((t) => t.status === "closed" || t.status === "expired").slice(-20),
    ].map(({ signal, entryQuote, exitQuote, ...trade }) => trade),
  };
}

export function activityCursor(value?: string | null): string | null {
  if (value == null) return null;
  if (!/^(0|[1-9]\d{0,18})$/.test(value) || BigInt(value) > 9223372036854775807n)
    throw Error("Invalid activity cursor");
  return value;
}

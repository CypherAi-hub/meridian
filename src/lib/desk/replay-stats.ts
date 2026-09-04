import type { LedgerRow, UniverseBucket } from "./types.ts";

export const STOP_R = 0.1;

export type SliceStat = {
  n: number;
  uniqueTokens: number;
  medianReturn: number | null;
  meanR: number | null;
};

export type ReplayTradeStats = {
  uniqueTokens: number;
  eligibleEvents: number;
  candidateTrades: number;
  vetoed: number;
  paperEntries: number;
  labeledTrades: number;
  wins: number;
  losses: number;
  flats: number;
  winRate: number | null;
  lossRate: number | null;
  averageWin: number | null;
  averageLoss: number | null;
  medianTrade: number | null;
  expectancy: number | null;
  profitFactor: number | null;
  maxDrawdown: number | null;
  p10: number | null;
  p50: number | null;
  p90: number | null;
  meanExec: number | null;
  medianExec: number | null;
  rugExposure: number | null;
  sellRouteLossExposure: number | null;
  liquidityCollapseExposure: number | null;
  meanR: number | null;
  medianR: number | null;
  maxConsecutiveLosses: number;
  maxDrawdownR: number | null;
  byBucket: Record<string, SliceStat>;
  byRegime: Record<string, SliceStat>;
  byWeek: Record<string, SliceStat>;
  byLiquidity: Record<string, SliceStat>;
  byHolder: Record<string, SliceStat>;
  note: string;
};

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(xs: number[]): number | null {
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function pctile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)));
  return s[i];
}

function rate(xs: Array<boolean | null | undefined>): number | null {
  const known = xs.filter((x): x is boolean => x === true || x === false);
  if (!known.length) return null;
  return known.filter(Boolean).length / known.length;
}

export function tradeReturn(row: LedgerRow): number | null {
  const exec = row.execution_adjusted_return ?? row.net_execution_return;
  if (exec != null && Number.isFinite(exec)) return exec;
  if (row.theoretical_return != null && Number.isFinite(row.theoretical_return)) return row.theoretical_return;
  if (row.price && row.price_after_15m != null) return row.price_after_15m / row.price - 1;
  return null;
}

/** 1R = distance from entry to proposed stop (default 10%). */
export function rMultiple(row: LedgerRow): number | null {
  const ret = tradeReturn(row);
  const entry = row.price ?? row.proposed_entry;
  const stop = row.proposed_stop;
  if (ret == null || entry == null || !entry) return null;
  const r = stop != null && entry !== stop ? Math.abs(entry - stop) / entry : STOP_R;
  if (r < 1e-9) return null;
  return ret / r;
}

function liqBucket(liq: number | null): string {
  if (liq == null) return "unknown";
  if (liq < 50_000) return "0-50k";
  if (liq < 150_000) return "50-150k";
  if (liq < 500_000) return "150-500k";
  return "500k+";
}

function holderBucket(pct: number | null): string {
  if (pct == null) return "unknown";
  if (pct < 0.2) return "0-20";
  if (pct < 0.35) return "20-35";
  if (pct < 0.5) return "35-50";
  return "50+";
}

export function isoWeek(ms: number): string {
  const d = new Date(ms);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function groupSlice(rows: LedgerRow[]): SliceStat {
  const rets = rows.map(tradeReturn).filter((n): n is number => n != null);
  const rs = rows.map(rMultiple).filter((n): n is number => n != null);
  return {
    n: rows.length,
    uniqueTokens: new Set(rows.map((r) => r.tokenAddress)).size,
    medianReturn: median(rets),
    meanR: mean(rs),
  };
}

function maxDrawdown(ordered: number[]): number | null {
  if (!ordered.length) return null;
  let peak = 0;
  let equity = 0;
  let dd = 0;
  for (const x of ordered) {
    equity += x;
    if (equity > peak) peak = equity;
    dd = Math.max(dd, peak - equity);
  }
  return dd;
}

function maxConsecutiveLosses(ordered: number[]): number {
  let run = 0;
  let best = 0;
  for (const x of ordered) {
    if (x < 0) {
      run += 1;
      best = Math.max(best, run);
    } else {
      run = 0;
    }
  }
  return best;
}

export function buildReplayTradeStats(opts: {
  labeled: LedgerRow[];
  considerations: number;
  authorized: number;
  vetoed: number;
}): ReplayTradeStats {
  const labeled = opts.labeled.filter((r) => r.labels_complete);
  const authorized = labeled.filter((r) => r.governor_result === "authorized");
  const chrono = [...authorized].sort((a, b) => a.decision_time - b.decision_time || a.tokenAddress.localeCompare(b.tokenAddress));
  const rets = chrono.map(tradeReturn);
  const paired = chrono
    .map((row, i) => ({ row, ret: rets[i] }))
    .filter((p): p is { row: LedgerRow; ret: number } => p.ret != null);
  const values = paired.map((p) => p.ret);
  const wins = values.filter((v) => v > 0);
  const losses = values.filter((v) => v < 0);
  const flats = values.filter((v) => v === 0);
  const rs = chrono.map(rMultiple).filter((n): n is number => n != null);
  const execs = authorized
    .map((r) => r.execution_adjusted_return ?? r.net_execution_return)
    .filter((n): n is number => n != null);
  const n = values.length;
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = losses.reduce((a, b) => a + b, 0);

  const byBucket: Record<string, SliceStat> = {};
  const byRegime: Record<string, SliceStat> = {};
  const byWeek: Record<string, SliceStat> = {};
  const byLiquidity: Record<string, SliceStat> = {};
  const byHolder: Record<string, SliceStat> = {};
  const buckets: UniverseBucket[] = ["new_launch", "early", "emerging", "established", "mature", "unknown"];
  for (const b of buckets) {
    const rows = authorized.filter((r) => r.bucket === b);
    if (rows.length) byBucket[b] = groupSlice(rows);
  }
  const weeks = [...new Set(authorized.map((r) => isoWeek(r.decision_time)))];
  for (const week of weeks) byWeek[week] = groupSlice(authorized.filter((r) => isoWeek(r.decision_time) === week));
  const regimes = [...new Set(authorized.map((r) => r.regime))];
  for (const regime of regimes) byRegime[regime] = groupSlice(authorized.filter((r) => r.regime === regime));
  for (const key of ["0-50k", "50-150k", "150-500k", "500k+", "unknown"]) {
    const rows = authorized.filter((r) => liqBucket(r.liquidity) === key);
    if (rows.length) byLiquidity[key] = groupSlice(rows);
  }
  for (const key of ["0-20", "20-35", "35-50", "50+", "unknown"]) {
    const rows = authorized.filter((r) => holderBucket(r.holder_concentration) === key);
    if (rows.length) byHolder[key] = groupSlice(rows);
  }

  return {
    uniqueTokens: new Set(authorized.map((r) => r.tokenAddress)).size,
    eligibleEvents: opts.considerations,
    candidateTrades: opts.authorized,
    vetoed: opts.vetoed,
    paperEntries: authorized.length,
    labeledTrades: n,
    wins: wins.length,
    losses: losses.length,
    flats: flats.length,
    winRate: n ? wins.length / n : null,
    lossRate: n ? losses.length / n : null,
    averageWin: mean(wins),
    averageLoss: mean(losses),
    medianTrade: median(values),
    expectancy: mean(values),
    profitFactor: grossLoss < 0 ? grossWin / Math.abs(grossLoss) : wins.length && !losses.length ? Number.POSITIVE_INFINITY : null,
    maxDrawdown: maxDrawdown(values),
    p10: pctile(values, 0.1),
    p50: pctile(values, 0.5),
    p90: pctile(values, 0.9),
    meanExec: mean(execs),
    medianExec: median(execs),
    rugExposure: rate(authorized.map((r) => r.rug_detected)),
    sellRouteLossExposure: rate(authorized.map((r) => r.sell_route_lost)),
    liquidityCollapseExposure: rate(authorized.map((r) => r.liquidity_collapse)),
    meanR: mean(rs),
    medianR: median(rs),
    maxConsecutiveLosses: maxConsecutiveLosses(values),
    maxDrawdownR: maxDrawdown(rs),
    byBucket,
    byRegime,
    byWeek,
    byLiquidity,
    byHolder,
    note:
      n === 0
        ? "No authorized labeled trades on this tape. Hypothetical paper expectancy is undefined. Not alpha."
        : "Hypothetical paper from warehouse replay. Authorized labeled rows only. Not live fills. Not claimed alpha.",
  };
}

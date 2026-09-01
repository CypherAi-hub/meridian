import { LIQ_COLLAPSE_THRESHOLD, PATH_MIN_INTERVAL_MS } from "./schema.ts";
import { LABEL_DEFINITION_VERSION } from "./versions.ts";
import { pathQualityFromGaps, researchQualityScore, gradeFromScore, freshnessQuality } from "./quality-score.ts";
import { STALE_MS } from "./schema.ts";
import type { BarrierConfidence, BarrierOutcome, LedgerRow, PathTick, TokenLive } from "./types.ts";

const H = {
  m1: 60_000,
  m5: 5 * 60_000,
  m15: 15 * 60_000,
  m30: 30 * 60_000,
  h1: 60 * 60_000,
};

export type BarrierHit = BarrierOutcome;

export function pathGaps(path: PathTick[]): { max: number; avg: number; count: number } {
  const ordered = [...path].sort((a, b) => a.ts - b.ts);
  if (ordered.length < 2) return { max: Number.POSITIVE_INFINITY, avg: Number.POSITIVE_INFINITY, count: ordered.length };
  let max = 0;
  let sum = 0;
  let n = 0;
  for (let i = 1; i < ordered.length; i++) {
    const g = (ordered[i].ts - ordered[i - 1].ts) / 1000;
    if (g < 0) continue;
    max = Math.max(max, g);
    sum += g;
    n += 1;
  }
  return { max, avg: n ? sum / n : 0, count: ordered.length };
}

export function labelConfidence(maxGapSeconds: number, sampleCount: number): BarrierConfidence {
  if (sampleCount < 2) return "UNKNOWN";
  if (maxGapSeconds <= 5) return "HIGH";
  if (maxGapSeconds <= 15) return "MEDIUM";
  if (maxGapSeconds <= 30) return "LOW";
  return "UNKNOWN";
}

export function barrierResult(
  entryPrice: number,
  observations: PathTick[],
  upperPct: number,
  lowerPct: number,
): BarrierHit {
  if (!entryPrice || observations.length < 2) return "INSUFFICIENT_DATA";
  const upper = entryPrice * (1 + upperPct);
  const lower = entryPrice * (1 - lowerPct);
  const ordered = [...observations].sort((a, b) => a.ts - b.ts);
  for (let i = 0; i < ordered.length; i++) {
    const obs = ordered[i];
    const prev = i > 0 ? ordered[i - 1] : null;
    const hitUp = obs.px >= upper;
    const hitDown = obs.px <= lower;
    if (!hitUp && !hitDown) continue;
    const gapS = prev ? (obs.ts - prev.ts) / 1000 : 0;
    const jump = prev ? Math.abs(obs.px / prev.px - 1) : 0;
    if (prev && gapS > 15 && jump >= upperPct + lowerPct) {
      return "AMBIGUOUS";
    }
    if (hitUp && hitDown) return "AMBIGUOUS";
    if (hitUp) return "UPPER_FIRST";
    if (hitDown) return "LOWER_FIRST";
  }
  return "NEITHER";
}

export function calculateMfeMae(entryPrice: number, prices: number[]) {
  if (!prices.length || !entryPrice) return { mfe: 0, mae: 0 };
  const returns = prices.map((p) => p / entryPrice - 1);
  return { mfe: Math.max(...returns), mae: Math.min(...returns) };
}

export function detectLiquidityCollapse(
  initialLiquidity: number | null | undefined,
  observations: PathTick[],
  threshold = LIQ_COLLAPSE_THRESHOLD,
): boolean | null {
  if (!initialLiquidity) return null;
  for (const obs of observations) {
    if (obs.liq == null) continue;
    const decline = 1 - obs.liq / initialLiquidity;
    if (decline >= threshold) return true;
  }
  return false;
}

export function theoreticalReturn(entry: number, exit: number) {
  if (!entry) return null;
  return exit / entry - 1;
}

export function executionAdjustedReturn(opts: {
  entryQuote: number;
  exitQuote: number;
  entryCostBps: number;
  exitCostBps: number;
  feeBps: number;
}) {
  const gross = opts.exitQuote / opts.entryQuote - 1;
  const costs = (opts.entryCostBps + opts.exitCostBps + opts.feeBps) / 10_000;
  return gross - costs;
}

function barrierBool(outcome: BarrierHit): boolean | null {
  if (outcome === "UPPER_FIRST") return true;
  if (outcome === "LOWER_FIRST") return false;
  if (outcome === "NEITHER") return false;
  return null;
}

function priceAt(path: PathTick[], t: number): number | null {
  let last: number | null = null;
  for (const p of path) {
    if (p.ts <= t) last = p.px;
    else break;
  }
  return last ?? path.at(-1)?.px ?? null;
}

function windowPrices(path: PathTick[], origin: number, horizon: number) {
  const end = origin + horizon;
  return path.filter((p) => p.ts <= end).map((p) => p.px);
}

export function stampResearchQuality(next: LedgerRow) {
  const gaps = pathGaps(next.path);
  next.path_sample_count = gaps.count;
  next.max_path_gap_seconds = Number.isFinite(gaps.max) ? gaps.max : null;
  next.avg_path_gap_seconds = Number.isFinite(gaps.avg) ? gaps.avg : null;
  next.barrier_label_confidence = labelConfidence(Number.isFinite(gaps.max) ? gaps.max : 999, gaps.count);
  const score = researchQualityScore({
    priceOk: next.price != null,
    liquidityOk: next.liquidity != null && next.liquidity > 0,
    holderOk: next.holder_concentration != null,
    routeOk: next.route_status === "ROUTABLE" || next.sell_quote_available,
    securityOk: next.mint_auth != null && next.freeze_auth != null,
    pathQuality: pathQualityFromGaps(next.max_path_gap_seconds, next.path_sample_count ?? 0),
    freshnessQuality: freshnessQuality(next.ingested_at && next.decision_time ? next.decision_time - next.ingested_at : 0, STALE_MS),
  });
  next.research_quality_score = score;
  next.research_grade = gradeFromScore(score);
  next.label_definition_version = LABEL_DEFINITION_VERSION;
}

export function appendOutcomeTick(row: LedgerRow, t: TokenLive, now: number): LedgerRow {
  if (row.labels_complete || row.price == null) return row;
  const px = t.priceUsd.value;
  if (px == null) return row;
  const path = row.path;
  const last = path.at(-1);
  if (last && now - last.ts < PATH_MIN_INTERVAL_MS) return freezeLabels(row, now);
  const nextPath: PathTick[] = [
    ...path,
    {
      ts: now,
      px,
      liq: t.liquidityUsd.value ?? 0,
      sell: t.sellQuote?.available ? (1 as const) : (0 as const),
      entryQuote: t.buyQuote?.impliedPriceUsd ?? null,
      exitQuote: t.sellQuote?.impliedPriceUsd ?? null,
    },
  ].slice(-720);
  return freezeLabels({ ...row, path: nextPath }, now);
}

export function freezeLabels(row: LedgerRow, now: number): LedgerRow {
  if (row.price == null) return row;
  const age = now - row.decision_time;
  const entry = row.price;
  const path = [...row.path].sort((a, b) => a.ts - b.ts);
  const next: LedgerRow = { ...row, path };

  const stamp = (key: keyof LedgerRow, horizon: number) => {
    if (age >= horizon && next[key] == null) {
      const px = priceAt(path, row.decision_time + horizon);
      if (px != null) (next as unknown as Record<string, unknown>)[key] = px;
    }
  };
  stamp("price_after_1m", H.m1);
  stamp("price_after_5m", H.m5);
  stamp("price_after_15m", H.m15);
  stamp("price_after_30m", H.m30);
  stamp("price_after_1h", H.h1);

  const freezeWindow = (horizon: number, mfeKey: keyof LedgerRow, maeKey: keyof LedgerRow) => {
    if (age < horizon || next[mfeKey] != null) return;
    const prices = windowPrices(path, row.decision_time, horizon);
    const { mfe, mae } = calculateMfeMae(entry, prices.length ? prices : [entry]);
    (next as unknown as Record<string, unknown>)[mfeKey] = mfe;
    (next as unknown as Record<string, unknown>)[maeKey] = mae;
  };
  freezeWindow(H.m1, "mfe_1m", "mae_1m");
  freezeWindow(H.m5, "max_gain_5m", "max_drawdown_5m");
  freezeWindow(H.m15, "max_gain_15m", "max_drawdown_15m");
  freezeWindow(H.m30, "mfe_30m", "mae_30m");
  freezeWindow(H.h1, "max_gain_1h", "max_drawdown_1h");

  const o10 = barrierResult(entry, path, 0.1, 0.1);
  const o20 = barrierResult(entry, path, 0.2, 0.1);
  next.barrier_10_outcome = o10;
  next.barrier_20_outcome = o20;
  if (next.hit_plus_10_before_minus_10 == null) {
    const hit = barrierBool(o10);
    if (hit != null) next.hit_plus_10_before_minus_10 = hit;
    else if (age >= H.h1 && o10 === "NEITHER") next.hit_plus_10_before_minus_10 = false;
  }
  if (next.hit_plus_20_before_minus_10 == null) {
    const hit = barrierBool(o20);
    if (hit != null) next.hit_plus_20_before_minus_10 = hit;
    else if (age >= H.h1 && o20 === "NEITHER") next.hit_plus_20_before_minus_10 = false;
  }

  if (next.liquidity_collapse !== true) {
    const collapsed = detectLiquidityCollapse(row.liquidity, path);
    if (collapsed) next.liquidity_collapse = true;
    else if (age >= H.h1) next.liquidity_collapse = collapsed === null ? null : false;
  }

  if (row.sell_quote_available) {
    const lost = path.find((p) => p.sell === 0);
    if (lost && next.sell_route_lost !== true) {
      next.sell_route_lost = true;
      next.first_sell_route_loss_at = next.first_sell_route_loss_at ?? lost.ts;
    }
    if (next.sell_route_lost && next.sell_route_restored_at == null) {
      const restored = path.find((p) => p.ts > (next.first_sell_route_loss_at ?? 0) && p.sell === 1);
      if (restored) next.sell_route_restored_at = restored.ts;
    }
    if (age >= H.h1 && next.sell_route_lost == null) next.sell_route_lost = false;
  } else if (!row.sell_quote_available && age >= H.h1 && next.sell_route_lost == null) {
    next.sell_route_lost = null;
  }

  if (next.rug_detected !== true) {
    if (next.liquidity_collapse) next.rug_detected = true;
    else if (age >= H.h1) next.rug_detected = false;
  }

  if (age >= H.m15 && next.price_after_15m != null && next.theoretical_return == null) {
    next.theoretical_return = theoreticalReturn(entry, next.price_after_15m);
  }

  if (age >= H.m15 && next.simulated_exit == null && next.simulated_entry != null) {
    const px = next.price_after_15m ?? path.at(-1)?.px;
    if (px != null) {
      const entryCostBps = (next.entry_impact ?? 0.004) * 10_000;
      const exitCostBps = (next.exit_impact ?? 0.004) * 10_000;
      const feeBps = 25;
      const slipBps = 50;
      if (next.theoretical_return == null) next.theoretical_return = theoreticalReturn(entry, px);
      next.execution_adjusted_return = executionAdjustedReturn({
        entryQuote: entry,
        exitQuote: px,
        entryCostBps: entryCostBps + slipBps,
        exitCostBps,
        feeBps,
      });
      next.net_execution_return = next.execution_adjusted_return;
      const load = (next.exit_impact ?? 0.004) + feeBps / 10_000 + slipBps / 10_000;
      next.simulated_exit = px * (1 - load);
    }
  }

  stampResearchQuality(next);
  if (age >= H.h1 && next.price_after_1h != null && next.barrier_10_outcome !== "AMBIGUOUS" && next.barrier_10_outcome !== "INSUFFICIENT_DATA") {
    next.labels_complete = true;
  } else if (age >= H.h1 && next.price_after_1h != null) {
    next.labels_complete = true;
  }
  return next;
}

export function labelPending(rows: LedgerRow[], tokens: TokenLive[], now: number): LedgerRow[] {
  const by = new Map(tokens.map((t) => [t.address, t]));
  return rows.map((r) => {
    if (r.labels_complete) return r;
    const t = by.get(r.tokenAddress);
    return t ? appendOutcomeTick(r, t, now) : freezeLabels(r, now);
  });
}

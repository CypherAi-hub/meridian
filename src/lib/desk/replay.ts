import { computeFeatures, predict } from "./features.ts";
import { govern } from "./governor.ts";
import { freezeLabels } from "./labels.ts";
import { cooldownKey } from "./leakage.ts";
import { blankSnapshot, field } from "./providers/normalize.ts";
import { START_EQUITY, STRATEGY_VERSION, WSOL, type SourceId } from "./schema.ts";
import { STRATEGIES, strategyMatches, type StrategyDef } from "./strategies.ts";
import type { Features, LedgerRow, PathTick, Predictions, Regime, TokenLive } from "./types.ts";

export class ReplayClock {
  now: number;
  constructor(startTime: number) {
    this.now = startTime;
  }
  advanceTo(timestamp: number) {
    if (timestamp < this.now) throw new Error("Replay time cannot go backwards");
    this.now = timestamp;
  }
}

export function replayVisible<T extends { ingestedAt: number }>(events: T[], clock: number): T[] {
  return events.filter((e) => e.ingestedAt <= clock);
}

export type ReplayObservation = {
  mint: string;
  symbol: string;
  name?: string;
  pairAddress?: string;
  createdAt?: number | null;
  ingestedAt: number;
  eventTime: number;
  price: number | null;
  liquidity: number | null;
  volume5m: number | null;
  volume1m: number | null;
  mcap: number | null;
  fdv?: number | null;
  buys5m: number | null;
  sells5m: number | null;
  uniqueBuyers: number | null;
  uniqueSellers: number | null;
  holders: number | null;
  top10Pct: number | null;
  mintAuth: boolean | null;
  freezeAuth: boolean | null;
  sellRoute: boolean | null;
  buyRoute: boolean | null;
  entryImpact: number | null;
  exitImpact: number | null;
  source: SourceId | "derived";
};

export type ReplayConsideration = {
  decisionTime: number;
  mint: string;
  symbol: string;
  strategyId: string;
  strategyVersion: string;
  matched: boolean;
  approved: boolean;
  vetoReason: string;
  features: Features;
  predictions: Predictions;
  price: number | null;
  liquidity: number | null;
  visibleCount: number;
  hiddenCount: number;
  leaked: boolean;
};

export type ReplayRun = {
  from: number;
  to: number;
  stepMs: number;
  observations: number;
  visibleAtEnd: number;
  hiddenAtStart: number;
  considerations: ReplayConsideration[];
  labeled: LedgerRow[];
  leakageViolations: number;
  note: string;
};

function srcOf(o: ReplayObservation): SourceId | "derived" {
  return o.source ?? "derived";
}

export function observationsAsOf(obs: ReplayObservation[], t: number): ReplayObservation[] {
  return obs.filter((o) => o.ingestedAt <= t);
}

export function reconstructToken(obs: ReplayObservation[], mint: string, t: number): TokenLive | null {
  const visible = observationsAsOf(obs, t)
    .filter((o) => o.mint === mint)
    .sort((a, b) => a.ingestedAt - b.ingestedAt || a.eventTime - b.eventTime);
  if (!visible.length) return null;
  const last = visible[visible.length - 1];
  const prev = visible.length > 1 ? visible[visible.length - 2] : last;
  const history = visible.map((o) => o.price ?? 0).slice(-48);
  const eventTime = last.eventTime;
  const ingestedAt = last.ingestedAt;
  const source = srcOf(last);
  const snap = blankSnapshot(mint, eventTime, ingestedAt);
  const mkQuote = (available: boolean | null, impact: number | null, side: "buy" | "sell") => {
    if (available == null && impact == null) return null;
    const ok = Boolean(available);
    return {
      available: ok,
      inMint: side === "buy" ? WSOL : mint,
      outMint: side === "buy" ? mint : WSOL,
      inAmount: "1",
      outAmount: "1",
      notionalUsd: 120,
      priceImpactPct: impact,
      impliedPriceUsd: last.price,
      routeLabels: ok ? ["replay"] : [],
      latencyMs: 0,
      eventTime,
      ingestedAt,
      source: "jupiter" as const,
      routeState: ok ? ("ROUTABLE" as const) : ("NO_ROUTE" as const),
    };
  };
  return {
    ...snap,
    symbol: last.symbol || "UNK",
    name: last.name || last.symbol || "unknown",
    pairAddress: last.pairAddress || "",
    createdAt: last.createdAt ?? null,
    priceUsd: field(last.price, eventTime, ingestedAt, source),
    liquidityUsd: field(last.liquidity, eventTime, ingestedAt, source),
    mcapUsd: field(last.mcap ?? null, eventTime, ingestedAt, source),
    fdvUsd: field(last.fdv ?? null, eventTime, ingestedAt, source),
    volume5mUsd: field(last.volume5m, eventTime, ingestedAt, source),
    volume1mUsd: field(last.volume1m, eventTime, ingestedAt, "derived"),
    buys5m: field(last.buys5m, eventTime, ingestedAt, source),
    sells5m: field(last.sells5m, eventTime, ingestedAt, source),
    uniqueBuyers5m: field(last.uniqueBuyers, eventTime, ingestedAt, source),
    uniqueSellers5m: field(last.uniqueSellers, eventTime, ingestedAt, source),
    holders: field(last.holders, eventTime, ingestedAt, source),
    top10Pct: field(last.top10Pct, eventTime, ingestedAt, source),
    mintAuth: field(last.mintAuth, eventTime, ingestedAt, source),
    freezeAuth: field(last.freezeAuth, eventTime, ingestedAt, source),
    buyQuote: mkQuote(last.buyRoute, last.entryImpact, "buy"),
    sellQuote: mkQuote(last.sellRoute, last.exitImpact, "sell"),
    history,
    prevLiq: prev.liquidity ?? last.liquidity ?? 0,
    prevVolume5m: prev.volume5m ?? last.volume5m ?? 0,
    prevBuyers: prev.uniqueBuyers ?? 0,
    rugged: (last.liquidity ?? 0) < 800,
  };
}

export function snapshotLeaked(token: TokenLive, t: number): boolean {
  const fields = [
    token.priceUsd,
    token.liquidityUsd,
    token.volume5mUsd,
    token.top10Pct,
    token.mintAuth,
    token.freezeAuth,
    token.holders,
  ];
  if (fields.some((f) => f.ingestedAt > t && f.value != null)) return true;
  if (token.buyQuote && token.buyQuote.ingestedAt > t) return true;
  if (token.sellQuote && token.sellQuote.ingestedAt > t) return true;
  return false;
}

export function replayConsider(opts: {
  observations: ReplayObservation[];
  mint: string;
  decisionTime: number;
  strategy: StrategyDef;
  regime?: Regime;
  equity?: number;
}): ReplayConsideration | null {
  const t = opts.decisionTime;
  const visible = observationsAsOf(opts.observations, t).filter((o) => o.mint === opts.mint);
  const hidden = opts.observations.filter((o) => o.mint === opts.mint && o.ingestedAt > t);
  const token = reconstructToken(opts.observations, opts.mint, t);
  if (!token) return null;
  const leaked = snapshotLeaked(token, t);
  const { features } = computeFeatures(token, t);
  const predictions = predict(token, features);
  const regime = opts.regime ?? "chop";
  const gov = govern({
    t: token,
    f: features,
    pred: predictions,
    equity: opts.equity ?? START_EQUITY,
    riskBps: 25,
    openCount: 0,
    maxPositions: 4,
    regime,
    strategyId: opts.strategy.id,
    now: t,
    dayDd: 0,
  });
  const matched = strategyMatches(opts.strategy, { ...features, ...predictions });
  if (!matched && gov.approved) {
    gov.approved = false;
    gov.reasons = ["Strategy filters"];
  }
  return {
    decisionTime: t,
    mint: opts.mint,
    symbol: token.symbol,
    strategyId: opts.strategy.id,
    strategyVersion: STRATEGY_VERSION,
    matched,
    approved: Boolean(matched && gov.approved),
    vetoReason: gov.approved && matched ? "TRADE AUTHORIZED" : gov.reasons[0] ?? "veto",
    features,
    predictions,
    price: token.priceUsd.value,
    liquidity: token.liquidityUsd.value,
    visibleCount: visible.length,
    hiddenCount: hidden.length,
    leaked,
  };
}

function pathFromObservations(obs: ReplayObservation[], mint: string, from: number, to: number): PathTick[] {
  return obs
    .filter((o) => o.mint === mint && o.eventTime >= from && o.eventTime <= to && o.price != null)
    .sort((a, b) => a.eventTime - b.eventTime)
    .map((o) => ({
      ts: o.eventTime,
      px: o.price as number,
      liq: o.liquidity ?? 0,
      sell: o.sellRoute ? (1 as const) : (0 as const),
    }));
}

export function labelReplayConsideration(
  considered: ReplayConsideration,
  observations: ReplayObservation[],
  now?: number,
): LedgerRow {
  const horizonEnd = considered.decisionTime + 60 * 60_000;
  const labelNow = now ?? horizonEnd;
  const path = pathFromObservations(observations, considered.mint, considered.decisionTime, labelNow);
  const entry = considered.price;
  const row = {
    decision_id: `replay-${considered.mint}-${considered.decisionTime}-${considered.strategyId}`,
    event_time: considered.decisionTime,
    ingested_at: considered.decisionTime,
    decision_time: considered.decisionTime,
    token: considered.symbol,
    tokenAddress: considered.mint,
    pair_address: "",
    token_age: considered.features.tokenAgeS,
    bucket: considered.features.bucket,
    price: entry,
    market_cap: null,
    liquidity: considered.liquidity,
    volume_1m: null,
    volume_5m: null,
    volume_acceleration: considered.features.volAccel,
    buy_sell_imbalance: considered.features.usdImbalance,
    unique_buyers: null,
    unique_sellers: null,
    holder_count: null,
    holder_concentration: considered.features.top10Pct,
    mint_auth: considered.features.mintAuth,
    freeze_auth: considered.features.freezeAuth,
    entry_impact: considered.features.entryImpactPct,
    exit_impact: considered.features.exitImpactPct,
    stressed_exit: 0,
    momentum_score: considered.predictions.momentumScore,
    flow_score: considered.predictions.flowScore,
    safety_score: considered.predictions.safetyScore,
    edge_score: considered.predictions.edgeScore,
    regime: "chop" as Regime,
    strategy_id: considered.strategyId,
    strategy_version: considered.strategyVersion,
    feature_engine_version: "v1.3.0",
    label_definition_version: "labels_v1",
    governor_result: considered.approved ? ("authorized" as const) : ("vetoed" as const),
    veto_reason: considered.vetoReason,
    veto_reason_code: considered.approved ? "TRADE_AUTHORIZED" : "VETO",
    proposed_size: 0,
    proposed_entry: entry,
    proposed_stop: entry != null ? entry * 0.9 : null,
    trade_taken: false,
    trade_action: considered.approved ? ("ignore" as const) : ("veto" as const),
    sell_quote_available: considered.features.sellQuoteAvailable === 1,
    route_status: considered.features.sellQuoteAvailable === 1 ? "ROUTABLE" : "UNKNOWN",
    feature_sources: {},
    features: considered.features,
    gates: [],
    path,
    price_after_1m: null,
    price_after_5m: null,
    price_after_15m: null,
    price_after_30m: null,
    price_after_1h: null,
    max_gain_5m: null,
    max_gain_15m: null,
    max_gain_1h: null,
    max_drawdown_5m: null,
    max_drawdown_15m: null,
    max_drawdown_1h: null,
    mfe_1m: null,
    mfe_30m: null,
    mae_1m: null,
    mae_30m: null,
    hit_plus_10_before_minus_10: null,
    hit_plus_20_before_minus_10: null,
    barrier_10_outcome: null,
    barrier_20_outcome: null,
    barrier_label_confidence: null,
    max_path_gap_seconds: null,
    avg_path_gap_seconds: null,
    path_sample_count: null,
    liquidity_collapse: null,
    sell_route_lost: null,
    first_sell_route_loss_at: null,
    sell_route_restored_at: null,
    rug_detected: null,
    simulated_entry: entry,
    simulated_exit: null,
    theoretical_return: null,
    net_execution_return: null,
    execution_adjusted_return: null,
    research_quality_score: null,
    research_grade: null,
    provider_disagreement: false,
    labels_complete: false,
    outcome: "not_taken",
  } as LedgerRow;
  return freezeLabels(row, labelNow);
}

export function replayStrategy(opts: {
  observations: ReplayObservation[];
  strategy?: StrategyDef;
  from?: number;
  to?: number;
  stepMs?: number;
  regime?: Regime;
  mints?: string[];
}): ReplayRun {
  const obs = [...opts.observations].sort((a, b) => a.ingestedAt - b.ingestedAt);
  if (!obs.length) {
    return {
      from: 0,
      to: 0,
      stepMs: opts.stepMs ?? 20_000,
      observations: 0,
      visibleAtEnd: 0,
      hiddenAtStart: 0,
      considerations: [],
      labeled: [],
      leakageViolations: 0,
      note: "No observations to replay.",
    };
  }
  const from = opts.from ?? obs[0].ingestedAt;
  const to = opts.to ?? obs[obs.length - 1].ingestedAt;
  const stepMs = opts.stepMs ?? 20_000;
  const strategy = opts.strategy ?? STRATEGIES[0];
  const mints = opts.mints ?? [...new Set(obs.map((o) => o.mint))];
  const clock = new ReplayClock(from);
  const lastByMint: Record<string, number> = {};
  const considerations: ReplayConsideration[] = [];
  let leakageViolations = 0;

  for (let t = from; t <= to; t += stepMs) {
    clock.advanceTo(t);
    for (const mint of mints) {
      const key = cooldownKey(mint, STRATEGY_VERSION, t);
      const prevKey = lastByMint[mint] != null ? cooldownKey(mint, STRATEGY_VERSION, lastByMint[mint]) : null;
      if (prevKey === key) continue;
      const considered = replayConsider({
        observations: obs,
        mint,
        decisionTime: t,
        strategy,
        regime: opts.regime,
      });
      if (!considered) continue;
      lastByMint[mint] = t;
      if (considered.leaked) leakageViolations += 1;
      considerations.push(considered);
    }
  }

  const labeled = considerations.map((c) => labelReplayConsideration(c, obs, to + 60 * 60_000));
  return {
    from,
    to,
    stepMs,
    observations: obs.length,
    visibleAtEnd: observationsAsOf(obs, to).length,
    hiddenAtStart: obs.filter((o) => o.ingestedAt > from).length,
    considerations,
    labeled,
    leakageViolations,
    note:
      leakageViolations === 0
        ? `Replay used only ingested_at ≤ decision_time. ${considerations.length} considerations, ${labeled.filter((r) => r.labels_complete).length} labeled.`
        : `Replay found ${leakageViolations} leakage violations. Do not train on this run.`,
  };
}

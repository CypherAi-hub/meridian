import { createHash } from "node:crypto";
import {
  DEFAULT_STRATEGY_RULES,
  evaluateStrategies,
  selectValidatedStrategy,
  type StrategyId,
  type StrategyRules,
  type SignalFeatures,
  type ValidatedStrategyConfig,
} from "./intelligence.ts";
import {
  DEFAULT_RISK_LIMITS,
  DEFAULT_SAFETY_POLICY,
  RiskGovernor,
  checkTokenSafety,
  type RiskLimits,
  type TokenSafetyEvidence,
} from "./risk.ts";
import type { ReplayContext, ReplayDecision, ReplayObservation, ReplayQuote } from "./replay.ts";
import { conservativeCostBps } from "./costs.ts";

type SerializedRisk = {
  [K in keyof RiskLimits]: RiskLimits[K] extends bigint ? string : RiskLimits[K];
};
type SerializedRules = Omit<StrategyRules, "minimumLiquidityLamports"> & {
  minimumLiquidityLamports: string;
};
export interface ReplayStrategyConfig {
  version: 1;
  id: string;
  strategy: StrategyId | "adaptive";
  frozenAt: number;
  entryLamports: string;
  rules: SerializedRules;
  risk: SerializedRisk;
  maxFeatureAgeMs: number;
  exits: {
    stopLossBps: number;
    trailingStopBps: number;
    takeProfitBps: number;
    maximumHoldMs: number;
    momentumExitImbalance: number;
    concentratedSellingBps: number;
  };
  /** Adaptive candidates contain only validation completed before the current decision time. */
  validated?: Array<
    Omit<ValidatedStrategyConfig, "outOfSampleNetLamports"> & { outOfSampleNetLamports: string }
  >;
}
export const REPLAY_FEATURE_CONTRACT = {
  timestamp: "featuresObservedAt",
  signals: [
    "observations",
    "verifiedLaunchAgeMs",
    "imbalance",
    "uniqueBuyers",
    "independentBuyerUnits",
    "uniqueBuyerAcceleration",
    "priceVelocityBps",
    "priceAccelerationBps",
    "drawdownFromPeakBps",
    "netInflowLamports",
    "sellerConcentrationBps",
    "organicScore",
    "smartBuyers",
    "creatorSelling",
    "creatorPriorLaunches",
    "creatorPriorAdverseOutcomes",
    "liquidityLamports",
    "liquidityGrowing",
    "curveProgressBps",
    "executionCostBps",
  ],
  safety: [
    "securityObservedAt",
    "mintAuthorityRevoked",
    "freezeAuthorityRevoked",
    "tokenProgram",
    "extensionsVerified",
    "unsupportedExtensionCount",
    "transferFeeBps",
    "permanentDelegateAbsent",
    "transferRestricted",
    "creatorConcentrationBps",
    "creatorAssociationsVerified",
    "creatorAssociatedConcentrationBps",
    "topHolderConcentrationBps",
    "knownMalicious",
    "sellRouteAvailable",
    "sellRouteObservedAt",
    "liquidityAccessible",
    "creatorSelling",
  ],
  encoding:
    "Feature values are finite numbers or null. Flags are exactly 0/1; tokenProgram is 1=SPL Token or 2=Token-2022. Raw lamports represented numerically must be safe integers; exact quotes remain decimal strings. Missing evidence is never assumed safe.",
} as const;
const raw = (v: string) => {
  if (!/^(0|[1-9]\d*)$/.test(v)) throw Error("INVALID_REPLAY_INTEGER_CONFIGURATION");
  return BigInt(v);
};
const value = (ctx: ReplayContext, key: string) => {
  const v = ctx.current.features[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};
const flag = (ctx: ReplayContext, key: string) => {
  const n = value(ctx, key);
  return n === 1 ? true : n === 0 ? false : null;
};
const integer = (ctx: ReplayContext, key: string) => {
  const n = value(ctx, key);
  return n != null && Number.isSafeInteger(n) ? BigInt(n) : null;
};
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function replayConfigurationHash(config: ReplayStrategyConfig): string {
  const { validated: _, ...executionConfig } = config;
  return createHash("sha256").update(stable(executionConfig)).digest("hex");
}
export function researchReplayConfiguration(
  strategy: StrategyId,
  frozenAt: number,
): ReplayStrategyConfig {
  const risk = Object.fromEntries(
    Object.entries(DEFAULT_RISK_LIMITS).map(([k, v]) => [
      k,
      typeof v === "bigint" ? v.toString() : v,
    ]),
  ) as SerializedRisk;
  return {
    version: 1,
    id: `research-${strategy}-v1`,
    strategy,
    frozenAt,
    entryLamports: "10000000",
    rules: {
      ...DEFAULT_STRATEGY_RULES,
      minimumLiquidityLamports: DEFAULT_STRATEGY_RULES.minimumLiquidityLamports.toString(),
    },
    risk,
    maxFeatureAgeMs: 30_000,
    exits: {
      stopLossBps: 1500,
      trailingStopBps: 1000,
      takeProfitBps: 5000,
      maximumHoldMs: 300_000,
      momentumExitImbalance: -0.4,
      concentratedSellingBps: 7000,
    },
  };
}
/** Flatten already-observed engine evidence for durable replay. Unsafe integer conversion becomes unknown. */
export function flattenReplayFeatures(
  f: SignalFeatures,
  s: TokenSafetyEvidence,
  risk: { now: number; slippageBps: number; killSwitch: boolean; consecutiveFailures: number },
): Record<string, number | null> {
  if (!Number.isFinite(risk.now) || f.asOf > risk.now || s.observedAt > risk.now)
    throw Error("FUTURE_EVIDENCE_IN_REPLAY_SNAPSHOT");
  if (f.mint !== s.mint) throw Error("REPLAY_SNAPSHOT_MINT_MISMATCH");
  const safe = (n: bigint | null) =>
    n === null || n > BigInt(Number.MAX_SAFE_INTEGER) || n < BigInt(Number.MIN_SAFE_INTEGER)
      ? null
      : Number(n);
  const boolean = (b: boolean | null | undefined) => (b === true ? 1 : b === false ? 0 : null);
  const revoked = (authority: string | null | undefined) =>
    authority === undefined ? null : authority === null ? 1 : 0;
  return {
    featuresObservedAt: risk.now,
    securityObservedAt: s.observedAt,
    observations: f.observations,
    verifiedLaunchAgeMs: f.verifiedLaunchAgeMs,
    imbalance: f.imbalance,
    uniqueBuyers: f.uniqueBuyers,
    independentBuyerUnits: f.organic.independentBuyerUnits,
    uniqueBuyerAcceleration: f.uniqueBuyerAcceleration,
    priceVelocityBps: f.priceVelocityBps,
    priceAccelerationBps: f.priceAccelerationBps,
    drawdownFromPeakBps: f.drawdownFromPeakBps,
    netInflowLamports: safe(f.netInflowLamports),
    sellerConcentrationBps: f.sellerConcentrationBps,
    organicScore: f.organic.score,
    clusteredBuyers: f.organic.clusteredBuyers,
    creatorAssociatedBuyers: f.organic.creatorAssociatedBuyers,
    effectiveBuyVolumeLamports: safe(f.organic.effectiveBuyVolume),
    smartBuyers: f.smartBuyers,
    creatorSelling:
      s.abnormalCreatorActivity == null
        ? null
        : boolean(s.abnormalCreatorActivity || f.creatorSelling),
    creatorPriorLaunches: f.creatorPriorLaunches,
    creatorPriorAdverseOutcomes: f.creatorPriorAdverseOutcomes,
    liquidityLamports: safe(f.liquidityLamports),
    liquidityGrowing: boolean(f.liquidityGrowing),
    curveProgressBps: f.curveProgressBps,
    executionCostBps: f.executionCostBps,
    mintAuthorityRevoked: revoked(s.mintAuthority),
    freezeAuthorityRevoked: revoked(s.freezeAuthority),
    tokenProgram: s.tokenProgram === "spl-token" ? 1 : s.tokenProgram === "token-2022" ? 2 : null,
    extensionsVerified: boolean(s.extensionsVerified),
    unsupportedExtensionCount: s.extensionsVerified
      ? s.extensions.filter((name) => !DEFAULT_SAFETY_POLICY.allowedExtensions.includes(name))
          .length
      : null,
    transferFeeBps: s.transferFeeBps,
    permanentDelegateAbsent: revoked(s.permanentDelegate),
    transferRestricted: boolean(s.transferRestricted),
    creatorConcentrationBps: s.creatorConcentrationBps,
    creatorAssociationsVerified: boolean(s.creatorAssociationsVerified),
    creatorAssociatedConcentrationBps: s.creatorAssociatedConcentrationBps ?? null,
    topHolderConcentrationBps: s.topHolderConcentrationBps,
    knownMalicious: boolean(s.knownMalicious),
    sellRouteAvailable: boolean(s.sellRouteAvailable),
    sellRouteObservedAt: s.sellRouteObservedAt,
    liquidityAccessible: boolean(s.liquidityAccessible),
    slippageBps: risk.slippageBps,
    killSwitch: boolean(risk.killSwitch),
    consecutiveFailures: risk.consecutiveFailures,
  };
}
function limitsFrom(config: ReplayStrategyConfig): RiskLimits {
  const values = { ...config.risk } as unknown as RiskLimits;
  for (const [k, v] of Object.entries(DEFAULT_RISK_LIMITS))
    if (typeof v === "bigint")
      (values as unknown as Record<string, unknown>)[k] = raw(
        (config.risk as unknown as Record<string, string>)[k],
      );
  return values;
}
function safetyAt(ctx: ReplayContext): TokenSafetyEvidence {
  const noAuthority = (key: string) =>
    flag(ctx, key) === true
      ? null
      : flag(ctx, key) === false
        ? "RECORDED_ACTIVE_AUTHORITY"
        : undefined;
  const tokenProgram = value(ctx, "tokenProgram");
  const unsupported = value(ctx, "unsupportedExtensionCount");
  return {
    mint: ctx.current.mint,
    observedAt: value(ctx, "securityObservedAt") ?? NaN,
    mintAuthority: noAuthority("mintAuthorityRevoked"),
    freezeAuthority: noAuthority("freezeAuthorityRevoked"),
    tokenProgram: tokenProgram === 1 ? "spl-token" : tokenProgram === 2 ? "token-2022" : "unknown",
    extensionsVerified: flag(ctx, "extensionsVerified") === true && unsupported === 0,
    extensions: unsupported === 0 ? [] : ["UNSUPPORTED_OR_UNRECORDED_EXTENSION"],
    transferFeeBps: value(ctx, "transferFeeBps"),
    permanentDelegate: noAuthority("permanentDelegateAbsent"),
    transferRestricted: flag(ctx, "transferRestricted"),
    creatorConcentrationBps: value(ctx, "creatorConcentrationBps"),
    creatorAssociationsVerified: flag(ctx, "creatorAssociationsVerified") ?? undefined,
    creatorAssociatedConcentrationBps: value(ctx, "creatorAssociatedConcentrationBps"),
    topHolderConcentrationBps: value(ctx, "topHolderConcentrationBps"),
    knownMalicious: flag(ctx, "knownMalicious"),
    sellRouteAvailable: flag(ctx, "sellRouteAvailable"),
    sellRouteObservedAt: value(ctx, "sellRouteObservedAt"),
    liquidityAccessible: flag(ctx, "liquidityAccessible"),
    abnormalCreatorActivity: flag(ctx, "creatorSelling"),
  };
}
function signalsAt(ctx: ReplayContext): SignalFeatures {
  const n = (key: string) => value(ctx, key),
    zero = (key: string) => n(key) ?? 0;
  return {
    asOf: ctx.now,
    mint: ctx.current.mint,
    observations: zero("observations"),
    verifiedLaunchAgeMs: n("verifiedLaunchAgeMs"),
    imbalance: n("imbalance"),
    uniqueBuyers: zero("uniqueBuyers"),
    uniqueBuyerAcceleration: zero("uniqueBuyerAcceleration"),
    priceVelocityBps: n("priceVelocityBps"),
    priceAccelerationBps: n("priceAccelerationBps"),
    drawdownFromPeakBps: n("drawdownFromPeakBps"),
    netInflowLamports: integer(ctx, "netInflowLamports") ?? 0n,
    sellerConcentrationBps: n("sellerConcentrationBps"),
    organic: {
      score: zero("organicScore"),
      confidence: "low",
      independentBuyerUnits: zero("independentBuyerUnits"),
      uniqueBuyers: zero("uniqueBuyers"),
      clusteredBuyers: zero("clusteredBuyers"),
      creatorAssociatedBuyers: zero("creatorAssociatedBuyers"),
      effectiveBuyVolume: integer(ctx, "effectiveBuyVolumeLamports") ?? 0n,
      evidence: [
        "Recorded point-in-time numeric features; inspect source wallet evidence separately.",
      ],
    },
    smartBuyers: zero("smartBuyers"),
    creatorSelling: flag(ctx, "creatorSelling") === true,
    creatorPriorLaunches: zero("creatorPriorLaunches"),
    creatorPriorAdverseOutcomes: zero("creatorPriorAdverseOutcomes"),
    liquidityLamports: integer(ctx, "liquidityLamports"),
    liquidityGrowing: flag(ctx, "liquidityGrowing"),
    curveProgressBps: n("curveProgressBps"),
    executionCostBps: n("executionCostBps"),
  };
}
function quoteValid(q: ReplayQuote | undefined, now: number, amount: bigint, maxAge: number) {
  if (
    !q ||
    !Number.isFinite(q.observedAt) ||
    q.observedAt < 0 ||
    q.observedAt > now ||
    now - q.observedAt > maxAge
  )
    return false;
  if (
    q.requestedAt !== undefined &&
    (!Number.isFinite(q.requestedAt) || q.requestedAt < 0 || q.requestedAt > q.observedAt)
  )
    return false;
  try {
    return (
      raw(q.inputRaw) === amount &&
      raw(q.outputRaw) > 0n &&
      raw(q.networkFeeLamports) >= 0n &&
      Number.isFinite(q.priceImpactBps) &&
      q.priceImpactBps >= 0
    );
  } catch {
    return false;
  }
}
const day = (at: number) => new Date(at).toISOString().slice(0, 10);

export function createReplayStrategy(input: ReplayStrategyConfig) {
  const config = deepFreeze(structuredClone(input));
  if (
    config.version !== 1 ||
    !config.id ||
    !Number.isFinite(config.frozenAt) ||
    config.frozenAt < 0 ||
    ![
      "launch_sniper",
      "momentum_breakout",
      "early_reversal",
      "smart_wallet_confirmation",
      "adaptive",
    ].includes(config.strategy) ||
    raw(config.entryLamports) <= 0n ||
    !Number.isFinite(config.maxFeatureAgeMs) ||
    config.maxFeatureAgeMs <= 0
  )
    throw Error("INVALID_FROZEN_REPLAY_CONFIGURATION");
  const limits = limitsFrom(config);
  new RiskGovernor(limits);
  for (const [name, v] of Object.entries(config.exits))
    if (
      !Number.isFinite(v) ||
      (name !== "momentumExitImbalance" && (!Number.isSafeInteger(v) || v <= 0))
    )
      throw Error("INVALID_REPLAY_EXIT_LIMITS");
  if (
    config.exits.stopLossBps >= 10_000 ||
    config.exits.trailingStopBps >= 10_000 ||
    config.exits.concentratedSellingBps > 10_000 ||
    config.exits.momentumExitImbalance < -1 ||
    config.exits.momentumExitImbalance > 1
  )
    throw Error("INVALID_REPLAY_EXIT_LIMITS");
  const rules: StrategyRules = {
    ...config.rules,
    minimumLiquidityLamports: raw(config.rules.minimumLiquidityLamports),
  };
  for (const [name, v] of Object.entries(rules))
    if (typeof v === "number" && !Number.isFinite(v)) throw Error(`INVALID_REPLAY_RULE:${name}`);
  const configurationHash = replayConfigurationHash(config);
  const common = (ctx: ReplayContext) => {
    const reasons: string[] = [];
    if (config.frozenAt >= ctx.now) reasons.push("CONFIGURATION_NOT_FROZEN_BEFORE_OBSERVATION");
    const at = value(ctx, "featuresObservedAt");
    if (at == null || at > ctx.now || ctx.now - at > config.maxFeatureAgeMs)
      reasons.push("FEATURES_UNRECORDED_STALE_OR_FUTURE");
    if (!ctx.portfolio) reasons.push("PORTFOLIO_RISK_STATE_UNAVAILABLE");
    return reasons;
  };
  // The initial decision and delayed settlement share signal/adaptive checks. Neither
  // calls evaluate(), so a pending fill cannot bypass deterioration or recurse.
  const entrySignals = (ctx: ReplayContext, amount: bigint) => {
    const reasons = common(ctx);
    const required = [
      "observations",
      "independentBuyerUnits",
      "organicScore",
      "creatorSelling",
      "creatorPriorAdverseOutcomes",
      "liquidityLamports",
      "executionCostBps",
      "netInflowLamports",
    ];
    for (const key of required)
      if (value(ctx, key) == null) reasons.push(`FEATURE_UNAVAILABLE:${key}`);
    let selected: StrategyId | "adaptive" = config.strategy;
    if (selected === "adaptive") {
      const candidates = (config.validated ?? []).map((c) => ({
        ...c,
        outOfSampleNetLamports: BigInt(c.outOfSampleNetLamports),
      }));
      const result = selectValidatedStrategy(candidates, ctx.current.regime, ctx.now);
      if (!result.selected) return { selected: null, reasons: [...reasons, ...result.reasons] };
      if (
        result.selected.configurationHash !==
        replayConfigurationHash({ ...config, strategy: result.selected.strategy })
      )
        return { selected: null, reasons: [...reasons, "VALIDATION_CONFIGURATION_HASH_MISMATCH"] };
      selected = result.selected.strategy;
    }
    const signals = signalsAt(ctx),
      buy = ctx.current.buy,
      sell = ctx.current.sell;
    // A stored numeric feature may have been rounded down by an older capture. Only
    // an exact current round-trip pair can prove the cost of this pending entry.
    if (
      !quoteValid(buy, ctx.now, amount, limits.maxQuoteAgeMs) ||
      !buy ||
      !quoteValid(sell, ctx.now, raw(buy.outputRaw), limits.maxQuoteAgeMs) ||
      !sell ||
      sell.observedAt < buy.observedAt ||
      (sell.requestedAt !== undefined && sell.requestedAt < buy.observedAt) ||
      buy.priceImpactBps > limits.maxImpactBps ||
      sell.priceImpactBps > limits.maxImpactBps
    ) {
      reasons.push("EXACT_SIZE_ROUND_TRIP_COST_UNAVAILABLE");
      signals.executionCostBps = null;
    } else {
      const exactCost = conservativeCostBps(
        amount,
        raw(sell.outputRaw),
        raw(buy.networkFeeLamports) + raw(sell.networkFeeLamports),
      );
      signals.executionCostBps = Math.max(signals.executionCostBps ?? 0, exactCost);
    }
    const decision = evaluateStrategies(signals, rules).find((d) => d.strategy === selected)!;
    if (!decision.enter) reasons.push(...decision.reasons);
    return { selected, reasons };
  };
  const portfolioGuard = (
    ctx: ReplayContext,
    order: { amountLamports: string; decisionAt: number },
  ) => {
    const reasons = common(ctx),
      portfolio = ctx.portfolio,
      amount = raw(order.amountLamports),
      q = ctx.current.buy;
    if (!portfolio || portfolio.equityLamports === null) reasons.push("PORTFOLIO_EQUITY_UNKNOWN");
    if (!quoteValid(q, ctx.now, amount, limits.maxQuoteAgeMs))
      reasons.push("EXACT_SIZE_ENTRY_QUOTE_UNAVAILABLE");
    if (flag(ctx, "killSwitch") === null) reasons.push("KILL_SWITCH_STATE_UNRECORDED");
    const failures = value(ctx, "consecutiveFailures");
    if (failures == null || !Number.isSafeInteger(failures) || failures < 0)
      reasons.push("EXECUTION_FAILURE_STATE_UNRECORDED");
    const slippage = value(ctx, "slippageBps");
    if (slippage == null) reasons.push("QUOTE_SLIPPAGE_UNRECORDED");
    const safety = checkTokenSafety(
      safetyAt(ctx),
      { ...DEFAULT_SAFETY_POLICY, maxAgeMs: config.maxFeatureAgeMs },
      ctx.now,
    );
    if (!safety.allowed) reasons.push(...safety.reasons);
    if (reasons.length || !portfolio || !q)
      return { allowed: false, reasons: [...new Set(reasons)] };
    const exposure = portfolio.positions.reduce((n, p) => n + raw(p.costLamports), 0n);
    const daily = portfolio.trades
      .filter((t) => day(t.closedAt) === day(ctx.now))
      .reduce((n, t) => n + BigInt(t.pnlLamports), 0n);
    const governor = new RiskGovernor(limits);
    const verdict = governor.authorize(
      {
        orderId: `${config.id}:${ctx.current.id}:${order.decisionAt}`,
        mint: ctx.current.mint,
        strategy: config.strategy,
        amountLamports: amount,
        feeLamports: raw(q.networkFeeLamports),
        liquidityLamports: integer(ctx, "liquidityLamports"),
        impactBps: q.priceImpactBps,
        slippageBps: slippage!,
        quoteObservedAt: q.observedAt,
      },
      {
        equityLamports: BigInt(portfolio.equityLamports!),
        peakEquityLamports: raw(portfolio.peakEquityLamports),
        cashLamports: raw(ctx.cashLamports),
        exposureLamports: exposure,
        openPositions: portfolio.positions.length,
        dailyRealizedPnlLamports: daily,
        consecutiveFailures: failures!,
        killSwitch: flag(ctx, "killSwitch") === true,
      },
      safety,
      ctx.now,
    );
    return { allowed: verdict.allowed, reasons: verdict.reasons };
  };
  const fillGuard = (ctx: ReplayContext, order: { amountLamports: string; decisionAt: number }) => {
    const signal = entrySignals(ctx, raw(order.amountLamports)),
      guard = portfolioGuard(ctx, order);
    const reasons = [...new Set([...signal.reasons, ...(!guard.allowed ? guard.reasons : [])])];
    return {
      allowed: signal.reasons.length === 0 && guard.allowed,
      reasons: reasons.length ? reasons : guard.reasons,
    };
  };
  const evaluate = (ctx: ReplayContext): ReplayDecision => {
    if (ctx.position) {
      const p = ctx.position,
        q = ctx.current.sell;
      if (!quoteValid(q, ctx.now, raw(p.quantityRaw), limits.maxQuoteAgeMs))
        return { action: "hold", reasons: ["EXIT_QUOTE_UNAVAILABLE_POSITION_UNRESOLVED"] };
      const net = raw(q!.outputRaw) - raw(q!.networkFeeLamports),
        cost = raw(p.costLamports) + raw(p.entryFeeLamports);
      let peak = net;
      for (const r of ctx.history) {
        if (
          r.mint === p.mint &&
          r.at >= p.openedAt &&
          quoteValid(r.sell, r.at, raw(p.quantityRaw), limits.maxQuoteAgeMs)
        ) {
          const mark = raw(r.sell!.outputRaw) - raw(r.sell!.networkFeeLamports);
          if (mark > peak) peak = mark;
        }
      }
      const reasons: string[] = [];
      if (flag(ctx, "killSwitch") === true) reasons.push("GLOBAL_KILL_SWITCH_EXIT");
      if (ctx.now - p.openedAt >= config.exits.maximumHoldMs) reasons.push("MAXIMUM_HOLD_TIME");
      if (net * 10_000n <= cost * BigInt(10_000 - config.exits.stopLossBps))
        reasons.push("STOP_LOSS");
      if (peak > cost && net * 10_000n <= peak * BigInt(10_000 - config.exits.trailingStopBps))
        reasons.push("TRAILING_STOP");
      if (net * 10_000n >= cost * BigInt(10_000 + config.exits.takeProfitBps))
        reasons.push("TAKE_PROFIT");
      const featureAt = value(ctx, "featuresObservedAt");
      if (
        featureAt != null &&
        featureAt <= ctx.now &&
        ctx.now - featureAt <= config.maxFeatureAgeMs
      ) {
        if (
          flag(ctx, "creatorSelling") === true ||
          (value(ctx, "sellerConcentrationBps") ?? 0) >= config.exits.concentratedSellingBps
        )
          reasons.push("CONCENTRATED_SELLING");
        if (
          value(ctx, "imbalance") != null &&
          value(ctx, "imbalance")! <= config.exits.momentumExitImbalance
        )
          reasons.push("MOMENTUM_DETERIORATION");
      }
      return {
        action: reasons.length ? "exit" : "hold",
        reasons: reasons.length ? reasons : ["EXIT_LIMITS_NOT_TRIGGERED"],
      };
    }
    const signal = entrySignals(ctx, raw(config.entryLamports)),
      reasons = signal.reasons;
    const guard = portfolioGuard(ctx, {
      amountLamports: config.entryLamports,
      decisionAt: ctx.now,
    });
    if (!guard.allowed) reasons.push(...guard.reasons);
    return {
      action: reasons.length ? "reject" : "enter",
      reasons: reasons.length
        ? [...new Set(reasons)]
        : [
            `FROZEN_CONFIG:${config.id}`,
            `STRATEGY:${signal.selected}`,
            "FINAL_FILL_RECHECK_REQUIRED",
          ],
      amountLamports: config.entryLamports,
    };
  };
  return Object.assign(evaluate, { fillGuard, configurationHash, configuration: config });
}

/** Convert persisted, verified snapshots; raw transactions alone never invent historical quotes. */
export function replayObservationFromSnapshot(input: {
  event: { id: string; mint: string; signature: string; slot: number; receivedAt: number };
  snapshotAt?: number;
  regime: string;
  features: Record<string, number | null>;
  buy?: ReplayQuote;
  sell?: ReplayQuote;
}): ReplayObservation {
  if (
    !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(input.event.signature) ||
    !Number.isSafeInteger(input.event.slot) ||
    input.event.slot < 0 ||
    !Number.isFinite(input.event.receivedAt)
  )
    throw Error("INVALID_RECORDED_SNAPSHOT_PROVENANCE");
  const snapshotAt = input.snapshotAt ?? input.event.receivedAt;
  if (!Number.isFinite(snapshotAt) || snapshotAt < input.event.receivedAt)
    throw Error("SNAPSHOT_PRECEDES_SOURCE_RECEIPT");
  for (const q of [input.buy, input.sell])
    if (q && (q.observedAt > snapshotAt || q.observedAt < 0))
      throw Error("FUTURE_QUOTE_IN_RECORDED_SNAPSHOT");
  for (const [name, value] of Object.entries(input.features))
    if (value !== null && !Number.isFinite(value)) throw Error(`INVALID_RECORDED_FEATURE:${name}`);
  return structuredClone({
    id: input.event.id,
    mint: input.event.mint,
    signature: input.event.signature,
    slot: input.event.slot,
    at: snapshotAt,
    regime: input.regime,
    features: input.features,
    ...(input.buy ? { buy: input.buy } : {}),
    ...(input.sell ? { sell: input.sell } : {}),
  });
}

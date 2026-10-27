import { describe, it, expect } from "vitest";
import {
  createReplayStrategy,
  researchReplayConfiguration,
  replayConfigurationHash,
  replayObservationFromSnapshot,
  flattenReplayFeatures,
  REPLAY_FEATURE_CONTRACT,
} from "../src/replay-strategy.ts";
import {
  replay,
  type ReplayContext,
  type ReplayObservation,
  type ReplayOptions,
  type ReplayPosition,
} from "../src/replay.ts";
import type { StrategyId, SignalFeatures } from "../src/intelligence.ts";
import type { TokenSafetyEvidence } from "../src/risk.ts";
// Entirely synthetic fixtures: these values are never published as observed market data.
const features = (at = 1000) => ({
  featuresObservedAt: at,
  securityObservedAt: at,
  observations: 8,
  verifiedLaunchAgeMs: 10_000,
  imbalance: 0.6,
  uniqueBuyers: 10,
  independentBuyerUnits: 8,
  uniqueBuyerAcceleration: 4,
  priceVelocityBps: 200,
  priceAccelerationBps: 100,
  drawdownFromPeakBps: 1500,
  netInflowLamports: 30_000_000,
  sellerConcentrationBps: 1000,
  organicScore: 80,
  smartBuyers: 2,
  creatorSelling: 0,
  creatorPriorLaunches: 0,
  creatorPriorAdverseOutcomes: 0,
  liquidityLamports: 30_000_000_000,
  liquidityGrowing: 1,
  curveProgressBps: 3000,
  executionCostBps: 60,
  mintAuthorityRevoked: 1,
  freezeAuthorityRevoked: 1,
  tokenProgram: 1,
  extensionsVerified: 1,
  unsupportedExtensionCount: 0,
  transferFeeBps: 0,
  permanentDelegateAbsent: 1,
  transferRestricted: 0,
  creatorConcentrationBps: 500,
  creatorAssociationsVerified: 1,
  creatorAssociatedConcentrationBps: 500,
  topHolderConcentrationBps: 1500,
  knownMalicious: 0,
  sellRouteAvailable: 1,
  sellRouteObservedAt: at,
  liquidityAccessible: 1,
  slippageBps: 100,
  consecutiveFailures: 0,
  killSwitch: 0,
});
const row = (id: string, at = 1000, sell = "10000000"): ReplayObservation => ({
  id,
  mint: "fixture-mint",
  at,
  regime: "trend",
  features: features(at),
  buy: {
    observedAt: at,
    inputRaw: "10000000",
    outputRaw: "1000",
    networkFeeLamports: "10000",
    priceImpactBps: 50,
  },
  sell: {
    observedAt: at,
    inputRaw: "1000",
    outputRaw: sell,
    networkFeeLamports: "10000",
    priceImpactBps: 50,
  },
});
const ctx = (
  current: ReplayObservation,
  position: ReplayPosition | null = null,
  history: ReplayObservation[] = [current],
): ReplayContext => ({
  now: current.at,
  current,
  position,
  history,
  cashLamports: "1000000000",
  portfolio: {
    positions: position ? [position] : [],
    trades: [],
    initialCapitalLamports: "1000000000",
    equityLamports: "1000000000",
    peakEquityLamports: "1000000000",
  },
});
const opts: ReplayOptions = {
  strategy: "launch_sniper",
  initialCapitalLamports: "1000000000",
  minimumLatencyMs: 100,
  maxQuoteAgeMs: 5000,
  maxImpactBps: 200,
  fixtureKind: "synthetic-fixture",
};
describe("frozen point-in-time strategy adapter", () => {
  it("does not renew recorded security freshness through later publication during replay", () => {
    const r = row("long-security-inspection", 40000);
    r.features = { ...r.features, securityEvidenceRequestedAt: 1000 };
    const result = createReplayStrategy(researchReplayConfiguration("launch_sniper", 0))(ctx(r));
    expect(result.action).toBe("reject");
    expect(result.reasons).toContain("SECURITY_EVIDENCE_STALE_OR_FUTURE");
  });
  for (const strategy of [
    "launch_sniper",
    "momentum_breakout",
    "early_reversal",
    "smart_wallet_confirmation",
  ] as StrategyId[])
    it(`${strategy} can enter on complete verified evidence`, () => {
      const evaluate = createReplayStrategy(researchReplayConfiguration(strategy, 0));
      expect(evaluate(ctx(row("a"))).action).toBe("enter");
    });
  it("does not replace missing security evidence with safe defaults", () => {
    const r = row("a");
    delete (r.features as Record<string, number>).mintAuthorityRevoked;
    const decision = createReplayStrategy(researchReplayConfiguration("launch_sniper", 0))(ctx(r));
    expect(decision.action).toBe("reject");
    expect(decision.reasons).toContain("MINT_AUTHORITY_UNKNOWN");
  });
  it.each([
    "missing-flag",
    "partial-coverage",
    "missing-associated-value",
    "excessive-associated-value",
  ] as const)("rejects %s creator association evidence despite safe direct holdings", (kind) => {
    const r = row("association");
    const recorded: Record<string, number | null> = { ...r.features, creatorConcentrationBps: 0 };
    if (kind === "missing-flag") delete recorded.creatorAssociationsVerified;
    if (kind === "partial-coverage") recorded.creatorAssociationsVerified = 0;
    if (kind === "missing-associated-value") delete recorded.creatorAssociatedConcentrationBps;
    if (kind === "excessive-associated-value") recorded.creatorAssociatedConcentrationBps = 1001;
    r.features = recorded;
    const result = createReplayStrategy(researchReplayConfiguration("launch_sniper", 0))(ctx(r));
    expect(result.action).toBe("reject");
    expect(result.reasons.some((reason) => reason.startsWith("CREATOR_ASSOCIAT"))).toBe(true);
  });
  it("rejects missing signal and future frozen configurations", () => {
    const r = row("a");
    delete (r.features as Record<string, number>).organicScore;
    const result = createReplayStrategy(researchReplayConfiguration("launch_sniper", 1001))(ctx(r));
    expect(result.action).toBe("reject");
    expect(result.reasons).toContain("FEATURE_UNAVAILABLE:organicScore");
    expect(result.reasons).toContain("CONFIGURATION_NOT_FROZEN_BEFORE_OBSERVATION");
  });
  it("rechecks security at delayed fill and vetoes deterioration", () => {
    const r = row("b", 1100);
    r.features = { ...r.features, knownMalicious: 1 };
    const evaluate = createReplayStrategy(researchReplayConfiguration("launch_sniper", 0));
    const report = replay([row("a"), r], evaluate, { ...opts, fillGuard: evaluate.fillGuard });
    expect(report.unresolvedPositions).toHaveLength(0);
    expect(report.decisions.some((d) => d.reasons.includes("MALICIOUS_CONFIGURATION"))).toBe(true);
  });
  it("rechecks the unchanged 150bps strategy cap when current captured cost rises to 151bps", () => {
    const later = row("fill", 1100);
    later.features = { ...later.features, executionCostBps: 151 };
    const evaluate = createReplayStrategy(researchReplayConfiguration("launch_sniper", 0));
    expect(evaluate(ctx(row("decision"))).action).toBe("enter");
    const report = replay([row("decision"), later], evaluate, {
      ...opts,
      fillGuard: evaluate.fillGuard,
    });
    expect(report.unresolvedPositions).toEqual([]);
    expect(report.cashLamports).toBe(opts.initialCapitalLamports);
    expect(
      report.decisions.some((d) => d.at === 1100 && d.reasons.includes("COST_BUDGET_EXCEEDED")),
    ).toBe(true);
  });
  it.each([
    ["9869999", "10000", "10000"],
    ["9879999", "5000", "25000"],
  ])(
    "vetoes legacy rounded150bps using exact paired proceeds %s and captured per-leg fees",
    (proceeds, buyFee, sellFee) => {
      const later = row("fill", 1100, proceeds);
      later.features = { ...later.features, executionCostBps: 150 };
      later.buy!.networkFeeLamports = buyFee;
      later.sell!.networkFeeLamports = sellFee;
      const evaluate = createReplayStrategy(researchReplayConfiguration("launch_sniper", 0));
      const report = replay([row("decision"), later], evaluate, {
        ...opts,
        fillGuard: evaluate.fillGuard,
      });
      expect(report.unresolvedPositions).toEqual([]);
      expect(report.cashLamports).toBe(opts.initialCapitalLamports);
      expect(
        report.decisions.some((d) => d.at === 1100 && d.reasons.includes("COST_BUDGET_EXCEEDED")),
      ).toBe(true);
    },
  );
  it("permits exact150bps equality with a valid delayed paired quote", () => {
    const later = row("fill", 1100, "9870000");
    later.features = { ...later.features, executionCostBps: 150 };
    const evaluate = createReplayStrategy(researchReplayConfiguration("launch_sniper", 0));
    const report = replay([row("decision"), later], evaluate, {
      ...opts,
      fillGuard: evaluate.fillGuard,
    });
    expect(report.unresolvedPositions).toHaveLength(1);
    expect(report.unresolvedPositions[0].openedAt).toBe(1100);
    expect(report.cashLamports).toBe("989990000");
  });
  it.each([
    "missing-sell",
    "mismatched-input",
    "pre-buy-sell",
    "pre-buy-request",
    "stale-pair",
    "future-sell",
    "invalid-fee",
    "missing-cost-feature",
  ] as const)("fails closed for %s current cost evidence at delayed fill", (fault) => {
    const later = row("fill", 1100);
    if (fault === "missing-sell") delete later.sell;
    if (fault === "mismatched-input") later.sell!.inputRaw = "999";
    if (fault === "pre-buy-sell") later.sell!.observedAt = 1099;
    if (fault === "pre-buy-request") later.sell!.requestedAt = 1099;
    if (fault === "stale-pair") {
      later.at = 6100;
      later.features = features(6100);
      later.buy!.observedAt = 0;
      later.sell!.observedAt = 0;
    }
    if (fault === "future-sell") later.sell!.observedAt = 1101;
    if (fault === "invalid-fee") later.sell!.networkFeeLamports = "-1";
    if (fault === "missing-cost-feature") {
      const features: Record<string, number | null> = { ...later.features };
      delete features.executionCostBps;
      later.features = features;
    }
    const evaluate = createReplayStrategy(researchReplayConfiguration("launch_sniper", 0));
    const guard = evaluate.fillGuard(ctx(later), { amountLamports: "10000000", decisionAt: 1000 });
    expect(guard.allowed).toBe(false);
    expect(guard.reasons).toContain(
      fault === "missing-cost-feature"
        ? "FEATURE_UNAVAILABLE:executionCostBps"
        : "EXACT_SIZE_ROUND_TRIP_COST_UNAVAILABLE",
    );
  });
  it.each([
    ["launch_sniper", "independentBuyerUnits", 4, "INSUFFICIENT_INDEPENDENT_BUYERS"],
    ["launch_sniper", "organicScore", null, "FEATURE_UNAVAILABLE:organicScore"],
    ["launch_sniper", "uniqueBuyerAcceleration", 0, "BUYER_ACCELERATION_REQUIRED"],
    ["launch_sniper", "verifiedLaunchAgeMs", 120001, "VERIFIED_RECENT_LAUNCH_REQUIRED"],
    ["momentum_breakout", "liquidityGrowing", 0, "GROWING_LIQUIDITY_REQUIRED"],
    ["early_reversal", "priceAccelerationBps", 0, "PRICE_RECOVERY_REQUIRED"],
    [
      "smart_wallet_confirmation",
      "smartBuyers",
      1,
      "TWO_OUT_OF_SAMPLE_SUCCESSFUL_WALLETS_REQUIRED",
    ],
  ] as const)(
    "rechecks %s signal %s before settling a delayed entry",
    (strategy, feature, value, reason) => {
      const later = row("fill", 1100);
      later.features = { ...later.features, [feature]: value };
      const evaluate = createReplayStrategy(researchReplayConfiguration(strategy, 0));
      expect(evaluate(ctx(row("decision"))).action).toBe("enter");
      const report = replay([row("decision"), later], evaluate, {
        ...opts,
        strategy,
        fillGuard: evaluate.fillGuard,
      });
      expect(report.unresolvedPositions).toEqual([]);
      expect(report.cashLamports).toBe(opts.initialCapitalLamports);
      expect(report.decisions.some((d) => d.at === 1100 && d.reasons.includes(reason))).toBe(true);
    },
  );
  it("rechecks adaptive validated coverage for the current regime at delayed fill", () => {
    const config = researchReplayConfiguration("launch_sniper", 0);
    config.strategy = "adaptive";
    config.validated = [
      {
        id: "synthetic-approved",
        strategy: "launch_sniper",
        regime: "trend",
        validatedAt: 500,
        trainingEndsAt: 100,
        validationStartsAt: 200,
        validationEndsAt: 400,
        validationTrades: 30,
        outOfSampleNetLamports: "100",
        outOfSampleMaxDrawdownBps: 100,
        configurationHash: replayConfigurationHash({ ...config, strategy: "launch_sniper" }),
        validationArtifactHash: "a".repeat(64),
        approved: true,
      },
    ];
    const evaluate = createReplayStrategy(config),
      later = row("fill", 1100);
    later.regime = "unvalidated-regime";
    expect(evaluate(ctx(row("decision"))).action).toBe("enter");
    const report = replay([row("decision"), later], evaluate, {
      ...opts,
      fillGuard: evaluate.fillGuard,
    });
    expect(report.unresolvedPositions).toEqual([]);
    expect(
      report.decisions.some(
        (d) =>
          d.at === 1100 &&
          d.reasons.includes("NO_PREVALIDATED_CONFIGURATION_FOR_REGIME_STAND_DOWN"),
      ),
    ).toBe(true);
  });
  it("runs entry, quote-valued take profit, delayed exit and exact P&L end to end", () => {
    const evaluate = createReplayStrategy(researchReplayConfiguration("launch_sniper", 0));
    const report = replay(
      [row("a", 1000), row("b", 1100, "16000000"), row("c", 1200, "15000000")],
      evaluate,
      { ...opts, fillGuard: evaluate.fillGuard },
    );
    expect(report.trades).toHaveLength(1);
    expect(report.trades[0]).toMatchObject({
      exitReason: "TAKE_PROFIT",
      pnlLamports: "4980000",
      entryLatencyMs: 100,
      exitLatencyMs: 100,
    });
  });
  it("applies final portfolio risk limits across concurrent inventories", () => {
    const current = row("a");
    const context = ctx(current);
    context.portfolio = {
      ...context.portfolio!,
      positions: Array.from({ length: 3 }, (_, i) => ({
        id: String(i),
        mint: String(i),
        strategy: "fixture",
        regime: "trend",
        quantityRaw: "1",
        costLamports: "1000000",
        entryFeeLamports: "1",
        openedAt: 1,
        decisionAt: 0,
      })),
    };
    const result = createReplayStrategy(researchReplayConfiguration("launch_sniper", 0))(context);
    expect(result.action).toBe("reject");
    expect(result.reasons).toContain("MAX_SIMULTANEOUS_POSITIONS");
  });
  it("uses executable quotes for stop loss, trailing stop, and maximum holding time", () => {
    const evaluate = createReplayStrategy(researchReplayConfiguration("launch_sniper", 0));
    const p: ReplayPosition = {
      id: "p",
      mint: "fixture-mint",
      strategy: "fixture",
      regime: "trend",
      quantityRaw: "1000",
      costLamports: "10000000",
      entryFeeLamports: "10000",
      openedAt: 1000,
      decisionAt: 900,
    };
    expect(evaluate(ctx(row("a", 1200, "8000000"), p)).reasons).toContain("STOP_LOSS");
    expect(
      evaluate(
        ctx(row("c", 1300, "12000000"), p, [
          row("b", 1100, "14000000"),
          row("c", 1300, "12000000"),
        ]),
      ).reasons,
    ).toContain("TRAILING_STOP");
    expect(evaluate(ctx(row("d", 302000, "10000000"), p)).reasons).toContain("MAXIMUM_HOLD_TIME");
    const missing = row("e", 302000);
    delete missing.sell;
    expect(evaluate(ctx(missing, p))).toMatchObject({
      action: "hold",
      reasons: ["EXIT_QUOTE_UNAVAILABLE_POSITION_UNRESOLVED"],
    });
  });
  it("keeps adaptive selection locked without completed validation artifacts", () => {
    const config = researchReplayConfiguration("launch_sniper", 0);
    config.strategy = "adaptive";
    expect(createReplayStrategy(config)(ctx(row("a"))).reasons).toContain(
      "NO_PREVALIDATED_CONFIGURATION_FOR_REGIME_STAND_DOWN",
    );
  });
  it("validates adaptive configuration hashes without self-referential metadata", () => {
    const config = researchReplayConfiguration("launch_sniper", 0);
    config.strategy = "adaptive";
    config.validated = [
      {
        id: "validated-launch",
        strategy: "launch_sniper",
        regime: "trend",
        validatedAt: 500,
        trainingEndsAt: 100,
        validationStartsAt: 200,
        validationEndsAt: 400,
        validationTrades: 30,
        outOfSampleNetLamports: "100",
        outOfSampleMaxDrawdownBps: 100,
        configurationHash: replayConfigurationHash({ ...config, strategy: "launch_sniper" }),
        validationArtifactHash: "a".repeat(64),
        approved: true,
      },
    ];
    expect(createReplayStrategy(config)(ctx(row("a"))).action).toBe("enter");
    config.validated[0].configurationHash = "b".repeat(64);
    expect(createReplayStrategy(config)(ctx(row("a"))).reasons).toContain(
      "VALIDATION_CONFIGURATION_HASH_MISMATCH",
    );
  });
  it("exports only observed quote snapshots and rejects future quote provenance", () => {
    const r = row("a"),
      event = { id: "a", mint: "fixture", signature: "1".repeat(64), slot: 1, receivedAt: 1000 };
    const exported = replayObservationFromSnapshot({
      event,
      regime: "trend",
      features: {},
      buy: r.buy,
    });
    expect(exported.buy?.outputRaw).toBe("1000");
    expect(() =>
      replayObservationFromSnapshot({
        event,
        regime: "trend",
        features: {},
        buy: { ...r.buy!, observedAt: 1001 },
      }),
    ).toThrow("FUTURE_QUOTE");
  });
  it.each([
    { snapshotCapturedAt: 2000 },
    { snapshotCapturedAt: null },
    { snapshotCapturedAt: 999 },
    { snapshotCapturedAt: 1000.5 },
    { snapshotCapturedAt: 1000, securityObservedAt: 1001 },
  ])(
    "rejects unavailable or inconsistent capture timing at export and direct strategy boundaries %#",
    (patch) => {
      const r = row("capture"),
        event = {
          id: "capture",
          mint: r.mint,
          signature: "1".repeat(64),
          slot: 1,
          receivedAt: 1000,
        };
    r.features = { ...r.features, ...(patch as Record<string, number | null>) };
      expect(() =>
        replayObservationFromSnapshot({
          event,
          snapshotAt: 1000,
          regime: "trend",
          features: { ...r.features },
        }),
      ).toThrow("CAPTURE_TIMING");
      const result = createReplayStrategy(researchReplayConfiguration("launch_sniper", 0))(ctx(r));
      expect(result.action).toBe("reject");
      expect(result.reasons).toContain("FEATURE_CAPTURE_TIMING_INVALID");
    },
  );
  it("accepts capture exactly at availability and does not invent missing legacy capture time", () => {
    const r = row("capture-boundary"),
      evaluate = createReplayStrategy(researchReplayConfiguration("launch_sniper", 0));
    expect(evaluate(ctx(r)).action).toBe("enter");
    r.features = { ...r.features, snapshotCapturedAt: 1000 };
    expect(evaluate(ctx(r)).action).toBe("enter");
    const event = {
      id: "capture",
      mint: r.mint,
      signature: "1".repeat(64),
      slot: 1,
      receivedAt: 1000,
    };
    expect(
      replayObservationFromSnapshot({
        event,
        snapshotAt: 1000,
        regime: "trend",
        features: { ...r.features },
      }).features.snapshotCapturedAt,
    ).toBe(1000);
  });
});
describe("durable replay feature capture", () => {
  const signal: SignalFeatures = {
    asOf: 1000,
    mint: "fixture",
    observations: 4,
    verifiedLaunchAgeMs: 100,
    imbalance: 0.5,
    uniqueBuyers: 5,
    uniqueBuyerAcceleration: 2,
    priceVelocityBps: 100,
    priceAccelerationBps: null,
    drawdownFromPeakBps: 0,
    netInflowLamports: 1_000_000n,
    sellerConcentrationBps: null,
    organic: {
      score: 50,
      confidence: "low",
      independentBuyerUnits: 5,
      uniqueBuyers: 5,
      clusteredBuyers: 0,
      creatorAssociatedBuyers: 0,
      effectiveBuyVolume: 1_000_000n,
      evidence: ["synthetic fixture"],
    },
    smartBuyers: 0,
    creatorSelling: false,
    creatorPriorLaunches: 0,
    creatorPriorAdverseOutcomes: 0,
    liquidityLamports: 100_000_000_000n,
    liquidityGrowing: null,
    curveProgressBps: null,
    executionCostBps: 100,
  };
  const safety: TokenSafetyEvidence = {
    mint: "fixture",
    observedAt: 1100,
    mintAuthority: null,
    freezeAuthority: undefined,
    tokenProgram: "token-2022",
    extensionsVerified: true,
    extensions: ["MetadataPointer", "TokenMetadata"],
    transferFeeBps: 0,
    permanentDelegate: undefined,
    transferRestricted: null,
    creatorConcentrationBps: null,
    topHolderConcentrationBps: 1000,
    knownMalicious: null,
    sellRouteAvailable: true,
    sellRouteObservedAt: 1100,
    liquidityAccessible: null,
    abnormalCreatorActivity: null,
  };
  const risk = { now: 1200, killSwitch: false, consecutiveFailures: 0, slippageBps: 100 };
  it("preserves the original security request anchor without retimestamping publication", () => {
    const f = flattenReplayFeatures(signal, { ...safety, evidenceRequestedAt: 900 }, risk);
    expect(f.securityEvidenceRequestedAt).toBe(900);
    expect(f.securityObservedAt).toBe(1100);
    expect(flattenReplayFeatures(signal, safety, risk)).not.toHaveProperty("securityEvidenceRequestedAt");
  });
  it.each([null, -1, 1101, NaN, Infinity, 1.5])("rejects malformed replay security request anchor %s", (anchor) => {
    expect(() => flattenReplayFeatures(signal, { ...safety, evidenceRequestedAt: anchor } as unknown as TokenSafetyEvidence, risk)).toThrow("REQUEST_ANCHOR");
  });
  it("preserves the source feature time separately from capture and unknown safety flags", () => {
    const f = flattenReplayFeatures(signal, safety, risk);
    expect(f.featuresObservedAt).toBe(1000);
    expect(f.snapshotCapturedAt).toBe(1200);
    expect(f.securityObservedAt).toBe(1100);
    expect(f.mintAuthorityRevoked).toBe(1);
    expect(f.freezeAuthorityRevoked).toBeNull();
    expect(f.permanentDelegateAbsent).toBeNull();
    expect(f.knownMalicious).toBeNull();
    expect(f.creatorSelling).toBeNull();
    expect(f.killSwitch).toBe(0);
    for (const key of [...REPLAY_FEATURE_CONTRACT.signals, ...REPLAY_FEATURE_CONTRACT.safety])
      expect(key in f).toBe(true);
    expect(f.creatorAssociationsVerified).toBeNull();
    expect(f.creatorAssociatedConcentrationBps).toBeNull();
  });
  it("retains explicit partial coverage as false instead of relabeling it complete", () => {
    const f = flattenReplayFeatures(
      signal,
      {
        ...safety,
        creatorConcentrationBps: 0,
        creatorAssociationsVerified: false,
        creatorAssociatedConcentrationBps: null,
      },
      risk,
    );
    expect(f.creatorAssociationsVerified).toBe(0);
    expect(f.creatorAssociatedConcentrationBps).toBeNull();
    const complete = flattenReplayFeatures(
      signal,
      { ...safety, creatorAssociationsVerified: true, creatorAssociatedConcentrationBps: 200 },
      risk,
    );
    expect(complete.creatorAssociationsVerified).toBe(1);
    expect(complete.creatorAssociatedConcentrationBps).toBe(200);
  });
  it("refuses lossy bigint conversions instead of manufacturing approximate evidence", () => {
    const unsafe = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    const f = flattenReplayFeatures(
      {
        ...signal,
        netInflowLamports: -unsafe,
        liquidityLamports: unsafe,
        organic: { ...signal.organic, effectiveBuyVolume: unsafe },
      },
      safety,
      risk,
    );
    expect(f.netInflowLamports).toBeNull();
    expect(f.liquidityLamports).toBeNull();
    expect(f.effectiveBuyVolumeLamports).toBeNull();
    expect(
      flattenReplayFeatures(
        { ...signal, liquidityLamports: BigInt(Number.MAX_SAFE_INTEGER) },
        safety,
        risk,
      ).liquidityLamports,
    ).toBe(Number.MAX_SAFE_INTEGER);
  });
  it("counts only unapproved extensions and does not invent extension verification", () => {
    expect(flattenReplayFeatures(signal, safety, risk).unsupportedExtensionCount).toBe(0);
    expect(
      flattenReplayFeatures(
        signal,
        { ...safety, extensions: ["TransferHook", "TokenMetadata"] },
        risk,
      ).unsupportedExtensionCount,
    ).toBe(1);
    expect(
      flattenReplayFeatures(signal, { ...safety, extensionsVerified: false }, risk)
        .unsupportedExtensionCount,
    ).toBeNull();
  });
  it("rejects future evidence and mixed mint snapshots", () => {
    expect(() => flattenReplayFeatures({ ...signal, asOf: 1201 }, safety, risk)).toThrow(
      "FUTURE_EVIDENCE",
    );
    expect(() => flattenReplayFeatures(signal, { ...safety, mint: "different" }, risk)).toThrow(
      "MINT_MISMATCH",
    );
  });
  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid source/capture timestamps %s",
    (at) => {
      expect(() => flattenReplayFeatures({ ...signal, asOf: at }, safety, risk)).toThrow(
        "TIMESTAMPS",
      );
      expect(() => flattenReplayFeatures(signal, { ...safety, observedAt: at }, risk)).toThrow(
        "TIMESTAMPS",
      );
      expect(() => flattenReplayFeatures(signal, safety, { ...risk, now: at })).toThrow(
        "TIMESTAMPS",
      );
    },
  );
  it("does not admit an old signal merely because quotes and security were captured recently", () => {
    const now = 1_000_000,
      r = row("stale-signal", now),
      complete = features(now);
    const f = flattenReplayFeatures(
      { ...signal, asOf: 1000 },
      { ...safety, observedAt: now },
      { ...risk, now },
    );
    // All other evidence is deliberately fresh and otherwise passes the policy.
    // Changing only the feature-source time must switch admission to rejection.
    const evaluate = createReplayStrategy(researchReplayConfiguration("launch_sniper", 0));
    expect(evaluate(ctx(r)).action).toBe("enter");
    r.features = {
      ...complete,
      featuresObservedAt: f.featuresObservedAt,
      snapshotCapturedAt: f.snapshotCapturedAt,
    };
    const result = evaluate(ctx(r));
    expect(result.action).toBe("reject");
    expect(result.reasons).toContain("FEATURES_UNRECORDED_STALE_OR_FUTURE");
  });
});

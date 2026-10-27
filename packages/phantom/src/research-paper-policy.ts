import { createHash } from "node:crypto";
import { evaluateStrategies, type SignalFeatures } from "./intelligence.ts";
import { checkTokenSafety, type SafetyVerdict, type TokenSafetyEvidence } from "./risk.ts";
import { WSOL } from "./types.ts";
import { conservativeCostBps } from "./costs.ts";

/** Offline engineering policy only: no provider, ledger, credentials or execution. */
const FIXED = {
  kind: "RESEARCH_PAPER_POLICY_V1",
  version: 1,
  strategy: "momentum_breakout",
  associationScope: "UNKNOWN_ASSOCIATIONS_ACCEPTED_FOR_PAPER",
  strictPolicyEligible: false,
  liveApproved: false,
  entryLamports: "10000000",
  initialCapitalLamports: "1000000000",
  maximumPositions: 1,
  minimumLiquidityLamports: "20000000000",
  maximumExecutionCostBps: 150,
  sourceUniverse: "LEGACY_SPL_SOL_PAIRS_JUPITER_AGGREGATOR_QUOTES",
  tokenProgram: "spl-token",
  requiredExtensions: [],
  quoteSource: "JUPITER",
  allowedRouters: ["metis", "dflow", "okx"],
  networkFeePerLegLamports: "10000",
  networkFeeScope: "EXPLICIT_MODEL_NOT_MEASURED",
  slippageBps: 25,
  minimumEntryDelayMs: 2000,
  maximumQuoteAgeMs: 5000,
  maximumDecisionAgeMs: 30000,
  safetyPolicy: {
    maxAgeMs: 30000,
    maxTransferFeeBps: 0,
    maxCreatorConcentrationBps: 1000,
    maxTopHolderConcentrationBps: 3500,
    allowedExtensions: ["MetadataPointer", "TokenMetadata", "ImmutableOwner"],
  },
  strategyRules: {
    minimumIndependentBuyers: 5,
    minimumOrganicScore: 40,
    minimumImbalance: 0.2,
    minimumVelocityBps: 100,
    reversalDrawdownBps: 1000,
    maximumLaunchAgeMs: 120000,
  },
} as const;

export type ResearchPaperPolicy = typeof FIXED &
  Readonly<{
    sourceHash: string;
    frozenAt: number;
    manifestHash: string;
  }>;

function canonical(value: unknown): string {
  if (value === null || ["boolean", "string", "number"].includes(typeof value)) {
    if (typeof value === "number" && !Number.isFinite(value))
      throw Error("RESEARCH_POLICY_VALUE_INVALID");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  throw Error("RESEARCH_POLICY_VALUE_INVALID");
}
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const clock = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const source = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

/** Freeze before observing decisions. There are deliberately no tunable parameters. */
export function freezeResearchPaperPolicy(input: {
  sourceHash: string;
  frozenAt: number;
}): ResearchPaperPolicy {
  if (
    !input ||
    Object.keys(input).sort().join(",") !== "frozenAt,sourceHash" ||
    !source(input.sourceHash) ||
    !clock(input.frozenAt)
  )
    throw Error("RESEARCH_POLICY_SOURCE_OR_CLOCK_INVALID");
  const body = structuredClone({
    ...FIXED,
    sourceHash: input.sourceHash,
    frozenAt: input.frozenAt,
  });
  return immutable({ ...body, manifestHash: hash(body) });
}

/** Saved manifests are accepted only when the entire immutable V1 contract matches. */
export function validateResearchPaperPolicy(value: unknown): ResearchPaperPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("RESEARCH_POLICY_INVALID");
  const p = value as Record<string, unknown>;
  if (!source(p.sourceHash) || !clock(p.frozenAt))
    throw Error("RESEARCH_POLICY_SOURCE_OR_CLOCK_INVALID");
  const expected = freezeResearchPaperPolicy({ sourceHash: p.sourceHash, frozenAt: p.frozenAt });
  if (canonical(value) !== canonical(expected))
    throw Error("RESEARCH_POLICY_MANIFEST_OR_FIXED_CONFIG_MISMATCH");
  return expected;
}

interface ResearchQuoteOutput {
  inputMint: string;
  outputMint: string;
  requestedAt: number;
  observedAt: number;
  outAmount: string;
  minOutAmount: string;
  slippageBps: number;
  source: "JUPITER";
  router: "metis" | "dflow" | "okx";
  /** Preserve response metadata: a router label cannot hide an RFQ offer. */
  quoteId?: unknown;
  maker?: unknown;
  expireAt?: unknown;
  swapType?: unknown;
}
export interface ResearchPaperDecisionEvidence {
  policyHash: string;
  sourceHash: string;
  /** A caller's durable capture reference, not an authentication attestation. */
  captureId: string;
  sourceObservedAt: number;
  decisionAt: number;
  capturedAt: number;
  initialCapitalLamports: string;
  openPositions: number;
  pendingEntries: number;
  quote: ResearchQuoteOutput & {
    inputLamports: string;
  };
  pairedSell: ResearchQuoteOutput & { inAmount: string };
  features: SignalFeatures;
  security: TokenSafetyEvidence;
}

/** Structurally incompatible with SafetyVerdict: notably there is NO `allowed`. */
export interface ResearchPaperAdmission {
  readonly kind: "OFFLINE_RESEARCH_PAPER_ADMISSION_NOT_EXECUTION";
  readonly allowedForResearch: boolean;
  readonly strictPolicyEligible: false;
  readonly liveApproved: false;
  readonly associationScope: "UNKNOWN_ASSOCIATIONS_ACCEPTED_FOR_PAPER";
  readonly unverifiedAssociatedSupplyUpperBps: 10000;
  readonly policyHash: string;
  readonly sourceHash: string;
  readonly mint: string;
  readonly checkedAt: number;
  readonly expiresAt: number;
  readonly reasons: readonly string[];
  readonly exemptedStrictReasons: readonly string[];
  readonly strictVerdict: Readonly<SafetyVerdict>;
  readonly provenanceScope: "CALLER_SUPPLIED_DECISION_SNAPSHOT_NOT_AUTHENTICATED";
  readonly pricing: Readonly<{
    scope: "SEQUENTIAL_PAIRED_QUOTE_STRESS_WITH_TEMPORAL_DRIFT_NOT_REALIZED_COST";
    computedExecutionCostBps: number | null;
    computedExecutionCostAsOf: number | null;
    reportedExecutionCostBps: number | null;
    reportedExecutionCostAsOf: number;
    reportedCostScope: "ORIGINAL_DECISION_TIME_FEATURE";
    modeledNetworkFeesLamports: string;
    networkFeeScope: "EXPLICIT_MODEL_NOT_MEASURED";
  }>;
  readonly evidence: Readonly<ResearchPaperDecisionEvidence>;
}

/**
 * Evaluate a NEW decision and a subsequent delayed quote against frozen rules.
 * Unknown association coverage is an explicit PAPER exception, not compliance
 * with the strict 10% associated-supply cap. All unknown supply may be associated.
 * Even a passing result neither reserves cash nor validates a fill/transaction.
 * Raw quote arithmetic is checked; provider authenticity and attainability are
 * not. Sequential quote drift is not simultaneous venue friction or a fill.
 * Original decision features are evaluated unchanged. Their earlier cost and
 * the new delayed pair's independently computed cost must each pass the cap;
 * they need not coincide. A later quote must never rewrite an earlier feature.
 * Populated RFQ metadata is unsupported on either leg; no deadline is parsed.
 * Capacity describes a new decision before its own entry reservation is made.
 * Invalid manifests throw; validly shaped adverse evidence returns a denial.
 */
export function evaluateResearchPaperAdmission(
  policy: ResearchPaperPolicy,
  evidence: ResearchPaperDecisionEvidence,
  now: number,
): ResearchPaperAdmission {
  const p = validateResearchPaperPolicy(policy);
  if (
    !clock(now) ||
    !evidence ||
    !evidence.quote ||
    !evidence.pairedSell ||
    !evidence.features ||
    !evidence.security ||
    !evidence.features.organic
  )
    throw Error("RESEARCH_DECISION_EVIDENCE_MALFORMED");
  // Work on a detached snapshot; admission must not change if a caller mutates it.
  const e = structuredClone(evidence),
    s = e.security,
    f = e.features,
    sell = e.pairedSell;
  const reasons: string[] = [],
    exempted: string[] = [];
  if (e.policyHash !== p.manifestHash || e.sourceHash !== p.sourceHash)
    reasons.push("RESEARCH_POLICY_OR_SOURCE_MISMATCH");
  if (typeof e.captureId !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(e.captureId))
    reasons.push("RESEARCH_CAPTURE_REFERENCE_INVALID");
  if (
    ![
      e.sourceObservedAt,
      e.decisionAt,
      e.capturedAt,
      e.quote.requestedAt,
      e.quote.observedAt,
      sell.requestedAt,
      sell.observedAt,
      s.observedAt,
      s.sellRouteObservedAt,
      f.asOf,
    ].every(clock) ||
    e.sourceObservedAt <= p.frozenAt ||
    s.observedAt <= p.frozenAt ||
    (s.sellRouteObservedAt ?? 0) <= p.frozenAt ||
    e.sourceObservedAt > e.decisionAt ||
    f.asOf !== e.decisionAt ||
    e.quote.requestedAt < e.decisionAt + p.minimumEntryDelayMs ||
    e.quote.observedAt < e.quote.requestedAt ||
    e.capturedAt < e.quote.observedAt ||
    sell.requestedAt < e.quote.observedAt ||
    sell.observedAt < sell.requestedAt ||
    sell.observedAt > e.capturedAt ||
    s.observedAt > e.capturedAt ||
    (s.sellRouteObservedAt ?? Infinity) > e.capturedAt ||
    e.capturedAt > now ||
    now - e.decisionAt > p.maximumDecisionAgeMs ||
    now - e.sourceObservedAt > p.maximumDecisionAgeMs ||
    now - e.quote.requestedAt > p.maximumQuoteAgeMs ||
    now - sell.requestedAt > p.maximumQuoteAgeMs ||
    now - e.quote.observedAt > p.maximumQuoteAgeMs ||
    now - sell.observedAt > p.maximumQuoteAgeMs
  )
    reasons.push("RESEARCH_EVIDENCE_CLOCK_DELAY_FRESHNESS_OR_HISTORICAL_IMPORT_INVALID");
  if (!s.mint || s.mint === WSOL || s.mint !== f.mint) reasons.push("RESEARCH_MINT_MISMATCH");
  if (
    e.quote.inputMint !== WSOL ||
    e.quote.outputMint !== s.mint ||
    sell.inputMint !== s.mint ||
    sell.outputMint !== WSOL
  )
    reasons.push("RESEARCH_QUOTE_MINT_IDENTITY_MISMATCH");
  if (s.sellRouteObservedAt !== sell.observedAt)
    reasons.push("RESEARCH_SELL_ROUTE_NOT_BOUND_TO_PAIRED_QUOTE");
  if (s.tokenProgram !== p.tokenProgram) reasons.push("RESEARCH_SOURCE_UNIVERSE_UNSUPPORTED");
  // The strict checker is preserved below, including its original verdict.
  // This V1 universe separately requires genuine legacy SPL schema: a legacy
  // mint cannot carry Token-2022 extensions, regardless of the default allowlist.
  const booleanFields = [
    "extensionsVerified",
    "transferRestricted",
    "knownMalicious",
    "sellRouteAvailable",
    "liquidityAccessible",
    "abnormalCreatorActivity",
  ] as const;
  if (booleanFields.some((field) => typeof s[field] !== "boolean"))
    reasons.push("RESEARCH_SECURITY_BOOLEAN_UNKNOWN_OR_INVALID");
  if (
    !Array.isArray(s.extensions) ||
    s.extensions.some(
      (name) => typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name),
    ) ||
    new Set(s.extensions).size !== s.extensions.length
  )
    reasons.push("RESEARCH_SECURITY_EXTENSIONS_MALFORMED");
  if (!Array.isArray(s.extensions) || s.extensions.length !== p.requiredExtensions.length)
    reasons.push("RESEARCH_LEGACY_SPL_EXTENSIONS_UNSUPPORTED");
  for (const quote of [e.quote, sell]) {
    if (
      quote.source !== p.quoteSource ||
      !p.allowedRouters.some((router) => router === quote.router)
    )
      reasons.push("RESEARCH_QUOTE_SOURCE_OR_ROUTER_UNSUPPORTED");
    const populated = (value: unknown) => value !== undefined && value !== null && value !== "";
    const rfqMetadata = [quote.quoteId, quote.maker, quote.expireAt].some(populated);
    const rfqType =
      typeof quote.swapType === "string" &&
      quote.swapType
        .toLowerCase()
        .split("+")
        .some((part) => part.trim() === "rfq");
    if (rfqMetadata || rfqType || (populated(quote.swapType) && typeof quote.swapType !== "string"))
      reasons.push("RESEARCH_QUOTE_RFQ_METADATA_UNSUPPORTED");
  }
  if (
    e.quote.inputLamports !== p.entryLamports ||
    e.initialCapitalLamports !== p.initialCapitalLamports
  )
    reasons.push("RESEARCH_FROZEN_AMOUNT_OR_INITIAL_CAPITAL_MISMATCH");
  if (e.quote.slippageBps !== p.slippageBps || sell.slippageBps !== p.slippageBps)
    reasons.push("RESEARCH_FROZEN_SLIPPAGE_MISMATCH");
  const positiveRaw = (value: unknown): bigint | null => {
    if (typeof value !== "string" || value.length > 20 || !/^[1-9][0-9]*$/.test(value)) return null;
    const n = BigInt(value);
    return n <= (1n << 64n) - 1n ? n : null;
  };
  const buyIn = positiveRaw(e.quote.inputLamports),
    buyOut = positiveRaw(e.quote.outAmount),
    buyMin = positiveRaw(e.quote.minOutAmount),
    sellIn = positiveRaw(sell.inAmount),
    sellOut = positiveRaw(sell.outAmount),
    sellMin = positiveRaw(sell.minOutAmount);
  let computedCost: number | null = null;
  const modeledNetworkFees = 2n * BigInt(p.networkFeePerLegLamports);
  if (
    buyIn === null ||
    buyOut === null ||
    buyMin === null ||
    sellIn === null ||
    sellOut === null ||
    sellMin === null ||
    buyMin > buyOut ||
    sellMin > sellOut ||
    buyMin < (buyOut * BigInt(10000 - p.slippageBps)) / 10000n ||
    sellMin < (sellOut * BigInt(10000 - p.slippageBps)) / 10000n
  ) {
    reasons.push("RESEARCH_QUOTE_RAW_AMOUNT_OR_MINIMUM_INVALID");
  } else if (sellIn !== buyMin) {
    reasons.push("RESEARCH_PAIRED_SELL_EXACT_QUANTITY_MISMATCH");
  } else {
    computedCost = conservativeCostBps(BigInt(p.entryLamports), sellMin, modeledNetworkFees);
    if (computedCost > p.maximumExecutionCostBps)
      reasons.push("RESEARCH_PAIRED_COST_BUDGET_EXCEEDED");
  }
  if (
    ![e.openPositions, e.pendingEntries].every((n) => Number.isSafeInteger(n) && n >= 0) ||
    e.openPositions + e.pendingEntries >= p.maximumPositions
  )
    reasons.push("RESEARCH_POSITION_CAPACITY_UNAVAILABLE");
  const signalNumbers = [
    f.observations,
    f.organic.independentBuyerUnits,
    f.organic.score,
    f.imbalance,
    f.uniqueBuyerAcceleration,
    f.priceVelocityBps,
    f.executionCostBps,
  ];
  if (
    !signalNumbers.every((n) => typeof n === "number" && Number.isFinite(n)) ||
    !Number.isSafeInteger(f.observations) ||
    !Number.isSafeInteger(f.organic.independentBuyerUnits) ||
    !Number.isSafeInteger(f.uniqueBuyerAcceleration) ||
    typeof f.creatorSelling !== "boolean" ||
    !Number.isSafeInteger(f.creatorPriorAdverseOutcomes) ||
    f.creatorPriorAdverseOutcomes < 0 ||
    f.observations < 0 ||
    f.organic.independentBuyerUnits < 0 ||
    f.organic.score < 0 ||
    f.organic.score > 100 ||
    (f.imbalance ?? -2) < -1 ||
    (f.imbalance ?? 2) > 1 ||
    (f.executionCostBps ?? -1) < 0 ||
    typeof f.netInflowLamports !== "bigint" ||
    typeof f.liquidityLamports !== "bigint"
  )
    reasons.push("RESEARCH_SIGNAL_VALUES_UNKNOWN_OR_INVALID");
  else {
    const decision = evaluateStrategies(f, {
      ...p.strategyRules,
      minimumLiquidityLamports: BigInt(p.minimumLiquidityLamports),
      maximumCostBps: p.maximumExecutionCostBps,
    }).find((d) => d.strategy === p.strategy)!;
    if (!decision.enter) reasons.push(...decision.reasons);
  }
  if (
    s.creatorAssociationsVerified !== undefined &&
    typeof s.creatorAssociationsVerified !== "boolean"
  )
    reasons.push("RESEARCH_ASSOCIATION_FLAG_INVALID");
  const strictVerdict = checkTokenSafety(
    s,
    {
      ...p.safetyPolicy,
      allowedExtensions: [...p.safetyPolicy.allowedExtensions],
    },
    now,
  );
  for (const reason of strictVerdict.allowed ? [] : strictVerdict.reasons) {
    const unknownCoverage = s.creatorAssociationsVerified !== true;
    const declaredException =
      unknownCoverage &&
      (reason === "CREATOR_ASSOCIATIONS_UNVERIFIED" ||
        (reason === "CREATOR_ASSOCIATED_CONCENTRATION_UNKNOWN_OR_EXCESSIVE" &&
          s.creatorAssociatedConcentrationBps == null));
    if (declaredException) exempted.push(reason);
    else reasons.push(reason);
  }
  return immutable({
    kind: "OFFLINE_RESEARCH_PAPER_ADMISSION_NOT_EXECUTION",
    allowedForResearch: reasons.length === 0,
    strictPolicyEligible: false,
    liveApproved: false,
    associationScope: p.associationScope,
    unverifiedAssociatedSupplyUpperBps: 10000,
    policyHash: p.manifestHash,
    sourceHash: p.sourceHash,
    mint: s.mint,
    checkedAt: now,
    expiresAt: Math.min(
      Number.MAX_SAFE_INTEGER,
      strictVerdict.expiresAt,
      e.sourceObservedAt + p.maximumDecisionAgeMs,
      e.quote.requestedAt + p.maximumQuoteAgeMs,
      sell.requestedAt + p.maximumQuoteAgeMs,
      e.quote.observedAt + p.maximumQuoteAgeMs,
      sell.observedAt + p.maximumQuoteAgeMs,
      e.decisionAt + p.maximumDecisionAgeMs,
    ),
    reasons: [...new Set(reasons)],
    exemptedStrictReasons: exempted,
    strictVerdict,
    provenanceScope: "CALLER_SUPPLIED_DECISION_SNAPSHOT_NOT_AUTHENTICATED",
    pricing: {
      scope: "SEQUENTIAL_PAIRED_QUOTE_STRESS_WITH_TEMPORAL_DRIFT_NOT_REALIZED_COST",
      computedExecutionCostBps: computedCost,
      computedExecutionCostAsOf: computedCost === null ? null : sell.observedAt,
      reportedExecutionCostBps: f.executionCostBps,
      reportedExecutionCostAsOf: f.asOf,
      reportedCostScope: "ORIGINAL_DECISION_TIME_FEATURE",
      modeledNetworkFeesLamports: modeledNetworkFees.toString(),
      networkFeeScope: p.networkFeeScope,
    },
    evidence: e,
  });
}

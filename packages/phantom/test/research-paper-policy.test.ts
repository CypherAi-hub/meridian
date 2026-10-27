/** Synthetic offline policy fixtures only: no market, custody or execution proof. */
import { describe, expect, it } from "vitest";
import {
  evaluateResearchPaperAdmission,
  freezeResearchPaperPolicy,
  validateResearchPaperPolicy,
  type ResearchPaperAdmission,
  type ResearchPaperDecisionEvidence,
} from "../src/research-paper-policy.ts";
import {
  RiskGovernor,
  checkTokenSafety,
  type SafetyVerdict,
  type TokenSafetyEvidence,
} from "../src/risk.ts";
import { WSOL } from "../src/types.ts";

const SOURCE = "a".repeat(64),
  NOW = 100000;
const policy = () => freezeResearchPaperPolicy({ sourceHash: SOURCE, frozenAt: 90000 });
function fixture(): ResearchPaperDecisionEvidence {
  return {
    policyHash: policy().manifestHash,
    sourceHash: SOURCE,
    captureId: "synthetic:decision:1",
    sourceObservedAt: 95000,
    decisionAt: 97000,
    capturedAt: NOW,
    initialCapitalLamports: "1000000000",
    openPositions: 0,
    pendingEntries: 0,
    quote: {
      inputMint: WSOL,
      outputMint: "synthetic-mint",
      requestedAt: 99000,
      observedAt: 99500,
      inputLamports: "10000000",
      outAmount: "1000000",
      minOutAmount: "997500",
      slippageBps: 25,
      source: "JUPITER",
      router: "metis",
    },
    pairedSell: {
      inputMint: "synthetic-mint",
      outputMint: WSOL,
      inAmount: "997500",
      outAmount: "9894000",
      minOutAmount: "9870000",
      requestedAt: 99500,
      observedAt: 99600,
      slippageBps: 25,
      source: "JUPITER",
      router: "metis",
    },
    features: {
      asOf: 97000,
      mint: "synthetic-mint",
      observations: 8,
      verifiedLaunchAgeMs: null,
      imbalance: 0.4,
      uniqueBuyers: 8,
      uniqueBuyerAcceleration: 3,
      priceVelocityBps: 125,
      priceAccelerationBps: null,
      drawdownFromPeakBps: null,
      netInflowLamports: 100000000n,
      sellerConcentrationBps: 1000,
      organic: {
        score: 80,
        confidence: "low",
        independentBuyerUnits: 8,
        uniqueBuyers: 8,
        clusteredBuyers: 0,
        creatorAssociatedBuyers: 0,
        effectiveBuyVolume: 100000000n,
        evidence: ["SYNTHETIC_TEST_ONLY_UNKNOWN_RELATIONSHIP_COVERAGE"],
      },
      smartBuyers: 0,
      creatorSelling: false,
      creatorPriorLaunches: 0,
      creatorPriorAdverseOutcomes: 0,
      liquidityLamports: 20000000000n,
      liquidityGrowing: true,
      curveProgressBps: null,
      executionCostBps: 150,
    },
    security: {
      mint: "synthetic-mint",
      observedAt: 98000,
      mintAuthority: null,
      freezeAuthority: null,
      tokenProgram: "spl-token",
      extensionsVerified: true,
      extensions: [],
      transferFeeBps: 0,
      permanentDelegate: null,
      transferRestricted: false,
      creatorConcentrationBps: 1000,
      creatorAssociationsVerified: false,
      creatorAssociatedConcentrationBps: null,
      topHolderConcentrationBps: 3500,
      knownMalicious: false,
      sellRouteAvailable: true,
      sellRouteObservedAt: 99600,
      liquidityAccessible: true,
      abnormalCreatorActivity: false,
    },
  };
}
const admission = (e = fixture(), now = NOW) => evaluateResearchPaperAdmission(policy(), e, now);

describe("frozen research-only PAPER admission with synthetic evidence", () => {
  it("retains original strict rejection while exposing only declared research exceptions", () => {
    const e = fixture(),
      r = admission(e);
    expect(r.allowedForResearch).toBe(true);
    expect(r).not.toHaveProperty("allowed");
    expect(r.strictVerdict).toEqual(checkTokenSafety(e.security, undefined, NOW));
    expect(r.strictVerdict.allowed).toBe(false);
    expect(r.exemptedStrictReasons).toEqual(r.strictVerdict.reasons);
    expect(r.strictPolicyEligible).toBe(false);
    expect(r.liveApproved).toBe(false);
    expect(r.unverifiedAssociatedSupplyUpperBps).toBe(10000);
    expect(r.associationScope).toBe("UNKNOWN_ASSOCIATIONS_ACCEPTED_FOR_PAPER");
    expect(r.provenanceScope).toBe("CALLER_SUPPLIED_DECISION_SNAPSHOT_NOT_AUTHENTICATED");
    expect(r.evidence.security.creatorAssociatedConcentrationBps).toBeNull();
  });

  it("cannot be passed to strict RiskGovernor even through a runtime cast", () => {
    const r = admission();
    function compileTimeBoundary(value: ResearchPaperAdmission) {
      // @ts-expect-error Research admission deliberately has no SafetyVerdict.allowed.
      const strict: SafetyVerdict = value;
      return strict;
    }
    void compileTimeBoundary;
    const verdict = new RiskGovernor().authorize(
      {
        orderId: "synthetic-order",
        mint: r.mint,
        strategy: "momentum_breakout",
        amountLamports: 10000000n,
        feeLamports: 10000n,
        liquidityLamports: 20000000000n,
        impactBps: 20,
        slippageBps: 25,
        quoteObservedAt: 99500,
      },
      {
        equityLamports: 1000000000n,
        peakEquityLamports: 1000000000n,
        cashLamports: 1000000000n,
        exposureLamports: 0n,
        openPositions: 0,
        dailyRealizedPnlLamports: 0n,
        consecutiveFailures: 0,
        killSwitch: false,
      },
      r as unknown as SafetyVerdict,
      NOW,
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons).toContain("TOKEN_SAFETY_VETO");
  });

  it("strictly verified evidence still produces only research classification", () => {
    const e = fixture();
    e.security.creatorAssociationsVerified = true;
    e.security.creatorAssociatedConcentrationBps = 1000;
    const r = admission(e);
    expect(r.strictVerdict.allowed).toBe(true);
    expect(r.allowedForResearch).toBe(true);
    expect(r.exemptedStrictReasons).toEqual([]);
    expect(r.strictPolicyEligible).toBe(false);
    expect(r.liveApproved).toBe(false);
    expect(r).not.toHaveProperty("allowed");
  });

  it("freezes a deterministic manifest, including nested rules, without parameter search", () => {
    const p = policy();
    expect(p.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(policy()).toEqual(p);
    expect(validateResearchPaperPolicy(JSON.parse(JSON.stringify(p)))).toEqual(p);
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.safetyPolicy.allowedExtensions)).toBe(true);
    expect(Object.isFrozen(p.strategyRules)).toBe(true);
    expect(p.minimumLiquidityLamports).toBe("20000000000");
    expect(p.maximumExecutionCostBps).toBe(150);
    expect(p.slippageBps).toBe(25);
    expect(p.minimumEntryDelayMs).toBe(2000);
    expect(p.maximumQuoteAgeMs).toBe(5000);
    expect(p.networkFeePerLegLamports).toBe("10000");
    expect(p.networkFeeScope).toBe("EXPLICIT_MODEL_NOT_MEASURED");
    expect(p.sourceUniverse).toBe("LEGACY_SPL_SOL_PAIRS_JUPITER_AGGREGATOR_QUOTES");
    expect(p.tokenProgram).toBe("spl-token");
    expect(p.requiredExtensions).toEqual([]);
    expect(() =>
      freezeResearchPaperPolicy({
        sourceHash: SOURCE,
        frozenAt: 90000,
        slippageBps: 100,
      } as Parameters<typeof freezeResearchPaperPolicy>[0]),
    ).toThrow();
  });

  it("rejects manifest, version, fixed parameter or unexpected-field tampering", () => {
    for (const patch of [
      { manifestHash: "b".repeat(64) },
      { version: 2 },
      { maximumExecutionCostBps: 151 },
      { minimumLiquidityLamports: "19999999999" },
      { slippageBps: 100 },
      { maximumPositions: 2 },
      { minimumEntryDelayMs: 1 },
      { initialCapitalLamports: "2000000000" },
      { entryLamports: "1" },
      { historicalImport: true },
      { networkFeePerLegLamports: "0" },
      { networkFeeScope: "MEASURED" },
      { allowedRouters: ["jupiterz"] },
      { sourceUniverse: "ANY_TOKEN" },
      { tokenProgram: "token-2022" },
      { requiredExtensions: ["MetadataPointer"] },
      { safetyPolicy: { ...policy().safetyPolicy, maxCreatorConcentrationBps: 1001 } },
    ])
      expect(() => validateResearchPaperPolicy({ ...policy(), ...patch })).toThrow();
  });

  it.each(["", "f".repeat(40), "A".repeat(64), "g".repeat(64)])(
    "rejects malformed source hash %s",
    (sourceHash) => {
      expect(() => freezeResearchPaperPolicy({ sourceHash, frozenAt: 90000 })).toThrow();
    },
  );

  it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid freeze clock %s",
    (frozenAt) => {
      expect(() => freezeResearchPaperPolicy({ sourceHash: SOURCE, frozenAt })).toThrow();
    },
  );

  it("binds source and policy identity and retains mismatched evidence as denied", () => {
    for (const key of ["sourceHash", "policyHash"] as const) {
      const e = fixture();
      e[key] = "b".repeat(64);
      expect(admission(e).reasons).toContain("RESEARCH_POLICY_OR_SOURCE_MISMATCH");
      expect(admission(e).allowedForResearch).toBe(false);
    }
  });

  it.each([false, undefined])(
    "accepts missing association coverage only when explicitly unknown (%s)",
    (flag) => {
      const e = fixture();
      e.security.creatorAssociationsVerified = flag;
      expect(admission(e).allowedForResearch).toBe(true);
    },
  );

  it.each([false, true])(
    "rejects known excessive associated concentration regardless of verification flag (%s)",
    (flag) => {
      const e = fixture();
      e.security.creatorAssociationsVerified = flag;
      e.security.creatorAssociatedConcentrationBps = 1001;
      const r = admission(e);
      expect(r.allowedForResearch).toBe(false);
      expect(r.reasons).toContain("CREATOR_ASSOCIATED_CONCENTRATION_UNKNOWN_OR_EXCESSIVE");
    },
  );

  it("does not exempt a missing numeric concentration claimed verified", () => {
    const e = fixture();
    e.security.creatorAssociationsVerified = true;
    expect(admission(e).allowedForResearch).toBe(false);
    expect(admission(e).exemptedStrictReasons).toEqual([]);
  });

  it.each([-1, NaN, Infinity, 999, 1000.001])(
    "rejects invalid associated values or values below the direct lower bound (%s)",
    (amount) => {
      const e = fixture();
      e.security.creatorAssociatedConcentrationBps = amount;
      expect(admission(e).allowedForResearch).toBe(false);
    },
  );

  it("preserves known unverified associated evidence without claiming complete ownership", () => {
    const e = fixture();
    e.security.creatorAssociatedConcentrationBps = 1000;
    const r = admission(e);
    expect(r.allowedForResearch).toBe(true);
    expect(r.exemptedStrictReasons).toEqual(["CREATOR_ASSOCIATIONS_UNVERIFIED"]);
    expect(r.unverifiedAssociatedSupplyUpperBps).toBe(10000);
    expect(r.evidence.security.creatorAssociatedConcentrationBps).toBe(1000);
  });

  it.each([
    { mintAuthority: "active" },
    { freezeAuthority: "active" },
    { tokenProgram: "unknown" },
    { extensionsVerified: false },
    { tokenProgram: "token-2022", extensions: ["TransferHook"] },
    { transferFeeBps: 1 },
    { permanentDelegate: "active" },
    { transferRestricted: true },
    { creatorConcentrationBps: 1001 },
    { creatorConcentrationBps: null },
    { topHolderConcentrationBps: 3501 },
    { knownMalicious: true },
    { knownMalicious: null },
    { sellRouteAvailable: false },
    { liquidityAccessible: false },
    { abnormalCreatorActivity: true },
  ])("keeps every other strict safety veto: %o", (patch) => {
    const e = fixture();
    Object.assign(e.security, patch);
    const r = admission(e);
    expect(r.allowedForResearch).toBe(false);
    expect(r.strictVerdict.allowed).toBe(false);
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it("enforces unchanged liquidity and cost boundaries with new tighter slippage", () => {
    expect(admission().allowedForResearch).toBe(true);
    for (const patch of [{ liquidityLamports: 19999999999n }, { executionCostBps: 150.001 }]) {
      const e = fixture();
      Object.assign(e.features, patch);
      expect(admission(e).allowedForResearch).toBe(false);
    }
    const e = fixture();
    e.quote.slippageBps = 100;
    expect(admission(e).reasons).toContain("RESEARCH_FROZEN_SLIPPAGE_MISMATCH");
  });

  it("recomputes the genuine exact 150-bps boundary with modeled fees charged once", () => {
    const r = admission();
    expect(r.allowedForResearch).toBe(true);
    expect(r.pricing).toEqual({
      scope: "SEQUENTIAL_PAIRED_QUOTE_STRESS_WITH_TEMPORAL_DRIFT_NOT_REALIZED_COST",
      computedExecutionCostBps: 150,
      computedExecutionCostAsOf: 99600,
      reportedExecutionCostBps: 150,
      reportedExecutionCostAsOf: 97000,
      reportedCostScope: "ORIGINAL_DECISION_TIME_FEATURE",
      modeledNetworkFeesLamports: "20000",
      networkFeeScope: "EXPLICIT_MODEL_NOT_MEASURED",
    });
    const e = fixture();
    e.pairedSell.minOutAmount = "9869999";
    e.features.executionCostBps = 151;
    const over = admission(e);
    expect(over.pricing.computedExecutionCostBps).toBe(151);
    expect(over.allowedForResearch).toBe(false);
    expect(over.reasons).toContain("RESEARCH_PAIRED_COST_BUDGET_EXCEEDED");
  });

  it("independently rejects fresh 151-bps paired stress after a valid original 1-bps decision", () => {
    const e = fixture();
    e.features.executionCostBps = 1;
    e.pairedSell.minOutAmount = "9869999";
    const r = admission(e);
    expect(r.allowedForResearch).toBe(false);
    expect(r.pricing.reportedExecutionCostBps).toBe(1);
    expect(r.pricing.computedExecutionCostBps).toBe(151);
    expect(r.reasons).toContain("RESEARCH_PAIRED_COST_BUDGET_EXCEEDED");
    expect(r.reasons).not.toContain("COST_BUDGET_EXCEEDED");
    expect(r.evidence.features.executionCostBps).toBe(1);
  });

  it.each([0, 149, 151])(
    "checks original decision cost %s independently of fresh 150-bps cost",
    (reported) => {
      const e = fixture();
      e.features.executionCostBps = reported;
      const r = admission(e);
      expect(r.allowedForResearch).toBe(reported <= 150);
      if (reported > 150) expect(r.reasons).toContain("COST_BUDGET_EXCEEDED");
      else expect(r.reasons).toEqual([]);
      expect(r.pricing.computedExecutionCostBps).toBe(150);
      expect(r.pricing.reportedExecutionCostBps).toBe(reported);
      expect(r.pricing.reportedExecutionCostAsOf).toBe(97000);
      expect(r.pricing.computedExecutionCostAsOf).toBe(99600);
      expect(r.evidence.features.executionCostBps).toBe(reported);
    },
  );

  it("does not invent a positive cost when proceeds already cover the fee model", () => {
    const e = fixture();
    e.pairedSell.outAmount = "10045000";
    e.pairedSell.minOutAmount = "10020000";
    e.features.executionCostBps = 0;
    const r = admission(e);
    expect(r.allowedForResearch).toBe(true);
    expect(r.pricing.computedExecutionCostBps).toBe(0);
    expect(r.pricing.scope).toContain("TEMPORAL_DRIFT");
  });

  it("requires raw outputs on both legs and rejects a missing paired sell", () => {
    for (const leg of ["quote", "pairedSell"] as const) {
      for (const field of ["outAmount", "minOutAmount"]) {
        const e = fixture();
        Reflect.deleteProperty(e[leg], field);
        const r = admission(e);
        expect(r.allowedForResearch).toBe(false);
        expect(r.pricing.computedExecutionCostBps).toBeNull();
        expect(r.reasons).toContain("RESEARCH_QUOTE_RAW_AMOUNT_OR_MINIMUM_INVALID");
      }
    }
    const e = fixture();
    Reflect.deleteProperty(e, "pairedSell");
    expect(() => admission(e)).toThrow("RESEARCH_DECISION_EVIDENCE_MALFORMED");
  });

  it("rejects noncanonical, zero and overflowing u64 amounts for every quoted amount", () => {
    const bad = [
      undefined,
      null,
      true,
      1,
      "0",
      "01",
      "-1",
      "+1",
      "1.0",
      "1e6",
      " 1",
      "1\n",
      "18446744073709551616",
      "9".repeat(10000),
    ];
    for (const [leg, fields] of [
      ["quote", ["inputLamports", "outAmount", "minOutAmount"]],
      ["pairedSell", ["inAmount", "outAmount", "minOutAmount"]],
    ] as const) {
      for (const field of fields)
        for (const value of bad) {
          const e = fixture();
          Object.assign(e[leg], { [field]: value });
          expect(admission(e).allowedForResearch).toBe(false);
          expect(admission(e).reasons).toContain("RESEARCH_QUOTE_RAW_AMOUNT_OR_MINIMUM_INVALID");
        }
    }
  });

  it("enforces both minimum outputs independently and uses exact u64-wide floor math", () => {
    for (const leg of ["quote", "pairedSell"] as const) {
      for (const patch of [{ minOutAmount: "999999999" }, { minOutAmount: "1" }]) {
        const e = fixture();
        Object.assign(e[leg], patch);
        expect(admission(e).reasons).toContain("RESEARCH_QUOTE_RAW_AMOUNT_OR_MINIMUM_INVALID");
      }
    }
    const e = fixture(),
      maximum = (1n << 64n) - 1n;
    e.quote.outAmount = maximum.toString();
    e.quote.minOutAmount = ((maximum * 9975n) / 10000n).toString();
    e.pairedSell.inAmount = e.quote.minOutAmount;
    expect(admission(e).allowedForResearch).toBe(true);
    e.quote.minOutAmount = (BigInt(e.quote.minOutAmount) - 1n).toString();
    e.pairedSell.inAmount = e.quote.minOutAmount;
    expect(admission(e).reasons).toContain("RESEARCH_QUOTE_RAW_AMOUNT_OR_MINIMUM_INVALID");
  });

  it("requires the paired sell to quote the exact buy minimum quantity", () => {
    for (const quantity of ["1000000", "997499", "997501"]) {
      const e = fixture();
      e.pairedSell.inAmount = quantity;
      expect(admission(e).allowedForResearch).toBe(false);
      expect(admission(e).reasons).toContain("RESEARCH_PAIRED_SELL_EXACT_QUANTITY_MISMATCH");
      expect(admission(e).pricing.computedExecutionCostBps).toBeNull();
    }
  });

  it("rejects wrong paired mint identities and independent route assertions", () => {
    for (const patch of [{ inputMint: WSOL }, { outputMint: "other-mint" }]) {
      const e = fixture();
      Object.assign(e.pairedSell, patch);
      expect(admission(e).reasons).toContain("RESEARCH_QUOTE_MINT_IDENTITY_MISMATCH");
    }
    const e = fixture();
    e.security.sellRouteObservedAt = 99999;
    expect(admission(e).allowedForResearch).toBe(false);
    expect(admission(e).reasons).toContain("RESEARCH_SELL_ROUTE_NOT_BOUND_TO_PAIRED_QUOTE");
    const same = fixture();
    same.features.mint = WSOL;
    same.security.mint = WSOL;
    same.quote.outputMint = WSOL;
    same.pairedSell.inputMint = WSOL;
    expect(admission(same).allowedForResearch).toBe(false);
    expect(admission(same).reasons).toContain("RESEARCH_MINT_MISMATCH");
  });

  it.each(["quote", "pairedSell"] as const)(
    "rejects RFQ, unknown and missing route/source metadata on %s",
    (leg) => {
      for (const patch of [
        { router: "jupiterz" },
        { router: "rfq" },
        { router: "unknown" },
        { router: undefined },
        { source: "PUMP_ONCHAIN" },
        { source: undefined },
      ]) {
        const e = fixture();
        Object.assign(e[leg], patch);
        expect(admission(e).allowedForResearch).toBe(false);
        expect(admission(e).reasons).toContain("RESEARCH_QUOTE_SOURCE_OR_ROUTER_UNSUPPORTED");
      }
    },
  );

  it.each(["quote", "pairedSell"] as const)(
    "rejects RFQ metadata hidden behind an allowed router on %s",
    (leg) => {
      for (const patch of [
        { quoteId: "offer-id" },
        { maker: "maker-address" },
        { expireAt: "2000-01-01T00:00:00Z" },
        { expireAt: "2999-01-01T00:00:00Z" },
        { expireAt: "unparseable" },
        { quoteId: 0 },
        { maker: false },
        { expireAt: {} },
        { swapType: "rfq" },
        { swapType: "aggregator+rfq" },
        { swapType: "aggregator + RFQ" },
        { swapType: " RFQ + aggregator " },
        { swapType: {} },
      ]) {
        const e = fixture();
        Object.assign(e[leg], patch);
        expect(e[leg].router).toBe("metis");
        const r = admission(e);
        expect(r.allowedForResearch).toBe(false);
        expect(r.reasons).toContain("RESEARCH_QUOTE_RFQ_METADATA_UNSUPPORTED");
      }
    },
  );

  it("permits absent or unpopulated RFQ metadata and ordinary aggregator swap types", () => {
    const e = fixture();
    for (const leg of [e.quote, e.pairedSell])
      Object.assign(leg, {
        quoteId: null,
        maker: undefined,
        expireAt: "",
        swapType: "aggregator",
      });
    expect(admission(e).allowedForResearch).toBe(true);
  });

  it.each(["metis", "dflow", "okx"] as const)(
    "allows the declared aggregator router %s without implying a fill",
    (router) => {
      const e = fixture();
      e.quote.router = router;
      e.pairedSell.router = router;
      expect(admission(e).allowedForResearch).toBe(true);
      expect(admission(e).liveApproved).toBe(false);
    },
  );

  it("limits the source universe to legacy SPL even when a Token-2022 mint passes strict checks", () => {
    const e = fixture();
    e.security.tokenProgram = "token-2022";
    e.security.creatorAssociationsVerified = true;
    e.security.creatorAssociatedConcentrationBps = 1000;
    const r = admission(e);
    expect(r.strictVerdict.allowed).toBe(true);
    expect(r.allowedForResearch).toBe(false);
    expect(r.reasons).toContain("RESEARCH_SOURCE_UNIVERSE_UNSUPPORTED");
  });

  it.each([
    "extensionsVerified",
    "transferRestricted",
    "knownMalicious",
    "sellRouteAvailable",
    "liquidityAccessible",
    "abnormalCreatorActivity",
  ] as const)("requires an exact Boolean for %s", (field) => {
    for (const value of ["false", "true", 0, 1, null, undefined]) {
      const e = fixture();
      Object.assign(e.security, { [field]: value });
      const r = admission(e);
      expect(r.allowedForResearch).toBe(false);
      expect(r.reasons).toContain("RESEARCH_SECURITY_BOOLEAN_UNKNOWN_OR_INVALID");
      expect(r.strictVerdict).toEqual(checkTokenSafety(e.security, undefined, NOW));
    }
  });

  it.each(["false", "true", 0, 1, null])(
    "rejects a malformed optional association Boolean (%s)",
    (value) => {
      const e = fixture();
      Object.assign(e.security, { creatorAssociationsVerified: value });
      expect(admission(e).allowedForResearch).toBe(false);
      expect(admission(e).reasons).toContain("RESEARCH_ASSOCIATION_FLAG_INVALID");
    },
  );

  it.each([
    "TransferHook",
    "PermanentDelegate",
    "MetadataPointer",
    "TokenMetadata",
    "ImmutableOwner",
  ])(
    "rejects impossible legacy-SPL extension %s while retaining the original strict verdict",
    (extension) => {
      const e = fixture();
      e.security.extensions = [extension];
      e.security.creatorAssociationsVerified = true;
      e.security.creatorAssociatedConcentrationBps = 1000;
      const r = admission(e);
      expect(r.strictVerdict.allowed).toBe(true);
      expect(r.strictVerdict).toEqual(checkTokenSafety(e.security, undefined, NOW));
      expect(r.allowedForResearch).toBe(false);
      expect(r.reasons).toContain("RESEARCH_LEGACY_SPL_EXTENSIONS_UNSUPPORTED");
      expect(r.evidence.security.extensions).toEqual([extension]);
    },
  );

  it("denies malformed extension containers, entries and duplicate names explicitly", () => {
    for (const value of [
      null,
      undefined,
      "TransferHook",
      {},
      [1],
      [null],
      [""],
      ["bad name"],
      ["TransferHook", "TransferHook"],
      ["MetadataPointer", "MetadataPointer"],
    ]) {
      const e = fixture();
      Object.assign(e.security, { extensions: value });
      const r = admission(e);
      expect(r.allowedForResearch).toBe(false);
      expect(r.reasons).toContain("RESEARCH_SECURITY_EXTENSIONS_MALFORMED");
      expect(r.reasons).toContain("RESEARCH_LEGACY_SPL_EXTENSIONS_UNSUPPORTED");
      expect(r.strictVerdict).toEqual(checkTokenSafety(e.security, undefined, NOW));
    }
  });

  it("enforces causal, fresh second-quote clocks and the second leg's fixed slippage", () => {
    for (const patch of [
      { requestedAt: 99499 },
      { requestedAt: 99601 },
      { observedAt: 94000 },
      { observedAt: 100001 },
      { requestedAt: NaN },
      { observedAt: Infinity },
    ]) {
      const e = fixture();
      Object.assign(e.pairedSell, patch);
      e.security.sellRouteObservedAt = e.pairedSell.observedAt;
      expect(admission(e).allowedForResearch).toBe(false);
      expect(admission(e).reasons).toContain(
        "RESEARCH_EVIDENCE_CLOCK_DELAY_FRESHNESS_OR_HISTORICAL_IMPORT_INVALID",
      );
    }
    const e = fixture();
    e.pairedSell.slippageBps = 26;
    expect(admission(e).reasons).toContain("RESEARCH_FROZEN_SLIPPAGE_MISMATCH");
  });

  it.each([
    { observations: 2 },
    { organic: { ...fixture().features.organic, independentBuyerUnits: 4 } },
    { organic: { ...fixture().features.organic, score: 39 } },
    { imbalance: 0.19 },
    { netInflowLamports: 0n },
    { liquidityGrowing: false },
    { priceVelocityBps: 99 },
    { uniqueBuyerAcceleration: 0 },
    { creatorSelling: true },
    { creatorPriorAdverseOutcomes: 1 },
  ])("recomputes the existing momentum checks rather than trusting an enter flag (%o)", (patch) => {
    const e = fixture();
    Object.assign(e.features, patch);
    expect(admission(e).allowedForResearch).toBe(false);
  });

  it.each([NaN, Infinity, null])("fails closed invalid signal numbers (%s)", (amount) => {
    const e = fixture();
    e.features.executionCostBps = amount;
    expect(admission(e).allowedForResearch).toBe(false);
    e.features.executionCostBps = 150;
    e.features.organic.score = amount as number;
    expect(admission(e).allowedForResearch).toBe(false);
  });

  it("rejects missing creator flags and malformed prior-adverse evidence instead of relying on comparisons", () => {
    for (const patch of [
      { creatorSelling: undefined },
      { creatorPriorAdverseOutcomes: NaN },
      { creatorPriorAdverseOutcomes: -1 },
      { uniqueBuyerAcceleration: 1.5 },
    ]) {
      const e = fixture();
      Object.assign(e.features, patch);
      expect(admission(e).allowedForResearch).toBe(false);
    }
  });

  it("requires exact SOL-to-token quote identity independently of feature identity", () => {
    for (const patch of [{ inputMint: "other-input" }, { outputMint: "other-output" }]) {
      const e = fixture();
      Object.assign(e.quote, patch);
      expect(admission(e).allowedForResearch).toBe(false);
      expect(admission(e).reasons).toContain("RESEARCH_QUOTE_MINT_IDENTITY_MISMATCH");
    }
  });

  it("requires the fixed initial capital, exact size and an unoccupied position slot", () => {
    for (const patch of [
      { initialCapitalLamports: "999999999" },
      { openPositions: 1 },
      { pendingEntries: 1 },
      { openPositions: -1 },
      { pendingEntries: NaN },
    ]) {
      const e = fixture();
      Object.assign(e, patch);
      expect(admission(e).allowedForResearch).toBe(false);
    }
    for (const amount of ["10000001", "010000000", "1e7"]) {
      const e = fixture();
      e.quote.inputLamports = amount;
      expect(admission(e).allowedForResearch).toBe(false);
    }
  });

  it("rejects old source/imported evidence, premature entry and future clock chains", () => {
    const mutations: Array<(e: ResearchPaperDecisionEvidence) => void> = [
      (e) => {
        e.sourceObservedAt = 90000;
      },
      (e) => {
        e.decisionAt = 89000;
        e.features.asOf = 89000;
      },
      (e) => {
        e.security.observedAt = 90000;
      },
      (e) => {
        e.security.sellRouteObservedAt = 90000;
      },
      (e) => {
        e.sourceObservedAt = e.decisionAt + 1;
      },
      (e) => {
        e.quote.requestedAt = 98999;
      },
      (e) => {
        e.quote.observedAt = 98999;
      },
      (e) => {
        e.capturedAt = 99499;
      },
      (e) => {
        e.capturedAt = NOW + 1;
      },
      (e) => {
        e.security.observedAt = NOW + 1;
      },
      (e) => {
        e.security.sellRouteObservedAt = NOW + 1;
      },
      (e) => {
        e.features.asOf++;
      },
      (e) => {
        e.quote.requestedAt = NaN;
      },
      (e) => {
        e.security.sellRouteObservedAt = NaN;
      },
    ];
    for (const mutate of mutations) {
      const e = fixture();
      mutate(e);
      expect(admission(e).allowedForResearch).toBe(false);
      expect(admission(e).reasons).toContain(
        "RESEARCH_EVIDENCE_CLOCK_DELAY_FRESHNESS_OR_HISTORICAL_IMPORT_INVALID",
      );
    }
  });

  it("allows the exact freshness boundary but rejects the next millisecond", () => {
    expect(admission().expiresAt).toBe(104000);
    expect(admission(fixture(), 104000).allowedForResearch).toBe(true);
    expect(admission(fixture(), 104001).allowedForResearch).toBe(false);
    const e = fixture();
    e.decisionAt = 90001;
    e.features.asOf = 90001;
    e.sourceObservedAt = 90001;
    e.quote.requestedAt = 119000;
    e.quote.observedAt = 120000;
    e.capturedAt = 120001;
    e.pairedSell.requestedAt = 120000;
    e.pairedSell.observedAt = 120001;
    e.security.observedAt = 119000;
    e.security.sellRouteObservedAt = 120001;
    expect(admission(e, 120001).allowedForResearch).toBe(true);
    expect(admission(e, 120002).allowedForResearch).toBe(false);
  });

  it("rejects a stale request start even when its reported quote observation is fresh", () => {
    const r = admission(fixture(), 104001);
    expect(104001 - fixture().quote.observedAt).toBeLessThan(5000);
    expect(r.allowedForResearch).toBe(false);
    expect(r.reasons).toContain(
      "RESEARCH_EVIDENCE_CLOCK_DELAY_FRESHNESS_OR_HISTORICAL_IMPORT_INVALID",
    );
  });
  it("expires at the source-observation boundary even when all later evidence remains fresh", () => {
    const e = fixture();
    e.decisionAt = 122000;
    e.features.asOf = 122000;
    e.quote.requestedAt = 124000;
    e.quote.observedAt = 124500;
    e.pairedSell.requestedAt = 124500;
    e.pairedSell.observedAt = 124600;
    e.security.sellRouteObservedAt = 124600;
    e.capturedAt = 124800;
    const r = admission(e, 124800);
    expect(r.allowedForResearch).toBe(true);
    expect(r.expiresAt).toBe(125000);
    expect(admission(e, r.expiresAt).allowedForResearch).toBe(true);
    expect(admission(e, r.expiresAt + 1).allowedForResearch).toBe(false);
  });

  it("rejects post-freeze historical source events even with fresh derived quote and feature clocks", () => {
    const p = freezeResearchPaperPolicy({ sourceHash: SOURCE, frozenAt: 60000 });
    const e = fixture();
    e.policyHash = p.manifestHash;
    e.sourceObservedAt = 60001;
    const r = evaluateResearchPaperAdmission(p, e, NOW);
    expect(r.allowedForResearch).toBe(false);
    expect(r.reasons).toContain(
      "RESEARCH_EVIDENCE_CLOCK_DELAY_FRESHNESS_OR_HISTORICAL_IMPORT_INVALID",
    );
  });

  it("checks evidence identity and preserves a detached immutable numeric snapshot", () => {
    const e = fixture(),
      r = admission(e);
    e.security.creatorConcentrationBps = 9999;
    e.features.organic.score = 0;
    expect(r.evidence.security.creatorConcentrationBps).toBe(1000);
    expect(r.evidence.features.organic.score).toBe(80);
    expect(Object.isFrozen(r.evidence.security)).toBe(true);
    expect(Object.isFrozen(r.strictVerdict.reasons)).toBe(true);
    const other = fixture();
    other.features.mint = "other-mint";
    expect(admission(other).reasons).toContain("RESEARCH_MINT_MISMATCH");
    other.captureId = "";
    expect(admission(other).reasons).toContain("RESEARCH_CAPTURE_REFERENCE_INVALID");
  });
});

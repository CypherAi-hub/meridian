/** Synthetic raw-byte policy fixtures only; no population, fill or profit evidence. */
import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  ExtensionType,
  MintLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { pack } from "@solana/spl-token-metadata";
import {
  evaluateResearchPaperAdmission,
  freezeResearchPaperPolicy,
  freezeResearchPaperPolicyV2,
  validateResearchPaperPolicy,
  type ResearchPaperDecisionEvidenceV2,
  type ResearchPaperDecisionEvidence,
} from "../src/research-paper-policy.ts";
import { checkTokenSafety } from "../src/risk.ts";
import { WSOL } from "../src/types.ts";

const SOURCE = "a".repeat(64),
  NOW = 100000;
const MINT = new PublicKey(new Uint8Array(32).fill(7));
const AUTHORITY = new PublicKey(new Uint8Array(32).fill(8));
const policy = (frozenAt = 90000) => freezeResearchPaperPolicyV2({ sourceHash: SOURCE, frozenAt });
type Tlv = [number, Buffer];
function mintBytes(extensions: Tlv[] = [], mintAuthority = false, freezeAuthority = false) {
  const data = Buffer.alloc(
    extensions.length ? 166 + extensions.reduce((n, [, v]) => n + 4 + v.length, 0) : 82,
  );
  MintLayout.encode(
    {
      mintAuthorityOption: mintAuthority ? 1 : 0,
      mintAuthority: mintAuthority ? AUTHORITY : PublicKey.default,
      freezeAuthorityOption: freezeAuthority ? 1 : 0,
      freezeAuthority: freezeAuthority ? AUTHORITY : PublicKey.default,
      supply: 1000000000000n,
      decimals: 6,
      isInitialized: true,
    },
    data,
  );
  if (extensions.length) {
    data[165] = 1;
    let offset = 166;
    for (const [type, value] of extensions) {
      data.writeUInt16LE(type, offset);
      data.writeUInt16LE(value.length, offset + 2);
      value.copy(data, offset + 4);
      offset += 4 + value.length;
    }
  }
  return data;
}
function pointer(): Tlv {
  const bytes = Buffer.alloc(64);
  MINT.toBuffer().copy(bytes, 32);
  return [ExtensionType.MetadataPointer, bytes];
}
function metadata(): Tlv {
  return [
    ExtensionType.TokenMetadata,
    Buffer.from(
      pack({
        mint: MINT,
        name: "Synthetic policy fixture",
        symbol: "SYN",
        uri: "https://synthetic.invalid/metadata",
        additionalMetadata: [],
      }),
    ),
  ];
}
function fixture(
  kind: "legacy" | "pointer" | "metadata" | "token2022-empty" = "metadata",
): ResearchPaperDecisionEvidenceV2 {
  const extensions =
    kind === "metadata" ? [pointer(), metadata()] : kind === "pointer" ? [pointer()] : [];
  const token2022 = kind !== "legacy";
  return {
    policyHash: policy().manifestHash,
    sourceHash: SOURCE,
    captureId: "synthetic:raw-mint:1",
    sourceObservedAt: 95000,
    decisionAt: 97000,
    capturedAt: NOW,
    initialCapitalLamports: "1000000000",
    openPositions: 0,
    pendingEntries: 0,
    quote: {
      inputMint: WSOL,
      outputMint: MINT.toBase58(),
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
      inputMint: MINT.toBase58(),
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
      mint: MINT.toBase58(),
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
      executionCostBps: 149,
    },
    security: {
      mint: MINT.toBase58(),
      observedAt: 98100,
      mintAuthority: null,
      freezeAuthority: null,
      tokenProgram: token2022 ? "token-2022" : "spl-token",
      extensionsVerified: true,
      extensions: extensions.map(([type]) => ExtensionType[type]),
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
    mintAccountCapture: {
      address: MINT.toBase58(),
      owner: (token2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID).toBase58(),
      dataBase64: mintBytes(extensions).toString("base64"),
      slot: 123456,
      requestedAt: 97001,
      observedAt: 98000,
      publishedAt: 98100,
    },
  };
}
const admission = (e = fixture(), now = NOW) => evaluateResearchPaperAdmission(policy(), e, now);

describe("separate immutable V2 raw-mint paper policy", () => {
  it("requires raw capture for a statically known V2 policy as well as at runtime", () => {
    function missingCapture(value: ResearchPaperDecisionEvidence) {
      // @ts-expect-error V2 requires original raw mint capture; V1 evidence is insufficient.
      return evaluateResearchPaperAdmission(policy(), value, NOW);
    }
    void missingCapture;
    expect(admission().allowedForResearch).toBe(true);
  });
  it("preserves the exact original V1 hash and restores either version without rewriting", () => {
    const v1 = freezeResearchPaperPolicy({ sourceHash: SOURCE, frozenAt: 90000 }),
      v2 = policy();
    expect(v1.manifestHash).toBe(
      "29c106bb2592c87345e2492ee2a214689cfab4b7e1a540f829ab2ec5d9876c82",
    );
    expect(v2.manifestHash).not.toBe(v1.manifestHash);
    expect(v2.kind).toBe("RESEARCH_PAPER_POLICY_V2");
    expect(validateResearchPaperPolicy(JSON.parse(JSON.stringify(v1)))).toEqual(v1);
    expect(validateResearchPaperPolicy(JSON.parse(JSON.stringify(v2)))).toEqual(v2);
    expect(Object.isFrozen(v2.allowedMintExtensions)).toBe(true);
    for (const key of [
      "strategy",
      "associationScope",
      "entryLamports",
      "initialCapitalLamports",
      "maximumPositions",
      "minimumLiquidityLamports",
      "maximumExecutionCostBps",
      "slippageBps",
      "minimumEntryDelayMs",
      "maximumQuoteAgeMs",
      "maximumDecisionAgeMs",
      "safetyPolicy",
      "strategyRules",
      "networkFeePerLegLamports",
      "networkFeeScope",
      "quoteSource",
      "allowedRouters",
    ] as const)
      expect(v2[key]).toEqual(v1[key]);
  });

  it("rejects other versions, mixed manifests and edited V2 universes", () => {
    for (const patch of [
      { version: 3 },
      { kind: "RESEARCH_PAPER_POLICY_V1" },
      { version: 1 },
      { allowedMintExtensions: ["ImmutableOwner"] },
      { requiresOriginalMintAccountCapture: false },
      { manifestHash: "b".repeat(64) },
      { maximumExecutionCostBps: 151 },
      { minimumLiquidityLamports: "19999999999" },
    ])
      expect(() => validateResearchPaperPolicy({ ...policy(), ...patch })).toThrow();
  });

  it.each(["legacy", "pointer", "metadata", "token2022-empty"] as const)(
    "allows safe raw %s controls while remaining research-only",
    (kind) => {
      const e = fixture(kind),
        r = admission(e);
      expect(r.allowedForResearch).toBe(true);
      expect(r.strictVerdict).toEqual(checkTokenSafety(e.security, undefined, NOW));
      expect(r.strictVerdict.allowed).toBe(false);
      expect(r.strictPolicyEligible).toBe(false);
      expect(r.liveApproved).toBe(false);
      expect(r.unverifiedAssociatedSupplyUpperBps).toBe(10000);
      expect(r.mintCaptureVerification?.mint).toBe(MINT.toBase58());
      expect(r.mintCaptureVerification?.slot).toBe(123456);
      expect(r.mintCaptureVerification?.observedAt).toBe(98000);
      expect(r.mintCaptureVerification?.publishedAt).toBe(e.security.observedAt);
      expect(r.mintCaptureVerification?.extensions).toEqual(e.security.extensions);
      expect(r.mintCaptureVerification?.provenanceScope).toBe(
        "CALLER_SUPPLIED_RAW_ACCOUNT_NOT_ATTESTED",
      );
    },
  );

  it("does not broaden V1 when supplied the same Token-2022 metadata capture", () => {
    const p = freezeResearchPaperPolicy({ sourceHash: SOURCE, frozenAt: 90000 }),
      e = fixture();
    e.policyHash = p.manifestHash;
    const r = evaluateResearchPaperAdmission(p, e, NOW);
    expect(r.allowedForResearch).toBe(false);
    expect(r.reasons).toContain("RESEARCH_SOURCE_UNIVERSE_UNSUPPORTED");
    expect(r.mintCaptureVerification).toBeUndefined();
  });

  it("V1 still admits legacy evidence without requiring a newly invented capture", () => {
    const p = freezeResearchPaperPolicy({ sourceHash: SOURCE, frozenAt: 90000 }),
      e = fixture("legacy");
    e.policyHash = p.manifestHash;
    Reflect.deleteProperty(e, "mintAccountCapture");
    expect(evaluateResearchPaperAdmission(p, e, NOW).allowedForResearch).toBe(true);
  });

  it("does not let a true flattened extensionsVerified flag substitute for raw V2 evidence", () => {
    const e = fixture();
    Reflect.deleteProperty(e, "mintAccountCapture");
    const r = admission(e);
    expect(r.allowedForResearch).toBe(false);
    expect(r.reasons).toContain("RESEARCH_V2_MINT_CAPTURE_REQUIRED");
    expect(r.mintCaptureVerification).toBeNull();
  });

  it("requires exact agreement with every independently derived control", () => {
    for (const patch of [
      { tokenProgram: "spl-token" },
      { observedAt: 97999 },
      { mintAuthority: AUTHORITY.toBase58() },
      { freezeAuthority: AUTHORITY.toBase58() },
      { extensions: [] },
      { extensionsVerified: false },
      { transferFeeBps: 1 },
      { permanentDelegate: AUTHORITY.toBase58() },
      { transferRestricted: true },
    ]) {
      const e = fixture();
      Object.assign(e.security, patch);
      const r = admission(e);
      expect(r.allowedForResearch).toBe(false);
      expect(r.reasons.some((reason) => reason.startsWith("RESEARCH_V2_MINT_CAPTURE_"))).toBe(true);
      expect(r.strictVerdict).toEqual(checkTokenSafety(e.security, undefined, NOW));
    }
  });

  it("rejects a hidden active authority and preserves strict veto when accurately reported", () => {
    for (const freeze of [false, true]) {
      const e = fixture("legacy");
      e.mintAccountCapture.dataBase64 = mintBytes([], !freeze, freeze).toString("base64");
      expect(admission(e).reasons).toContain("RESEARCH_V2_MINT_CAPTURE_CONTROL_MISMATCH");
      if (freeze) e.security.freezeAuthority = AUTHORITY.toBase58();
      else e.security.mintAuthority = AUTHORITY.toBase58();
      const r = admission(e);
      expect(r.allowedForResearch).toBe(false);
      expect(r.reasons).toContain(freeze ? "FREEZE_AUTHORITY_ACTIVE" : "MINT_AUTHORITY_ACTIVE");
    }
  });

  it.each([
    [ExtensionType.ImmutableOwner, 0],
    [ExtensionType.TransferFeeConfig, 108],
    [ExtensionType.TransferHook, 64],
    [ExtensionType.PermanentDelegate, 32],
    [65000, 0],
  ])(
    "rejects unsupported raw extension %s even when flattened evidence claims no risk",
    (type, length) => {
      const e = fixture("token2022-empty");
      e.mintAccountCapture.dataBase64 = mintBytes([[type, Buffer.alloc(length)]]).toString(
        "base64",
      );
      const r = admission(e);
      expect(r.allowedForResearch).toBe(false);
      expect(r.reasons).toContain("RESEARCH_V2_MINT_CAPTURE_INVALID_OR_UNVERIFIED");
    },
  );

  it("rejects claimed account-only or transfer-affecting extension names independently of bytes", () => {
    for (const extensions of [
      ["ImmutableOwner"],
      ["TransferFeeConfig"],
      ["TransferHook"],
      ["UnknownMintExtension"],
    ]) {
      const e = fixture();
      e.security.extensions = extensions;
      expect(admission(e).allowedForResearch).toBe(false);
      expect(admission(e).reasons).toContain("RESEARCH_V2_MINT_EXTENSIONS_UNSUPPORTED");
    }
  });

  it("rejects malformed capture addresses, owners, bytes, slot or mint initialization", () => {
    const uninitialized = mintBytes();
    uninitialized[45] = 0;
    for (const patch of [
      { address: AUTHORITY.toBase58() },
      { owner: AUTHORITY.toBase58() },
      { dataBase64: "not base64" },
      { dataBase64: Buffer.alloc(81).toString("base64") },
      { dataBase64: uninitialized.toString("base64") },
      { slot: -1 },
      { slot: NaN },
    ]) {
      const e = fixture();
      Object.assign(e.mintAccountCapture, patch);
      expect(admission(e).allowedForResearch).toBe(false);
      expect(admission(e).reasons).toContain("RESEARCH_V2_MINT_CAPTURE_INVALID_OR_UNVERIFIED");
    }
  });

  it("requires all raw clocks after freeze, before package availability, and not in the future", () => {
    for (const observedAt of [90000, 89999, 100001, NaN]) {
      const e = fixture();
      Object.assign(e.mintAccountCapture, {
        requestedAt: observedAt - 1,
        observedAt,
        publishedAt: observedAt,
      });
      e.security.observedAt = observedAt;
      const r = admission(e);
      expect(r.allowedForResearch).toBe(false);
      expect(r.reasons).toContain("RESEARCH_V2_MINT_CAPTURE_CLOCK_INVALID");
    }
    const e = fixture();
    e.mintAccountCapture.publishedAt = 98101;
    expect(admission(e).allowedForResearch).toBe(false); // differs from security publication
  });

  it("includes earliest raw request freshness in TTL without retimestamping it to publication", () => {
    const p = policy(60000),
      e = fixture();
    e.policyHash = p.manifestHash;
    e.mintAccountCapture.requestedAt = 70001;
    e.mintAccountCapture.observedAt = 70002;
    const r = evaluateResearchPaperAdmission(p, e, NOW);
    expect(r.allowedForResearch).toBe(true);
    expect(r.expiresAt).toBe(100001);
    const late = evaluateResearchPaperAdmission(p, e, 100002);
    expect(late.allowedForResearch).toBe(false);
    expect(late.reasons).toContain("RESEARCH_V2_MINT_CAPTURE_CLOCK_INVALID");
  });

  it("separates raw request, raw response and completed security publication clocks", () => {
    const e = fixture(),
      r = admission(e);
    expect(r.allowedForResearch).toBe(true);
    expect(r.evidence.mintAccountCapture?.requestedAt).toBe(97001);
    expect(r.evidence.mintAccountCapture?.observedAt).toBe(98000);
    expect(r.evidence.security.observedAt).toBe(98100);
    expect(r.mintCaptureVerification?.publishedAt).toBe(98100);
    for (const patch of [
      { requestedAt: 98001 },
      { observedAt: 98101 },
      { publishedAt: 100001 },
      { requestedAt: undefined },
      { publishedAt: undefined },
    ]) {
      const bad = fixture();
      Object.assign(bad.mintAccountCapture, patch);
      expect(admission(bad).allowedForResearch).toBe(false);
      expect(admission(bad).reasons).toContain("RESEARCH_V2_MINT_CAPTURE_CLOCK_INVALID");
    }
  });

  it("keeps all causal, fee, RFQ, capacity, cost and known-association controls", () => {
    const cases: Array<(e: ResearchPaperDecisionEvidenceV2) => void> = [
      (e) => {
        e.features.executionCostBps = 151;
      },
      (e) => {
        e.features.liquidityLamports = 19999999999n;
      },
      (e) => {
        e.pairedSell.minOutAmount = "9869999";
      },
      (e) => {
        e.quote.expireAt = "expired";
      },
      (e) => {
        e.pairedSell.inAmount = "1000000";
      },
      (e) => {
        e.quote.requestedAt = 98999;
      },
      (e) => {
        e.pendingEntries = 1;
      },
      (e) => {
        e.security.creatorConcentrationBps = 1001;
      },
      (e) => {
        e.security.creatorAssociatedConcentrationBps = 1001;
      },
    ];
    for (const change of cases) {
      const e = fixture();
      change(e);
      expect(admission(e).allowedForResearch).toBe(false);
    }
  });

  it("requires the new policy identity and retains original immutable raw evidence", () => {
    const e = fixture(),
      r = admission(e);
    e.mintAccountCapture.dataBase64 = "mutated";
    expect(r.evidence.mintAccountCapture?.dataBase64).not.toBe("mutated");
    expect(Object.isFrozen(r.mintCaptureVerification)).toBe(true);
    const old = fixture();
    old.policyHash = freezeResearchPaperPolicy({
      sourceHash: SOURCE,
      frozenAt: 90000,
    }).manifestHash;
    expect(admission(old).reasons).toContain("RESEARCH_POLICY_OR_SOURCE_MISMATCH");
  });
});

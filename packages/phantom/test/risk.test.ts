import { describe, expect, it } from "vitest";
import {
  DEFAULT_RISK_LIMITS,
  DEFAULT_SAFETY_POLICY,
  RiskGovernor,
  checkTokenSafety,
  type PortfolioRiskState,
  type TokenSafetyEvidence,
  type TradeProposal,
} from "../src/risk.ts";

// All data below are explicitly synthetic safety/capital fixtures.
const now = 100_000;
const evidence: TokenSafetyEvidence = {
  mint: "mint",
  observedAt: now,
  mintAuthority: null,
  freezeAuthority: null,
  tokenProgram: "spl-token",
  extensionsVerified: true,
  extensions: [],
  transferFeeBps: 0,
  permanentDelegate: null,
  transferRestricted: false,
  creatorConcentrationBps: 100,
  creatorAssociationsVerified: true,
  creatorAssociatedConcentrationBps: 100,
  topHolderConcentrationBps: 1000,
  knownMalicious: false,
  sellRouteAvailable: true,
  sellRouteObservedAt: now,
  liquidityAccessible: true,
  abnormalCreatorActivity: false,
};
const portfolio: PortfolioRiskState = {
  equityLamports: 10_000_000_000n,
  peakEquityLamports: 10_000_000_000n,
  cashLamports: 10_000_000_000n,
  exposureLamports: 0n,
  openPositions: 0,
  dailyRealizedPnlLamports: 0n,
  consecutiveFailures: 0,
  killSwitch: false,
};
const proposal: TradeProposal = {
  orderId: "order1",
  mint: "mint",
  strategy: "launch_sniper",
  amountLamports: 100_000_000n,
  feeLamports: 10_000n,
  liquidityLamports: 50_000_000_000n,
  impactBps: 20,
  slippageBps: 100,
  quoteObservedAt: now,
};
const safety = checkTokenSafety(evidence, DEFAULT_SAFETY_POLICY, now);

describe("token safety", () => {
  it("accepts only complete, fresh safety evidence and does not promise future sellability", () => {
    expect(safety.allowed).toBe(true);
    expect(safety.reasons).toContain("CHECKS_PASSED_FUTURE_SELLABILITY_NOT_GUARANTEED");
  });
  it.each([
    ["mintAuthority", undefined],
    ["freezeAuthority", "active"],
    ["extensionsVerified", false],
    ["permanentDelegate", "delegate"],
    ["transferRestricted", null],
    ["transferFeeBps", 1],
    ["creatorConcentrationBps", null],
    ["topHolderConcentrationBps", 9000],
    ["knownMalicious", null],
    ["creatorAssociationsVerified", false],
    ["creatorAssociationsVerified", undefined],
    ["creatorAssociatedConcentrationBps", null],
    ["creatorAssociatedConcentrationBps", undefined],
    ["creatorAssociatedConcentrationBps", Infinity],
    ["creatorAssociatedConcentrationBps", NaN],
    ["creatorAssociatedConcentrationBps", -1],
    ["creatorAssociatedConcentrationBps", 1001],
    ["sellRouteAvailable", false],
    ["sellRouteObservedAt", now + 1],
    ["liquidityAccessible", null],
    ["abnormalCreatorActivity", true],
    ["observedAt", now - 31_000],
    ["observedAt", now + 1],
  ])("vetoes unsafe or unknown %s", (key, value) => {
    const result = checkTokenSafety({ ...evidence, [key]: value }, DEFAULT_SAFETY_POLICY, now);
    expect(result.allowed).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });
  it("rejects unreviewed Token-2022 extensions even when the sell simulation succeeds", () => {
    const result = checkTokenSafety(
      { ...evidence, tokenProgram: "token-2022", extensions: ["TransferHook"] },
      DEFAULT_SAFETY_POLICY,
      now,
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain("UNSUPPORTED_TOKEN_EXTENSION:TransferHook");
  });
  it("cannot substitute safe-looking direct creator balances or a partial graph for verified associated supply", () => {
    const directOnly = checkTokenSafety(
      {
        ...evidence,
        creatorConcentrationBps: 0,
        creatorAssociationsVerified: false,
        creatorAssociatedConcentrationBps: null,
      },
      DEFAULT_SAFETY_POLICY,
      now,
    );
    expect(directOnly.allowed).toBe(false);
    expect(directOnly.reasons).toContain("CREATOR_ASSOCIATIONS_UNVERIFIED");
    expect(directOnly.reasons).toContain("CREATOR_ASSOCIATED_CONCENTRATION_UNKNOWN_OR_EXCESSIVE");
    const missingCoverage = {
      ...evidence,
      creatorConcentrationBps: 0,
      creatorAssociatedConcentrationBps: 0,
    };
    delete missingCoverage.creatorAssociationsVerified;
    expect(checkTokenSafety(missingCoverage, DEFAULT_SAFETY_POLICY, now).reasons).toContain(
      "CREATOR_ASSOCIATIONS_UNVERIFIED",
    );
  });
  it("requires the verified associated estimate to include the direct lower bound", () => {
    const inconsistent = checkTokenSafety(
      { ...evidence, creatorAssociatedConcentrationBps: 99 },
      DEFAULT_SAFETY_POLICY,
      now,
    );
    expect(inconsistent.allowed).toBe(false);
    expect(inconsistent.reasons).toContain(
      "CREATOR_ASSOCIATED_CONCENTRATION_BELOW_DIRECT_LOWER_BOUND",
    );
    const coveredZero = checkTokenSafety(
      { ...evidence, creatorConcentrationBps: 0, creatorAssociatedConcentrationBps: 0 },
      DEFAULT_SAFETY_POLICY,
      now,
    );
    expect(coveredZero.allowed).toBe(true);
  });
});

describe("final deterministic risk governor", () => {
  it("reserves exact funds, rejects duplicate order submission and tracks completion", () => {
    const governor = new RiskGovernor();
    const first = governor.authorize(proposal, portfolio, safety, now);
    expect(first.allowed).toBe(true);
    expect(first.reservedLamports).toBe(100_010_000n);
    expect(governor.authorize(proposal, portfolio, safety, now).reasons).toContain(
      "DUPLICATE_OR_INVALID_ORDER",
    );
    governor.complete(proposal.orderId, now + 1);
    expect(governor.pendingCount(now + 1)).toBe(0);
    expect(governor.authorize(proposal, portfolio, safety, now + 1).allowed).toBe(false);
  });
  it("prevents concurrency oversubscription of cash, positions and portfolio exposure", () => {
    const governor = new RiskGovernor({ ...DEFAULT_RISK_LIMITS, maxPositions: 1 });
    expect(governor.authorize(proposal, portfolio, safety, now).allowed).toBe(true);
    const second = governor.authorize(
      { ...proposal, orderId: "2", mint: "other" },
      portfolio,
      { ...safety, mint: "other" },
      now,
    );
    expect(second.reasons).toContain("MAX_SIMULTANEOUS_POSITIONS");
    const cashGovernor = new RiskGovernor();
    const state = { ...portfolio, cashLamports: 250_015_000n };
    expect(cashGovernor.authorize(proposal, state, safety, now).allowed).toBe(true);
    expect(
      cashGovernor.authorize(
        { ...proposal, orderId: "2", mint: "other" },
        state,
        { ...safety, mint: "other" },
        now,
      ).reasons,
    ).toContain("MIN_SOL_RESERVE");
  });
  it.each([
    [{ ...portfolio, killSwitch: true }, "GLOBAL_KILL_SWITCH"],
    [{ ...portfolio, dailyRealizedPnlLamports: -200_000_000n }, "DAILY_REALIZED_LOSS_LIMIT"],
    [{ ...portfolio, equityLamports: 9_000_000_000n }, "MAX_PORTFOLIO_DRAWDOWN"],
    [{ ...portfolio, consecutiveFailures: 3 }, "REPEATED_EXECUTION_FAILURES"],
    [{ ...portfolio, openPositions: 3 }, "MAX_SIMULTANEOUS_POSITIONS"],
    [{ ...portfolio, exposureLamports: 1_000_000_000n }, "MAX_PORTFOLIO_EXPOSURE"],
    [{ ...portfolio, equityLamports: 1_000_000_000n }, "MAX_CAPITAL_PERCENT_PER_TRADE"],
    [{ ...portfolio, cashLamports: 100_000_000n }, "MIN_SOL_RESERVE"],
  ] as const)("cannot bypass portfolio invariant %s", (state, reason) => {
    expect(new RiskGovernor().authorize(proposal, state, safety, now).reasons).toContain(reason);
  });
  it.each([
    [{ amountLamports: 101_000_000n }, "MAX_SOL_PER_TRADE"],
    [{ feeLamports: 1_000_001n }, "FEE_BUDGET_EXCEEDED"],
    [{ slippageBps: 101 }, "SLIPPAGE_LIMIT"],
    [{ impactBps: null }, "PRICE_IMPACT_UNKNOWN_OR_HIGH"],
    [{ impactBps: 201 }, "PRICE_IMPACT_UNKNOWN_OR_HIGH"],
    [{ liquidityLamports: null }, "LIQUIDITY_UNKNOWN_OR_LOW"],
    [{ quoteObservedAt: now - 5001 }, "QUOTE_STALE_OR_FUTURE"],
    [{ quoteObservedAt: now + 1 }, "QUOTE_STALE_OR_FUTURE"],
  ] as const)("vetoes proposal invariant %s", (patch, reason) => {
    expect(
      new RiskGovernor().authorize({ ...proposal, ...patch }, portfolio, safety, now).reasons,
    ).toContain(reason);
  });
  it("requires the matching unexpired safety verdict even for an attractive strategy", () => {
    expect(
      new RiskGovernor().authorize(proposal, portfolio, { ...safety, allowed: false }, now).reasons,
    ).toContain("TOKEN_SAFETY_VETO");
    expect(
      new RiskGovernor().authorize(proposal, portfolio, { ...safety, mint: "different" }, now)
        .reasons,
    ).toContain("TOKEN_SAFETY_VETO");
    expect(
      new RiskGovernor().authorize(proposal, portfolio, safety, now + 31_000).reasons,
    ).toContain("TOKEN_SAFETY_VETO");
  });
  it("expires reservations and refuses late fills or fills after kill", () => {
    const governor = new RiskGovernor();
    governor.authorize(proposal, portfolio, safety, now);
    expect(() => governor.complete(proposal.orderId, now + 2001)).toThrow(/expired/);
    expect(governor.pendingCount(now + 2001)).toBe(0);
    governor.authorize(
      { ...proposal, orderId: "new", quoteObservedAt: now + 2001 },
      portfolio,
      safety,
      now + 2001,
    );
    governor.kill();
    expect(() => governor.complete("new", now + 2002)).toThrow(/killed/);
    expect(
      governor.authorize({ ...proposal, orderId: "third" }, portfolio, safety, now).reasons,
    ).toContain("GLOBAL_KILL_SWITCH");
  });
  it("rejects invalid risk settings rather than silently disabling limits", () => {
    expect(() => new RiskGovernor({ ...DEFAULT_RISK_LIMITS, maxPositions: 0 })).toThrow();
    expect(() => new RiskGovernor({ ...DEFAULT_RISK_LIMITS, maxExposureBps: 10_001 })).toThrow();
  });
  it("copies and freezes limits so strategy code cannot expand authorization", () => {
    const limits = { ...DEFAULT_RISK_LIMITS };
    const governor = new RiskGovernor(limits);
    limits.maxPerTradeLamports = 10_000_000_000n;
    expect(governor.limits.maxPerTradeLamports).toBe(DEFAULT_RISK_LIMITS.maxPerTradeLamports);
    expect(Object.isFrozen(governor.limits)).toBe(true);
    expect(
      governor.authorize({ ...proposal, amountLamports: 101_000_000n }, portfolio, safety, now)
        .reasons,
    ).toContain("MAX_SOL_PER_TRADE");
  });
});

describe("final exit risk authority", () => {
  const exit = {
    orderId: "exit1",
    mint: "mint",
    quantityRaw: 500n,
    positionQuantityRaw: 1000n,
    feeLamports: 10_000n,
    quoteObservedAt: now,
    slippageBps: 100,
    impactBps: 10,
  };
  it("allows a balance-limited partial liquidation even during a global entry kill switch", () => {
    const governor = new RiskGovernor();
    governor.kill();
    expect(governor.authorizeExit(exit, now)).toMatchObject({
      allowed: true,
      reasons: ["RISK_EXIT_APPROVED"],
      expiresAt: now + DEFAULT_RISK_LIMITS.authorizationTtlMs,
    });
  });
  it.each([
    [{ orderId: "" }, "DUPLICATE_OR_INVALID_EXIT"],
    [{ quantityRaw: 1001n }, "EXIT_EXCEEDS_CONFIRMED_POSITION"],
    [{ quantityRaw: 0n }, "EXIT_EXCEEDS_CONFIRMED_POSITION"],
    [{ feeLamports: 1_000_001n }, "EXIT_FEE_BUDGET_EXCEEDED"],
    [{ feeLamports: -1n }, "EXIT_FEE_BUDGET_EXCEEDED"],
    [{ quoteObservedAt: now - 5001 }, "EXIT_QUOTE_STALE_OR_FUTURE"],
    [{ quoteObservedAt: now + 1 }, "EXIT_QUOTE_STALE_OR_FUTURE"],
    [{ slippageBps: 101 }, "EXIT_SLIPPAGE_LIMIT"],
    [{ impactBps: null }, "EXIT_PRICE_IMPACT_UNKNOWN_OR_HIGH"],
    [{ impactBps: 201 }, "EXIT_PRICE_IMPACT_UNKNOWN_OR_HIGH"],
  ] as const)("enforces executable-exit safety for %s", (patch, reason) => {
    const verdict = new RiskGovernor().authorizeExit({ ...exit, ...patch }, now);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons).toContain(reason);
  });
  it("rejects an already completed order id reused as an exit", () => {
    const governor = new RiskGovernor();
    governor.authorize(proposal, portfolio, safety, now);
    governor.complete(proposal.orderId, now);
    expect(governor.authorizeExit({ ...exit, orderId: proposal.orderId }, now).reasons).toContain(
      "DUPLICATE_OR_INVALID_EXIT",
    );
  });
});

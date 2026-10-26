import { describe, it, expect } from "vitest";
import {
  completedSummary,
  researchSummary,
  horizonSummary,
  verificationLabel,
} from "../app/analytics";
import type { CompletedPosition, ResearchObservation } from "../app/state";
const position = (pnlLamports: string): CompletedPosition => ({
  positionId: "synthetic-position",
  mint: "fixture",
  strategy: "fixture",
  openedAt: 0,
  closedAt: 100,
  quantityRaw: "100",
  costLamports: "1000",
  proceedsLamports: (1000n + BigInt(pnlLamports) + 20n).toString(),
  feesLamports: "20",
  pnlLamports,
  exitLegs: 2,
  finalReason: "STOP",
});
describe("position-level performance reporting", () => {
  it("does not invent completed positions from missing attribution", () => {
    expect(completedSummary(undefined)).toEqual({
      count: null,
      winRate: null,
      netLamports: null,
      feesLamports: null,
    });
  });
  it("counts each fully closed position once even with several realized legs", () => {
    // The engine has combined a profitable first leg and larger losing final leg into net -100.
    const summary = completedSummary([position("-100")]);
    expect(summary.count).toBe(1);
    expect(summary.winRate).toBe(0);
    expect(summary.netLamports).toBe("-100");
  });
  it("calculates win rate from complete net position outcomes only", () => {
    const summary = completedSummary([position("100"), { ...position("-50"), positionId: "p2" }]);
    expect(summary.winRate).toBe(0.5);
    expect(summary.netLamports).toBe("50");
    expect(summary.feesLamports).toBe("40");
  });
  it("keeps a zero sample win rate unknown", () => {
    expect(completedSummary([]).winRate).toBeNull();
  });
});
describe("typed transaction evidence labels", () => {
  it("does not claim full transaction verification for typed events", () => {
    expect(
      verificationLabel({ verification: "TYPED_PROGRAM_EVENT", fullTransactionVerified: false }),
    ).toBe("Typed event · awaiting full transaction");
  });
  it("shows verification unavailable for legacy unknown events", () => {
    expect(verificationLabel({})).toBe("Verification unavailable");
  });
  it("accepts explicit full verification evidence", () => {
    expect(verificationLabel({ verification: "FULL_TRANSACTION" })).toBe(
      "Full transaction verified",
    );
  });
});
describe("observed quote costs", () => {
  const sample = (
    id: string,
    cost: number | undefined,
    status: "QUOTED" | "UNAVAILABLE",
  ): ResearchObservation => ({
    id,
    mint: "fixture",
    signature: "1".repeat(64),
    slot: 1,
    eventObservedAt: 0,
    startedAt: 1,
    scope: "RESEARCH_QUOTE_ONLY_NO_TRADE",
    amountLamports: "10000",
    modeledNetworkFeesLamports: "20",
    slippageBpsPerLeg: 100,
    completedAt: 2,
    latencyMs: 1,
    status,
    conservativeRoundTripCostBps: cost,
  });
  it("does not turn unavailable quotes into zero cost samples", () => {
    const result = researchSummary([
      sample("a", 100, "QUOTED"),
      sample("b", undefined, "UNAVAILABLE"),
      sample("c", 200, "QUOTED"),
    ]);
    expect(result).toEqual({ samples: 3, quoted: 2, unavailable: 1, medianCostBps: 150 });
  });
  it("keeps missing costs unknown", () => {
    expect(researchSummary(undefined).medianCostBps).toBeNull();
    expect(researchSummary([]).medianCostBps).toBeNull();
  });
  it("excludes quote-only horizons from baseline median costs and counts", () => {
    const base = sample("base", 100, "QUOTED"),
      horizon = {
        ...sample("horizon", undefined, "QUOTED"),
        phase: "HORIZON" as const,
        horizonMs: 30000,
        hypotheticalHorizonReturnBps: 500,
        delayPastTargetMs: 1000,
      };
    expect(researchSummary([base, horizon])).toEqual({
      samples: 1,
      quoted: 1,
      unavailable: 0,
      medianCostBps: 100,
    });
    expect(horizonSummary([base, horizon])[0]).toMatchObject({
      samples: 1,
      quoted: 1,
      medianHypotheticalReturnBps: 500,
      maximumDelayMs: 1000,
    });
  });
  it("keeps missing horizon outcomes and delays unknown", () => {
    expect(horizonSummary(undefined)[0].medianHypotheticalReturnBps).toBeNull();
    const missing = {
      ...sample("h", undefined, "UNAVAILABLE"),
      phase: "HORIZON" as const,
      horizonMs: 30000,
    };
    expect(horizonSummary([missing])[0]).toMatchObject({
      quoted: 0,
      unavailable: 1,
      medianHypotheticalReturnBps: null,
      maximumDelayMs: null,
    });
  });
});

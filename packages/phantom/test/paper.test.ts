/** Every quote, timestamp, token and balance below is a synthetic fixture. No real transaction is sent. */
import { describe, it, expect, vi } from "vitest";
import {
  PaperLedger,
  restoreLedger,
  aggregateCompletedPositions,
  type PaperTrade,
} from "../src/paper.ts";
import { RiskGovernor, DEFAULT_RISK_LIMITS, type SafetyVerdict } from "../src/risk.ts";
import { WSOL, json } from "../src/types.ts";
import type { Quote } from "../src/execution.ts";

const INITIAL = 1_000_000_000n,
  COST = 10_000_001n,
  ENTRY_FEE = 101n;
const MINT = "SYNTHETIC_PAPER_MINT";
function quote(
  inputMint: string,
  outputMint: string,
  input: bigint,
  minimum: bigint,
  at: number,
  overrides: Partial<Quote> = {},
): Quote {
  return {
    inputMint,
    outputMint,
    inAmount: input.toString(),
    outAmount: minimum.toString(),
    minOutAmount: minimum.toString(),
    observedAt: at,
    impactBps: 50,
    contextSlot: 123,
    route: ["SYNTHETIC TEST ROUTE"],
    ...overrides,
  };
}
function safety(now: number): SafetyVerdict {
  return {
    mint: MINT,
    allowed: true,
    checkedAt: now,
    expiresAt: now + 30_000,
    reasons: ["SYNTHETIC_VERIFIED_FIXTURE"],
  };
}
function fixture() {
  const governor = new RiskGovernor({ ...DEFAULT_RISK_LIMITS });
  const ledger = new PaperLedger(INITIAL, governor);
  ledger.queue(
    {
      id: "entry-1",
      mint: MINT,
      strategy: "launch-sniper",
      amountLamports: COST,
      eventId: "SYNTHETIC-EVENT",
    },
    0,
    2000,
  );
  return {
    ledger,
    governor,
    order: ledger.state.pending[0],
    entryQuote: quote(WSOL, MINT, COST, 1001n, 2000),
  };
}
function entered() {
  const f = fixture();
  expect(
    f.ledger.fill(f.order, f.entryQuote, safety(2000), 100_000_000_000n, ENTRY_FEE, 2000).allowed,
  ).toBe(true);
  return { ...f, position: f.ledger.state.positions[0] };
}
function saved(value: unknown) {
  return JSON.parse(json(value));
}

describe("paper settlement with synthetic quote evidence", () => {
  it("enforces the configured minimum delay and observes a new quote after readiness", () => {
    const f = fixture();
    expect(() =>
      f.ledger.fill(
        f.order,
        { ...f.entryQuote, observedAt: 1999 },
        safety(2000),
        100_000_000_000n,
        ENTRY_FEE,
        2000,
      ),
    ).toThrow("DELAY");
    expect(() =>
      f.ledger.fill(f.order, f.entryQuote, safety(2000), 100_000_000_000n, ENTRY_FEE, 1999),
    ).toThrow("DELAY");
    expect(() =>
      f.ledger.queue(
        { id: "fast", mint: "OTHER", strategy: "test", amountLamports: COST, eventId: "x" },
        0,
        0,
      ),
    ).toThrow("MINIMUM_EXECUTION_DELAY");
    expect(f.ledger.state.positions).toHaveLength(0);
    expect(f.ledger.state.cashLamports).toBe(INITIAL);
  });
  it("uses exact minimum output as fill quantity and charges the separate entry fee once", () => {
    const f = fixture(),
      q = { ...f.entryQuote, outAmount: "1011" };
    expect(f.ledger.fill(f.order, q, safety(2000), 100_000_000_000n, ENTRY_FEE, 2000).allowed).toBe(
      true,
    );
    expect(f.ledger.state.positions[0].quantityRaw).toBe(1001n);
    expect(f.ledger.state.cashLamports).toBe(INITIAL - COST - ENTRY_FEE);
    expect(f.ledger.equity(2000)).toBeNull();
    expect(f.ledger.state.equity.at(-1)?.equityLamports).toBeNull();
  });
  it("cannot substitute a cheaper same-id pending order to bypass the governor", () => {
    const f = fixture();
    expect(() =>
      f.ledger.fill(
        { ...f.order, amountLamports: 1n },
        quote(WSOL, MINT, 1n, 1001n, 2000),
        safety(2000),
        100_000_000_000n,
        ENTRY_FEE,
        2000,
      ),
    ).toThrow("CONTENT_MISMATCH");
    expect(f.ledger.state.cashLamports).toBe(INITIAL);
  });
  it.each([
    [{ inputMint: "WRONG" }, "MISMATCH"],
    [{ inAmount: "1" }, "MISMATCH"],
    [{ observedAt: 2001 }, "MISMATCH"],
    [{ outAmount: "100000", minOutAmount: "1" }, "SLIPPAGE"],
    [{ outAmount: "1.5" }, "INTEGER"],
  ] as const)("rejects malformed or weaker-than-configured fill quote %#", (override, message) => {
    const f = fixture();
    expect(() =>
      f.ledger.fill(
        f.order,
        { ...f.entryQuote, ...override },
        safety(2000),
        100_000_000_000n,
        ENTRY_FEE,
        2000,
      ),
    ).toThrow(message);
    expect(f.ledger.state.positions).toHaveLength(0);
  });
  it("rechecks the final governor state and cannot settle after a kill", () => {
    const f = fixture();
    f.governor.kill();
    const veto = f.ledger.fill(
      f.order,
      f.entryQuote,
      safety(2000),
      100_000_000_000n,
      ENTRY_FEE,
      2000,
    );
    expect(veto.allowed).toBe(false);
    expect(veto.reasons).toContain("GLOBAL_KILL_SWITCH");
    expect(f.ledger.state.cashLamports).toBe(INITIAL);
    expect(f.ledger.state.pending).toHaveLength(1);
    const late = fixture();
    const authorize = late.governor.authorize.bind(late.governor);
    vi.spyOn(late.governor, "authorize").mockImplementation((...args) => {
      const result = authorize(...args);
      late.ledger.state.killSwitch = true;
      return result;
    });
    expect(() =>
      late.ledger.fill(
        late.order,
        late.entryQuote,
        safety(2000),
        100_000_000_000n,
        ENTRY_FEE,
        2000,
      ),
    ).toThrow("FINAL_PAPER_RISK");
    expect(late.ledger.state.cashLamports).toBe(INITIAL);
    expect(late.governor.pendingCount(2000)).toBe(0);
  });
  it("rejects stale safety and caps network fees without any economic mutation", () => {
    const f = fixture();
    expect(() =>
      f.ledger.fill(f.order, f.entryQuote, safety(2000), 100_000_000_000n, -1n, 2000),
    ).toThrow("FEE_BUDGET");
    expect(() =>
      f.ledger.fill(
        f.order,
        f.entryQuote,
        safety(2000),
        100_000_000_000n,
        DEFAULT_RISK_LIMITS.maxFeeLamports + 1n,
        2000,
      ),
    ).toThrow("FEE_BUDGET");
    expect(
      f.ledger.fill(
        f.order,
        f.entryQuote,
        { ...safety(2000), expiresAt: 1999 },
        100_000_000_000n,
        ENTRY_FEE,
        2000,
      ).allowed,
    ).toBe(false);
    expect(f.ledger.state.cashLamports).toBe(INITIAL);
  });
  it("restores a queued entry and prevents duplicate fills across restart", () => {
    const f = fixture(),
      snapshot = saved(f.ledger.state);
    const restored = new PaperLedger(INITIAL, new RiskGovernor(), restoreLedger(snapshot));
    const order = restored.state.pending[0];
    expect(
      restored.fill(order, f.entryQuote, safety(2000), 100_000_000_000n, ENTRY_FEE, 2000).allowed,
    ).toBe(true);
    const restart = new PaperLedger(
      INITIAL,
      new RiskGovernor(),
      restoreLedger(saved(restored.state)),
    );
    expect(() =>
      restart.fill(order, f.entryQuote, safety(2000), 100_000_000_000n, ENTRY_FEE, 2000),
    ).toThrow("NOT_PENDING");
    expect(restart.queue({ ...order }, 3000, 2000)).toBe(false);
    expect(restart.state.positions).toHaveLength(1);
    expect(restart.state.cashLamports).toBe(INITIAL - COST - ENTRY_FEE);
  });
  it("rejects a restored pending order that shortens the mandatory delay", () => {
    const f = fixture(),
      snapshot = saved(f.ledger.state);
    snapshot.pending[0].readyAt = 1;
    expect(() => new PaperLedger(INITIAL, new RiskGovernor(), restoreLedger(snapshot))).toThrow(
      "DELAY_POLICY_VIOLATION",
    );
  });
});

describe("quote marks and delayed protective exits with synthetic data", () => {
  it.each([null, NaN, -1, DEFAULT_RISK_LIMITS.maxImpactBps + 1])(
    "does not turn inadmissible impact %s into liquidation equity or a trailing peak",
    (impactBps) => {
      const { ledger, position } = entered();
      ledger.mark(position, quote(MINT, WSOL, 1001n, 11_000_000n, 3000), 10000n, 3000);
      const positionPeak = position.peakLamports;
      const portfolioPeak = ledger.state.peakEquityLamports;
      expect(() => ledger.mark(position,
        quote(MINT, WSOL, 1001n, 20_000_000n, 3001, { impactBps }), 10000n, 3001,
      )).toThrow("PAPER_MARK_RISK_VETO");
      expect(position.markLamports).toBeNull();
      expect(ledger.equity(3001)).toBeNull();
      expect(position.peakLamports).toBe(positionPeak);
      expect(ledger.state.peakEquityLamports).toBe(portfolioPeak);
      ledger.mark(position, quote(MINT, WSOL, 1001n, 17_000_000n, 3002), 10000n, 3002);
      expect(ledger.exitReason(position, 3002)?.reason).not.toBe("TRAILING_STOP");
    },
  );
  it("keeps emergency and maximum-hold intent available with an unknown liquidation value", () => {
    const { ledger, position, governor } = entered();
    expect(position.markLamports).toBeNull();
    expect(ledger.exitReason(position, 302000)).toEqual({ reason: "MAX_HOLD", bps: 10000 });
    governor.kill();
    expect(ledger.exitReason(position, 302000)).toEqual({ reason: "EMERGENCY_SHUTDOWN", bps: 10000 });
  });
  it("supersedes a pending profit slice with a delayed full emergency exit without filling the old quote", () => {
    const { ledger, position, governor } = entered();
    const partial = ledger.queueExit(position, 500n, "PARTIAL_PROFIT", 3000, 2000)!;
    governor.kill();
    const full = ledger.queueRequiredExit(position, 4000, 2000)!;
    expect(full).toMatchObject({ quantityRaw: 1001n, reason: "EMERGENCY_SHUTDOWN", readyAt: 6000 });
    expect(full.id).not.toBe(partial.id);
    expect(ledger.queueRequiredExit(position, 5000, 2000)).toBe(full);
    expect(() => ledger.close(position, quote(MINT, WSOL, 500n, 6_000_000n, 5000),
      500n, 10000n, partial.reason, 5000, partial.id)).toThrow("NOT_PENDING_OR_MISMATCH");
    expect(() => ledger.close(position, quote(MINT, WSOL, 1001n, 10_000_000n, 5999),
      1001n, 10000n, full.reason, 5999, full.id)).toThrow("PAPER_DELAY_NOT_OBSERVED");
    const restored = new PaperLedger(INITIAL, new RiskGovernor(), restoreLedger(saved(ledger.state)));
    expect(restored.state.pendingExits[0]).toEqual(full);
    ledger.close(position, quote(MINT, WSOL, 1001n, 10_000_000n, 6000),
      1001n, 10000n, full.reason, 6000, full.id);
    expect(ledger.state.positions).toEqual([]);
    expect(ledger.state.trades).toHaveLength(1);
  });
  it("preserves the pending slice if a required replacement has an invalid delay", () => {
    const { ledger, position, governor } = entered();
    const partial = ledger.queueExit(position, 500n, "PARTIAL_PROFIT", 3000, 2000)!;
    governor.kill();
    expect(() => ledger.queueRequiredExit(position, 4000, 1)).toThrow("MINIMUM_EXECUTION_DELAY");
    expect(ledger.state.pendingExits).toEqual([partial]);
  });
  it("counts a profitable partial plus a larger losing final exit as one losing completed position", () => {
    const { ledger, position } = entered();
    const originalId = position.id;
    ledger.queueExit(position, 500n, "PARTIAL_PROFIT", 3000, 2000, "profitable-leg");
    const partial = ledger.close(
      position,
      quote(MINT, WSOL, 500n, 6_000_000n, 5000),
      500n,
      41n,
      "PARTIAL_PROFIT",
      5000,
      "profitable-leg",
    );
    expect(partial.pnlLamports).toBeGreaterThan(0n);
    expect(partial.positionId).toBe(originalId);
    expect(partial.isFinalExit).toBe(false);
    expect(aggregateCompletedPositions(ledger.state.trades)).toEqual([]);
    const realizedCashAfterPartial = ledger.state.cashLamports;
    expect(ledger.risk(5000).dailyRealizedPnlLamports).toBe(partial.pnlLamports);
    ledger.queueExit(position, position.quantityRaw, "STOP_LOSS", 6000, 2000, "losing-final-leg");
    const final = ledger.close(
      position,
      quote(MINT, WSOL, position.quantityRaw, 1_000_000n, 8000),
      position.quantityRaw,
      43n,
      "STOP_LOSS",
      8000,
      "losing-final-leg",
    );
    expect(final.pnlLamports).toBeLessThan(0n);
    expect(final.positionId).toBe(originalId);
    expect(final.isFinalExit).toBe(true);
    const positions = aggregateCompletedPositions(ledger.state.trades);
    expect(ledger.state.trades).toHaveLength(2);
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({
      positionId: originalId,
      quantityRaw: 1001n,
      exitLegs: 2,
      finalReason: "STOP_LOSS",
      costLamports: COST,
      proceedsLamports: 7_000_000n,
      feesLamports: ENTRY_FEE + 41n + 43n,
      pnlLamports: 7_000_000n - COST - ENTRY_FEE - 41n - 43n,
    });
    expect(positions.filter((p) => p.pnlLamports > 0n)).toHaveLength(0);
    expect(ledger.state.cashLamports).toBe(realizedCashAfterPartial + 1_000_000n - 43n);
    expect(ledger.state.cashLamports).toBe(INITIAL + positions[0].pnlLamports);
    expect(ledger.risk(8000).dailyRealizedPnlLamports).toBe(positions[0].pnlLamports);
    expect(aggregateCompletedPositions(restoreLedger(saved(ledger.state))!.trades)).toEqual(
      positions,
    );
  });
  it("keeps missing legacy closure/identity unknown and never creates a completed position from it", () => {
    const f = entered();
    f.ledger.queueExit(f.position, 1001n, "MAX_HOLD", 3000, 2000, "legacy-exit");
    f.ledger.close(
      f.position,
      quote(MINT, WSOL, 1001n, 8_000_000n, 5000),
      1001n,
      10n,
      "MAX_HOLD",
      5000,
      "legacy-exit",
    );
    const snapshot = saved(f.ledger.state);
    delete snapshot.trades[0].positionId;
    delete snapshot.trades[0].isFinalExit;
    const restored = restoreLedger(snapshot)!;
    expect(restored.trades[0].positionId).toBeNull();
    expect(restored.trades[0].isFinalExit).toBeNull();
    expect(restored.trades[0].pnlLamports).toBe(f.ledger.state.trades[0].pnlLamports);
    expect(aggregateCompletedPositions(restored.trades)).toEqual([]);
  });
  it("does not double count duplicated legs or merge different positions sharing a mint", () => {
    const leg: PaperTrade = {
      id: "leg-a",
      positionId: "position-a",
      isFinalExit: true,
      mint: MINT,
      strategy: "synthetic",
      openedAt: 1000,
      closedAt: 3000,
      costLamports: 100n,
      proceedsLamports: 90n,
      feesLamports: 1n,
      pnlLamports: -11n,
      reason: "STOP_LOSS",
      quantityRaw: 10n,
    };
    const next: PaperTrade = {
      ...leg,
      id: "leg-b",
      positionId: "position-b",
      openedAt: 4000,
      closedAt: 6000,
      proceedsLamports: 120n,
      pnlLamports: 19n,
    };
    const positions = aggregateCompletedPositions([next, leg, { ...leg }]);
    expect(positions).toHaveLength(2);
    expect(positions.map((p) => p.positionId)).toEqual(["position-a", "position-b"]);
    expect(positions[0].pnlLamports).toBe(-11n);
    expect(positions[1].pnlLamports).toBe(19n);
    expect(
      aggregateCompletedPositions([leg, { ...leg, proceedsLamports: 200n, pnlLamports: 99n }]),
    ).toEqual([]);
  });
  it("does not certify a final leg when earlier overlapping legacy realization cannot be grouped", () => {
    const final: PaperTrade = {
      id: "final",
      positionId: "position-a",
      isFinalExit: true,
      mint: MINT,
      strategy: "synthetic",
      openedAt: 1000,
      closedAt: 3000,
      costLamports: 100n,
      proceedsLamports: 120n,
      feesLamports: 1n,
      pnlLamports: 19n,
      reason: "FINAL",
      quantityRaw: 10n,
    };
    const legacy: PaperTrade = {
      ...final,
      id: "unknown-partial",
      positionId: null,
      isFinalExit: null,
      closedAt: 2000,
    };
    expect(aggregateCompletedPositions([legacy, final])).toEqual([]);
    expect(aggregateCompletedPositions([{ ...legacy, closedAt: 500 }, final])).toHaveLength(1);
  });
  it("unknown/stale marks are null equity while risk explicitly uses a conservative lower bound", () => {
    const { ledger, position } = entered();
    expect(ledger.equity(2000)).toBeNull();
    expect(ledger.conservativeEquity(2000)).toBe(ledger.state.cashLamports);
    ledger.mark(position, quote(MINT, WSOL, 1001n, 12_000_000n, 3000), 100n, 3000);
    expect(ledger.equity(3000)).toBe(ledger.state.cashLamports + 11_999_900n);
    expect(ledger.equity(8001)).toBeNull();
    ledger.recordEquity(8001);
    expect(ledger.state.equity.at(-1)?.equityLamports).toBeNull();
    expect(ledger.exitReason(position, 8001)).toBeNull();
    expect(() =>
      ledger.mark(position, quote(MINT, WSOL, 1001n, 12_000_000n, 3000), 100n, 8001, 999999),
    ).toThrow("STALE");
  });
  it("settles entry, executable mark, partial exit, and final exit with exact full-life P&L", () => {
    const { ledger, position } = entered();
    ledger.mark(position, quote(MINT, WSOL, 1001n, 20_000_000n, 3000), 100n, 3000);
    expect(ledger.exitReason(position, 3000)).toEqual({ reason: "PARTIAL_PROFIT", bps: 5000 });
    const peak = position.peakLamports;
    const partial = ledger.queueExit(position, 333n, "PARTIAL_PROFIT", 3000, 2000, "partial-1")!;
    const first = ledger.close(
      position,
      quote(MINT, WSOL, 333n, 8_000_000n, 5000),
      333n,
      41n,
      "PARTIAL_PROFIT",
      5000,
      partial.id,
    );
    expect(first.costLamports + position.costLamports).toBe(COST);
    expect(first.feesLamports - 41n + position.entryFeeLamports).toBe(ENTRY_FEE);
    expect(position.quantityRaw).toBe(668n);
    expect(position.peakLamports).toBe((peak * 668n) / 1001n);
    expect(position.markLamports).toBeNull();
    expect(ledger.equity(5000)).toBeNull();
    const final = ledger.queueExit(
      position,
      position.quantityRaw,
      "TRAILING_STOP",
      6000,
      2000,
      "final-1",
    )!;
    ledger.close(
      position,
      quote(MINT, WSOL, 668n, 9_000_000n, 8000),
      668n,
      43n,
      "TRAILING_STOP",
      8000,
      final.id,
    );
    const pnl = 17_000_000n - COST - ENTRY_FEE - 41n - 43n;
    expect(ledger.state.trades.reduce((sum, t) => sum + t.pnlLamports, 0n)).toBe(pnl);
    expect(ledger.state.trades.reduce((sum, t) => sum + t.costLamports, 0n)).toBe(COST);
    expect(ledger.state.trades.reduce((sum, t) => sum + t.feesLamports, 0n)).toBe(
      ENTRY_FEE + 41n + 43n,
    );
    expect(ledger.state.cashLamports).toBe(INITIAL + pnl);
    expect(ledger.equity(8000)).toBe(INITIAL + pnl);
    expect(ledger.state.positions).toHaveLength(0);
    expect(ledger.state.pendingExits).toHaveLength(0);
    expect(restoreLedger(saved(ledger.state))?.cashLamports).toBe(INITIAL + pnl);
  });
  it("preserves the quantity-adjusted trailing high-water through a partial sale", () => {
    const { ledger, position } = entered();
    ledger.mark(position, quote(MINT, WSOL, 1001n, 20_000_000n, 3000), 0n, 3000);
    ledger.queueExit(position, 500n, "PARTIAL_PROFIT", 3000, 2000, "profit");
    ledger.close(
      position,
      quote(MINT, WSOL, 500n, 10_000_000n, 5000),
      500n,
      0n,
      "PARTIAL_PROFIT",
      5000,
      "profit",
    );
    const high = position.peakLamports;
    ledger.mark(
      position,
      quote(MINT, WSOL, position.quantityRaw, (high * 89n) / 100n, 6000),
      0n,
      6000,
    );
    expect(ledger.exitReason(position, 6000)?.reason).toBe("TRAILING_STOP");
  });
  it("requires delayed exit quotes and matching queued quantity/reason before recording a sale", () => {
    const { ledger, position } = entered(),
      q = quote(MINT, WSOL, 1001n, 8_000_000n, 5000);
    expect(() => ledger.close(position, q, 1001n, 10n, "STOP_LOSS", 5000)).toThrow(
      "EXIT_NOT_PENDING",
    );
    ledger.queueExit(position, 1001n, "STOP_LOSS", 4000, 2000, "stop");
    expect(() => ledger.close(position, q, 1001n, 10n, "STOP_LOSS", 6000, "stop")).toThrow("DELAY");
    expect(() =>
      ledger.close(position, { ...q, observedAt: 6000 }, 1000n, 10n, "STOP_LOSS", 6000, "stop"),
    ).toThrow("MISMATCH");
    expect(ledger.state.trades).toHaveLength(0);
    expect(ledger.state.positions).toHaveLength(1);
  });
  it("exit governor vetoes unknown impact and excess fees; pending position remains unresolved", () => {
    const { ledger, position } = entered();
    ledger.queueExit(position, 1001n, "STOP_LOSS", 3000, 2000, "stop");
    const q = quote(MINT, WSOL, 1001n, 8_000_000n, 5000, { impactBps: null });
    expect(() => ledger.close(position, q, 1001n, 10n, "STOP_LOSS", 5000, "stop")).toThrow(
      "EXIT_RISK_VETO",
    );
    expect(() =>
      ledger.close(position, { ...q, impactBps: 1 }, 1001n, 2_000_000n, "STOP_LOSS", 5000, "stop"),
    ).toThrow("FEE_BUDGET");
    expect(ledger.state.trades).toHaveLength(0);
    expect(ledger.state.pendingExits).toHaveLength(1);
  });
  it("kill-switch blocks new entries but permits a bounded protective liquidation", () => {
    const { ledger, position, governor } = entered();
    ledger.mark(position, quote(MINT, WSOL, 1001n, 9_000_000n, 3000), 10n, 3000);
    ledger.state.killSwitch = true;
    governor.kill();
    expect(ledger.exitReason(position, 3000)?.reason).toBe("EMERGENCY_SHUTDOWN");
    ledger.queueExit(position, 1001n, "EMERGENCY_SHUTDOWN", 3000, 2000, "kill-exit");
    ledger.close(
      position,
      quote(MINT, WSOL, 1001n, 8_000_000n, 5000),
      1001n,
      10n,
      "EMERGENCY_SHUTDOWN",
      5000,
      "kill-exit",
    );
    expect(ledger.state.positions).toHaveLength(0);
    expect(ledger.state.trades[0].pnlLamports).toBe(8_000_000n - COST - ENTRY_FEE - 10n);
  });
  it("restores pending exits and invalidates stale current marks without losing historical trailing state", () => {
    const f = entered();
    f.ledger.mark(f.position, quote(MINT, WSOL, 1001n, 20_000_000n, 3000), 10n, 3000);
    f.ledger.queueExit(f.position, 1001n, "MAX_HOLD", 4000, 2000, "durable-exit");
    const restarted = new PaperLedger(
      INITIAL,
      new RiskGovernor(),
      restoreLedger(saved(f.ledger.state)),
    );
    const p = restarted.state.positions[0];
    expect(p.markLamports).toBeNull();
    expect(p.markAt).toBeNull();
    expect(p.peakLamports).toBe(19_999_990n);
    expect(restarted.state.pendingExits[0].id).toBe("durable-exit");
    restarted.close(
      p,
      quote(MINT, WSOL, 1001n, 15_000_000n, 6000),
      1001n,
      10n,
      "MAX_HOLD",
      6000,
      "durable-exit",
    );
    const again = new PaperLedger(
      INITIAL,
      new RiskGovernor(),
      restoreLedger(saved(restarted.state)),
    );
    expect(() =>
      again.close(
        p,
        quote(MINT, WSOL, 1001n, 15_000_000n, 6000),
        1001n,
        10n,
        "MAX_HOLD",
        6000,
        "durable-exit",
      ),
    ).toThrow("BALANCE_MISMATCH");
    expect(again.state.trades).toHaveLength(1);
    expect(again.state.completedOrderIds).toContain("durable-exit");
  });
  it("rejects corrupt saved accounting or duplicate order identifiers rather than creating capital", () => {
    const f = entered(),
      corrupt = saved(f.ledger.state);
    corrupt.cashLamports = String(BigInt(corrupt.cashLamports) + 1n);
    expect(() => restoreLedger(corrupt)).toThrow("CAPITAL_RECONCILIATION");
    const duplicate = saved(f.ledger.state);
    duplicate.completedOrderIds.push("entry-1");
    expect(() => restoreLedger(duplicate)).toThrow("DUPLICATE");
    expect(
      () => new PaperLedger(INITIAL + 1n, new RiskGovernor(), restoreLedger(saved(f.ledger.state))),
    ).toThrow("INITIAL_CAPITAL_MISMATCH");
  });
});

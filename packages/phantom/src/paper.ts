import { randomUUID } from "node:crypto";
import { WSOL } from "./types.ts";
import { rawAmount, type Quote, type QuotePriority } from "./execution.ts";
import {
  RiskGovernor,
  type PortfolioRiskState,
  type SafetyVerdict,
  type TradeProposal,
} from "./risk.ts";

export type PaperPosition = {
  id: string;
  mint: string;
  strategy: string;
  quantityRaw: bigint;
  costLamports: bigint;
  openedAt: number;
  markLamports: bigint | null;
  markAt: number | null;
  peakLamports: bigint;
  partialTaken: boolean;
  entryFeeLamports: bigint;
};
export type PaperTrade = {
  id: string;
  /** Legacy realized legs without explicit identity/closure evidence remain unknown. */
  positionId: string | null;
  isFinalExit: boolean | null;
  mint: string;
  strategy: string;
  openedAt: number;
  closedAt: number;
  costLamports: bigint;
  proceedsLamports: bigint;
  feesLamports: bigint;
  pnlLamports: bigint;
  reason: string;
  quantityRaw?: bigint;
  exitOrderId?: string;
};
export type PendingEntry = {
  id: string;
  mint: string;
  strategy: string;
  amountLamports: bigint;
  createdAt: number;
  readyAt: number;
  eventId: string;
  slippageBps?: number;
};
export type PendingExit = {
  id: string;
  positionId: string;
  mint: string;
  quantityRaw: bigint;
  reason: string;
  createdAt: number;
  readyAt: number;
  slippageBps: number;
};
export type LedgerState = {
  initialLamports: bigint;
  cashLamports: bigint;
  peakEquityLamports: bigint;
  positions: PaperPosition[];
  trades: PaperTrade[];
  pending: PendingEntry[];
  pendingExits: PendingExit[];
  completedOrderIds: string[];
  equity: { at: number; equityLamports: bigint | null }[];
  failures: number;
  killSwitch: boolean;
};
export type QuoteProvider = {
  quote(input: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    slippageBps?: number;
    priority?: QuotePriority;
  }): Promise<Quote>;
};
export type PaperPolicy = { minExecutionDelayMs: number; maxQuoteAgeMs: number };
function timestamp(at: number) {
  if (!Number.isSafeInteger(at) || at < 0) throw Error("INVALID_LEDGER_TIMESTAMP");
}
function basisPoints(value: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
    throw Error("PAPER_SLIPPAGE_LIMIT");
  return value;
}

/** Synchronous economic mutations. Persist the entire state atomically after every mutation. */
export class PaperLedger {
  readonly state: LedgerState;
  readonly policy: Readonly<PaperPolicy>;
  constructor(
    initial: bigint,
    readonly governor: RiskGovernor,
    restored?: LedgerState,
    policy: Partial<PaperPolicy> = {},
  ) {
    if (initial <= 0n) throw Error("INITIAL_PAPER_CAPITAL_REQUIRED");
    this.policy = Object.freeze({
      minExecutionDelayMs: policy.minExecutionDelayMs ?? 2000,
      maxQuoteAgeMs: Math.min(
        policy.maxQuoteAgeMs ?? governor.limits.maxQuoteAgeMs,
        governor.limits.maxQuoteAgeMs,
      ),
    });
    for (const n of Object.values(this.policy))
      if (!Number.isSafeInteger(n) || n < 1) throw Error("INVALID_PAPER_EXECUTION_POLICY");
    const saved = restoreLedger(restored);
    if (saved && saved.initialLamports !== initial)
      throw Error("RESTORED_INITIAL_CAPITAL_MISMATCH");
    this.state = saved ?? {
      initialLamports: initial,
      cashLamports: initial,
      peakEquityLamports: initial,
      positions: [],
      trades: [],
      pending: [],
      pendingExits: [],
      completedOrderIds: [],
      equity: [],
      failures: 0,
      killSwitch: false,
    };
    for (const order of [...this.state.pending, ...this.state.pendingExits]) {
      if (order.readyAt - order.createdAt < this.policy.minExecutionDelayMs) {
        throw Error("RESTORED_DELAY_POLICY_VIOLATION");
      }
    }
  }
  /** Unknown/stale liquidation value means unknown equity, never an invented loss. */
  equity(now = Date.now()): bigint | null {
    timestamp(now);
    if (
      this.state.positions.some(
        (p) =>
          p.markLamports === null ||
          p.markAt === null ||
          p.markAt > now ||
          now - p.markAt > this.policy.maxQuoteAgeMs,
      )
    )
      return null;
    return (
      this.state.cashLamports + this.state.positions.reduce((sum, p) => sum + p.markLamports!, 0n)
    );
  }
  /** Explicit conservative lower bound, only for additional-entry risk checks. */
  conservativeEquity(now = Date.now()): bigint {
    timestamp(now);
    return (
      this.state.cashLamports +
      this.state.positions.reduce(
        (sum, p) =>
          sum +
          (p.markLamports !== null &&
          p.markAt !== null &&
          p.markAt <= now &&
          now - p.markAt <= this.policy.maxQuoteAgeMs
            ? p.markLamports
            : 0n),
        0n,
      )
    );
  }
  risk(now: number): PortfolioRiskState {
    timestamp(now);
    const day = new Date(now).toISOString().slice(0, 10);
    return {
      equityLamports: this.conservativeEquity(now),
      peakEquityLamports: this.state.peakEquityLamports,
      cashLamports: this.state.cashLamports,
      exposureLamports: this.state.positions.reduce((sum, p) => sum + p.costLamports, 0n),
      openPositions: this.state.positions.length,
      dailyRealizedPnlLamports: this.state.trades
        .filter((t) => new Date(t.closedAt).toISOString().startsWith(day))
        .reduce((sum, t) => sum + t.pnlLamports, 0n),
      consecutiveFailures: this.state.failures,
      killSwitch: this.state.killSwitch,
    };
  }
  queue(input: Omit<PendingEntry, "createdAt" | "readyAt">, now: number, delayMs: number) {
    timestamp(now);
    this.validateDelay(delayMs);
    rawAmount(input.amountLamports);
    if (!input.id || !input.mint || !input.strategy || !input.eventId)
      throw Error("INVALID_PAPER_ENTRY");
    const slippageBps = basisPoints(input.slippageBps ?? 100, this.governor.limits.maxSlippageBps);
    if (
      this.state.pending.some((p) => p.id === input.id || p.mint === input.mint) ||
      this.state.completedOrderIds.includes(input.id) ||
      this.state.positions.some((p) => p.mint === input.mint)
    )
      return false;
    timestamp(now + delayMs);
    this.state.pending.push({ ...input, slippageBps, createdAt: now, readyAt: now + delayMs });
    return true;
  }
  fill(
    order: PendingEntry,
    quote: Quote,
    safety: SafetyVerdict,
    liquidity: bigint | null,
    fee: bigint,
    now: number,
  ) {
    timestamp(now);
    this.validateFee(fee);
    const pending = this.state.pending.find((p) => p.id === order.id);
    if (!pending || this.state.completedOrderIds.includes(order.id))
      throw Error("PAPER_ORDER_NOT_PENDING");
    for (const field of [
      "mint",
      "strategy",
      "amountLamports",
      "createdAt",
      "readyAt",
      "eventId",
    ] as const)
      if (order[field] !== pending[field]) throw Error("PAPER_ORDER_CONTENT_MISMATCH");
    if (this.state.positions.some((p) => p.mint === pending.mint))
      throw Error("PAPER_POSITION_ALREADY_OPEN");
    this.validateReady(pending, quote, now);
    const { min } = this.validateQuote(
      quote,
      WSOL,
      pending.mint,
      pending.amountLamports,
      now,
      pending.slippageBps ?? 100,
    );
    if (min <= 0n) throw Error("PAPER_ENTRY_HAS_NO_FILL_QUANTITY");
    const proposal: TradeProposal = {
      orderId: pending.id,
      mint: pending.mint,
      strategy: pending.strategy,
      amountLamports: pending.amountLamports,
      feeLamports: fee,
      liquidityLamports: liquidity,
      impactBps: quote.impactBps,
      slippageBps: pending.slippageBps ?? 100,
      quoteObservedAt: quote.observedAt,
    };
    const authorization = this.governor.authorize(proposal, this.risk(now), safety, now);
    if (!authorization.allowed) return authorization;
    try {
      if (
        this.state.killSwitch ||
        this.governor.isKilled() ||
        !Number.isSafeInteger(authorization.expiresAt) ||
        authorization.expiresAt < now ||
        authorization.reservedLamports !== pending.amountLamports + fee ||
        authorization.orderId !== pending.id ||
        authorization.mint !== pending.mint
      )
        throw Error("FINAL_PAPER_RISK_AUTHORIZATION_INVALID");
      if (this.state.cashLamports < pending.amountLamports + fee)
        throw Error("PAPER_CASH_BALANCE_MISMATCH");
      // No await/provider work occurs between final authorization consumption and settlement.
      this.governor.complete(pending.id, now);
    } catch (error) {
      this.governor.release(pending.id);
      throw error;
    }
    this.state.cashLamports -= pending.amountLamports + fee;
    this.state.positions.push({
      id: pending.id,
      mint: pending.mint,
      strategy: pending.strategy,
      quantityRaw: min,
      costLamports: pending.amountLamports,
      openedAt: now,
      markLamports: null,
      markAt: null,
      peakLamports: 0n,
      partialTaken: false,
      entryFeeLamports: fee,
    });
    this.state.pending = this.state.pending.filter((p) => p.id !== pending.id);
    this.state.completedOrderIds.push(pending.id);
    this.state.failures = 0;
    this.recordEquity(now);
    return authorization;
  }
  mark(
    position: PaperPosition,
    quote: Quote,
    fee: bigint,
    now: number,
    maxAgeMs = this.policy.maxQuoteAgeMs,
  ) {
    this.assertPosition(position);
    timestamp(now);
    try {
      this.validateFee(fee);
      const { min } = this.validateQuote(
        quote,
        position.mint,
        WSOL,
        position.quantityRaw,
        now,
        this.governor.limits.maxSlippageBps,
        Math.min(maxAgeMs, this.policy.maxQuoteAgeMs),
      );
      const authorization = this.governor.authorizeExit({
        orderId: `mark:${position.id}:${now}`,
        mint: position.mint,
        quantityRaw: position.quantityRaw,
        positionQuantityRaw: position.quantityRaw,
        feeLamports: fee,
        quoteObservedAt: quote.observedAt,
        slippageBps: this.governor.limits.maxSlippageBps,
        impactBps: quote.impactBps,
      }, now);
      if (!authorization.allowed)
        throw Error("PAPER_MARK_RISK_VETO:" + authorization.reasons.join(","));
      position.markLamports = min > fee ? min - fee : 0n;
      position.markAt = quote.observedAt;
      if (position.markLamports > position.peakLamports)
        position.peakLamports = position.markLamports;
      this.recordEquity(now);
    } catch (error) {
      // An inadmissible replacement is unavailable valuation evidence, even if
      // a previous mark has not yet aged out. Never turn it into a new peak.
      position.markLamports = null;
      position.markAt = null;
      this.recordEquity(now);
      throw error;
    }
  }
  /** Emergency and time-limit intent does not depend on an observable price. */
  requiredExitReason(p: PaperPosition, now: number) {
    this.assertPosition(p);
    timestamp(now);
    if (this.state.killSwitch || this.governor.isKilled())
      return { reason: "EMERGENCY_SHUTDOWN", bps: 10000 };
    if (now - p.openedAt >= 300000) return { reason: "MAX_HOLD", bps: 10000 };
    return null;
  }
  /** A pending profit slice cannot suppress a required full liquidation. A
   * replacement is a new decision and must observe its own complete delay. */
  queueRequiredExit(p: PaperPosition, now: number, delayMs: number): PendingExit | null {
    const required = this.requiredExitReason(p, now);
    if (!required) return null;
    const existing = this.state.pendingExits.find((exit) => exit.positionId === p.id);
    if (existing?.quantityRaw === p.quantityRaw) return existing;
    const previous = this.state.pendingExits;
    this.state.pendingExits = previous.filter((exit) => exit.positionId !== p.id);
    try {
      return this.queueExit(p, p.quantityRaw, required.reason, now, delayMs);
    } catch (error) {
      this.state.pendingExits = previous;
      throw error;
    }
  }
  exitReason(
    p: PaperPosition,
    now: number,
    signal?: {
      creatorSelling: boolean;
      imbalance: number | null;
      sellerConcentrationBps: number | null;
    },
  ) {
    this.assertPosition(p);
    timestamp(now);
    const required = this.requiredExitReason(p, now);
    if (required) return required;
    if (
      p.markAt === null ||
      p.markLamports === null ||
      p.markAt > now ||
      now - p.markAt > this.policy.maxQuoteAgeMs
    )
      return null;
    const mark = p.markLamports,
      basis = p.costLamports + p.entryFeeLamports;
    if (mark * 10000n <= basis * 8500n) return { reason: "STOP_LOSS", bps: 10000 };
    if (p.peakLamports > basis && mark * 10000n <= p.peakLamports * 9000n)
      return { reason: "TRAILING_STOP", bps: 10000 };
    if (signal?.creatorSelling || (signal?.sellerConcentrationBps ?? 0) >= 7000)
      return { reason: "CONCENTRATED_SELLING", bps: 10000 };
    if (signal?.imbalance != null && Number.isFinite(signal.imbalance) && signal.imbalance < -0.4)
      return { reason: "MOMENTUM_DETERIORATION", bps: 10000 };
    if (!p.partialTaken && mark * 2n >= basis * 3n) return { reason: "PARTIAL_PROFIT", bps: 5000 };
    return null;
  }
  queueExit(
    position: PaperPosition,
    quantity: bigint,
    reason: string,
    now: number,
    delayMs: number,
    id = `exit:${position.id}:${randomUUID()}`,
  ): PendingExit | null {
    this.assertPosition(position);
    timestamp(now);
    this.validateDelay(delayMs);
    rawAmount(quantity);
    if (quantity > position.quantityRaw || !id || !reason) throw Error("INVALID_PAPER_EXIT");
    if (this.state.completedOrderIds.includes(id)) return null;
    const existing = this.state.pendingExits.find((p) => p.positionId === position.id);
    if (existing) return existing;
    if (
      this.state.pendingExits.some((p) => p.id === id) ||
      this.state.pending.some((p) => p.id === id)
    )
      throw Error("DUPLICATE_PAPER_ORDER_ID");
    const order: PendingExit = {
      id,
      positionId: position.id,
      mint: position.mint,
      quantityRaw: quantity,
      reason,
      createdAt: now,
      readyAt: now + delayMs,
      slippageBps: this.governor.limits.maxSlippageBps,
    };
    timestamp(order.readyAt);
    this.state.pendingExits.push(order);
    return order;
  }
  close(
    p: PaperPosition,
    quote: Quote,
    quantity: bigint,
    fee: bigint,
    reason: string,
    now: number,
    exitOrderId?: string,
  ) {
    this.assertPosition(p);
    timestamp(now);
    this.validateFee(fee);
    rawAmount(quantity);
    if (quantity > p.quantityRaw) throw Error("PAPER_POSITION_BALANCE_MISMATCH");
    const pending = this.state.pendingExits.find(
      (order) =>
        order.positionId === p.id && (exitOrderId === undefined || order.id === exitOrderId),
    );
    if (
      !pending ||
      pending.mint !== p.mint ||
      pending.quantityRaw !== quantity ||
      pending.reason !== reason ||
      this.state.completedOrderIds.includes(pending.id)
    )
      throw Error("PAPER_EXIT_NOT_PENDING_OR_MISMATCH");
    this.validateReady(pending, quote, now);
    const { min: proceeds } = this.validateQuote(
      quote,
      p.mint,
      WSOL,
      quantity,
      now,
      pending.slippageBps,
    );
    if (this.state.cashLamports + proceeds < fee) throw Error("PAPER_EXIT_NETWORK_FEE_UNFUNDED");
    const authorization = this.governor.authorizeExit(
      {
        orderId: pending.id,
        mint: p.mint,
        quantityRaw: quantity,
        positionQuantityRaw: p.quantityRaw,
        feeLamports: fee,
        quoteObservedAt: quote.observedAt,
        slippageBps: pending.slippageBps,
        impactBps: quote.impactBps,
      },
      now,
    );
    if (
      !authorization.allowed ||
      !Number.isSafeInteger(authorization.expiresAt) ||
      authorization.expiresAt < now
    )
      throw Error("PAPER_EXIT_RISK_VETO:" + authorization.reasons.join(","));
    const beforeQuantity = p.quantityRaw,
      remaining = beforeQuantity - quantity,
      cost = (p.costLamports * quantity) / beforeQuantity,
      entryFee = (p.entryFeeLamports * quantity) / beforeQuantity;
    const trade: PaperTrade = {
      id: pending.id,
      positionId: p.id,
      isFinalExit: remaining === 0n,
      exitOrderId: pending.id,
      quantityRaw: quantity,
      mint: p.mint,
      strategy: p.strategy,
      openedAt: p.openedAt,
      closedAt: now,
      costLamports: cost,
      proceedsLamports: proceeds,
      feesLamports: entryFee + fee,
      pnlLamports: proceeds - cost - entryFee - fee,
      reason,
    };
    this.state.cashLamports += proceeds - fee;
    this.state.trades.push(trade);
    p.quantityRaw = remaining;
    p.costLamports -= cost;
    p.entryFeeLamports -= entryFee;
    p.partialTaken = true;
    // A sold-slice quote is not a quote for the remainder. Retain a quantity-rebased trailing high-water.
    p.markLamports = null;
    p.markAt = null;
    p.peakLamports = (p.peakLamports * remaining) / beforeQuantity;
    if (remaining === 0n)
      this.state.positions = this.state.positions.filter((position) => position !== p);
    this.state.pendingExits = this.state.pendingExits.filter((order) => order.id !== pending.id);
    this.state.completedOrderIds.push(pending.id);
    this.state.failures = 0;
    this.recordEquity(now);
    return trade;
  }
  private assertPosition(p: PaperPosition) {
    if (!this.state.positions.includes(p) || p.quantityRaw <= 0n)
      throw Error("PAPER_POSITION_BALANCE_MISMATCH");
  }
  private validateFee(fee: bigint) {
    if (typeof fee !== "bigint" || fee < 0n || fee > this.governor.limits.maxFeeLamports)
      throw Error("PAPER_FEE_BUDGET_EXCEEDED");
  }
  private validateDelay(delay: number) {
    if (!Number.isSafeInteger(delay) || delay < this.policy.minExecutionDelayMs)
      throw Error("PAPER_MINIMUM_EXECUTION_DELAY_REQUIRED");
  }
  private validateReady(order: { readyAt: number }, quote: Quote, now: number) {
    if (now < order.readyAt || quote.observedAt < order.readyAt)
      throw Error("PAPER_DELAY_NOT_OBSERVED");
  }
  private validateQuote(
    q: Quote,
    inputMint: string,
    outputMint: string,
    amount: bigint,
    now: number,
    slippage: number,
    maxAgeMs = this.policy.maxQuoteAgeMs,
  ) {
    timestamp(now);
    timestamp(q.observedAt);
    basisPoints(slippage, this.governor.limits.maxSlippageBps);
    if (
      !Number.isFinite(maxAgeMs) ||
      maxAgeMs < 1 ||
      q.observedAt > now ||
      now - q.observedAt > maxAgeMs ||
      q.inputMint !== inputMint ||
      q.outputMint !== outputMint ||
      rawAmount(q.inAmount) !== amount
    )
      throw Error("PAPER_QUOTE_UNKNOWN_STALE_OR_MISMATCH");
    const out = rawAmount(q.outAmount),
      min = rawAmount(q.minOutAmount, true);
    if (min > out || min < (out * BigInt(10000 - slippage)) / 10000n)
      throw Error("PAPER_QUOTE_SLIPPAGE_MISMATCH");
    return { out, min };
  }
  recordEquity(now: number) {
    const equity = this.equity(now);
    if (equity !== null && equity > this.state.peakEquityLamports)
      this.state.peakEquityLamports = equity;
    this.state.equity.push({ at: now, equityLamports: equity });
    if (this.state.equity.length > 10000) this.state.equity.shift();
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("INVALID_SAVED_LEDGER");
  return value as Record<string, unknown>;
}
function integer(value: unknown, signed = false) {
  if (
    (typeof value !== "bigint" && typeof value !== "string") ||
    !(signed ? /^-?(0|[1-9][0-9]*)$/ : /^(0|[1-9][0-9]*)$/).test(String(value))
  )
    throw Error("INVALID_SAVED_LEDGER_INTEGER");
  return BigInt(value);
}
function text(value: unknown) {
  if (typeof value !== "string" || !value) throw Error("INVALID_SAVED_LEDGER_TEXT");
  return value;
}
function time(value: unknown) {
  if (typeof value !== "number") throw Error("INVALID_SAVED_LEDGER_TIME");
  timestamp(value);
  return value;
}
function bool(value: unknown) {
  if (typeof value !== "boolean") throw Error("INVALID_SAVED_LEDGER_BOOLEAN");
  return value;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw Error("INVALID_SAVED_LEDGER_LIST");
  return value;
}
/** Validate durable accounting; preserve historical series but invalidate current marks on restart. */
export function restoreLedger(value: unknown): LedgerState | undefined {
  if (value === null || value === undefined) return undefined;
  const v = object(value);
  const positions: PaperPosition[] = list(v.positions).map((value) => {
    const p = object(value),
      quantityRaw = integer(p.quantityRaw);
    if (quantityRaw <= 0n) throw Error("INVALID_SAVED_POSITION_QUANTITY");
    return {
      id: text(p.id),
      mint: text(p.mint),
      strategy: text(p.strategy),
      quantityRaw,
      costLamports: integer(p.costLamports),
      openedAt: time(p.openedAt),
      markLamports: null,
      markAt: null,
      peakLamports: integer(p.peakLamports),
      partialTaken: bool(p.partialTaken),
      entryFeeLamports: integer(p.entryFeeLamports),
    };
  });
  const trades: PaperTrade[] = list(v.trades).map((value) => {
    const t = object(value),
      cost = integer(t.costLamports),
      proceeds = integer(t.proceedsLamports),
      fees = integer(t.feesLamports),
      pnl = integer(t.pnlLamports, true);
    if (pnl !== proceeds - cost - fees) throw Error("SAVED_TRADE_PNL_RECONCILIATION_FAILED");
    const openedAt = time(t.openedAt),
      closedAt = time(t.closedAt);
    if (closedAt < openedAt) throw Error("INVALID_SAVED_TRADE_TIME");
    return {
      id: text(t.id),
      positionId: t.positionId == null ? null : text(t.positionId),
      isFinalExit: t.isFinalExit == null ? null : bool(t.isFinalExit),
      mint: text(t.mint),
      strategy: text(t.strategy),
      openedAt,
      closedAt,
      costLamports: cost,
      proceedsLamports: proceeds,
      feesLamports: fees,
      pnlLamports: pnl,
      reason: text(t.reason),
      ...(t.quantityRaw === undefined ? {} : { quantityRaw: integer(t.quantityRaw) }),
      ...(t.exitOrderId === undefined ? {} : { exitOrderId: text(t.exitOrderId) }),
    };
  });
  const pending: PendingEntry[] = list(v.pending).map((value) => {
    const p = object(value),
      createdAt = time(p.createdAt),
      readyAt = time(p.readyAt),
      amountLamports = integer(p.amountLamports);
    if (readyAt <= createdAt || amountLamports <= 0n) throw Error("INVALID_SAVED_PENDING_ENTRY");
    return {
      id: text(p.id),
      mint: text(p.mint),
      strategy: text(p.strategy),
      eventId: text(p.eventId),
      createdAt,
      readyAt,
      amountLamports,
      slippageBps: p.slippageBps === undefined ? 100 : basisPoints(time(p.slippageBps), 10000),
    };
  });
  const pendingExits: PendingExit[] = list(v.pendingExits ?? []).map((value) => {
    const p = object(value),
      createdAt = time(p.createdAt),
      readyAt = time(p.readyAt),
      quantityRaw = integer(p.quantityRaw);
    if (readyAt <= createdAt || quantityRaw <= 0n) throw Error("INVALID_SAVED_PENDING_EXIT");
    return {
      id: text(p.id),
      positionId: text(p.positionId),
      mint: text(p.mint),
      quantityRaw,
      reason: text(p.reason),
      createdAt,
      readyAt,
      slippageBps: basisPoints(time(p.slippageBps), 10000),
    };
  });
  const completedOrderIds = list(v.completedOrderIds).map(text),
    allOrderIds = [
      ...pending.map((p) => p.id),
      ...pendingExits.map((p) => p.id),
      ...completedOrderIds,
    ];
  if (
    new Set(allOrderIds).size !== allOrderIds.length ||
    new Set(positions.map((p) => p.id)).size !== positions.length ||
    new Set(positions.map((p) => p.mint)).size !== positions.length ||
    new Set(pending.map((p) => p.mint)).size !== pending.length ||
    new Set(pendingExits.map((p) => p.positionId)).size !== pendingExits.length
  )
    throw Error("DUPLICATE_SAVED_LEDGER_ORDER");
  for (const order of pendingExits) {
    const position = positions.find((p) => p.id === order.positionId);
    if (!position || order.mint !== position.mint || order.quantityRaw > position.quantityRaw)
      throw Error("SAVED_EXIT_POSITION_MISMATCH");
  }
  const state: LedgerState = {
    initialLamports: integer(v.initialLamports),
    cashLamports: integer(v.cashLamports),
    peakEquityLamports: integer(v.peakEquityLamports),
    positions,
    trades,
    pending,
    pendingExits,
    completedOrderIds,
    equity: list(v.equity).map((value) => {
      const point = object(value);
      return {
        at: time(point.at),
        equityLamports: point.equityLamports === null ? null : integer(point.equityLamports),
      };
    }),
    failures: time(v.failures),
    killSwitch: bool(v.killSwitch),
  };
  if (state.initialLamports <= 0n || state.peakEquityLamports < state.initialLamports)
    throw Error("INVALID_SAVED_INITIAL_EQUITY");
  const accounted =
      state.cashLamports +
      state.positions.reduce((sum, p) => sum + p.costLamports + p.entryFeeLamports, 0n),
    expected = state.initialLamports + state.trades.reduce((sum, t) => sum + t.pnlLamports, 0n);
  if (accounted !== expected) throw Error("SAVED_LEDGER_CAPITAL_RECONCILIATION_FAILED");
  return state;
}

export type CompletedPaperPosition = {
  positionId: string;
  mint: string;
  strategy: string;
  openedAt: number;
  closedAt: number;
  quantityRaw: bigint | null;
  costLamports: bigint;
  proceedsLamports: bigint;
  feesLamports: bigint;
  pnlLamports: bigint;
  exitLegs: number;
  finalReason: string;
};

/**
 * Aggregate the FULL durable realized-leg history before any pagination. Partial realizations
 * affect cash and daily risk immediately, but are not completed positions or independent wins.
 * Unknown legacy grouping/closure evidence and inconsistent groups are deliberately excluded.
 */
export function aggregateCompletedPositions(legs: readonly PaperTrade[]): CompletedPaperPosition[] {
  const byId = new Map<string, PaperTrade>();
  const invalidGroups = new Set<string>();
  const groups = new Map<string, PaperTrade[]>();
  const ungroupedLegacy = legs.filter((leg) => !leg.positionId || leg.isFinalExit == null);
  for (const leg of legs) {
    if (!leg.positionId) continue;
    const previous = byId.get(leg.id);
    if (previous) {
      const identical = [
        "positionId",
        "isFinalExit",
        "mint",
        "strategy",
        "openedAt",
        "closedAt",
        "quantityRaw",
        "costLamports",
        "proceedsLamports",
        "feesLamports",
        "pnlLamports",
        "reason",
      ].every((field) => previous[field as keyof PaperTrade] === leg[field as keyof PaperTrade]);
      if (!identical) {
        invalidGroups.add(previous.positionId!);
        invalidGroups.add(leg.positionId);
      }
      continue;
    }
    byId.set(leg.id, leg);
    const group = groups.get(leg.positionId) ?? [];
    group.push(leg);
    groups.set(leg.positionId, group);
  }
  const completed: CompletedPaperPosition[] = [];
  for (const [positionId, group] of groups) {
    if (invalidGroups.has(positionId)) continue;
    const first = group[0],
      finals = group.filter((leg) => leg.isFinalExit === true);
    if (
      finals.length !== 1 ||
      group.some((leg) => leg.isFinalExit === null || leg.isFinalExit === undefined)
    )
      continue;
    const final = finals[0];
    // Do not assign legacy identities from coincident mint/timestamps. Their overlap is
    // sufficient to make coverage uncertain, so exclude the affected result instead.
    if (
      ungroupedLegacy.some(
        (leg) =>
          leg.mint === first.mint &&
          leg.strategy === first.strategy &&
          leg.closedAt >= first.openedAt &&
          leg.closedAt <= final.closedAt,
      )
    )
      continue;
    if (
      group.some(
        (leg) =>
          leg.mint !== first.mint ||
          leg.strategy !== first.strategy ||
          leg.openedAt !== first.openedAt ||
          !Number.isSafeInteger(leg.closedAt) ||
          leg.closedAt < leg.openedAt ||
          leg.closedAt > final.closedAt ||
          leg.costLamports < 0n ||
          leg.proceedsLamports < 0n ||
          leg.feesLamports < 0n ||
          leg.pnlLamports !== leg.proceedsLamports - leg.costLamports - leg.feesLamports,
      )
    )
      continue;
    const sum = (field: "costLamports" | "proceedsLamports" | "feesLamports" | "pnlLamports") =>
      group.reduce((total, leg) => total + leg[field], 0n);
    const quantityRaw = group.every((leg) => leg.quantityRaw !== undefined && leg.quantityRaw > 0n)
      ? group.reduce((total, leg) => total + leg.quantityRaw!, 0n)
      : null;
    completed.push({
      positionId,
      mint: first.mint,
      strategy: first.strategy,
      openedAt: first.openedAt,
      closedAt: final.closedAt,
      quantityRaw,
      costLamports: sum("costLamports"),
      proceedsLamports: sum("proceedsLamports"),
      feesLamports: sum("feesLamports"),
      pnlLamports: sum("pnlLamports"),
      exitLegs: group.length,
      finalReason: final.reason,
    });
  }
  return completed.sort(
    (a, b) => a.closedAt - b.closedAt || a.positionId.localeCompare(b.positionId),
  );
}

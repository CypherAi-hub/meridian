/** Prospective, isolated PAPER bookkeeping. This module never imports a signer or live executor. */
import { createHash } from "node:crypto";
import {
  PaperLedger,
  PAPER_EXIT_RULES,
  restoreLedger,
  validateResearchPaperQuote,
  type LedgerState,
  type QuoteProvider,
  type PendingExit,
} from "./paper.ts";
import { RiskGovernor, RESEARCH_PAPER_RISK_LIMITS, type TokenSafetyEvidence } from "./risk.ts";
import { evaluateStrategies, type SignalFeatures } from "./intelligence.ts";
import {
  validateResearchPaperPolicy,
  evaluateResearchPaperAdmission,
  type ResearchPaperPolicy,
  type ResearchPaperDecisionEvidence,
} from "./research-paper-policy.ts";
import { rawAmount, type Quote } from "./execution.ts";
import { json, WSOL } from "./types.ts";
import type { Store } from "./store.ts";

function canonical(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value === null || typeof value !== "object") {
    const text = JSON.stringify(value);
    if (text === undefined || (typeof value === "number" && !Number.isFinite(value)))
      throw Error("RESEARCH_MANIFEST_VALUE_INVALID");
    return text;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
function clock(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw Error("RESEARCH_CLOCK_INVALID");
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
const RUN_FIXED = {
  kind: "RESEARCH_PAPER_RUN_V1",
  mode: "RESEARCH_PAPER",
  strictPolicyEligible: false,
  liveApproved: false,
  settlementScope: "QUOTE_MINIMUM_MODEL_NOT_ATTAINABLE_FILL_CERTIFICATION",
  feeScope: "10000_LAMPORTS_PER_SETTLED_LEG_MODEL_NOT_MEASURED",
  priorityFeeScope: "INCLUDED_IN_FIXED_NETWORK_FEE_MODEL_NOT_MEASURED",
  rentScope: "NO_TOKEN_ACCOUNT_CREATED_RENT_EXCLUDED_FROM_PAPER_MODEL",
  failedAttemptScope: "NO_TRANSACTION_SUBMITTED_NO_ONCHAIN_FAILURE_FEE_MODELED",
  providerAllocation: "SHARED_JUPITER_LANE_PROTECTIVE_EXITS_FIRST",
  maximumQuoteCallsPerStep: 2,
  stopScope: "IRREVERSIBLE_BOOK_ENTRY_BARRIER_PROTECTIVE_EXITS_REMAIN_AVAILABLE",
  entryQuoteFailures: "CANCEL_ENTRY_WITHOUT_FILL_NO_AUTOMATIC_RESUBMISSION",
  exitQuoteFailures: "RETAIN_INVENTORY_AND_INTENT_WITH_UNKNOWN_MARK",
  observedUntil: "ENROLLMENT_END_THEN_CONTINUE_PROTECTIVE_EXITS",
} as const;
export type ResearchRunManifest = typeof RUN_FIXED & {
  readonly bookId: string;
  readonly policy: ResearchPaperPolicy;
  readonly enrollmentStart: number;
  readonly enrollmentEnd: number;
  readonly economicProfileHash: string;
  readonly exitProfileHash: string;
  readonly manifestHash: string;
};
/** No outcomes or configurable strategy thresholds are accepted. Freeze before new decisions. */
export function freezeResearchPaperRun(input: {
  bookId: string;
  policy: ResearchPaperPolicy;
  enrollmentStart: number;
  enrollmentEnd: number;
}): ResearchRunManifest {
  input = structuredClone(input);
  if (
    !input ||
    Object.keys(input).sort().join(",") !== "bookId,enrollmentEnd,enrollmentStart,policy"
  )
    throw Error("RESEARCH_RUN_INPUT_INVALID");
  const policy = validateResearchPaperPolicy(input.policy);
  clock(input.enrollmentStart);
  clock(input.enrollmentEnd);
  if (
    !/^[A-Za-z0-9_-]{1,80}$/.test(input.bookId) ||
    input.enrollmentStart < policy.frozenAt ||
    input.enrollmentEnd <= input.enrollmentStart
  )
    throw Error("RESEARCH_RUN_ID_OR_ENROLLMENT_INVALID");
  const body = {
    ...RUN_FIXED,
    ...input,
    policy,
    economicProfileHash: hash(RESEARCH_PAPER_RISK_LIMITS),
    exitProfileHash: hash(PAPER_EXIT_RULES),
  };
  return freeze({ ...body, manifestHash: hash(body) });
}
function validateRun(value: ResearchRunManifest) {
  value = structuredClone(value);
  const expected = freezeResearchPaperRun({
    bookId: value.bookId,
    policy: value.policy,
    enrollmentStart: value.enrollmentStart,
    enrollmentEnd: value.enrollmentEnd,
  });
  if (canonical(value) !== canonical(expected)) throw Error("RESEARCH_RUN_MANIFEST_MISMATCH");
  return expected;
}
export interface ResearchPaperDecision {
  captureId: string;
  sourceObservedAt: number;
  decisionAt: number;
  features: SignalFeatures;
  security: TokenSafetyEvidence;
  mintAccountCapture?: ResearchPaperDecisionEvidence["mintAccountCapture"];
}
type EntryStatus = "QUEUED" | "FILLED" | "REJECTED" | "EXPIRED" | "ENTRY_QUOTE_FAILED";
type EntryRecord = {
  id: string;
  decision: ResearchPaperDecision;
  status: EntryStatus;
  reasons: string[];
  fill?: { at: number; quote: Quote; evidence: ResearchPaperDecisionEvidence };
};
type JournalRecord = {
  sequence: number;
  at: number;
  bookId: string;
  kind:
    | "ENTRY_INTENT"
    | "ENTRY_SETTLED"
    | "ENTRY_CANCELLED"
    | "EXIT_INTENT"
    | "EXIT_UNAVAILABLE"
    | "EXIT_SETTLED"
    | "MARK_UNAVAILABLE"
    | "MARK_OBSERVED"
    | "EMERGENCY_STOP";
  entryId: string;
  reason?: string;
  intent?: PendingExit;
  mark?: { quote: Quote; feeLamports: string };
  exit?: {
    id: string;
    quantityRaw: string;
    proceedsLamports: string;
    feeLamports: string;
    quote: Quote;
  };
};
export interface ResearchBookEnvelope {
  schemaVersion: 1;
  manifest: ResearchRunManifest;
  ledgerVersion: number;
  ledger: LedgerState;
  entries: EntryRecord[];
  journal: JournalRecord[];
}
export interface ResearchRunnerControls {
  stopRequested?: () => boolean;
}
export interface ResearchStepControls {
  allowEntryQuotes?: boolean;
  allowPassiveMarks?: boolean;
}

type RunnerStore = Pick<
  Store,
  | "get"
  | "saveResearchPaperBook"
  | "assertWorkerLease"
  | "workerLeaseHealthy"
  | "workerLeaseEnforced"
>;

function reviveFeatures(input: SignalFeatures): SignalFeatures {
  const f = structuredClone(input);
  const signed = (v: unknown) => {
    if ((typeof v !== "string" && typeof v !== "bigint") || !/^-?(0|[1-9][0-9]*)$/.test(String(v)))
      throw Error("RESEARCH_SAVED_FEATURE_INTEGER_INVALID");
    return BigInt(v as string);
  };
  f.netInflowLamports = signed(f.netInflowLamports);
  f.liquidityLamports = signed(f.liquidityLamports);
  f.organic.effectiveBuyVolume = signed(f.organic.effectiveBuyVolume);
  return f;
}
function reviveEvidence(input: ResearchPaperDecisionEvidence): ResearchPaperDecisionEvidence {
  return { ...structuredClone(input), features: reviveFeatures(input.features) };
}
function reviveEntry(input: EntryRecord): EntryRecord {
  const e = structuredClone(input);
  e.decision.features = reviveFeatures(e.decision.features);
  if (e.fill) e.fill.evidence = reviveEvidence(e.fill.evidence);
  return e;
}

function validateDecision(d: ResearchPaperDecision, manifest: ResearchRunManifest, at: number) {
  const p = manifest.policy;
  for (const v of [at, d.decisionAt, d.sourceObservedAt, d.security.observedAt, d.features.asOf])
    clock(v);
  if (
    !/^[A-Za-z0-9:_-]{1,128}$/.test(d.captureId) ||
    d.features.mint !== d.security.mint ||
    d.features.asOf !== d.decisionAt ||
    d.decisionAt < manifest.enrollmentStart ||
    at >= manifest.enrollmentEnd ||
    d.decisionAt > at ||
    d.sourceObservedAt <= manifest.enrollmentStart ||
    d.sourceObservedAt > d.decisionAt ||
    d.security.observedAt > at ||
    at - d.decisionAt > p.maximumDecisionAgeMs
  )
    throw Error("RESEARCH_NEW_DECISION_IDENTITY_CLOCK_OR_ENROLLMENT_INVALID");
  if (
    !evaluateStrategies(d.features, {
      ...p.strategyRules,
      minimumLiquidityLamports: BigInt(p.minimumLiquidityLamports),
      maximumCostBps: p.maximumExecutionCostBps,
    }).some((x) => x.strategy === p.strategy && x.enter)
  )
    throw Error("RESEARCH_ORIGINAL_SIGNAL_REJECTED");
}

/** Independent cash/quantity and causal journal reconstruction, separate from ledger mutations. */
export function reconcileResearchPaper(envelope: ResearchBookEnvelope) {
  const manifest = validateRun(envelope.manifest),
    policy = manifest.policy;
  const ledger = restoreLedger(envelope.ledger)!;
  let cash = BigInt(policy.initialCapitalLamports),
    previousAt = -1;
  let killed = false;
  const positions = new Map<
    string,
    {
      quantity: bigint;
      cost: bigint;
      fee: bigint;
      mint: string;
      openedAt: number;
      peak: bigint;
      partial: boolean;
      mark: bigint | null;
      markAt: number | null;
    }
  >();
  const entries = new Map(envelope.entries.map((e) => [e.id, e]));
  const consumed = new Set<string>(),
    realizedIds = new Set<string>(),
    cancelled = new Set<string>();
  const intents = new Map<string, number>(),
    exits = new Map<string, PendingExit>(),
    exitIds = new Set<string>();
  const kinds = new Set([
    "ENTRY_INTENT",
    "ENTRY_SETTLED",
    "ENTRY_CANCELLED",
    "EXIT_INTENT",
    "EXIT_UNAVAILABLE",
    "EXIT_SETTLED",
    "MARK_UNAVAILABLE",
    "MARK_OBSERVED",
    "EMERGENCY_STOP",
  ]);
  let sequence = 1;
  for (const j of envelope.journal) {
    clock(j.at);
    if (
      j.bookId !== manifest.bookId ||
      j.sequence !== sequence++ ||
      j.at < previousAt ||
      !kinds.has(j.kind)
    )
      throw Error("RESEARCH_JOURNAL_IDENTITY_SEQUENCE_OR_TIME_MISMATCH");
    previousAt = j.at;
    if (j.kind === "EMERGENCY_STOP") {
      if (
        killed ||
        j.entryId !== "" ||
        typeof j.reason !== "string" ||
        !/^[A-Z0-9_]{1,80}$/.test(j.reason)
      )
        throw Error("RESEARCH_EMERGENCY_JOURNAL_INVALID");
      killed = true;
      continue;
    }
    const e = entries.get(j.entryId);
    if (!e) throw Error("RESEARCH_JOURNAL_ENTRY_MISSING");
    if (j.kind === "ENTRY_INTENT") {
      if (intents.has(e.id) || e.id !== `research:${manifest.bookId}:${e.decision.captureId}`)
        throw Error("RESEARCH_DUPLICATE_OR_WRONG_ENTRY_INTENT");
      validateDecision(
        { ...e.decision, features: reviveFeatures(e.decision.features) },
        manifest,
        j.at,
      );
      if (
        [...intents.keys()].filter((id) => !cancelled.has(id) && !consumed.has(id)).length +
          positions.size >=
        policy.maximumPositions
      )
        throw Error("RESEARCH_HISTORICAL_CAPACITY_EXCEEDED");
      intents.set(e.id, j.at);
    }
    if (!intents.has(e.id)) throw Error("RESEARCH_JOURNAL_PRECEDES_ENTRY_INTENT");
    if (j.kind === "ENTRY_CANCELLED") {
      if (cancelled.has(e.id) || consumed.has(e.id))
        throw Error("RESEARCH_INVALID_ENTRY_CANCELLATION");
      cancelled.add(e.id);
    }
    if (j.kind === "ENTRY_SETTLED") {
      if (killed) throw Error("RESEARCH_ENTRY_AFTER_EMERGENCY_STOP");
      if (!e.fill || e.status !== "FILLED" || consumed.has(e.id) || cancelled.has(e.id))
        throw Error("RESEARCH_DUPLICATE_OR_MISSING_FILL");
      const evidence = reviveEvidence(e.fill.evidence),
        d = e.decision;
      const admission = evaluateResearchPaperAdmission(policy, evidence, e.fill.at);
      const originalSecurity = {
        ...d.security,
        sellRouteAvailable: true,
        sellRouteObservedAt: evidence.pairedSell.observedAt,
      };
      if (
        !admission.allowedForResearch ||
        e.fill.at !== j.at ||
        evidence.captureId !== d.captureId ||
        evidence.decisionAt !== d.decisionAt ||
        evidence.sourceObservedAt !== d.sourceObservedAt ||
        canonical(evidence.features) !== canonical(d.features) ||
        canonical(evidence.security) !== canonical(originalSecurity) ||
        canonical(evidence.mintAccountCapture ?? null) !== canonical(d.mintAccountCapture ?? null)
      )
        throw Error("RESEARCH_SAVED_FILL_EVIDENCE_MISMATCH");
      const { inputLamports: _input, slippageBps: _slippage, ...admittedQuote } = evidence.quote;
      if (canonical(admittedQuote) !== canonical(e.fill.quote))
        throw Error("RESEARCH_SAVED_FILL_QUOTE_MISMATCH");
      const readyAt = intents.get(e.id)! + policy.minimumEntryDelayMs;
      validateResearchPaperQuote(
        e.fill.quote,
        WSOL,
        d.features.mint,
        BigInt(policy.entryLamports),
        policy,
        j.at,
        readyAt,
      );
      const cost = rawAmount(e.fill.quote.inAmount),
        quantity = rawAmount(e.fill.quote.minOutAmount),
        fee = BigInt(policy.networkFeePerLegLamports);
      if (positions.size || [...exits].length) throw Error("RESEARCH_HISTORICAL_CAPACITY_EXCEEDED");
      cash -= cost + fee;
      positions.set(e.id, {
        quantity,
        cost,
        fee,
        mint: d.features.mint,
        openedAt: j.at,
        peak: 0n,
        partial: false,
        mark: null,
        markAt: null,
      });
      consumed.add(e.id);
    }
    const position = positions.get(e.id);
    if (
      [
        "MARK_OBSERVED",
        "MARK_UNAVAILABLE",
        "EXIT_INTENT",
        "EXIT_UNAVAILABLE",
        "EXIT_SETTLED",
      ].includes(j.kind) &&
      !position
    )
      throw Error("RESEARCH_JOURNAL_POSITION_MISSING");
    if (j.kind === "MARK_OBSERVED") {
      const m = j.mark;
      if (!m || exits.has(e.id) || m.feeLamports !== policy.networkFeePerLegLamports)
        throw Error("RESEARCH_MARK_EVIDENCE_MISMATCH");
      const { min } = validateResearchPaperQuote(
        m.quote,
        position!.mint,
        WSOL,
        position!.quantity,
        policy,
        j.at,
      );
      const net = min > BigInt(m.feeLamports) ? min - BigInt(m.feeLamports) : 0n;
      position!.mark = net;
      position!.markAt = m.quote.observedAt;
      if (net > position!.peak) position!.peak = net;
    }
    if (j.kind === "MARK_UNAVAILABLE" || j.kind === "EXIT_UNAVAILABLE") {
      if (j.kind === "EXIT_UNAVAILABLE" && !exits.has(e.id))
        throw Error("RESEARCH_MISSING_EXIT_INTENT");
      position!.mark = null;
      position!.markAt = null;
    }
    if (j.kind === "EXIT_INTENT") {
      const x = j.intent,
        p = position!;
      if (
        !x ||
        !x.id ||
        exitIds.has(x.id) ||
        x.positionId !== e.id ||
        x.mint !== p.mint ||
        x.createdAt !== j.at ||
        x.readyAt !== x.createdAt + policy.minimumEntryDelayMs ||
        x.slippageBps !== policy.slippageBps
      )
        throw Error("RESEARCH_EXIT_INTENT_IDENTITY_DELAY_OR_PROFILE_INVALID");
      const quantity = rawAmount(x.quantityRaw);
      let expected: { reason: string; bps: number } | null = null;
      if (killed) expected = { reason: "EMERGENCY_SHUTDOWN", bps: 10000 };
      else if (j.at - p.openedAt >= PAPER_EXIT_RULES.maximumHoldMs)
        expected = { reason: "MAX_HOLD", bps: 10000 };
      else if (
        p.mark !== null &&
        p.markAt !== null &&
        j.at - p.markAt <= policy.maximumQuoteAgeMs
      ) {
        const basis = p.cost + p.fee;
        if (p.mark * 10000n <= basis * BigInt(PAPER_EXIT_RULES.stopLossRemainingBps))
          expected = { reason: "STOP_LOSS", bps: 10000 };
        else if (
          p.peak > basis &&
          p.mark * 10000n <= p.peak * BigInt(PAPER_EXIT_RULES.trailingRemainingBps)
        )
          expected = { reason: "TRAILING_STOP", bps: 10000 };
        else if (
          !p.partial &&
          p.mark * 10000n >= basis * BigInt(PAPER_EXIT_RULES.partialProfitReturnBps)
        )
          expected = { reason: "PARTIAL_PROFIT", bps: PAPER_EXIT_RULES.partialExitBps };
      }
      const expectedQuantity = expected ? (p.quantity * BigInt(expected.bps)) / 10000n : 0n;
      if (
        !expected ||
        x.reason !== expected.reason ||
        quantity !== (expectedQuantity > 0n ? expectedQuantity : p.quantity)
      )
        throw Error("RESEARCH_EXIT_INTENT_REASON_OR_QUANTITY_INVALID");
      if (
        exits.has(e.id) &&
        expected.reason !== "MAX_HOLD" &&
        expected.reason !== "EMERGENCY_SHUTDOWN"
      )
        throw Error("RESEARCH_EXIT_INTENT_SUPERSESSION_INVALID");
      exits.set(e.id, { ...x, quantityRaw: quantity });
      exitIds.add(x.id);
    }
    if (j.kind === "EXIT_SETTLED") {
      const p = position!,
        x = j.exit,
        intent = exits.get(e.id);
      if (!x || !intent || x.id !== intent.id || realizedIds.has(x.id))
        throw Error("RESEARCH_DUPLICATE_OR_UNOWNED_EXIT");
      const quantity = rawAmount(x.quantityRaw),
        proceeds = rawAmount(x.proceedsLamports, true),
        fee = BigInt(x.feeLamports);
      validateResearchPaperQuote(x.quote, p.mint, WSOL, quantity, policy, j.at, intent.readyAt);
      if (
        quantity !== intent.quantityRaw ||
        quantity > p.quantity ||
        fee.toString() !== policy.networkFeePerLegLamports ||
        x.quote.minOutAmount !== x.proceedsLamports
      )
        throw Error("RESEARCH_EXIT_EVIDENCE_MISMATCH");
      const cost = (p.cost * quantity) / p.quantity,
        entryFee = (p.fee * quantity) / p.quantity;
      const t = ledger.trades.find((t) => t.id === x.id);
      if (
        !t ||
        t.positionId !== e.id ||
        t.quantityRaw !== quantity ||
        t.costLamports !== cost ||
        t.proceedsLamports !== proceeds ||
        t.feesLamports !== entryFee + fee ||
        t.pnlLamports !== proceeds - cost - entryFee - fee ||
        t.closedAt !== j.at ||
        t.openedAt !== p.openedAt ||
        t.reason !== intent.reason ||
        t.isFinalExit !== (quantity === p.quantity)
      )
        throw Error("RESEARCH_REALIZED_LEG_RECONCILIATION_FAILED");
      cash += proceeds - fee;
      p.peak = (p.peak * (p.quantity - quantity)) / p.quantity;
      p.quantity -= quantity;
      p.cost -= cost;
      p.fee -= entryFee;
      p.partial = true;
      p.mark = null;
      p.markAt = null;
      if (p.quantity === 0n) positions.delete(e.id);
      exits.delete(e.id);
      realizedIds.add(x.id);
    }
    if (cash < 0n) throw Error("RESEARCH_NEGATIVE_RECONSTRUCTED_CASH");
  }
  if (
    cash !== ledger.cashLamports ||
    positions.size !== ledger.positions.length ||
    ledger.trades.length !== realizedIds.size ||
    exits.size !== ledger.pendingExits.length
  )
    throw Error("RESEARCH_CASH_POSITION_OR_EXIT_INTENT_RECONCILIATION_FAILED");
  for (const x of ledger.pendingExits)
    if (canonical(x) !== canonical(exits.get(x.positionId)))
      throw Error("RESEARCH_PENDING_EXIT_RECONCILIATION_FAILED");
  for (const p of ledger.positions) {
    const r = positions.get(p.id);
    if (
      !r ||
      p.quantityRaw !== r.quantity ||
      p.costLamports !== r.cost ||
      p.entryFeeLamports !== r.fee ||
      p.mint !== r.mint ||
      p.openedAt !== r.openedAt ||
      p.peakLamports !== r.peak ||
      p.partialTaken !== r.partial
    )
      throw Error("RESEARCH_INVENTORY_RECONCILIATION_FAILED");
  }
  if (ledger.killSwitch !== killed) throw Error("RESEARCH_KILL_STATE_RECONCILIATION_FAILED");
  const expectedCompleted = new Set([...consumed, ...realizedIds]);
  if (
    expectedCompleted.size !== ledger.completedOrderIds.length ||
    ledger.completedOrderIds.some((id) => !expectedCompleted.has(id))
  )
    throw Error("RESEARCH_COMPLETED_ORDER_RECONCILIATION_FAILED");
  for (const e of envelope.entries) {
    if (
      !["QUEUED", "FILLED", "REJECTED", "EXPIRED", "ENTRY_QUOTE_FAILED"].includes(e.status) ||
      !intents.has(e.id) ||
      (e.status === "FILLED") !== consumed.has(e.id) ||
      (e.status === "QUEUED") !== ledger.pending.some((p) => p.id === e.id) ||
      !["FILLED", "QUEUED"].includes(e.status) !== cancelled.has(e.id)
    )
      throw Error("RESEARCH_ENTRY_STATE_RECONCILIATION_FAILED");
  }
  if (
    entries.size !== envelope.entries.length ||
    ledger.pending.length + ledger.positions.length > policy.maximumPositions
  )
    throw Error("RESEARCH_CAPACITY_OR_ENTRY_IDENTITY_INVALID");
  for (const pending of ledger.pending) {
    const e = entries.get(pending.id);
    if (
      !e ||
      pending.eventId !== e.decision.captureId ||
      pending.mint !== e.decision.features.mint ||
      pending.createdAt !== intents.get(e.id) ||
      pending.readyAt !== pending.createdAt + policy.minimumEntryDelayMs ||
      pending.amountLamports.toString() !== policy.entryLamports ||
      pending.slippageBps !== policy.slippageBps
    )
      throw Error("RESEARCH_PENDING_DECISION_MISMATCH");
  }
  return {
    cashLamports: cash,
    openPositions: positions.size,
    realizedLegs: realizedIds.size,
    settledEntries: consumed.size,
  };
}

/** Call step from an owning worker's serial loop. It shares that worker's quote lane and Store lease. */
export class ResearchPaperRunner {
  readonly manifest: ResearchRunManifest;
  #ledger: PaperLedger;
  #entries: EntryRecord[];
  #journal: JournalRecord[];
  #version: number;
  #suspended = false;
  #busy = false;
  #idleWaiters: (() => void)[] = [];
  #entryBarrierClosed = false;
  #stopDirty = false;
  #stopRequested: () => boolean;
  #quoteCalls = 0;
  private constructor(
    private store: RunnerStore,
    private provider: QuoteProvider,
    manifest: ResearchRunManifest,
    private now: () => number,
    saved?: ResearchBookEnvelope,
    controls: ResearchRunnerControls = {},
  ) {
    const callback = controls.stopRequested;
    if (callback !== undefined && typeof callback !== "function")
      throw Error("RESEARCH_STOP_CALLBACK_INVALID");
    this.#stopRequested = callback ?? (() => false);
    this.manifest = validateRun(manifest);
    this.#entries = saved ? saved.entries.map(reviveEntry) : [];
    this.#journal = structuredClone(saved?.journal ?? []);
    this.#version = saved?.ledgerVersion ?? 0;
    if (!Number.isSafeInteger(this.#version) || this.#version < 0)
      throw Error("RESEARCH_LEDGER_VERSION_INVALID");
    const governor = new RiskGovernor(
      { ...RESEARCH_PAPER_RISK_LIMITS },
      { bookId: this.manifest.bookId, policy: this.manifest.policy },
    );
    this.#ledger = new PaperLedger(
      BigInt(this.manifest.policy.initialCapitalLamports),
      governor,
      saved?.ledger,
    );
    this.#entryBarrierClosed = this.#ledger.state.killSwitch;
    if (this.#entryBarrierClosed) governor.kill();
  }
  static async create(
    store: RunnerStore,
    provider: QuoteProvider,
    manifest: ResearchRunManifest,
    now = Date.now,
    controls: ResearchRunnerControls = {},
  ) {
    const runner = new ResearchPaperRunner(store, provider, manifest, now, undefined, controls);
    runner.assertLease();
    if (await store.get(runner.key)) throw Error("RESEARCH_BOOK_ALREADY_EXISTS_USE_RESTORE");
    const at = runner.time();
    if (at < runner.manifest.policy.frozenAt || at > runner.manifest.enrollmentStart)
      throw Error("RESEARCH_RUN_MUST_BE_FROZEN_BEFORE_ENROLLMENT");
    runner.observeEntryStop();
    await runner.checkpoint();
    return runner;
  }
  static async restore(
    store: RunnerStore,
    provider: QuoteProvider,
    manifest: ResearchRunManifest,
    now = Date.now,
    controls: ResearchRunnerControls = {},
  ) {
    const frozenControls = { stopRequested: controls.stopRequested };
    const expected = validateRun(manifest);
    if (!store.workerLeaseEnforced) throw Error("RESEARCH_WORKER_LEASE_REQUIRED");
    store.assertWorkerLease();
    const saved = (await store.get(
      `research-paper:${expected.bookId}`,
    )) as ResearchBookEnvelope | null;
    if (!saved) throw Error("RESEARCH_BOOK_MISSING_NO_CAPITAL_RESET");
    if (saved.schemaVersion !== 1 || canonical(saved.manifest) !== canonical(expected))
      throw Error("RESEARCH_BOOK_IDENTITY_MISMATCH");
    reconcileResearchPaper(saved);
    const runner = new ResearchPaperRunner(store, provider, expected, now, saved, frozenControls);
    runner.observeEntryStop();
    // PaperLedger invalidates all current marks on restart. Checkpoint that durable fact.
    await runner.checkpoint();
    return runner;
  }
  get key() {
    return `research-paper:${this.manifest.bookId}`;
  }
  get suspended() {
    return this.#suspended;
  }
  accountState() {
    const s = this.#ledger.state;
    const reserved = s.pending.reduce(
      (n, p) => n + p.amountLamports + BigInt(this.manifest.policy.networkFeePerLegLamports),
      0n,
    );
    return {
      bookId: this.manifest.bookId,
      mode: "RESEARCH_PAPER" as const,
      strictPolicyEligible: false,
      liveApproved: false,
      associationScope: this.manifest.policy.associationScope,
      cashLamports: s.cashLamports,
      reservedLamports: reserved,
      availableCashLamports: s.cashLamports - reserved,
      equityLamports: this.#ledger.equity(this.time()),
      realizedPnlLamports: s.trades.reduce((n, t) => n + t.pnlLamports, 0n),
      modeledSettledFeesLamports:
        BigInt(this.manifest.policy.networkFeePerLegLamports) *
        BigInt(
          this.#journal.filter((j) => j.kind === "ENTRY_SETTLED" || j.kind === "EXIT_SETTLED")
            .length,
        ),
      openPositions: s.positions.length,
      pendingEntries: s.pending.length,
      pendingExits: s.pendingExits.length,
      sourceHash: this.manifest.policy.sourceHash,
      policyHash: this.manifest.policy.manifestHash,
      runHash: this.manifest.manifestHash,
      emergencyStopLatched: this.#entryBarrierClosed,
      ledgerVersion: this.#version,
      suspended: this.#suspended,
    };
  }
  snapshot(): ResearchBookEnvelope {
    return structuredClone({
      schemaVersion: 1,
      manifest: this.manifest,
      ledgerVersion: this.#version,
      ledger: this.#ledger.state,
      entries: this.#entries,
      journal: this.#journal,
    });
  }
  private time() {
    const at = this.now();
    clock(at);
    return at;
  }
  private assertLease() {
    if (this.#suspended) throw Error("RESEARCH_RUN_SUSPENDED_RESTORE_DURABLE_STATE");
    if (!this.store.workerLeaseEnforced || !this.store.workerLeaseHealthy) {
      this.#suspended = true;
      throw Error("RESEARCH_WORKER_LEASE_REQUIRED_OR_LOST");
    }
    try {
      this.store.assertWorkerLease();
    } catch {
      this.#suspended = true;
      throw Error("RESEARCH_WORKER_LEASE_LOST");
    }
  }
  private append(
    kind: JournalRecord["kind"],
    entryId: string,
    exit?: JournalRecord["exit"],
    at = this.time(),
    intent?: PendingExit,
    mark?: JournalRecord["mark"],
    reason?: string,
  ) {
    clock(at);
    this.#journal.push({
      sequence: this.#journal.length + 1,
      at,
      bookId: this.manifest.bookId,
      kind,
      entryId,
      ...(exit ? { exit } : {}),
      ...(intent ? { intent: structuredClone(intent) } : {}),
      ...(mark ? { mark: structuredClone(mark) } : {}),
      ...(reason ? { reason } : {}),
    });
  }
  private async checkpoint() {
    this.assertLease();
    let audited = false;
    try {
      const next = this.snapshot();
      next.ledgerVersion++;
      reconcileResearchPaper(next);
      audited = true;
      const changed = await this.store.saveResearchPaperBook(
        this.key,
        next,
        this.#version === 0 ? null : this.#version,
        this.manifest.manifestHash,
      );
      if (!changed) throw Error("RESEARCH_BOOK_VERSION_CONFLICT");
      this.assertLease();
      this.#version = next.ledgerVersion;
      if (next.ledger.killSwitch) this.#stopDirty = false;
    } catch {
      this.#suspended = true;
      throw Error(
        audited
          ? "RESEARCH_PERSISTENCE_ACK_AMBIGUOUS_RESTORE_REQUIRED"
          : "RESEARCH_CHECKPOINT_AUDIT_FAILED_RESTORE_REQUIRED",
      );
    }
  }
  private finishWork() {
    this.#busy = false;
    for (const resolve of this.#idleWaiters.splice(0)) resolve();
  }
  private closeEntryBarrier(reason: string) {
    if (this.#entryBarrierClosed) return;
    this.#entryBarrierClosed = true;
    this.#ledger.governor.kill();
    this.#ledger.state.killSwitch = true;
    this.#stopDirty = true;
    const at = this.time();
    this.append("EMERGENCY_STOP", "", undefined, at, undefined, undefined, reason);
    for (const order of this.#ledger.state.pending) {
      const entry = this.#entries.find((e) => e.id === order.id)!;
      entry.status = "REJECTED";
      entry.reasons = ["BOOK_EMERGENCY_STOP"];
      this.append("ENTRY_CANCELLED", order.id, undefined, at);
    }
    this.#ledger.state.pending = [];
    for (const position of this.#ledger.state.positions) {
      const previous = this.#ledger.state.pendingExits.find((e) => e.positionId === position.id);
      const intent = this.#ledger.queueRequiredExit(
        position,
        at,
        this.manifest.policy.minimumEntryDelayMs,
      );
      if (intent && intent !== previous)
        this.append("EXIT_INTENT", position.id, undefined, at, intent);
    }
  }
  private observeEntryStop() {
    let stop = false;
    if (!this.#entryBarrierClosed) {
      try {
        const value = this.#stopRequested();
        stop = typeof value !== "boolean" || value;
      } catch {
        stop = true;
      }
    }
    if (stop) this.closeEntryBarrier("EXTERNAL_STOP_REQUESTED");
    return this.#entryBarrierClosed;
  }
  /** Closes entry authority synchronously before its first await; exits remain available. */
  async latchEmergencyStop(reason: string) {
    if (typeof reason !== "string" || !/^[A-Z0-9_]{1,80}$/.test(reason))
      throw Error("RESEARCH_STOP_REASON_INVALID");
    this.closeEntryBarrier(reason);
    while (this.#busy) await new Promise<void>((resolve) => this.#idleWaiters.push(resolve));
    this.#busy = true;
    try {
      this.assertLease();
      if (this.#stopDirty) await this.checkpoint();
    } finally {
      this.finishWork();
    }
  }
  /** Persist the original decision and intent before any provider I/O. */
  async enroll(input: ResearchPaperDecision): Promise<boolean> {
    if (this.#busy) throw Error("RESEARCH_RUN_ALREADY_BUSY");
    this.#busy = true;
    try {
      this.assertLease();
      if (this.observeEntryStop()) {
        await this.checkpoint();
        return false;
      }
      const at = this.time(),
        p = this.manifest.policy,
        d = structuredClone(input);
      validateDecision(d, this.manifest, at);
      const id = `research:${this.manifest.bookId}:${d.captureId}`;
      const prior = this.#entries.find((e) => e.id === id);
      if (prior) {
        if (canonical(prior.decision) !== canonical(d))
          throw Error("RESEARCH_CAPTURE_ID_CONTENT_COLLISION");
        return false;
      }
      if (
        !evaluateStrategies(d.features, {
          ...p.strategyRules,
          minimumLiquidityLamports: BigInt(p.minimumLiquidityLamports),
          maximumCostBps: p.maximumExecutionCostBps,
        }).some((s) => s.strategy === p.strategy && s.enter)
      )
        return false;
      const accepted = this.#ledger.queue(
        {
          id,
          eventId: d.captureId,
          mint: d.features.mint,
          strategy: p.strategy,
          amountLamports: BigInt(p.entryLamports),
          slippageBps: p.slippageBps,
        },
        at,
        p.minimumEntryDelayMs,
      );
      if (!accepted) return false;
      this.#entries.push({ id, decision: d, status: "QUEUED", reasons: [] });
      this.append("ENTRY_INTENT", id, undefined, at);
      await this.checkpoint();
      if (this.observeEntryStop()) {
        await this.checkpoint();
        return false;
      }
      return true;
    } finally {
      this.finishWork();
    }
  }
  private async quote(input: Parameters<QuoteProvider["quote"]>[0]): Promise<Quote> {
    this.assertLease();
    if (input.priority === "entry" && this.observeEntryStop())
      throw Error("RESEARCH_ENTRY_STOPPED");
    if (++this.#quoteCalls > this.manifest.maximumQuoteCallsPerStep)
      throw Error("RESEARCH_STEP_QUOTE_BUDGET_EXCEEDED");
    const calledAt = this.time();
    let supplied: Quote;
    try {
      supplied = await this.provider.quote(input);
    } finally {
      this.assertLease();
      this.observeEntryStop();
    }
    if (input.priority === "entry" && this.#entryBarrierClosed)
      throw Error("RESEARCH_ENTRY_STOPPED");
    // Read untrusted provider fields once; accessors or later mutation cannot change a checked quote.
    const q = structuredClone(supplied);
    const returnedAt = this.time();
    if (
      !Number.isSafeInteger(q.requestedAt) ||
      (q.requestedAt ?? -1) < calledAt ||
      q.observedAt < q.requestedAt! ||
      q.observedAt > returnedAt
    )
      throw Error("RESEARCH_PROVIDER_REQUEST_OR_RETURN_CLOCK_INVALID");
    return q;
  }
  async step(controls: ResearchStepControls = {}) {
    const options = structuredClone(controls);
    const allowEntryQuotes =
      options.allowEntryQuotes === undefined ? true : options.allowEntryQuotes;
    const allowPassiveMarks =
      options.allowPassiveMarks === undefined ? true : options.allowPassiveMarks;
    if (typeof allowEntryQuotes !== "boolean" || typeof allowPassiveMarks !== "boolean")
      throw Error("RESEARCH_STEP_CONTROLS_INVALID");
    if (this.#busy) throw Error("RESEARCH_RUN_ALREADY_BUSY");
    this.#busy = true;
    this.#quoteCalls = 0;
    try {
      this.assertLease();
      this.observeEntryStop();
      if (this.#stopDirty) await this.checkpoint();
      const p = this.manifest.policy,
        fee = BigInt(p.networkFeePerLegLamports);
      // Persist protective intent before even a mark request. One research position maximum.
      for (const position of this.#ledger.state.positions) {
        const previous = this.#ledger.state.pendingExits.find((e) => e.positionId === position.id);
        const required = this.#ledger.queueRequiredExit(
          position,
          this.time(),
          p.minimumEntryDelayMs,
        );
        if (required && required !== previous) {
          this.append("EXIT_INTENT", position.id, undefined, required.createdAt, required);
          await this.checkpoint();
        }
        const pending = this.#ledger.state.pendingExits.find((e) => e.positionId === position.id);
        if (!pending && !allowPassiveMarks) continue;
        if (pending && this.time() < pending.readyAt) continue;
        let q: Quote;
        try {
          q = await this.quote({
            priority: pending ? "protective_exit" : "research",
            inputMint: position.mint,
            outputMint: WSOL,
            amount: pending?.quantityRaw ?? position.quantityRaw,
            slippageBps: p.slippageBps,
          });
          const currentIntent = this.#ledger.state.pendingExits.find(
            (e) => e.positionId === position.id,
          );
          if (currentIntent?.id !== pending?.id) {
            position.markLamports = null;
            position.markAt = null;
            this.#ledger.recordEquity(this.time());
            this.append(currentIntent ? "EXIT_UNAVAILABLE" : "MARK_UNAVAILABLE", position.id);
            await this.checkpoint();
            continue;
          }
          if (pending) {
            const settlementAt = this.time();
            this.#ledger.close(
              position,
              q,
              pending.quantityRaw,
              fee,
              pending.reason,
              settlementAt,
              pending.id,
            );
            this.append(
              "EXIT_SETTLED",
              position.id,
              {
                id: pending.id,
                quantityRaw: pending.quantityRaw.toString(),
                proceedsLamports: q.minOutAmount,
                feeLamports: fee.toString(),
                quote: structuredClone(q),
              },
              settlementAt,
            );
          } else {
            const markedAt = this.time();
            this.#ledger.mark(position, q, fee, markedAt);
            this.append("MARK_OBSERVED", position.id, undefined, markedAt, undefined, {
              quote: q,
              feeLamports: fee.toString(),
            });
            const exitDecisionAt = this.time();
            const reason = this.#ledger.exitReason(position, exitDecisionAt);
            if (reason) {
              const quantity = (position.quantityRaw * BigInt(reason.bps)) / 10000n;
              const intent = this.#ledger.queueExit(
                position,
                quantity > 0n ? quantity : position.quantityRaw,
                reason.reason,
                exitDecisionAt,
                p.minimumEntryDelayMs,
              );
              if (!intent) throw Error("RESEARCH_EXIT_INTENT_NOT_CREATED");
              this.append("EXIT_INTENT", position.id, undefined, intent.createdAt, intent);
            }
          }
        } catch (error) {
          if (this.#suspended) throw error;
          this.assertLease();
          position.markLamports = null;
          position.markAt = null;
          this.#ledger.recordEquity(this.time());
          this.append(pending ? "EXIT_UNAVAILABLE" : "MARK_UNAVAILABLE", position.id);
        }
        await this.checkpoint();
      }
      for (const order of [...this.#ledger.state.pending]) {
        const entry = this.#entries.find((e) => e.id === order.id)!;
        if (this.observeEntryStop()) {
          await this.checkpoint();
          continue;
        }
        if (entry.status !== "QUEUED") continue;
        if (this.time() - entry.decision.decisionAt > p.maximumDecisionAgeMs) {
          entry.status = "EXPIRED";
          entry.reasons = ["ORIGINAL_DECISION_EXPIRED"];
          this.#ledger.state.pending = this.#ledger.state.pending.filter((x) => x.id !== order.id);
          this.append("ENTRY_CANCELLED", order.id);
          await this.checkpoint();
          continue;
        }
        if (this.time() < order.readyAt) continue;
        if (!allowEntryQuotes) continue;
        let buy: Quote, sell: Quote;
        try {
          buy = await this.quote({
            priority: "entry",
            inputMint: WSOL,
            outputMint: order.mint,
            amount: order.amountLamports,
            slippageBps: p.slippageBps,
          });
          sell = await this.quote({
            priority: "entry",
            inputMint: order.mint,
            outputMint: WSOL,
            amount: rawAmount(buy.minOutAmount),
            slippageBps: p.slippageBps,
          });
        } catch (error) {
          if (this.#suspended) throw error;
          this.assertLease();
          if (this.observeEntryStop()) {
            await this.checkpoint();
            continue;
          }
          entry.status = "ENTRY_QUOTE_FAILED";
          entry.reasons = ["PROVIDER_QUOTE_UNAVAILABLE_NO_FILL"];
          this.#ledger.state.pending = this.#ledger.state.pending.filter((x) => x.id !== order.id);
          this.#ledger.state.failures++;
          this.append("ENTRY_CANCELLED", order.id);
          await this.checkpoint();
          continue;
        }
        const d = entry.decision;
        const evidence: ResearchPaperDecisionEvidence = {
          policyHash: p.manifestHash,
          sourceHash: p.sourceHash,
          captureId: d.captureId,
          sourceObservedAt: d.sourceObservedAt,
          decisionAt: d.decisionAt,
          capturedAt: this.time(),
          initialCapitalLamports: this.#ledger.state.initialLamports.toString(),
          openPositions: this.#ledger.state.positions.length,
          pendingEntries: this.#ledger.state.pending.length - 1,
          features: structuredClone(d.features),
          security: {
            ...structuredClone(d.security),
            sellRouteAvailable: true,
            sellRouteObservedAt: sell.observedAt,
          },
          ...(d.mintAccountCapture
            ? { mintAccountCapture: structuredClone(d.mintAccountCapture) }
            : {}),
          quote: {
            ...buy,
            inputLamports: buy.inAmount,
            slippageBps: p.slippageBps,
          } as ResearchPaperDecisionEvidence["quote"],
          pairedSell: {
            ...sell,
            slippageBps: p.slippageBps,
          } as ResearchPaperDecisionEvidence["pairedSell"],
        };
        try {
          this.assertLease();
          if (this.observeEntryStop()) {
            await this.checkpoint();
            continue;
          }
          const settlementAt = this.time();
          const authorization = this.#ledger.fillResearch(order, buy, evidence, settlementAt);
          entry.reasons = [...authorization.reasons];
          if (authorization.allowedForResearch) {
            entry.status = "FILLED";
            entry.fill = {
              at: settlementAt,
              quote: structuredClone(buy),
              evidence: structuredClone(authorization.admission.evidence),
            };
            this.append("ENTRY_SETTLED", order.id, undefined, settlementAt);
          } else {
            entry.status = "REJECTED";
            this.#ledger.state.pending = this.#ledger.state.pending.filter(
              (x) => x.id !== order.id,
            );
            this.append("ENTRY_CANCELLED", order.id);
          }
        } catch (error) {
          if (this.#suspended) throw error;
          this.assertLease();
          if (this.#ledger.state.positions.some((x) => x.id === order.id)) {
            this.#suspended = true;
            throw Error("RESEARCH_SETTLEMENT_AUDIT_FAILED_RESTORE_REQUIRED");
          }
          entry.status = "REJECTED";
          entry.reasons = ["FINAL_RESEARCH_GUARD_REJECTED_NO_FILL"];
          this.#ledger.state.pending = this.#ledger.state.pending.filter((x) => x.id !== order.id);
          this.append("ENTRY_CANCELLED", order.id);
        }
        await this.checkpoint();
      }
    } finally {
      this.finishWork();
    }
  }
}

import { createHash } from "node:crypto";

/** Prospective quote research. This module has no wallet, order, ledger or submit API. */
export const FORWARD_SCOPE = "FORWARD_QUOTE_COHORT_NOT_TRADES";
export const FORWARD_WSOL = "So11111111111111111111111111111111111111112";
const U64 = 18_446_744_073_709_551_615n;
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HASH = /^[a-f0-9]{64}$/;

export function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  throw Error("FORWARD_NONCANONICAL_VALUE");
}
export const forwardHash = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");
export function forwardRaw(value: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
    throw Error("FORWARD_INVALID_AMOUNT");
  const n = BigInt(value);
  if (n <= 0n || n > U64) throw Error("FORWARD_AMOUNT_OUTSIDE_U64");
  return n;
}
const timestamp = (n: number) => Number.isSafeInteger(n) && n >= 0;
const costCeiling = (n: bigint, d: bigint) => (n > 0n ? (n + d - 1n) / d : n / d).toString();

export type ForwardProtocol = {
  version: 1;
  scope: typeof FORWARD_SCOPE;
  experimentId: string;
  frozenAt: number;
  enrollmentStart: number;
  enrollmentEnd: number;
  runtimeSourceVersion: string;
  sourceCommit: string;
  amountLamports: string;
  maximumProbeCostBps: number;
  slippageBps: number;
  networkFeePerLegLamports: string;
  researchMinimumTurnSpacingMs: number;
  minimumEntryDelayMs: number;
  entryToleranceMs: number;
  primaryHorizonMs: number;
  horizonToleranceMs: number;
  maxQuoteAgeMs: number;
  maxActiveEpisodes: number;
  minimumDistinctEnteredTokens: number;
  minimumUtcDays: number;
  selection: "FIRST_PROBE_PER_MINT";
  control: "PAIRED_NO_TRADE_ZERO";
  security: "UNASSESSED_NOT_TRADABLE";
  configurationHash: string;
};

export function freezeForwardProtocol(input: {
  now: number;
  runtimeSourceVersion: string;
  sourceCommit: string;
  experimentId?: string;
}): ForwardProtocol {
  const p: Omit<ForwardProtocol, "configurationHash"> = {
    version: 1 as const,
    scope: FORWARD_SCOPE,
    experimentId: input.experimentId ?? `post-probe-60s-v1-${input.now}`,
    frozenAt: input.now,
    enrollmentStart: input.now + 1000,
    enrollmentEnd: input.now + 72 * 3_600_000,
    runtimeSourceVersion: input.runtimeSourceVersion,
    sourceCommit: input.sourceCommit,
    amountLamports: "10000000",
    maximumProbeCostBps: 150,
    slippageBps: 100,
    networkFeePerLegLamports: "10000",
    researchMinimumTurnSpacingMs: 30000,
    minimumEntryDelayMs: 32000,
    entryToleranceMs: 5000,
    primaryHorizonMs: 60000,
    horizonToleranceMs: 5000,
    maxQuoteAgeMs: 5000,
    maxActiveEpisodes: 1,
    minimumDistinctEnteredTokens: 100,
    minimumUtcDays: 3,
    selection: "FIRST_PROBE_PER_MINT" as const,
    control: "PAIRED_NO_TRADE_ZERO" as const,
    security: "UNASSESSED_NOT_TRADABLE" as const,
  };
  const protocol = { ...p, configurationHash: forwardHash(p) };
  validateForwardProtocol(protocol);
  return Object.freeze(protocol);
}

export function validateForwardProtocol(p: ForwardProtocol) {
  const { configurationHash, ...body } = p;
  if (
    p.version !== 1 ||
    p.scope !== FORWARD_SCOPE ||
    !/^[a-zA-Z0-9:_-]{1,128}$/.test(p.experimentId) ||
    !HASH.test(p.runtimeSourceVersion) ||
    !/^[a-f0-9]{40}$/.test(p.sourceCommit) ||
    ![p.frozenAt, p.enrollmentStart, p.enrollmentEnd].every(timestamp) ||
    p.enrollmentStart <= p.frozenAt ||
    p.enrollmentEnd <= p.enrollmentStart ||
    p.selection !== "FIRST_PROBE_PER_MINT" ||
    p.control !== "PAIRED_NO_TRADE_ZERO" ||
    p.security !== "UNASSESSED_NOT_TRADABLE" ||
    !HASH.test(configurationHash) ||
    forwardHash(body) !== configurationHash
  )
    throw Error("FORWARD_PROTOCOL_INVALID_OR_CHANGED");
  forwardRaw(p.amountLamports);
  forwardRaw(p.networkFeePerLegLamports);
  for (const n of [
    p.researchMinimumTurnSpacingMs,
    p.minimumEntryDelayMs,
    p.entryToleranceMs,
    p.primaryHorizonMs,
    p.horizonToleranceMs,
    p.maxQuoteAgeMs,
    p.maxActiveEpisodes,
    p.minimumDistinctEnteredTokens,
    p.minimumUtcDays,
  ])
    if (!Number.isSafeInteger(n) || n <= 0) throw Error("FORWARD_PROTOCOL_LIMIT_INVALID");
  if (p.minimumEntryDelayMs < p.researchMinimumTurnSpacingMs)
    throw Error("FORWARD_ENTRY_PRECEDES_SHARED_BUDGET");
  for (const n of [p.maximumProbeCostBps, p.slippageBps])
    if (!Number.isSafeInteger(n) || n < 0 || n >= 10000)
      throw Error("FORWARD_PROTOCOL_BPS_INVALID");
  return p;
}

export function forwardCostAudit(p: ForwardProtocol) {
  validateForwardProtocol(p);
  const amount = forwardRaw(p.amountLamports),
    fee = forwardRaw(p.networkFeePerLegLamports) * 2n;
  const first = (amount * BigInt(10000 - p.slippageBps)) / 10000n;
  const last = (first * BigInt(10000 - p.slippageBps)) / 10000n;
  const loss = amount + fee - last;
  return {
    definition: "SEQUENTIAL_MIN_OUT_QUOTE_STRESS_WITH_TEMPORAL_DRIFT",
    idealStaticLinearStressCostBpsCeiling: costCeiling(loss * 10000n, amount),
    idealStaticLinearStressLossLamports: loss.toString(),
    configuredCapBelowStaticStressFloor: loss * 10000n > BigInt(p.maximumProbeCostBps) * amount,
    breakEvenExitProceedsLamports: (amount + fee).toString(),
    caveat:
      "Conditional static zero-fee linear example. Moving sequential quotes can offset this floor; passing does not prove low venue friction.",
  };
}

export type ForwardQuote = {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  minOutAmount: string;
  observedAt: number;
  /** Provider-reported actual request start; absent data proves only invocation timing. */
  requestedAt?: number;
};
export type ForwardTimingEvidence = "PROVIDER_REPORTED_REQUEST_START" | "PROVIDER_INVOCATION_ONLY";
export type TimedForwardQuote = {
  /** Unmarked legacy records used this field for invocation time; never infer network proof. */
  requestedAt?: number;
  providerInvocationAt?: number;
  timingEvidence?: ForwardTimingEvidence;
  receivedAt: number;
  quote: ForwardQuote;
};
export type ForwardProvider = {
  quote(input: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    slippageBps: number;
  }): Promise<ForwardQuote>;
};
export type ForwardProbe = {
  id: string;
  mint: string;
  signature: string;
  slot: number;
  protocol: "pump" | "pumpswap" | "raydium-cpmm";
  kind: "launch" | "pool" | "buy" | "sell" | "migrate" | "swap";
  eventObservedAt: number;
  startedAt: number;
  completedAt: number;
  amountLamports: string;
  buy?: ForwardQuote;
  sell?: ForwardQuote;
};
type Phase = "ENROLLMENT" | "ENTRY_REQUEST" | "ENTRY_RESULT" | "EXIT_REQUEST" | "EXIT_RESULT";
export type ForwardRecord = {
  id: string;
  experimentId: string;
  configurationHash: string;
  scope: typeof FORWARD_SCOPE;
  mint: string;
  phase: Phase;
  at: number;
  data: Record<string, unknown>;
};
export interface ForwardJournal {
  ensureProtocol(protocol: ForwardProtocol): Promise<void>;
  records(experimentId: string): Promise<ForwardRecord[]>;
  append(record: ForwardRecord): Promise<void>;
}

/** Explicit whitelist: provider routes/URLs/credentials/transaction bytes are never journaled. */
function cleanQuote(q: ForwardQuote): ForwardQuote {
  return {
    inputMint: q.inputMint,
    outputMint: q.outputMint,
    inAmount: q.inAmount,
    outAmount: q.outAmount,
    minOutAmount: q.minOutAmount,
    observedAt: q.observedAt,
    ...(q.requestedAt !== undefined ? { requestedAt: q.requestedAt } : {}),
  };
}
export function validateForwardQuote(
  q: ForwardQuote | undefined,
  input: string,
  output: string,
  amount: string,
  now: number,
  notBefore: number,
  maxAge: number,
  slippageBps = 100,
) {
  if (
    q?.requestedAt !== undefined &&
    (!timestamp(q.requestedAt) ||
      q.requestedAt < notBefore ||
      q.requestedAt > q.observedAt ||
      q.requestedAt > now)
  )
    throw Error("FORWARD_PROVIDER_REQUEST_TIMING_INVALID");
  if (
    !q ||
    q.inputMint !== input ||
    q.outputMint !== output ||
    q.inAmount !== amount ||
    !timestamp(q.observedAt) ||
    q.observedAt < notBefore ||
    q.observedAt > now ||
    now - q.observedAt > maxAge ||
    forwardRaw(q.minOutAmount) > forwardRaw(q.outAmount) ||
    forwardRaw(q.minOutAmount) < (forwardRaw(q.outAmount) * BigInt(10000 - slippageBps)) / 10000n ||
    forwardRaw(q.inAmount).toString() !== amount
  )
    throw Error("FORWARD_QUOTE_IDENTITY_SIZE_OR_TIMING_INVALID");
  return cleanQuote(q);
}
const safeQuoteErrors = new Set([
  "FORWARD_INVALID_AMOUNT",
  "FORWARD_AMOUNT_OUTSIDE_U64",
  "FORWARD_QUOTE_IDENTITY_SIZE_OR_TIMING_INVALID",
  "FORWARD_PROVIDER_REQUEST_TIMING_INVALID",
  "FORWARD_CLOCK_REGRESSED",
  "FORWARD_RESPONSE_AFTER_DEADLINE",
  "FORWARD_REQUEST_START_AFTER_DEADLINE",
]);
const safeError = (e: unknown) =>
  e instanceof Error && safeQuoteErrors.has(e.message)
    ? e.message
    : "FORWARD_QUOTE_PROVIDER_UNAVAILABLE";

/** Legacy requestedAt remains an invocation lower bound, not network-start evidence. */
function timingLowerBound(
  value: { requestedAt?: unknown; providerInvocationAt?: unknown; timingEvidence?: unknown },
  intent: number,
  receivedAt: number,
  deadlineAt: number,
  quote?: ForwardQuote,
) {
  const fail = () => {
    throw Error("FORWARD_RESTORED_CAUSAL_GRAPH_INVALID");
  };
  if (value.timingEvidence === undefined) {
    if (
      !timestamp(value.requestedAt as number) ||
      (value.requestedAt as number) < intent ||
      (value.requestedAt as number) > receivedAt ||
      value.providerInvocationAt !== undefined ||
      quote?.requestedAt !== undefined
    )
      fail();
    return value.requestedAt as number;
  }
  const invocation = value.providerInvocationAt as number;
  if (
    !timestamp(invocation) ||
    invocation < intent ||
    invocation > deadlineAt ||
    invocation > receivedAt
  )
    fail();
  if (value.timingEvidence === "PROVIDER_INVOCATION_ONLY") {
    if (value.requestedAt !== undefined || quote?.requestedAt !== undefined) fail();
    return invocation;
  }
  if (value.timingEvidence !== "PROVIDER_REPORTED_REQUEST_START") fail();
  const requested = value.requestedAt as number;
  if (
    !timestamp(requested) ||
    requested < invocation ||
    requested > receivedAt ||
    (quote && quote.requestedAt !== requested)
  )
    fail();
  return requested;
}

/** Single serialized research lane. The caller must grant shared provider budget and prioritize actual paper exits. */
export class ForwardCohortCollector {
  private loaded = false;
  private chain: Promise<unknown> = Promise.resolve();
  private rows: ForwardRecord[] = [];
  readonly protocol: ForwardProtocol;
  private journal: ForwardJournal;
  private now: () => number;
  constructor(
    protocol: ForwardProtocol,
    journal: ForwardJournal,
    runtimeSourceVersion: string,
    now: () => number = Date.now,
  ) {
    validateForwardProtocol(protocol);
    this.protocol = Object.freeze(structuredClone(protocol));
    if (runtimeSourceVersion !== protocol.runtimeSourceVersion)
      throw Error("FORWARD_RUNTIME_SOURCE_MISMATCH");
    this.journal = journal;
    this.now = now;
  }
  private run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chain.then(work);
    this.chain = result.catch(() => undefined);
    return result;
  }
  private row(mint: string, phase: Phase) {
    return this.rows.find((r) => r.mint === mint && r.phase === phase);
  }
  private async append(mint: string, phase: Phase, data: Record<string, unknown>, at = this.now()) {
    if (!timestamp(at) || at < this.protocol.frozenAt) throw Error("FORWARD_CLOCK_INVALID");
    const record: ForwardRecord = {
      id: `${this.protocol.experimentId}:${mint}:${phase}`,
      experimentId: this.protocol.experimentId,
      configurationHash: this.protocol.configurationHash,
      scope: FORWARD_SCOPE,
      mint,
      phase,
      at,
      data,
    };
    try {
      await this.journal.append(record);
    } catch (error) {
      this.loaded = false;
      throw error;
    }
    this.rows.push(structuredClone(record));
    return record;
  }
  private async load() {
    if (this.loaded) return;
    if (this.now() < this.protocol.frozenAt) throw Error("FORWARD_CLOCK_PRECEDES_FREEZE");
    await this.journal.ensureProtocol(this.protocol);
    const records = await this.journal.records(this.protocol.experimentId),
      unique = new Map<string, ForwardRecord>();
    for (const row of records) {
      if (
        row.experimentId !== this.protocol.experimentId ||
        row.configurationHash !== this.protocol.configurationHash ||
        row.scope !== FORWARD_SCOPE ||
        !ADDRESS.test(row.mint) ||
        !["ENROLLMENT", "ENTRY_REQUEST", "ENTRY_RESULT", "EXIT_REQUEST", "EXIT_RESULT"].includes(
          row.phase,
        ) ||
        row.id !== `${row.experimentId}:${row.mint}:${row.phase}` ||
        !timestamp(row.at) ||
        row.at > this.now() ||
        row.at < this.protocol.frozenAt
      )
        throw Error("FORWARD_JOURNAL_CONTEXT_INVALID");
      if (unique.has(row.id) && canonical(unique.get(row.id)) !== canonical(row))
        throw Error("FORWARD_CONFLICTING_DUPLICATE");
      unique.set(row.id, row);
    }
    this.rows = [...unique.values()];
    for (const row of this.rows)
      if (row.phase !== "ENROLLMENT" && !this.row(row.mint, "ENROLLMENT"))
        throw Error("FORWARD_ORPHAN_RECORD");
    this.validateGraph();
    // Quote-only requests interrupted by restart are not retried or silently substituted.
    for (const row of [...this.rows]) {
      const result =
        row.phase === "ENTRY_REQUEST"
          ? "ENTRY_RESULT"
          : row.phase === "EXIT_REQUEST"
            ? "EXIT_RESULT"
            : null;
      if (result && !this.row(row.mint, result))
        await this.append(row.mint, result, {
          status: "INTERRUPTED_UNKNOWN_NO_RETRY",
          requestId: row.id,
        });
    }
    this.validateGraph();
    this.loaded = true;
  }
  private validateGraph() {
    const p = this.protocol,
      intervals: Array<{ start: number; end: number }> = [],
      probeIds = new Set<string>();
    const fail = () => {
      throw Error("FORWARD_RESTORED_CAUSAL_GRAPH_INVALID");
    };
    for (const enrollment of this.rows.filter((r) => r.phase === "ENROLLMENT")) {
      const d = enrollment.data,
        mint = enrollment.mint;
      if (
        typeof d.probeId !== "string" ||
        !/^[A-Za-z0-9:_-]{1,128}$/.test(d.probeId) ||
        probeIds.has(d.probeId) ||
        typeof d.signature !== "string" ||
        !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(d.signature) ||
        !timestamp(d.slot as number) ||
        !["pump", "pumpswap", "raydium-cpmm"].includes(String(d.protocol)) ||
        !["launch", "pool", "buy", "sell", "migrate", "swap"].includes(String(d.kind)) ||
        d.decisionAt !== enrollment.at ||
        enrollment.at < p.enrollmentStart ||
        enrollment.at > p.enrollmentEnd ||
        d.entryDueAt !== enrollment.at + p.minimumEntryDelayMs ||
        d.entryDeadlineAt !== enrollment.at + p.minimumEntryDelayMs + p.entryToleranceMs ||
        d.controlNetLamports !== "0" ||
        d.security !== p.security ||
        typeof d.admitted !== "boolean" ||
        typeof d.costQualified !== "boolean"
      )
        fail();
      probeIds.add(d.probeId as string);
      const phases = this.rows.filter((r) => r.mint === mint && r.phase !== "ENROLLMENT");
      if (!d.admitted) {
        if (phases.length) fail();
        continue;
      }
      if (
        !d.costQualified ||
        d.amountLamports !== p.amountLamports ||
        ![d.eventObservedAt, d.probeStartedAt, d.probeCompletedAt].every((n) =>
          timestamp(n as number),
        ) ||
        (d.eventObservedAt as number) < p.enrollmentStart ||
        (d.probeStartedAt as number) < (d.eventObservedAt as number) ||
        (d.probeCompletedAt as number) < (d.probeStartedAt as number) ||
        (d.probeCompletedAt as number) > enrollment.at ||
        enrollment.at - (d.probeCompletedAt as number) > p.maxQuoteAgeMs
      )
        fail();
      const buy = validateForwardQuote(
        d.probeBuy as ForwardQuote,
        FORWARD_WSOL,
        mint,
        p.amountLamports,
        d.probeCompletedAt as number,
        d.probeStartedAt as number,
        p.maxQuoteAgeMs,
        p.slippageBps,
      );
      const sell = validateForwardQuote(
        d.probeSell as ForwardQuote,
        mint,
        FORWARD_WSOL,
        buy.minOutAmount,
        d.probeCompletedAt as number,
        buy.observedAt,
        p.maxQuoteAgeMs,
        p.slippageBps,
      );
      const loss =
        forwardRaw(p.amountLamports) +
        2n * forwardRaw(p.networkFeePerLegLamports) -
        forwardRaw(sell.minOutAmount);
      if (loss * 10000n > BigInt(p.maximumProbeCostBps) * forwardRaw(p.amountLamports)) fail();
      let terminal = Infinity;
      for (const entry of [true, false]) {
        const request = this.row(mint, entry ? "ENTRY_REQUEST" : "EXIT_REQUEST"),
          result = this.row(mint, entry ? "ENTRY_RESULT" : "EXIT_RESULT");
        const canonicalEntry = this.row(mint, "ENTRY_RESULT");
        if (!entry && (!canonicalEntry || canonicalEntry.data.status !== "QUOTED")) {
          if (request || result) fail();
          continue;
        }
        const entryQuote = !entry
          ? (canonicalEntry!.data.timedQuote as TimedForwardQuote).quote
          : null;
        const dueAt = entry
          ? (d.entryDueAt as number)
          : entryQuote!.observedAt + p.primaryHorizonMs;
        const deadlineAt = dueAt + (entry ? p.entryToleranceMs : p.horizonToleranceMs);
        const input = entry ? FORWARD_WSOL : mint,
          output = entry ? mint : FORWARD_WSOL,
          amount = entry ? p.amountLamports : entryQuote!.minOutAmount;
        if (
          request &&
          (request.at < dueAt ||
            request.at > deadlineAt ||
            request.data.requestIntentAt !== request.at ||
            request.data.dueAt !== dueAt ||
            request.data.deadlineAt !== deadlineAt ||
            request.data.inputMint !== input ||
            request.data.outputMint !== output ||
            request.data.amountRaw !== amount)
        )
          fail();
        if (!result) continue;
        const rd = result.data;
        if (rd.status === "MISSED_DEADLINE_NO_QUOTE") {
          if (
            request ||
            result.at <= deadlineAt ||
            rd.dueAt !== dueAt ||
            rd.deadlineAt !== deadlineAt ||
            rd.timedQuote !== undefined
          )
            fail();
        } else {
          if (!request || rd.requestId !== request.id || result.at < request.at) fail();
          if (rd.status === "QUOTED") {
            const timed = rd.timedQuote as TimedForwardQuote | undefined;
            if (
              !timed ||
              timed.receivedAt !== result.at ||
              result.at > deadlineAt ||
              rd.dueAt !== dueAt ||
              rd.deadlineAt !== deadlineAt
            )
              fail();
            const lowerBound = timingLowerBound(
              timed!,
              request!.at,
              result.at,
              deadlineAt,
              timed!.quote,
            );
            if (lowerBound > deadlineAt) fail();
            validateForwardQuote(
              timed!.quote,
              input,
              output,
              amount,
              timed!.receivedAt,
              lowerBound,
              p.maxQuoteAgeMs,
              p.slippageBps,
            );
          } else if (rd.status === "UNAVAILABLE_OR_LATE") {
            if (
              rd.timedQuote !== undefined ||
              rd.receivedAt !== result.at ||
              rd.dueAt !== dueAt ||
              rd.deadlineAt !== deadlineAt ||
              !(
                safeQuoteErrors.has(String(rd.error)) ||
                rd.error === "FORWARD_QUOTE_PROVIDER_UNAVAILABLE" ||
                rd.error === "FORWARD_INTENT_PERSISTENCE_DELAY"
              )
            )
              fail();
            if (rd.timingEvidence === "NO_PROVIDER_CALL") {
              if (
                rd.providerCalled !== false ||
                rd.error !== "FORWARD_INTENT_PERSISTENCE_DELAY" ||
                result.at <= deadlineAt ||
                rd.requestedAt !== undefined ||
                rd.providerInvocationAt !== undefined
              )
                fail();
            } else {
              const start = timingLowerBound(rd, request!.at, result.at, deadlineAt);
              if (rd.timingEvidence === undefined) {
                if (
                  start > deadlineAt &&
                  !(rd.providerCalled === false && rd.error === "FORWARD_INTENT_PERSISTENCE_DELAY")
                )
                  fail();
                if (
                  rd.error === "FORWARD_INTENT_PERSISTENCE_DELAY" &&
                  !(rd.providerCalled === false && start > deadlineAt)
                )
                  fail();
              } else if (
                rd.providerCalled !== true ||
                (start > deadlineAt &&
                  !(
                    rd.timingEvidence === "PROVIDER_REPORTED_REQUEST_START" &&
                    rd.error === "FORWARD_REQUEST_START_AFTER_DEADLINE" &&
                    result.at > deadlineAt
                  ))
              )
                fail();
            }
          } else if (rd.status === "INTERRUPTED_UNKNOWN_NO_RETRY") {
            if (rd.timedQuote !== undefined) fail();
          } else fail();
        }
        if (
          !entry &&
          rd.originalEntryRecordId !== undefined &&
          rd.originalEntryRecordId !== canonicalEntry!.id
        )
          fail();
        if (!entry && rd.originalQuantityRaw !== undefined && rd.originalQuantityRaw !== amount)
          fail();
        if (!entry || rd.status !== "QUOTED") terminal = result.at;
      }
      intervals.push({ start: enrollment.at, end: terminal });
    }
    const boundaries = intervals
      .flatMap((x) => [
        { at: x.start, change: 1 },
        { at: x.end, change: -1 },
      ])
      .filter((x) => Number.isFinite(x.at))
      .sort((a, b) => a.at - b.at || a.change - b.change);
    let active = 0;
    for (const event of boundaries) {
      active += event.change;
      if (active > p.maxActiveEpisodes) fail();
    }
  }
  initialize() {
    return this.run(() => this.load());
  }
  private pending() {
    return this.rows.filter(
      (r) =>
        r.phase === "ENROLLMENT" &&
        r.data.admitted === true &&
        (!this.row(r.mint, "ENTRY_RESULT") ||
          (this.row(r.mint, "ENTRY_RESULT")?.data.status === "QUOTED" &&
            !this.row(r.mint, "EXIT_RESULT"))),
    );
  }
  /** Read-only scheduler reservation hint; actual paper exits keep priority. */
  nextQuoteWindow() {
    return this.run(async () => {
      await this.load();
      const windows = this.pending().map((enrollment) => {
        const entry = this.row(enrollment.mint, "ENTRY_RESULT");
        const dueAt = entry
          ? (entry.data.timedQuote as TimedForwardQuote).quote.observedAt +
            this.protocol.primaryHorizonMs
          : Number(enrollment.data.entryDueAt);
        return {
          mint: enrollment.mint,
          phase: entry ? ("EXIT" as const) : ("ENTRY" as const),
          dueAt,
          deadlineAt:
            dueAt + (entry ? this.protocol.horizonToleranceMs : this.protocol.entryToleranceMs),
        };
      });
      return windows.sort((a, b) => a.dueAt - b.dueAt || a.mint.localeCompare(b.mint))[0] ?? null;
    });
  }
  considerProbe(input: ForwardProbe) {
    return this.run(async () => {
      await this.load();
      const p = this.protocol,
        now = this.now(),
        probe = structuredClone(input);
      if (
        !ADDRESS.test(probe.mint) ||
        probe.mint === FORWARD_WSOL ||
        !/^[A-Za-z0-9:_-]{1,128}$/.test(probe.id) ||
        !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(probe.signature) ||
        !timestamp(probe.slot) ||
        ![probe.eventObservedAt, probe.startedAt, probe.completedAt].every(timestamp) ||
        !["pump", "pumpswap", "raydium-cpmm"].includes(probe.protocol) ||
        !["launch", "pool", "buy", "sell", "migrate", "swap"].includes(probe.kind)
      )
        throw Error("FORWARD_PROBE_IDENTITY_INVALID");
      forwardRaw(probe.amountLamports);
      if (this.row(probe.mint, "ENROLLMENT")) return { status: "FIRST_PROBE_ALREADY_RECORDED" };
      if (this.rows.some((r) => r.phase === "ENROLLMENT" && r.data.probeId === probe.id))
        throw Error("FORWARD_PROBE_ID_REUSED");
      if (now < p.enrollmentStart || now > p.enrollmentEnd)
        return { status: "OUTSIDE_ENROLLMENT_WINDOW" };
      const reasons: string[] = [];
      let buy: ForwardQuote | undefined, sell: ForwardQuote | undefined, loss: bigint | undefined;
      if (
        ![probe.eventObservedAt, probe.startedAt, probe.completedAt].every(timestamp) ||
        probe.eventObservedAt < p.enrollmentStart ||
        probe.startedAt < probe.eventObservedAt ||
        probe.completedAt < probe.startedAt ||
        probe.completedAt > now ||
        now - probe.completedAt > p.maxQuoteAgeMs ||
        probe.amountLamports !== p.amountLamports
      )
        reasons.push("PROBE_OUTSIDE_PROSPECTIVE_TIME_OR_SIZE");
      try {
        buy = validateForwardQuote(
          probe.buy,
          FORWARD_WSOL,
          probe.mint,
          p.amountLamports,
          probe.completedAt,
          probe.startedAt,
          p.maxQuoteAgeMs,
          p.slippageBps,
        );
        sell = validateForwardQuote(
          probe.sell,
          probe.mint,
          FORWARD_WSOL,
          buy.minOutAmount,
          probe.completedAt,
          buy.observedAt,
          p.maxQuoteAgeMs,
          p.slippageBps,
        );
        loss =
          forwardRaw(p.amountLamports) +
          2n * forwardRaw(p.networkFeePerLegLamports) -
          forwardRaw(sell.minOutAmount);
        if (loss * 10000n > BigInt(p.maximumProbeCostBps) * forwardRaw(p.amountLamports))
          reasons.push("SEQUENTIAL_PROBE_STRESS_OVER_FROZEN_CAP");
      } catch {
        reasons.push("PROBE_QUOTES_UNAVAILABLE_OR_INVALID");
      }
      const costQualified = reasons.length === 0;
      if (costQualified && this.pending().length >= p.maxActiveEpisodes)
        reasons.push("FORWARD_CAPACITY_UNAVAILABLE");
      const admitted = reasons.length === 0;
      const row = await this.append(
        probe.mint,
        "ENROLLMENT",
        {
          probeId: probe.id,
          signature: probe.signature,
          slot: probe.slot,
          protocol: probe.protocol,
          kind: probe.kind,
          eventObservedAt: probe.eventObservedAt,
          probeStartedAt: probe.startedAt,
          probeCompletedAt: probe.completedAt,
          amountLamports: probe.amountLamports,
          ...(buy ? { probeBuy: buy } : {}),
          ...(sell ? { probeSell: sell } : {}),
          ...(loss !== undefined
            ? {
                sequentialStressCostBpsCeiling: costCeiling(
                  loss * 10000n,
                  forwardRaw(p.amountLamports),
                ),
              }
            : {}),
          decisionAt: now,
          costQualified,
          admitted,
          reasons,
          entryDueAt: now + p.minimumEntryDelayMs,
          entryDeadlineAt: now + p.minimumEntryDelayMs + p.entryToleranceMs,
          controlNetLamports: "0",
          security: p.security,
        },
        now,
      );
      return {
        status: admitted ? "ENROLLED_FRESH_ENTRY_REQUIRED" : "REJECTED_RECORDED",
        id: row.id,
      };
    });
  }
  /** One request per invocation. A false permit records expired deadlines but never calls the provider. */
  tick(provider: ForwardProvider, permit = true) {
    return this.run(async () => {
      await this.load();
      const p = this.protocol,
        now = this.now();
      const pending = this.pending().sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
      for (const enrollment of pending) {
        const mint = enrollment.mint,
          entry = this.row(mint, "ENTRY_RESULT"),
          isEntry = !entry;
        const dueAt = isEntry
          ? Number(enrollment.data.entryDueAt)
          : (entry!.data.timedQuote as TimedForwardQuote).quote.observedAt + p.primaryHorizonMs;
        const deadlineAt = dueAt + (isEntry ? p.entryToleranceMs : p.horizonToleranceMs);
        const resultPhase = isEntry ? "ENTRY_RESULT" : "EXIT_RESULT",
          requestPhase = isEntry ? "ENTRY_REQUEST" : "EXIT_REQUEST";
        if (now < dueAt) continue;
        if (now > deadlineAt) {
          await this.append(mint, resultPhase, {
            status: "MISSED_DEADLINE_NO_QUOTE",
            dueAt,
            deadlineAt,
          });
          return;
        }
        if (!permit) return;
        const inputMint = isEntry ? FORWARD_WSOL : mint,
          outputMint = isEntry ? mint : FORWARD_WSOL;
        const amount = isEntry
          ? p.amountLamports
          : (entry!.data.timedQuote as TimedForwardQuote).quote.minOutAmount;
        const requestIntentAt = this.now();
        if (requestIntentAt < dueAt || requestIntentAt > deadlineAt) return;
        const request = await this.append(
          mint,
          requestPhase,
          { requestIntentAt, dueAt, deadlineAt, inputMint, outputMint, amountRaw: amount },
          requestIntentAt,
        );
        const providerInvocationAt = this.now();
        if (!timestamp(providerInvocationAt) || providerInvocationAt < requestIntentAt)
          throw Error("FORWARD_CLOCK_REGRESSED");
        if (providerInvocationAt > deadlineAt) {
          await this.append(
            mint,
            resultPhase,
            {
              status: "UNAVAILABLE_OR_LATE",
              requestId: request.id,
              dueAt,
              deadlineAt,
              timingEvidence: "NO_PROVIDER_CALL",
              receivedAt: providerInvocationAt,
              providerCalled: false,
              error: "FORWARD_INTENT_PERSISTENCE_DELAY",
            },
            providerInvocationAt,
          );
          return;
        }
        let quote: ForwardQuote | undefined, error: string | undefined;
        let requestedAt: number | undefined;
        try {
          quote = await provider.quote({
            inputMint,
            outputMint,
            amount: forwardRaw(amount),
            slippageBps: p.slippageBps,
          });
        } catch {
          error = "FORWARD_QUOTE_PROVIDER_UNAVAILABLE";
        }
        const receivedAt = this.now();
        try {
          if (!timestamp(receivedAt) || receivedAt < providerInvocationAt)
            throw Error("FORWARD_CLOCK_REGRESSED");
          if (quote?.requestedAt !== undefined) {
            if (
              !timestamp(quote.requestedAt) ||
              quote.requestedAt < providerInvocationAt ||
              !timestamp(quote.observedAt) ||
              quote.requestedAt > quote.observedAt ||
              quote.requestedAt > receivedAt
            )
              throw Error("FORWARD_PROVIDER_REQUEST_TIMING_INVALID");
            requestedAt = quote.requestedAt;
          }
          if (requestedAt !== undefined && requestedAt > deadlineAt)
            throw Error("FORWARD_REQUEST_START_AFTER_DEADLINE");
          quote = validateForwardQuote(
            quote,
            inputMint,
            outputMint,
            amount,
            receivedAt,
            requestedAt ?? providerInvocationAt,
            p.maxQuoteAgeMs,
            p.slippageBps,
          );
          if (receivedAt > deadlineAt) throw Error("FORWARD_RESPONSE_AFTER_DEADLINE");
        } catch (e) {
          error = error ?? safeError(e);
        }
        await this.append(
          mint,
          resultPhase,
          {
            status: error ? "UNAVAILABLE_OR_LATE" : "QUOTED",
            requestId: request.id,
            dueAt,
            deadlineAt,
            ...(error
              ? {
                  error,
                  providerInvocationAt,
                  receivedAt,
                  providerCalled: true,
                  timingEvidence:
                    requestedAt === undefined
                      ? "PROVIDER_INVOCATION_ONLY"
                      : "PROVIDER_REPORTED_REQUEST_START",
                  ...(requestedAt !== undefined ? { requestedAt } : {}),
                }
              : {
                  timedQuote: {
                    providerInvocationAt,
                    timingEvidence:
                      requestedAt === undefined
                        ? "PROVIDER_INVOCATION_ONLY"
                        : "PROVIDER_REPORTED_REQUEST_START",
                    ...(requestedAt !== undefined ? { requestedAt } : {}),
                    receivedAt,
                    quote: cleanQuote(quote!),
                  },
                }),
            ...(isEntry ? {} : { originalEntryRecordId: entry!.id, originalQuantityRaw: amount }),
          },
          receivedAt,
        );
        return;
      }
    });
  }
  async export() {
    return this.run(async () => {
      await this.load();
      return {
        exportedAt: this.now(),
        protocol: structuredClone(this.protocol),
        costAudit: forwardCostAudit(this.protocol),
        records: structuredClone(this.rows),
      };
    });
  }
  async idle() {
    await this.chain;
  }
}

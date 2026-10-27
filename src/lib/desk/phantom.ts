import { z } from "zod";
import { isSolanaAddress } from "./capital.ts";

const epoch = z.number().int().nonnegative().max(8640000000000000);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const raw = z.string().regex(/^(0|[1-9]\d{0,39})$/);
const signedRaw = z.string().regex(/^-?(0|[1-9]\d{0,39})$/);
const address = z.string().refine(isSolanaAddress);
const text = z.string().max(2000);
const latency = z.object({
  p50: z.number().finite().nonnegative().nullable(),
  p95: z.number().finite().nonnegative().nullable(),
});
const healthSchema = z.object({
  status: z.string().max(40),
  source: z.string().max(40),
  received: count,
  decoded: count,
  rejected: count,
  errors: count,
  lastEventAt: epoch.nullable(),
  latencyMs: latency,
  queueDepth: count.optional(),
  backfillGaps: count.optional(),
  lastError: text.optional(),
  typedObserved: count.optional(),
  typedLogs: z
    .object({
      received: count,
      processed: count,
      dropped: count,
      errors: count,
      queueDepth: count,
      latencyMs: latency,
    })
    .nullable()
    .optional(),
});
const stateSchema = z.object({
  application: z.literal("PHANTOM"),
  mode: z.literal("PAPER"),
  now: epoch,
  startedAt: epoch,
  sourceVersion: z.string().max(128).optional(),
  health: healthSchema,
  events: z.array(z.unknown()).max(2000),
  decisions: z.array(z.unknown()).max(2000),
  positions: z.array(z.unknown()).max(2000),
  pending: z.array(z.unknown()).max(2000),
  completedPositions: z.array(z.unknown()).max(5000).optional(),
  cashLamports: raw,
  equity: z.array(z.unknown()).max(20000),
  limitations: z.array(text).max(100),
  researchPaper: z.unknown().optional(),
});
const eventSchema = z.object({
  id: z.string().min(1).max(512),
  protocol: z.enum(["pump", "pumpswap", "raydium-cpmm"]),
  kind: z.enum(["launch", "pool", "buy", "sell", "migrate", "swap"]),
  signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/),
  slot: count.positive(),
  mint: address,
  quoteMint: address.optional(),
  actor: address.optional(),
  receivedAt: epoch,
  processedAt: epoch,
  blockTime: count.nullable().optional(),
  commitment: z.enum(["confirmed", "finalized"]),
  amountRaw: raw.nullable().optional(),
  quoteAmountRaw: raw.nullable().optional(),
  quantityEvidence: z.string().max(80).optional(),
  verification: z.enum(["FULL_TRANSACTION", "TYPED_PROGRAM_EVENT"]).optional(),
  fullTransactionVerified: z.boolean().optional(),
  details: z.object({ fullTransactionVerified: z.boolean().optional() }).optional(),
});
const decisionSchema = z.object({
  at: epoch,
  mint: address,
  strategy: z.string().min(1).max(100),
  accepted: z.boolean(),
  reasons: z.array(text).max(100),
  organicDemandScore: z.number().finite().optional(),
  walletEvidence: z.array(text).max(100).optional(),
});
const positionSchema = z.object({
  id: z.string().min(1).max(512),
  mint: address,
  strategy: z.string().max(100),
  quantityRaw: raw,
  costLamports: raw,
  openedAt: epoch,
  markLamports: raw.nullable(),
});
const completedSchema = z.object({
  positionId: z.string().min(1).max(512),
  mint: address,
  strategy: z.string().max(100),
  openedAt: epoch,
  closedAt: epoch,
  costLamports: raw,
  proceedsLamports: raw,
  feesLamports: raw,
  pnlLamports: signedRaw,
  exitLegs: count.positive(),
  finalReason: text,
});
const equitySchema = z.object({ at: epoch, equityLamports: raw.nullable() });
const researchId = z.string().regex(/^[A-Za-z0-9:_.-]{1,512}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const researchSignedRaw = z.string().regex(/^(?:0|[1-9]\d{0,39}|-[1-9]\d{0,39})$/);
const researchPolicySchema = z.object({
  kind: z.enum(["RESEARCH_PAPER_POLICY_V1", "RESEARCH_PAPER_POLICY_V2"]),
  version: z.union([z.literal(1), z.literal(2)]),
  strategy: z.literal("momentum_breakout"),
  associationScope: z.literal("UNKNOWN_ASSOCIATIONS_ACCEPTED_FOR_PAPER"),
  strictPolicyEligible: z.literal(false),
  liveApproved: z.literal(false),
  sourceHash: hash,
  manifestHash: hash,
  frozenAt: epoch,
  entryLamports: z.literal("10000000"),
  initialCapitalLamports: z.literal("1000000000"),
  maximumPositions: z.literal(1),
  networkFeePerLegLamports: z.literal("10000"),
  maximumQuoteAgeMs: z.literal(5000),
  minimumEntryDelayMs: z.literal(2000),
  maximumExecutionCostBps: z.literal(150),
  slippageBps: z.literal(25),
  sourceUniverse: z.enum([
    "LEGACY_SPL_SOL_PAIRS_JUPITER_AGGREGATOR_QUOTES",
    "LEGACY_SPL_AND_METADATA_ONLY_TOKEN_2022_SOL_PAIRS_JUPITER_AGGREGATOR_QUOTES",
  ]),
});
const researchManifestSchema = z.object({
  kind: z.literal("RESEARCH_PAPER_RUN_V1"),
  mode: z.literal("RESEARCH_PAPER"),
  strictPolicyEligible: z.literal(false),
  liveApproved: z.literal(false),
  bookId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  enrollmentStart: epoch,
  enrollmentEnd: epoch,
  manifestHash: hash,
  economicProfileHash: hash,
  exitProfileHash: hash,
  settlementScope: z.literal("QUOTE_MINIMUM_MODEL_NOT_ATTAINABLE_FILL_CERTIFICATION"),
  feeScope: z.literal("10000_LAMPORTS_PER_SETTLED_LEG_MODEL_NOT_MEASURED"),
  priorityFeeScope: z.literal("INCLUDED_IN_FIXED_NETWORK_FEE_MODEL_NOT_MEASURED"),
  rentScope: z.literal("NO_TOKEN_ACCOUNT_CREATED_RENT_EXCLUDED_FROM_PAPER_MODEL"),
  failedAttemptScope: z.literal("NO_TRANSACTION_SUBMITTED_NO_ONCHAIN_FAILURE_FEE_MODELED"),
  policy: researchPolicySchema,
});
const researchAccountSchema = z.object({
  bookId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  mode: z.literal("RESEARCH_PAPER"),
  strictPolicyEligible: z.literal(false),
  liveApproved: z.literal(false),
  associationScope: z.literal("UNKNOWN_ASSOCIATIONS_ACCEPTED_FOR_PAPER"),
  cashLamports: raw,
  reservedLamports: raw,
  availableCashLamports: raw,
  equityLamports: raw.nullable(),
  realizedPnlLamports: researchSignedRaw,
  modeledSettledFeesLamports: raw,
  openPositions: count.max(100),
  pendingEntries: count.max(100),
  pendingExits: count.max(100),
  sourceHash: hash,
  policyHash: hash,
  runHash: hash,
  ledgerVersion: count,
  suspended: z.boolean(),
});
const researchPositionSchema = positionSchema.extend({
  id: researchId,
  quantityRaw: raw,
  markAt: epoch.nullable(),
  entryFeeLamports: raw,
});
const researchPendingSchema = z.object({
  id: researchId,
  mint: address,
  strategy: z.literal("momentum_breakout"),
  amountLamports: raw,
  createdAt: epoch,
  readyAt: epoch,
  eventId: researchId,
  slippageBps: count.max(10000).optional(),
});
const researchExitSchema = z.object({
  id: researchId,
  positionId: researchId,
  mint: address,
  quantityRaw: raw,
  reason: text,
  createdAt: epoch,
  readyAt: epoch,
  slippageBps: count.max(10000),
});
const researchTradeSchema = z.object({
  id: researchId,
  positionId: researchId,
  isFinalExit: z.boolean(),
  mint: address,
  strategy: z.literal("momentum_breakout"),
  openedAt: epoch,
  closedAt: epoch,
  costLamports: raw,
  proceedsLamports: raw,
  feesLamports: raw,
  pnlLamports: researchSignedRaw,
  quantityRaw: raw.optional(),
  reason: text,
});
const researchJournalSchema = z.object({
  sequence: count.positive(),
  at: epoch,
  bookId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  kind: z.enum([
    "ENTRY_INTENT",
    "ENTRY_SETTLED",
    "ENTRY_CANCELLED",
    "EXIT_INTENT",
    "EXIT_UNAVAILABLE",
    "EXIT_SETTLED",
    "MARK_UNAVAILABLE",
    "MARK_OBSERVED",
  ]),
  entryId: researchId,
});
const researchPaperSchema = z.object({
  status: z.enum([
    "WAITING_ENROLLMENT",
    "ACTIVE",
    "ENTRY_STOPPED",
    "SUSPENDED",
    "ENROLLMENT_CLOSED",
  ]),
  account: researchAccountSchema,
  manifest: researchManifestSchema,
  positions: z.array(researchPositionSchema).max(100),
  pending: z.array(researchPendingSchema).max(100),
  pendingExits: z.array(researchExitSchema).max(100),
  journal: z.array(researchJournalSchema).max(200),
  trades: z.array(researchTradeSchema).max(1000),
  completedPositions: z
    .array(
      completedSchema.extend({
        positionId: researchId,
        strategy: z.literal("momentum_breakout"),
        pnlLamports: researchSignedRaw,
      }),
    )
    .max(5000),
  limitations: z.array(text).max(100),
});
export type PhantomResearchPaper = z.infer<typeof researchPaperSchema>;

/** Optional research book is isolated from the legacy strict account and never promoted to approval. */
function parseResearchPaper(input: unknown, now: number): PhantomResearchPaper | null {
  const parsed = researchPaperSchema.safeParse(input);
  if (!parsed.success) return null;
  const r = parsed.data,
    a = r.account,
    m = r.manifest,
    p = m.policy;
  const unique = <T>(items: T[], key: (item: T) => string | number) =>
    new Set(items.map(key)).size === items.length;
  const positionIds = new Map(r.positions.map((v) => [v.id, v]));
  const prefix = `research:${m.bookId}:`;
  if (
    a.bookId !== m.bookId ||
    a.sourceHash !== p.sourceHash ||
    a.policyHash !== p.manifestHash ||
    a.runHash !== m.manifestHash ||
    m.enrollmentStart < p.frozenAt ||
    m.enrollmentEnd <= m.enrollmentStart ||
    p.frozenAt > now ||
    (p.kind === "RESEARCH_PAPER_POLICY_V1") !== (p.version === 1) ||
    (p.version === 1) !== (p.sourceUniverse === "LEGACY_SPL_SOL_PAIRS_JUPITER_AGGREGATOR_QUOTES") ||
    BigInt(p.entryLamports) <= 0n ||
    BigInt(p.initialCapitalLamports) <= 0n ||
    BigInt(a.reservedLamports) > BigInt(a.cashLamports) ||
    BigInt(a.availableCashLamports) !== BigInt(a.cashLamports) - BigInt(a.reservedLamports) ||
    a.openPositions !== r.positions.length ||
    a.pendingEntries !== r.pending.length ||
    a.pendingExits !== r.pendingExits.length ||
    a.openPositions + a.pendingEntries > p.maximumPositions ||
    !unique(r.positions, (v) => v.id) ||
    !unique(r.positions, (v) => v.mint) ||
    !unique(r.pending, (v) => v.id) ||
    !unique(r.pendingExits, (v) => v.id) ||
    !unique(r.pendingExits, (v) => v.positionId) ||
    !unique(r.trades, (v) => v.id) ||
    !unique(r.completedPositions, (v) => v.positionId) ||
    !unique(r.journal, (v) => v.sequence)
  )
    return null;
  if (
    BigInt(a.reservedLamports) !==
    r.pending.reduce(
      (n, v) => n + BigInt(v.amountLamports) + BigInt(p.networkFeePerLegLamports),
      0n,
    )
  )
    return null;
  if (
    BigInt(a.cashLamports) +
      r.positions.reduce((n, v) => n + BigInt(v.costLamports) + BigInt(v.entryFeeLamports), 0n) !==
    BigInt(p.initialCapitalLamports) + BigInt(a.realizedPnlLamports)
  )
    return null;
  if (
    r.positions.some(
      (v) =>
        !v.id.startsWith(prefix) ||
        v.strategy !== p.strategy ||
        BigInt(v.quantityRaw) <= 0n ||
        v.openedAt > now ||
        v.openedAt < m.enrollmentStart,
    ) ||
    r.pending.some(
      (v) =>
        !v.id.startsWith(prefix) ||
        v.amountLamports !== p.entryLamports ||
        v.createdAt > now ||
        v.createdAt < m.enrollmentStart ||
        v.readyAt - v.createdAt < p.minimumEntryDelayMs,
    ) ||
    r.pendingExits.some((v) => {
      const position = positionIds.get(v.positionId);
      return (
        !position ||
        position.mint !== v.mint ||
        BigInt(v.quantityRaw) <= 0n ||
        BigInt(v.quantityRaw) > BigInt(position.quantityRaw) ||
        v.createdAt > now ||
        v.readyAt - v.createdAt < p.minimumEntryDelayMs
      );
    }) ||
    r.journal.some(
      (v, i) =>
        v.bookId !== m.bookId ||
        !v.entryId.startsWith(prefix) ||
        v.at > now ||
        (i > 0 && (v.sequence <= r.journal[i - 1].sequence || v.at < r.journal[i - 1].at)),
    ) ||
    [...r.trades, ...r.completedPositions].some(
      (v) =>
        v.openedAt > v.closedAt ||
        v.closedAt > now ||
        BigInt(v.pnlLamports) !==
          BigInt(v.proceedsLamports) - BigInt(v.costLamports) - BigInt(v.feesLamports),
    ) ||
    r.trades.some((v) => !v.positionId.startsWith(prefix)) ||
    r.completedPositions.some((v) => !v.positionId.startsWith(prefix))
  )
    return null;
  // Account equity is only usable with fresh exact-size marks for every open position.
  r.positions = r.positions.map((v) => ({
    ...v,
    strategy: phantomText(v.strategy),
    markLamports:
      v.markAt !== null && v.markAt <= now && now - v.markAt <= p.maximumQuoteAgeMs
        ? v.markLamports
        : null,
  }));
  const fresh = r.positions.every((v) => v.markLamports !== null && v.markAt !== null);
  const derivedEquity = fresh
    ? BigInt(a.cashLamports) + r.positions.reduce((n, v) => n + BigInt(v.markLamports!), 0n)
    : null;
  if (
    a.equityLamports !== null &&
    (derivedEquity === null || BigInt(a.equityLamports) !== derivedEquity)
  )
    a.equityLamports = null;
  r.pendingExits = r.pendingExits.map((v) => ({ ...v, reason: phantomText(v.reason) }));
  r.trades = r.trades.map((v) => ({ ...v, reason: phantomText(v.reason) }));
  r.completedPositions = r.completedPositions.map((v) => ({
    ...v,
    finalReason: phantomText(v.finalReason),
  }));
  r.limitations = r.limitations.map(phantomText);
  return r;
}

export function phantomText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s]+/gi, "[provider URL omitted]")
    .replace(/((?:api[_-]?key|authorization|secret|token)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]")
    .slice(0, 400);
}
export type PhantomEvent = Omit<
  z.infer<typeof eventSchema>,
  "details" | "fullTransactionVerified" | "verification"
> & {
  verification: "FULL_TRANSACTION" | "TYPED_PROGRAM_EVENT" | "UNKNOWN";
};
export type PhantomDecision = z.infer<typeof decisionSchema>;
export type PhantomPosition = z.infer<typeof positionSchema>;
export type PhantomCompleted = z.infer<typeof completedSchema>;
export type PhantomState = {
  now: number;
  sampledAt: number;
  startedAt: number;
  sourceVersion: string | null;
  health: z.infer<typeof healthSchema>;
  events: PhantomEvent[];
  decisions: PhantomDecision[];
  positions: PhantomPosition[];
  positionCount: number;
  pendingCount: number;
  completed: PhantomCompleted[];
  completedCount: number | null;
  completedNetLamports: string | null;
  cashLamports: string;
  equityLamports: string | null;
  equityAt: number | null;
  lastObservationAt: number | null;
  discardedRows: number;
  limitations: string[];
  researchPaper: PhantomResearchPaper | null;
  researchPaperStatus: "absent" | "invalid" | "available";
};
export type PhantomReport = {
  mode: "PAPER";
  readOnly: true;
  checkedAt: number;
  connection: "connected" | "unavailable" | "incompatible";
  status: "live" | "degraded" | "stale" | "waiting" | "offline";
  state: PhantomState | null;
  message: string;
};

/** Whitelist the monitoring contract. Never forward raw config, credentials or transaction bytes. */
export function parsePhantomState(input: unknown, receivedAt: number): PhantomReport {
  const base = { mode: "PAPER" as const, readOnly: true as const, checkedAt: receivedAt };
  const parsed = stateSchema.safeParse(input);
  if (!parsed.success)
    return {
      ...base,
      connection: "incompatible",
      status: "offline",
      state: null,
      message: "The local engine did not return a compatible paper monitoring state.",
    };
  const source = parsed.data;
  if (source.startedAt > source.now + 1000 || (source.health.lastEventAt ?? 0) > source.now + 1000)
    return {
      ...base,
      connection: "incompatible",
      status: "offline",
      state: null,
      message: "The local engine returned inconsistent observation times.",
    };
  let discardedRows = 0;
  const hasResearchPaper = source.researchPaper !== undefined && source.researchPaper !== null;
  const researchPaper = hasResearchPaper
    ? parseResearchPaper(source.researchPaper, source.now)
    : null;
  const researchPaperStatus = hasResearchPaper
    ? researchPaper
      ? "available"
      : "invalid"
    : "absent";
  if (researchPaperStatus === "invalid") discardedRows++;
  const rows = <T>(
    values: unknown[],
    schema: z.ZodType<T>,
    valid: (row: T) => boolean = () => true,
  ): T[] =>
    values.flatMap((value) => {
      const p = schema.safeParse(value);
      if (!p.success || !valid(p.data)) {
        discardedRows++;
        return [];
      }
      return [p.data];
    });
  const eventRows = rows(
    source.events,
    eventSchema,
    (r) =>
      r.receivedAt <= source.now + 1000 &&
      r.processedAt >= r.receivedAt &&
      r.processedAt <= source.now + 1000,
  )
    .map<PhantomEvent>(({ details, fullTransactionVerified, verification, ...r }) => ({
      ...r,
      verification:
        verification === "TYPED_PROGRAM_EVENT" ||
        fullTransactionVerified === false ||
        details?.fullTransactionVerified === false
          ? "TYPED_PROGRAM_EVENT"
          : verification === "FULL_TRANSACTION"
            ? "FULL_TRANSACTION"
            : "UNKNOWN",
    }))
    .sort((a, b) => b.receivedAt - a.receivedAt)
    .slice(0, 200);
  const byId = new Map<string, PhantomEvent>();
  for (const e of eventRows) {
    if (byId.has(e.id)) {
      discardedRows++;
      continue;
    }
    byId.set(e.id, e);
  }
  const events = [...byId.values()];
  const decisions = rows(source.decisions, decisionSchema, (r) => r.at <= source.now + 1000).map(
    (d) => ({
      ...d,
      strategy: phantomText(d.strategy),
      reasons: d.reasons.map(phantomText),
      walletEvidence: d.walletEvidence?.map(phantomText),
    }),
  );
  const positions = rows(
    source.positions,
    positionSchema,
    (r) => r.openedAt <= source.now + 1000,
  ).map((p) => ({ ...p, strategy: phantomText(p.strategy) }));
  const errorsBeforeCompleted = discardedRows;
  const parsedCompleted =
    source.completedPositions === undefined
      ? []
      : rows(
          source.completedPositions,
          completedSchema,
          (r) => r.openedAt <= r.closedAt && r.closedAt <= source.now + 1000,
        ).map((p) => ({
          ...p,
          finalReason: phantomText(p.finalReason),
          strategy: phantomText(p.strategy),
        }));
  const groups = new Map<string, number>();
  for (const p of parsedCompleted) groups.set(p.positionId, (groups.get(p.positionId) ?? 0) + 1);
  const completed = parsedCompleted.filter((p) => groups.get(p.positionId) === 1);
  discardedRows += parsedCompleted.length - completed.length;
  const completeValid =
    source.completedPositions !== undefined && discardedRows === errorsBeforeCompleted;
  const equity = rows(source.equity, equitySchema, (r) => r.at <= source.now + 1000)
    .sort((a, b) => a.at - b.at)
    .at(-1);
  const lastObservationAt =
    Math.max(source.health.lastEventAt ?? 0, ...events.map((e) => e.receivedAt)) || null;
  const stale =
    Math.abs(receivedAt - source.now) > 15000 ||
    (!!lastObservationAt && source.now - lastObservationAt > 60000);
  const degraded =
    !["LIVE", "HEALTHY"].includes(source.health.status.toUpperCase()) ||
    discardedRows > 0 ||
    (source.health.backfillGaps ?? 0) > 0 ||
    (source.health.typedLogs?.dropped ?? 0) > 0;
  return {
    ...base,
    connection: "connected",
    status: stale ? "stale" : !lastObservationAt ? "waiting" : degraded ? "degraded" : "live",
    message: stale
      ? "The last engine observation is stale or the computer clocks disagree."
      : degraded
        ? "The engine reports incomplete coverage or delayed verification."
        : "Read-only paper engine connected.",
    state: {
      now: source.now,
      sampledAt: receivedAt,
      startedAt: source.startedAt,
      sourceVersion:
        source.sourceVersion && /^[a-f0-9]{40,64}$/i.test(source.sourceVersion)
          ? source.sourceVersion
          : null,
      health: {
        ...source.health,
        lastError: source.health.lastError ? phantomText(source.health.lastError) : undefined,
      },
      events,
      decisions,
      positions,
      positionCount: source.positions.length,
      pendingCount: source.pending.length,
      completed,
      completedCount: completeValid ? completed.length : null,
      completedNetLamports: completeValid
        ? String(completed.reduce((n, p) => n + BigInt(p.pnlLamports), 0n))
        : null,
      cashLamports: source.cashLamports,
      equityLamports: equity && source.now - equity.at <= 45000 ? equity.equityLamports : null,
      equityAt: equity?.at ?? null,
      lastObservationAt,
      discardedRows,
      limitations: source.limitations.map(phantomText),
      researchPaper,
      researchPaperStatus,
    },
  };
}

export function phantomSol(value: string | null | undefined, precision = 5): string {
  if (value == null) return "—";
  const n = BigInt(value),
    abs = n < 0n ? -n : n;
  if (precision < 9 && abs > 0n && abs < 10n ** BigInt(9 - precision))
    return `${n < 0n ? "−" : ""}0.${abs.toString().padStart(9, "0").replace(/0+$/, "")}`;
  return `${n < 0n ? "−" : ""}${abs / 1000000000n}.${(abs % 1000000000n).toString().padStart(9, "0").slice(0, precision)}`;
}

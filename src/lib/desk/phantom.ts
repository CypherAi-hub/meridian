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
    },
  };
}

export function phantomSol(value: string | null | undefined, precision = 5): string {
  if (value == null) return "—";
  const n = BigInt(value),
    abs = n < 0n ? -n : n;
  return `${n < 0n ? "−" : ""}${abs / 1000000000n}.${(abs % 1000000000n).toString().padStart(9, "0").slice(0, precision)}`;
}

import { z } from "zod";
const raw = z.string().regex(/^\d+$/),
  signedRaw = z.string().regex(/^-?\d+$/),
  time = z.number().finite().nonnegative();
const stateSchema = z.object({
  mode: z.literal("PAPER"),
  startedAt: time,
  now: time,
  health: z.object({
    status: z.string(),
    source: z.string(),
    received: z.number().int().nonnegative(),
    decoded: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    lastEventAt: time.nullable(),
    latencyMs: z.object({
      p50: z.number().finite().nonnegative().nullable(),
      p95: z.number().finite().nonnegative().nullable(),
    }),
    queueDepth: z.number().int().nonnegative().optional(),
    backfillGaps: z.number().int().nonnegative().optional(),
    lastError: z.string().optional(),
    typedObserved: z.number().int().nonnegative().optional(),
    typedLogs: z
      .object({
        received: z.number().int().nonnegative(),
        processed: z.number().int().nonnegative(),
        dropped: z.number().int().nonnegative(),
        errors: z.number().int().nonnegative(),
        queueDepth: z.number().int().nonnegative(),
        latencyMs: z.object({
          p50: z.number().finite().nonnegative().nullable(),
          p95: z.number().finite().nonnegative().nullable(),
        }),
      })
      .optional(),
  }),
  events: z
    .array(
      z.object({
        id: z.string(),
        protocol: z.string(),
        kind: z.string(),
        signature: z.string(),
        slot: z.number().int().nonnegative(),
        mint: z.string(),
        actor: z.string(),
        receivedAt: time,
        processedAt: time,
        commitment: z.string(),
        amountRaw: raw.nullable().optional(),
        quoteAmountRaw: raw.nullable().optional(),
        verification: z.enum(["FULL_TRANSACTION", "TYPED_PROGRAM_EVENT"]).optional(),
        fullTransactionVerified: z.boolean().optional(),
        instructionSchema: z.string().optional(),
        eventSchema: z.string().optional(),
      }),
    )
    .max(10_000),
  decisions: z
    .array(
      z.object({
        at: time,
        mint: z.string(),
        strategy: z.string(),
        accepted: z.boolean(),
        reasons: z.array(z.string()),
        score: z.number().finite().optional(),
        organicDemandScore: z.number().finite().optional(),
        walletEvidence: z.array(z.string()).optional(),
      }),
    )
    .max(10_000),
  positions: z
    .array(
      z.object({
        id: z.string(),
        mint: z.string(),
        strategy: z.string(),
        quantityRaw: raw,
        costLamports: raw,
        openedAt: time,
        markLamports: raw.nullable(),
      }),
    )
    .max(10_000),
  trades: z
    .array(
      z.object({
        id: z.string(),
        positionId: z.string().nullable().optional(),
        isFinalExit: z.boolean().nullable().optional(),
        mint: z.string(),
        strategy: z.string(),
        openedAt: time,
        closedAt: time,
        costLamports: raw,
        proceedsLamports: raw,
        feesLamports: raw,
        pnlLamports: signedRaw,
        reason: z.string(),
      }),
    )
    .max(10_000),
  completedPositions: z
    .array(
      z.object({
        positionId: z.string(),
        mint: z.string(),
        strategy: z.string(),
        openedAt: time,
        closedAt: time,
        quantityRaw: raw.nullable(),
        costLamports: raw,
        proceedsLamports: raw,
        feesLamports: raw,
        pnlLamports: signedRaw,
        exitLegs: z.number().int().positive(),
        finalReason: z.string(),
      }),
    )
    .max(100_000)
    .optional(),
  equity: z.array(z.object({ at: time, equityLamports: signedRaw.nullable() })).max(100_000),
  cashLamports: raw,
  limitations: z.array(z.string()),
});
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const engine = new URL(process.env.PHANTOM_ENGINE_URL ?? "http://127.0.0.1:8790");
    if (
      engine.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(engine.hostname) ||
      engine.username ||
      engine.password ||
      engine.search
    )
      throw Error("Engine must be a local HTTP service");
    const response = await fetch(new URL("/state", engine), {
      cache: "no-store",
      signal: AbortSignal.timeout(4500),
      redirect: "error",
    });
    if (!response.ok) throw Error("Engine unavailable");
    // Strip unknown properties so future engine configuration cannot leak through this read-only proxy.
    const state = stateSchema.parse(await response.json());
    return Response.json(state, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json(
      {
        error:
          "Engine unavailable. Start the PHANTOM paper worker and confirm its local /state endpoint.",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

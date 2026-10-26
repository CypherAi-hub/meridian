import { z } from "zod";
const raw = z.string().regex(/^\d+$/),
  signed = z.string().regex(/^-?\d+$/),
  time = z.number().finite().nonnegative();
const quote = z.object({
  inputMint: z.string(),
  outputMint: z.string(),
  inAmount: raw,
  outAmount: raw,
  minOutAmount: raw,
  impactBps: z.number().finite().nullable(),
  observedAt: time,
  contextSlot: z.number().int().nonnegative().nullable(),
  route: z.array(z.string()),
  feeBps: z.number().finite().optional(),
  feeMint: z.string().optional(),
  source: z.enum(["JUPITER", "PUMP_ONCHAIN", "PUMPSWAP_ONCHAIN"]).optional(),
  liquidityLamports: raw.optional(),
});
const base = z.object({
  id: z.string(),
  mint: z.string(),
  signature: z.string(),
  slot: z.number().int().nonnegative(),
  eventObservedAt: time,
  startedAt: time,
  scope: z.literal("RESEARCH_QUOTE_ONLY_NO_TRADE"),
  amountLamports: raw,
  modeledNetworkFeesLamports: raw,
  slippageBpsPerLeg: z.number().int().min(0).max(10_000),
  completedAt: time,
  latencyMs: z.number().finite().nonnegative(),
  observedAt: time.optional(),
  quoteFreshness: z
    .object({
      buy: z.enum(["FRESH", "STALE", "FUTURE", "NO_QUOTE"]).optional(),
      sell: z.enum(["FRESH", "STALE", "FUTURE", "NO_QUOTE"]).optional(),
      buyAgeMs: z.number().finite().nullable().optional(),
      sellAgeMs: z.number().finite().nullable().optional(),
    })
    .optional(),
});
const baseline = base.extend({
  phase: z.literal("BASELINE").optional(),
  baselineEligibleForHorizons: z.boolean().optional(),
});
const horizon = base.extend({
  phase: z.literal("HORIZON"),
  episodeId: z.string(),
  baselineAt: time,
  baselineBuy: quote,
  hypotheticalTokenQuantityRaw: raw,
  horizonMs: z.union([z.literal(30000), z.literal(60000), z.literal(180000)]),
  targetAt: time,
  observedAt: time,
  delayPastTargetMs: z.number().finite().nonnegative(),
});
const observations = z.object({
  observations: z
    .array(
      z.union([
        z.discriminatedUnion("status", [
          baseline.extend({
            status: z.literal("QUOTED"),
            buy: quote,
            sell: quote,
            conservativeRoundTripNetLamports: signed,
            conservativeRoundTripCostBps: z.number().finite(),
            assumptions: z.string(),
          }),
          baseline.extend({
            status: z.literal("UNAVAILABLE"),
            error: z.string(),
            buy: quote.optional(),
          }),
        ]),
        z.discriminatedUnion("status", [
          horizon.extend({
            status: z.literal("QUOTED"),
            sell: quote,
            hypotheticalHorizonNetLamports: signed,
            hypotheticalHorizonReturnBps: z.number().finite(),
            assumptions: z.string(),
          }),
          horizon.extend({
            status: z.literal("UNAVAILABLE"),
            error: z.string(),
            assumptions: z.string().optional(),
          }),
        ]),
      ]),
    )
    .max(10_000),
});
export const dynamic = "force-dynamic";
function verifyQuote(
  q: z.infer<typeof quote>,
  inputMint: string,
  outputMint: string,
  input: bigint,
  at: number,
  targetAt?: number,
) {
  if (
    q.inputMint !== inputMint ||
    q.outputMint !== outputMint ||
    BigInt(q.inAmount) !== input ||
    BigInt(q.minOutAmount) <= 0n ||
    BigInt(q.minOutAmount) > BigInt(q.outAmount) ||
    q.observedAt > at ||
    at - q.observedAt > 5000 ||
    (targetAt !== undefined && q.observedAt < targetAt)
  )
    throw Error("Unverified quote provenance");
  return BigInt(q.minOutAmount);
}
function verifyObservation(row: z.infer<typeof observations>["observations"][number]) {
  if (row.status !== "QUOTED") return;
  const wsol = "So11111111111111111111111111111111111111112",
    amount = BigInt(row.amountLamports),
    fees = BigInt(row.modeledNetworkFeesLamports);
  if (amount <= 0n) throw Error("Invalid baseline amount");
  if (row.phase === "HORIZON") {
    if (
      row.targetAt !== row.baselineAt + row.horizonMs ||
      row.observedAt < row.targetAt ||
      row.delayPastTargetMs !== row.observedAt - row.targetAt
    )
      throw Error("Invalid horizon time");
    const quantity = verifyQuote(row.baselineBuy, wsol, row.mint, amount, row.baselineAt);
    if (quantity !== BigInt(row.hypotheticalTokenQuantityRaw))
      throw Error("Changed original quantity");
    const proceeds = verifyQuote(row.sell, row.mint, wsol, quantity, row.observedAt, row.targetAt),
      net = proceeds - amount - fees;
    if (
      net !== BigInt(row.hypotheticalHorizonNetLamports) ||
      Number((net * 10000n) / amount) !== row.hypotheticalHorizonReturnBps
    )
      throw Error("Invalid hypothetical quote accounting");
  } else {
    const at = row.observedAt ?? row.completedAt,
      quantity = verifyQuote(row.buy, wsol, row.mint, amount, at),
      proceeds = verifyQuote(row.sell, row.mint, wsol, quantity, at);
    if (
      proceeds - amount - fees !== BigInt(row.conservativeRoundTripNetLamports) ||
      Number(((amount + fees - proceeds) * 10000n) / amount) !== row.conservativeRoundTripCostBps
    )
      throw Error("Invalid baseline quote accounting");
  }
}
/** Reads persisted research only. This route never asks a market provider for a quote. */
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
      throw Error("Local engine required");
    const response = await fetch(new URL("/quote-research", engine), {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(4500),
    });
    if (!response.ok) throw Error("Research unavailable");
    const data = observations.parse(await response.json());
    data.observations.forEach(verifyObservation);
    return Response.json(data, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(
      {
        error:
          "Stored quote research is unavailable. No sample or cost estimate has been invented.",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

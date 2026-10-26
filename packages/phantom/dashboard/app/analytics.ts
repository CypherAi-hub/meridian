import type { ChainEvent, CompletedPosition, ResearchObservation } from "./state";
/** This input must be the engine's aggregation of its full ledger, before exit-leg pagination. */
export function completedSummary(positions: readonly CompletedPosition[] | undefined) {
  if (positions === undefined)
    return { count: null, winRate: null, netLamports: null, feesLamports: null };
  const net = positions.reduce((n, p) => n + BigInt(p.pnlLamports), 0n),
    fees = positions.reduce((n, p) => n + BigInt(p.feesLamports), 0n),
    wins = positions.filter((p) => BigInt(p.pnlLamports) > 0n).length;
  return {
    count: positions.length,
    winRate: positions.length ? wins / positions.length : null,
    netLamports: net.toString(),
    feesLamports: fees.toString(),
  };
}
export function researchSummary(observations: readonly ResearchObservation[] | undefined) {
  if (observations === undefined)
    return { samples: null, quoted: null, unavailable: null, medianCostBps: null };
  const baselines = observations.filter((o) => o.phase !== "HORIZON");
  const costs = baselines
    .filter((o) => o.status === "QUOTED" && o.conservativeRoundTripCostBps != null)
    .map((o) => o.conservativeRoundTripCostBps!)
    .sort((a, b) => a - b);
  const middle = Math.floor(costs.length / 2),
    median = costs.length
      ? costs.length % 2
        ? costs[middle]
        : (costs[middle - 1] + costs[middle]) / 2
      : null;
  return {
    samples: baselines.length,
    quoted: baselines.filter((o) => o.status === "QUOTED").length,
    unavailable: baselines.filter((o) => o.status === "UNAVAILABLE").length,
    medianCostBps: median,
  };
}
export function horizonSummary(observations: readonly ResearchObservation[] | undefined) {
  return [30_000, 60_000, 180_000].map((horizonMs) => {
    if (observations === undefined)
      return {
        horizonMs,
        samples: null,
        quoted: null,
        unavailable: null,
        medianHypotheticalReturnBps: null,
        maximumDelayMs: null,
      };
    const rows = observations.filter((o) => o.phase === "HORIZON" && o.horizonMs === horizonMs),
      values = rows
        .filter((o) => o.status === "QUOTED" && o.hypotheticalHorizonReturnBps != null)
        .map((o) => o.hypotheticalHorizonReturnBps!)
        .sort((a, b) => a - b),
      middle = Math.floor(values.length / 2),
      delays = rows.map((o) => o.delayPastTargetMs).filter((v): v is number => v != null);
    return {
      horizonMs,
      samples: rows.length,
      quoted: values.length,
      unavailable: rows.filter((o) => o.status === "UNAVAILABLE").length,
      medianHypotheticalReturnBps: values.length
        ? values.length % 2
          ? values[middle]
          : (values[middle - 1] + values[middle]) / 2
        : null,
      maximumDelayMs: delays.length ? Math.max(...delays) : null,
    };
  });
}
export function verificationLabel(
  event: Pick<ChainEvent, "verification" | "fullTransactionVerified">,
) {
  if (event.verification === "TYPED_PROGRAM_EVENT" && event.fullTransactionVerified !== true)
    return "Typed event · awaiting full transaction";
  if (
    event.fullTransactionVerified === true ||
    (event.verification === "FULL_TRANSACTION" && event.fullTransactionVerified !== false)
  )
    return "Full transaction verified";
  return "Verification unavailable";
}

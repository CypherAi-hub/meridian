import type { ParticipantEvent, ParticipantFeatureVector } from "./v35-types.ts";

export function participantMissingnessAudit(events: ParticipantEvent[], vectors: ParticipantFeatureVector[]) {
  const n = events.length;
  const unknownWallet = n ? events.filter((e) => e.walletId === "UNKNOWN" || e.dataStatus !== "OK").length / n : 1;
  const noNotional = n ? events.filter((e) => e.usdNotional == null).length / n : 1;
  const vecUnknown = vectors.length ? vectors.filter((v) => v.dataStatus !== "OK").length / vectors.length : 1;
  return {
    version: "research_quality_v3_participant",
    events: n,
    walletIdentityCoverage: 1 - unknownWallet,
    notionalCoverage: 1 - noNotional,
    vectorUnknownRatio: vecUnknown,
    note: "Missingness is UNKNOWN, never zero. Provider failure is not a rug signal.",
  };
}

export function degradeOnProviderFailure<T>(marketLive: T, participantOk: boolean): { market: T; participantStatus: "OK" | "UNKNOWN" } {
  return { market: marketLive, participantStatus: participantOk ? "OK" : "UNKNOWN" };
}

import { researchHealth } from "./research-health.ts";
import type { DataQuality } from "./types.ts";

export type TrainingAudit = {
  decisions: number;
  completed: number;
  qualified: number;
  qualifiedTokens: number;
  leakageViolations: number;
  missingSnapshots: number;
};

/** Readiness evidence only; this never authorizes training or execution. */
export function trainingReadiness(q: DataQuality, audit: TrainingAudit, production: boolean, now = Date.now()) {
  const health = researchHealth(q, { useEpoch: true });
  const blockers = [...health.blockers];
  const soak = q.productionSoakStartedAtMs;
  const soakHours = soak != null && Number.isFinite(soak) && soak > 0 && soak <= now
    ? (now - soak) / 3_600_000 : 0;
  if (!production) blockers.push("Production Neon collection required; preview time does not count");
  if (soakHours < 72) blockers.push(`Production soak ${soakHours.toFixed(1)}h < 72h`);
  if (!Number.isFinite(audit.qualifiedTokens) || audit.qualifiedTokens < 500)
    blockers.push(`Qualified v2 tokens ${audit.qualifiedTokens} < 500`);
  if (audit.leakageViolations !== 0) blockers.push(`Decision-time audit violations: ${audit.leakageViolations}`);
  if (audit.missingSnapshots !== 0) blockers.push(`Missing frozen snapshots: ${audit.missingSnapshots}`);
  return {
    generatedAt: now, epoch: q.collectionEpoch, scope: "full_epoch" as const,
    executionMode: "PAPER" as const, trainingEnabled: false as const,
    collectionReady: blockers.length === 0, blockers, soakHours, audit,
    nextStep: blockers.length
      ? "Keep collecting genuine observations; historical UNKNOWN labels remain excluded."
      : "Freeze and audit a dataset, then validate token-disjoint chronological splits before fitting a model.",
  };
}

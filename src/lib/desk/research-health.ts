import type { DataQuality, RouteCoverage } from "./types.ts";
import { officialSoakAllowed } from "./env.ts";

export type ResearchHealthStatus = "HEALTHY" | "DEGRADED";

export type BlockingReason = {
  metric: string;
  actual: number;
  required: number;
};

function routeCheckFromCoverage(rc?: RouteCoverage | null): number | null {
  if (!rc || !rc.checks) return null;
  return Math.max(0, Math.min(1, (rc.checks - (rc.notChecked ?? 0)) / rc.checks));
}

export function derivedRouteCheckCoverage(q: DataQuality, epoch: boolean): number {
  if (epoch && q.epochRouteCheckCoveragePct != null) return q.epochRouteCheckCoveragePct;
  if (!epoch && q.routeCheckCoveragePct != null) return q.routeCheckCoveragePct;
  if (q.routeCheckCoveragePct != null) return q.routeCheckCoveragePct;
  return routeCheckFromCoverage(q.routeCoverage) ?? 0;
}

export function researchHealth(
  q: DataQuality,
  opts?: { useEpoch?: boolean },
): { status: ResearchHealthStatus; blockers: string[]; blockingReasons: BlockingReason[] } {
  const blockers: string[] = [];
  const blockingReasons: BlockingReason[] = [];
  const epochRows =
    (q.epochUniqueTokens ?? 0) + (q.epochGradeA ?? 0) + (q.epochGradeB ?? 0) + (q.epochGradeC ?? 0) + (q.epochResearchOnly ?? 0);
  const epoch = opts?.useEpoch ?? epochRows > 0;
  const holderAtDecision =
    (epoch ? (q.holderCoverageAtDecisionPct ?? q.epochHolderCoveragePct) : q.holderCoveragePct) ??
    q.holderCoveragePct ??
    0;
  const highMed = epoch
    ? (q.epochHighConfidencePct ?? 0) + (q.epochMediumConfidencePct ?? 0)
    : (q.highConfidencePct ?? 0) + (q.mediumConfidencePct ?? 0);
  const gradeAB = epoch ? (q.epochGradeA ?? 0) + (q.epochGradeB ?? 0) : q.gradeA + q.gradeB;
  const gradeN = epoch
    ? gradeAB + (q.epochGradeC ?? 0) + (q.epochResearchOnly ?? 0)
    : gradeAB + q.gradeC + q.researchOnly;
  const gradePct = gradeN ? gradeAB / gradeN : 0;
  const checkCoverage = derivedRouteCheckCoverage(q, epoch);
  const tokens = epoch ? (q.epochUniqueTokens ?? q.uniqueTokens ?? 0) : (q.uniqueTokens ?? 0);
  const push = (metric: string, actual: number, required: number, label: string) => {
    if (actual < required) {
      blockingReasons.push({ metric, actual, required });
      blockers.push(label);
    }
  };
  push("holderCoverageAtDecision", holderAtDecision, 0.8, `holder-at-decision ${(holderAtDecision * 100).toFixed(0)}% < 80%`);
  push("highMediumBarrierCoverage", highMed, 0.65, `HIGH+MEDIUM labels ${((highMed) * 100).toFixed(0)}% < 65%`);
  push("gradeAB", gradePct, 0.5, `Grade A+B ${(gradePct * 100).toFixed(0)}% < 50%`);
  push("routeCheckCoverage", checkCoverage, 0.9, `route check coverage ${(checkCoverage * 100).toFixed(0)}% < 90%`);
  push("uniqueTokens", tokens, 500, `unique tokens ${tokens} < 500`);
  return { status: blockers.length ? "DEGRADED" : "HEALTHY", blockers, blockingReasons };
}

export function productionReady(q: DataQuality): boolean {
  if (!officialSoakAllowed()) return false;
  const soak = q.productionSoakStartedAtMs;
  if (soak == null) return false;
  if (Date.now() - soak < 72 * 3_600_000) return false;
  return researchHealth(q, { useEpoch: true }).status === "HEALTHY";
}

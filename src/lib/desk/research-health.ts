import type { DataQuality } from "./types.ts";

export type ResearchHealthStatus = "HEALTHY" | "DEGRADED";

export function researchHealth(q: DataQuality): { status: ResearchHealthStatus; blockers: string[] } {
  const blockers: string[] = [];
  const holder = q.holderCoveragePct ?? 0;
  const highMed = (q.highConfidencePct ?? 0) + (q.mediumConfidencePct ?? 0);
  const gradeAB = q.gradeA + q.gradeB;
  const gradeN = gradeAB + q.gradeC + q.researchOnly;
  const gradePct = gradeN ? gradeAB / gradeN : 0;
  const checks = q.routeCoverage.checks || 0;
  const checked = checks - q.routeCoverage.notChecked;
  const checkCoverage = checks ? checked / checks : 0;
  if (holder < 0.8) blockers.push(`holder coverage ${(holder * 100).toFixed(0)}% < 80%`);
  if (highMed < 0.65) blockers.push(`HIGH+MEDIUM labels ${((highMed) * 100).toFixed(0)}% < 65%`);
  if (gradePct < 0.5) blockers.push(`Grade A+B ${(gradePct * 100).toFixed(0)}% < 50%`);
  if (checkCoverage < 0.9) blockers.push(`route check coverage ${(checkCoverage * 100).toFixed(0)}% < 90%`);
  if ((q.uniqueTokens ?? 0) < 500) blockers.push(`unique tokens ${q.uniqueTokens} < 500`);
  return { status: blockers.length ? "DEGRADED" : "HEALTHY", blockers };
}

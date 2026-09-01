export type ResearchGrade = "TRAINING_GRADE_A" | "TRAINING_GRADE_B" | "TRAINING_GRADE_C" | "RESEARCH_ONLY";

export type QualityComponents = {
  priceOk: boolean;
  liquidityOk: boolean;
  holderOk: boolean;
  routeOk: boolean;
  securityOk: boolean;
  pathQuality: number;
  freshnessQuality: number;
};

export function researchQualityScore(c: QualityComponents): number {
  let score = 0;
  score += c.priceOk ? 15 : 0;
  score += c.liquidityOk ? 15 : 0;
  score += c.holderOk ? 15 : 0;
  score += c.routeOk ? 15 : 0;
  score += c.securityOk ? 15 : 0;
  score += 15 * clamp01(c.pathQuality);
  score += 10 * clamp01(c.freshnessQuality);
  return Math.max(0, Math.min(100, score));
}

export function gradeFromScore(score: number): ResearchGrade {
  if (score >= 90) return "TRAINING_GRADE_A";
  if (score >= 75) return "TRAINING_GRADE_B";
  if (score >= 50) return "TRAINING_GRADE_C";
  return "RESEARCH_ONLY";
}

export function pathQualityFromGaps(maxGapSeconds: number | null, sampleCount: number): number {
  if (sampleCount < 2 || maxGapSeconds == null) return 0;
  if (maxGapSeconds <= 5) return 1;
  if (maxGapSeconds <= 15) return 0.7;
  if (maxGapSeconds <= 30) return 0.35;
  return 0.1;
}

export function freshnessQuality(ageMs: number, staleMs: number): number {
  if (!Number.isFinite(ageMs) || ageMs < 0) return 0;
  if (ageMs <= staleMs / 3) return 1;
  if (ageMs <= staleMs) return 0.6;
  return 0.15;
}

function clamp01(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

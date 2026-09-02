import type { ResearchGrade } from "./quality-score.ts";
import { gradeFromScore, pathQualityFromGaps } from "./quality-score.ts";

export const RESEARCH_QUALITY_V2 = "research_quality_v2";

export type InputQualityParts = {
  priceOk: boolean;
  liquidityOk: boolean;
  flowOk: boolean;
  holderOk: boolean;
  securityOk: boolean;
  routeOk: boolean;
  freshness: number;
};

export type LabelQualityParts = {
  pathDensity: number;
  routePath: boolean;
  liqPath: boolean;
  lateWatchPenalty: number;
};

function clamp01(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function inputQualityScore(c: InputQualityParts): number {
  let s = 0;
  s += c.priceOk ? 10 : 0;
  s += c.liquidityOk ? 10 : 0;
  s += c.flowOk ? 10 : 0;
  s += c.holderOk ? 15 : 0;
  s += c.securityOk ? 10 : 0;
  s += c.routeOk ? 15 : 0;
  s += 10 * clamp01(c.freshness);
  return Math.max(0, Math.min(80, s));
}

export function labelQualityScore(c: LabelQualityParts): number {
  let s = 0;
  s += 15 * clamp01(c.pathDensity);
  s += c.routePath ? 3 : 0;
  s += c.liqPath ? 2 : 0;
  s *= clamp01(c.lateWatchPenalty);
  return Math.max(0, Math.min(20, s));
}

export function lateWatchPenalty(firstSampleDelaySeconds: number | null): number {
  if (firstSampleDelaySeconds == null) return 0.4;
  if (firstSampleDelaySeconds <= 5) return 1;
  if (firstSampleDelaySeconds <= 15) return 0.7;
  if (firstSampleDelaySeconds <= 30) return 0.4;
  return 0.2;
}

export function overallQualityV2(input: number, label: number, holderOk: boolean): number {
  let overall = Math.max(0, Math.min(100, input + label));
  if (!holderOk) overall = Math.min(overall, 74);
  return overall;
}

export function gradeFromV2(score: number, holderOk: boolean): ResearchGrade {
  const capped = holderOk ? score : Math.min(score, 74);
  return gradeFromScore(capped);
}

export function pathDensityFromGaps(maxGapSeconds: number | null, sampleCount: number): number {
  return pathQualityFromGaps(maxGapSeconds, sampleCount);
}

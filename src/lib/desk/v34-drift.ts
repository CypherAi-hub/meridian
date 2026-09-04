import type { FeatureMatrixRow } from "./v34-matrix.ts";

export type DriftFeature = {
  column: string;
  baselineMean: number | null;
  currentMean: number | null;
  absDelta: number | null;
};

export type DriftReport = {
  baselineRows: number;
  currentRows: number;
  features: DriftFeature[];
  shifted: string[];
};

function mean(xs: number[]): number | null {
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function values(rows: FeatureMatrixRow[], col: string): number[] {
  const out: number[] = [];
  for (const r of rows) {
    const v = r.features[col];
    if (typeof v === "number" && Number.isFinite(v)) out.push(v);
  }
  return out;
}

/** Mean-shift drift. Threshold is absolute, not a p-value. Honest about small n. */
export function driftReport(
  baseline: FeatureMatrixRow[],
  current: FeatureMatrixRow[],
  opts?: { minN?: number; absDelta?: number },
): DriftReport {
  const minN = opts?.minN ?? 30;
  const absDelta = opts?.absDelta ?? 0.25;
  const cols = new Set<string>();
  for (const r of [...baseline, ...current]) {
    for (const k of Object.keys(r.features)) cols.add(k);
  }
  const features: DriftFeature[] = [];
  const shifted: string[] = [];
  for (const column of [...cols].sort()) {
    const b = values(baseline, column);
    const c = values(current, column);
    const row: DriftFeature = {
      column,
      baselineMean: mean(b),
      currentMean: mean(c),
      absDelta: null,
    };
    if (row.baselineMean != null && row.currentMean != null) {
      row.absDelta = Math.abs(row.currentMean - row.baselineMean);
      if (b.length >= minN && c.length >= minN && row.absDelta >= absDelta) shifted.push(column);
    }
    features.push(row);
  }
  return { baselineRows: baseline.length, currentRows: current.length, features, shifted };
}

import { FEATURE_SCHEMA_HASH } from "./versions.ts";
import { driftReport } from "./v34-drift.ts";
import type { FeatureMatrixRow } from "./v34-matrix.ts";

export type PsiFeature = { column: string; psi: number | null };

export type MonitorReport = {
  meanShift: string[];
  missingnessShift: string[];
  unseenRanges: string[];
  schemaMatch: boolean;
  psi: PsiFeature[];
  psiAlert: string[];
};

function missingPct(rows: FeatureMatrixRow[], col: string): number {
  if (!rows.length) return 0;
  let m = 0;
  for (const r of rows) {
    const v = r.features[col];
    if (v == null || !Number.isFinite(v)) m += 1;
  }
  return m / rows.length;
}

function numeric(rows: FeatureMatrixRow[], col: string): number[] {
  const xs: number[] = [];
  for (const r of rows) {
    const v = r.features[col];
    if (typeof v === "number" && Number.isFinite(v)) xs.push(v);
  }
  return xs;
}

function psi(base: number[], cur: number[], bins = 8): number | null {
  if (base.length < 20 || cur.length < 20) return null;
  const lo = Math.min(...base);
  const hi = Math.max(...base);
  const width = (hi - lo) / bins || 1;
  const counts = (xs: number[]) => {
    const c = Array(bins).fill(0);
    for (const x of xs) {
      let i = Math.floor((x - lo) / width);
      i = Math.min(bins - 1, Math.max(0, i));
      c[i] += 1;
    }
    return c.map((n) => Math.max(n / xs.length, 1e-6));
  };
  const b = counts(base);
  const c = counts(cur);
  let s = 0;
  for (let i = 0; i < bins; i++) s += (c[i] - b[i]) * Math.log(c[i] / b[i]);
  return s;
}

export function monitorDrift(
  baseline: FeatureMatrixRow[],
  current: FeatureMatrixRow[],
  opts?: { expectedSchemaHash?: string },
): MonitorReport {
  const mean = driftReport(baseline, current, { minN: 20, absDelta: 0.2 });
  const cols = new Set<string>();
  for (const r of [...baseline, ...current]) {
    for (const k of Object.keys(r.features)) cols.add(k);
  }
  const missingnessShift: string[] = [];
  const unseenRanges: string[] = [];
  const psiRows: PsiFeature[] = [];
  const psiAlert: string[] = [];
  for (const col of [...cols].sort()) {
    if (Math.abs(missingPct(current, col) - missingPct(baseline, col)) >= 0.2) missingnessShift.push(col);
    const b = numeric(baseline, col);
    const c = numeric(current, col);
    if (b.length && c.length) {
      const minB = Math.min(...b);
      const maxB = Math.max(...b);
      const span = maxB - minB || 1;
      if (c.some((x) => x < minB - 0.25 * span || x > maxB + 0.25 * span)) unseenRanges.push(col);
    }
    const p = psi(b, c);
    psiRows.push({ column: col, psi: p });
    if (p != null && p > 0.25) psiAlert.push(col);
  }
  return {
    meanShift: mean.shifted,
    missingnessShift,
    unseenRanges,
    schemaMatch: (opts?.expectedSchemaHash ?? FEATURE_SCHEMA_HASH) === FEATURE_SCHEMA_HASH,
    psi: psiRows,
    psiAlert,
  };
}

import { FEATURE_SCHEMA } from "./versions.ts";
import type { DatasetRow } from "./dataset.ts";
import type { FeatureMatrixRow } from "./v34-matrix.ts";
import type { SplitAssignment, SplitName } from "./v34-splits.ts";

export type MissingnessColumn = {
  column: string;
  n: number;
  missing: number;
  missingPct: number;
  providerMissingRisk: boolean;
};

export type MissingnessAudit = {
  columns: MissingnessColumn[];
  flagged: string[];
};

const PROVIDER_PROXY = new Set(["top10Pct", "mintAuth", "freezeAuth", "entryImpactPct", "exitImpactPct", "sellQuoteAvailable"]);

export function missingnessAudit(rows: FeatureMatrixRow[]): MissingnessAudit {
  const columns: MissingnessColumn[] = [];
  for (const column of FEATURE_SCHEMA.fields) {
    let missing = 0;
    for (const r of rows) {
      const v = r.features[column];
      if (v == null || (typeof v === "number" && !Number.isFinite(v))) missing += 1;
    }
    const missingPct = rows.length ? missing / rows.length : 0;
    columns.push({
      column,
      n: rows.length,
      missing,
      missingPct,
      providerMissingRisk: PROVIDER_PROXY.has(column) && missingPct >= 0.2,
    });
  }
  return { columns, flagged: columns.filter((c) => c.providerMissingRisk).map((c) => c.column) };
}

function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[i];
}

export type DistColumn = {
  column: string;
  n: number;
  min: number | null;
  max: number | null;
  p10: number | null;
  p50: number | null;
  p90: number | null;
  mean: number | null;
  constant: boolean;
  outliers: number;
};

export type FeatureDistributionAudit = {
  columns: DistColumn[];
  constant: string[];
  correlated: Array<[string, string, number]>;
};

function pearson(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  let sa = 0;
  let sb = 0;
  let sab = 0;
  let sa2 = 0;
  let sb2 = 0;
  for (let i = 0; i < n; i++) {
    sa += a[i];
    sb += b[i];
    sab += a[i] * b[i];
    sa2 += a[i] * a[i];
    sb2 += b[i] * b[i];
  }
  const cov = sab - (sa * sb) / n;
  const da = sa2 - (sa * sa) / n;
  const db = sb2 - (sb * sb) / n;
  if (da <= 0 || db <= 0) return null;
  return cov / Math.sqrt(da * db);
}

export function featureDistributionAudit(rows: FeatureMatrixRow[]): FeatureDistributionAudit {
  const columns: DistColumn[] = [];
  const series = new Map<string, number[]>();
  for (const column of FEATURE_SCHEMA.fields) {
    const xs: number[] = [];
    for (const r of rows) {
      const v = r.features[column];
      if (typeof v === "number" && Number.isFinite(v)) xs.push(v);
    }
    series.set(column, xs);
    const sorted = [...xs].sort((a, b) => a - b);
    const mean = xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
    const varN =
      mean == null || xs.length < 2 ? 0 : xs.reduce((s, v) => s + (v - mean) ** 2, 0) / xs.length;
    const sd = Math.sqrt(varN);
    const outliers = mean == null || sd === 0 ? 0 : xs.filter((v) => Math.abs(v - mean) / sd > 4).length;
    const min = sorted[0] ?? null;
    const max = sorted.at(-1) ?? null;
    columns.push({
      column,
      n: xs.length,
      min,
      max,
      p10: quantile(sorted, 0.1),
      p50: quantile(sorted, 0.5),
      p90: quantile(sorted, 0.9),
      mean,
      constant: min != null && min === max,
      outliers,
    });
  }
  const correlated: Array<[string, string, number]> = [];
  const names = [...series.keys()];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const r = pearson(series.get(names[i]) ?? [], series.get(names[j]) ?? []);
      if (r != null && Math.abs(r) >= 0.95) correlated.push([names[i], names[j], r]);
    }
  }
  return { columns, constant: columns.filter((c) => c.constant && c.n > 1).map((c) => c.column), correlated };
}

export type TargetBalanceAudit = {
  n: number;
  hit10: number;
  hit20: number;
  rug: number;
  positiveHorizon: number;
  hit10Pct: number;
  rugPct: number;
  positiveHorizonPct: number;
};

export function targetBalanceAudit(rows: FeatureMatrixRow[]): TargetBalanceAudit {
  let hit10 = 0;
  let hit20 = 0;
  let rug = 0;
  let positiveHorizon = 0;
  for (const r of rows) {
    if (r.labels.hit10 === 1) hit10 += 1;
    if (r.labels.hit20 === 1) hit20 += 1;
    if (r.labels.rug === 1) rug += 1;
    if (r.labels.ret15m != null && r.labels.ret15m > 0) positiveHorizon += 1;
  }
  const n = rows.length;
  return {
    n,
    hit10,
    hit20,
    rug,
    positiveHorizon,
    hit10Pct: n ? hit10 / n : 0,
    rugPct: n ? rug / n : 0,
    positiveHorizonPct: n ? positiveHorizon / n : 0,
  };
}

export type SplitFoldReport = {
  name: SplitName;
  rows: number;
  tokens: number;
  from: number | null;
  to: number | null;
};

export type SplitReport = {
  folds: SplitFoldReport[];
  leakedTokens: string[];
  purgeOk: boolean;
  tokenGroupedOk: boolean;
};

export function splitReport<T extends { decision_time: number; tokenAddress: string; label_end_time?: number }>(
  splits: SplitAssignment<T>,
  opts: { trainEnd: number; horizonMs?: number },
): SplitReport {
  const horizonMs = opts.horizonMs ?? 60 * 60_000;
  const fold = (name: SplitName, rows: T[]): SplitFoldReport => {
    const times = rows.map((r) => r.decision_time);
    return {
      name,
      rows: rows.length,
      tokens: new Set(rows.map((r) => r.tokenAddress)).size,
      from: times.length ? Math.min(...times) : null,
      to: times.length ? Math.max(...times) : null,
    };
  };
  const trainLabelEnds = splits.train.map((r) => r.label_end_time ?? r.decision_time + horizonMs);
  const purgeOk = trainLabelEnds.every((t) => t < opts.trainEnd);
  const seen = new Map<string, SplitName>();
  let tokenGroupedOk = true;
  const assign = (rows: T[], name: SplitName) => {
    for (const r of rows) {
      const prev = seen.get(r.tokenAddress);
      if (prev && prev !== name) tokenGroupedOk = false;
      seen.set(r.tokenAddress, name);
    }
  };
  assign(splits.train, "train");
  assign(splits.validation, "validation");
  assign(splits.test, "test");
  return {
    folds: [fold("train", splits.train), fold("validation", splits.validation), fold("test", splits.test)],
    leakedTokens: splits.leakedTokens,
    purgeOk,
    tokenGroupedOk,
  };
}

export function datasetRowMatrixCompat(rows: DatasetRow[]): FeatureMatrixRow[] {
  return rows.map((r) => ({
    decisionKey: `${r.tokenAddress}:${r.decision_time}`,
    tokenAddress: r.tokenAddress,
    decisionTime: r.decision_time,
    features: Object.fromEntries(
      FEATURE_SCHEMA.fields.map((col) => {
        const v = r.features[col as keyof typeof r.features];
        return [col, typeof v === "number" && Number.isFinite(v) ? v : null];
      }),
    ),
    labels: {
      hit10: r.hit_plus_10_before_minus_10 == null ? null : r.hit_plus_10_before_minus_10 ? 1 : 0,
      hit20: r.hit_plus_20_before_minus_10 == null ? null : r.hit_plus_20_before_minus_10 ? 1 : 0,
      ret15m: r.theoretical_return,
      rug: r.rug_detected == null ? null : r.rug_detected ? 1 : 0,
    },
  }));
}

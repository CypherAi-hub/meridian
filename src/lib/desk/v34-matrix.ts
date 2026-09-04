import { FEATURE_SCHEMA, FEATURE_SCHEMA_HASH } from "./versions.ts";
import type { DatasetRow } from "./dataset.ts";
import type { Features } from "./types.ts";
import type { SplitName } from "./v34-splits.ts";

export type FeatureMatrixRow = {
  decisionKey: string;
  tokenAddress: string;
  decisionTime: number;
  features: Record<string, number | null>;
  labels: {
    hit10: number | null;
    hit20: number | null;
    ret15m: number | null;
    rug: number | null;
  };
  split?: SplitName;
};

export type FeatureMatrix = {
  columns: readonly string[];
  schemaHash: string;
  rows: FeatureMatrixRow[];
};

function numericFeatures(f: Features): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const col of FEATURE_SCHEMA.fields) {
    const v = f[col as keyof Features];
    if (typeof v === "number") out[col] = Number.isFinite(v) ? v : null;
    else if (typeof v === "string") out[col] = null;
    else out[col] = v == null ? null : null;
  }
  return out;
}

export function toFeatureMatrix(
  rows: DatasetRow[],
  splits?: Map<string, SplitName>,
): FeatureMatrix {
  const matrixRows: FeatureMatrixRow[] = rows.map((r) => {
    const decisionKey = `${r.tokenAddress}:${r.decision_time}`;
    return {
      decisionKey,
      tokenAddress: r.tokenAddress,
      decisionTime: r.decision_time,
      features: numericFeatures(r.features),
      labels: {
        hit10: r.hit_plus_10_before_minus_10 == null ? null : r.hit_plus_10_before_minus_10 ? 1 : 0,
        hit20: r.hit_plus_20_before_minus_10 == null ? null : r.hit_plus_20_before_minus_10 ? 1 : 0,
        ret15m: r.theoretical_return,
        rug: r.rug_detected == null ? null : r.rug_detected ? 1 : 0,
      },
      split: splits?.get(decisionKey),
    };
  });
  return { columns: FEATURE_SCHEMA.fields, schemaHash: FEATURE_SCHEMA_HASH, rows: matrixRows };
}

export function matrixToJsonl(matrix: FeatureMatrix): string {
  return matrix.rows.map((r) => JSON.stringify(r)).join("\n");
}

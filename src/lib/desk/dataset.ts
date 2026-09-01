import type { LedgerRow } from "./types.ts";

export type DatasetRow = LedgerRow & { label_end_time: number };

export function sanitizeTrainingRows(
  rows: LedgerRow[],
  opts?: { minQuality?: number; allowConfidence?: Array<"HIGH" | "MEDIUM" | "LOW" | "UNKNOWN"> },
): DatasetRow[] {
  const minQ = opts?.minQuality ?? 75;
  const allow = new Set(opts?.allowConfidence ?? ["HIGH", "MEDIUM"]);
  const out: DatasetRow[] = [];
  for (const row of rows) {
    if (!row.labels_complete) continue;
    if ((row.research_quality_score ?? 0) < minQ) continue;
    const conf = row.barrier_label_confidence ?? "UNKNOWN";
    if (!allow.has(conf)) continue;
    const labelEnd = row.decision_time + 60 * 60_000;
    if (row.decision_time >= labelEnd) continue;
    out.push({ ...row, label_end_time: labelEnd });
  }
  return out;
}

export function walkForwardSplit<T extends { decision_time: number }>(
  rows: T[],
  trainEnd: number,
  validationEnd: number,
): { train: T[]; validation: T[]; test: T[] } {
  return {
    train: rows.filter((r) => r.decision_time < trainEnd),
    validation: rows.filter((r) => r.decision_time >= trainEnd && r.decision_time < validationEnd),
    test: rows.filter((r) => r.decision_time >= validationEnd),
  };
}

export function tokenLeakage(train: Array<{ tokenAddress: string }>, test: Array<{ tokenAddress: string }>): string[] {
  const inTrain = new Set(train.map((r) => r.tokenAddress));
  const leaked = new Set<string>();
  for (const r of test) if (inTrain.has(r.tokenAddress)) leaked.add(r.tokenAddress);
  return [...leaked];
}

export function groupByToken<T extends { tokenAddress: string }>(rows: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const r of rows) {
    const list = map.get(r.tokenAddress) ?? [];
    list.push(r);
    map.set(r.tokenAddress, list);
  }
  return map;
}

export function corpusIndependence(rows: Array<{ tokenAddress: string }>) {
  const grouped = groupByToken(rows);
  const counts = [...grouped.values()].map((g) => g.length).sort((a, b) => a - b);
  const mid = counts[Math.floor(counts.length / 2)] ?? 0;
  return {
    uniqueTokens: grouped.size,
    considerations: rows.length,
    considerationsPerToken: grouped.size ? rows.length / grouped.size : 0,
    medianConsiderationsPerToken: mid,
    maxConsiderationsPerToken: counts.at(-1) ?? 0,
  };
}

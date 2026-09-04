export type LeakKind = "future_field" | "post_decision_holder" | "bad_timestamp";

export type LeakInspect = {
  decision_time: number;
  holder_ingested_at?: number | null;
  feature_sources?: Record<string, { source: string; eventTime: number; ingestedAt: number; lagMs: number } | undefined>;
};

/** Point-in-time leaks a future model must never see. */
export function rowLeakage(row: LeakInspect): LeakKind[] {
  const leaks: LeakKind[] = [];
  if (!Number.isFinite(row.decision_time) || row.decision_time <= 0) leaks.push("bad_timestamp");
  if (row.holder_ingested_at != null && row.holder_ingested_at > row.decision_time) {
    leaks.push("post_decision_holder");
  }
  for (const meta of Object.values(row.feature_sources ?? {})) {
    if (!meta) continue;
    if (meta.ingestedAt > row.decision_time || meta.eventTime > row.decision_time) leaks.push("future_field");
  }
  return [...new Set(leaks)];
}

export function rejectLeakedRows<T extends LeakInspect>(rows: T[]): {
  clean: T[];
  rejected: Array<{ row: T; leaks: LeakKind[] }>;
} {
  const clean: T[] = [];
  const rejected: Array<{ row: T; leaks: LeakKind[] }> = [];
  for (const row of rows) {
    const leaks = rowLeakage(row);
    if (leaks.length) rejected.push({ row, leaks });
    else clean.push(row);
  }
  return { clean, rejected };
}

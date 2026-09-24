import { stampResearchQuality } from "./labels.ts";
import type { LedgerRow } from "./types.ts";

export function unionLabelPath(existing: LedgerRow["path"], incoming: LedgerRow["path"]): LedgerRow["path"] {
  const path = new Map(existing.map(t => [t.ts, t]));
  for (const tick of incoming) if (!path.has(tick.ts)) path.set(tick.ts, tick);
  return [...path.values()].sort((a, b) => a.ts - b.ts);
}

/** Merge only observations. Fast collection must not replace decisions/book state. */
export function mergeLabelProgress(rows: LedgerRow[], progress: LedgerRow[], now: number): LedgerRow[] {
  const byId = new Map(progress.map(row => [row.decision_id, row]));
  return rows.map(row => {
    const incoming = byId.get(row.decision_id);
    if (row.labels_complete || !incoming || incoming === row) return row;
    const next = { ...row, path: unionLabelPath(row.path, incoming.path) };
    stampResearchQuality(next, now);
    return next;
  });
}

import { stampResearchQuality } from "./labels.ts";
import type { LedgerRow } from "./types.ts";

/** Merge only observations. Fast collection must not replace decisions/book state. */
export function mergeLabelProgress(rows: LedgerRow[], progress: LedgerRow[], now: number): LedgerRow[] {
  const byId = new Map(progress.map(row => [row.decision_id, row]));
  return rows.map(row => {
    const incoming = byId.get(row.decision_id);
    if (row.labels_complete || !incoming || incoming === row) return row;
    const path = new Map(row.path.map(t => [t.ts, t]));
    for (const tick of incoming.path) if (!path.has(tick.ts)) path.set(tick.ts, tick);
    const next = { ...row, path: [...path.values()].sort((a, b) => a.ts - b.ts) };
    stampResearchQuality(next, now);
    return next;
  });
}

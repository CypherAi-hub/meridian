import type { LedgerRow } from "./types.ts";

export const LABEL_PROGRESS_SQL = `
update outcome_labels o set
  path = p.path,
  max_path_gap_seconds = p.max_gap,
  avg_path_gap_seconds = p.avg_gap,
  path_sample_count = jsonb_array_length(p.path),
  barrier_label_confidence = p.confidence,
  updated_at_ms = $2
from jsonb_to_recordset($1::jsonb) as p(
  decision_id text, path jsonb, max_gap double precision,
  avg_gap double precision, confidence text
)
where o.decision_id = p.decision_id and o.labels_complete = false
  and jsonb_array_length(p.path) >= jsonb_array_length(o.path)`;

export function labelProgressPayload(rows: LedgerRow[]) {
  return rows.map(row => ({
    decision_id: row.decision_id,
    path: row.path ?? [],
    max_gap: row.max_path_gap_seconds ?? null,
    avg_gap: row.avg_path_gap_seconds ?? null,
    confidence: row.barrier_label_confidence ?? "UNKNOWN",
  }));
}

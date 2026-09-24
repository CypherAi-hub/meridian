import { getSql } from "@/lib/db";
import type { LedgerRow } from "./types.ts";

/** Write the open path onto the label. Fast ticks were priced, then thrown away. */
export async function persistLabelProgress(rows: LedgerRow[]) {
  if (!rows.length) return;
  const sql = await getSql();
  const now = Date.now();
  for (const row of rows) {
    await sql.query(
      `update outcome_labels set
         path = $2::jsonb,
         max_path_gap_seconds = $3,
         avg_path_gap_seconds = $4,
         path_sample_count = $5,
         barrier_label_confidence = $6,
         updated_at_ms = $7
       where decision_id = $1 and labels_complete = false`,
      [
        row.decision_id,
        JSON.stringify(row.path ?? []),
        row.max_path_gap_seconds ?? null,
        row.avg_path_gap_seconds ?? null,
        row.path_sample_count ?? null,
        row.barrier_label_confidence ?? null,
        now,
      ],
    );
  }
}

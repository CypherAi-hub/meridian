import { getSql } from "@/lib/db";
import type { LedgerRow } from "./types.ts";
import { LABEL_PROGRESS_SQL, labelProgressPayload } from "./label-progress-sql";

/** One database round trip for the entire fast batch. */
export async function persistLabelProgress(rows: LedgerRow[]) {
  if (!rows.length) return;
  const sql = await getSql();
  await sql.query(LABEL_PROGRESS_SQL, [JSON.stringify(labelProgressPayload(rows)), Date.now()]);
}

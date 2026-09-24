import { getSql } from "@/lib/db";
import type { LedgerRow } from "./types.ts";
import { saveFastLabelProgress } from "./label-storage";

export async function persistLabelProgress(rows: LedgerRow[]) {
  if (!rows.length) return;
  await saveFastLabelProgress(await getSql(), rows, Date.now());
}

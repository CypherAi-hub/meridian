import { TRAINING_AUDIT_SQL } from "./training-readiness-sql";
import { getSql } from "@/lib/db";
import { loadQuality } from "./quality.server";
import { currentEpochName, officialSoakAllowed } from "./env";
import { trainingReadiness, type TrainingAudit } from "./training-readiness";

export async function loadTrainingReadiness() {
  const sql = await getSql();
  // No catch-to-zero: a failed audit must return an error, never a clean result.
  const rows = await sql.query<TrainingAudit>(TRAINING_AUDIT_SQL, [currentEpochName()]);
  return trainingReadiness(await loadQuality(sql), rows[0], officialSoakAllowed());
}

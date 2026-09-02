import { getSql } from "@/lib/db";
import { currentEpochName } from "./env";
import { STRATEGY_VERSION } from "./schema";
import { FEATURE_SCHEMA_HASH } from "./versions";

export async function exportCorpusManifest() {
  const sql = await getSql();
  const counts: Record<string, number> = {};
  for (const table of [
    "market_observations",
    "feature_vectors",
    "candidate_considerations",
    "outcome_labels",
    "token_path_samples",
    "decision_snapshots",
  ]) {
    try {
      const row = (await sql.query<{ n: number }>(`select count(*)::int as n from ${table}`))[0];
      counts[table] = Number(row?.n ?? 0);
    } catch {
      counts[table] = 0;
    }
  }
  const checksum = FEATURE_SCHEMA_HASH + ":" + Object.values(counts).reduce((a, b) => a + b, 0);
  return {
    schemaVersion: "v33a2",
    rowCounts: counts,
    collectionEpoch: currentEpochName(),
    codeVersion: STRATEGY_VERSION,
    checksum,
    createdAtMs: Date.now(),
  };
}

export async function importCorpusToNeon(): Promise<never> {
  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error("NEON_NOT_CONFIGURED");
  }
  throw new Error("NEON_IMPORT_BLOCKED: canonical switch requires a dedicated cutover after checksum validation");
}

import type { Sql } from "../db.ts";
import type { LedgerRow } from "./types.ts";
import { unionLabelPath } from "./label-progress.ts";
import { freezeLabels, stampResearchQuality } from "./labels.ts";
import { LABEL_PROGRESS_SQL, labelProgressPayload } from "./label-progress-sql.ts";

/** Both writers lock the same label rows before reading/merging observations. */
export async function saveFastLabelProgress(sql: Sql, rows: LedgerRow[], now: number) {
  if (!rows.length) return;
  await sql.transaction(async tx => {
    const saved = await tx.query<{decision_id:string;path:LedgerRow["path"]}>(
      `select decision_id,path from outcome_labels
       where decision_id = any($1::text[]) and labels_complete = false
       order by decision_id for update`, [rows.map(r=>r.decision_id)]);
    const byId = new Map(saved.map(r=>[r.decision_id,r.path]));
    const merged = rows.filter(r=>byId.has(r.decision_id)).map(row=> {
      const next={...row,path:unionLabelPath(byId.get(row.decision_id)!,row.path)};
      stampResearchQuality(next,now);
      return next;
    });
    if (merged.length) await tx.query(LABEL_PROGRESS_SQL, [JSON.stringify(labelProgressPayload(merged)), now]);
  });
}

export async function saveMergedLabel(
  sql: Sql, incoming: LedgerRow, now: number,
  write: (tx: Sql, row: LedgerRow) => Promise<void>,
): Promise<LedgerRow | null> {
  return sql.transaction(async tx => {
    // Lock the parent too, so first insert has the same serialization guarantee.
    await tx.query(`select decision_id from candidate_considerations where decision_id=$1 for update`, [incoming.decision_id]);
    const saved = (await tx.query<{path:LedgerRow["path"];labels_complete:boolean}>(
      `select path,labels_complete from outcome_labels where decision_id=$1 for update`, [incoming.decision_id]))[0];
    if (saved?.labels_complete) return null;
    const seed = (await tx.query<{snapshot:LedgerRow}>(
      `select snapshot from decision_snapshots where decision_id=$1`, [incoming.decision_id]))[0]?.snapshot;
    if (!seed) throw new Error(`Missing frozen decision ${incoming.decision_id}`);
    let path = unionLabelPath(saved?.path ?? [], incoming.path);
    // Recover genuine persisted polls if the process died before attaching them
    // to a newly inserted decision. Never backfill historical v1 decisions.
    if (seed.label_definition_version === "labels_v2") {
      const polls = await tx.query<{point:LedgerRow["path"][number]}>(
        `select provider_snapshot->'pathTick' as point from token_path_samples
         where token_mint=$1 and event_time_ms >= $2 and event_time_ms <= $3
           and ingested_at_ms >= $2 and ingested_at_ms <= $3
           and provider_snapshot ? 'pathTick'
         order by ingested_at_ms`,
        [seed.tokenAddress,seed.decision_time,Math.min(now,seed.decision_time+3600000)]);
      path = unionLabelPath(path,polls.map(p=>p.point));
    }
    // Derive all outcomes from the frozen decision and the full merged path,
    // never from cached barrier/MFE fields calculated on a shorter path.
    const merged = freezeLabels({...seed, labels_complete:false,
      path},now);
    // Only the universe cycle, after draining in-flight collection, may seal.
    // A long database save crossing the horizon is not itself a closing signal.
    merged.labels_complete = merged.labels_complete && incoming.labels_complete;
    await write(tx,merged);
    return merged;
  });
}

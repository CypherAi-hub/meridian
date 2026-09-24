import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { LABEL_PROGRESS_SQL } from "./label-progress-sql.ts";

test("batch label writes preserve completed labels and reject stale shorter paths", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create table outcome_labels (
      decision_id text primary key, path jsonb, labels_complete boolean,
      max_path_gap_seconds double precision, avg_path_gap_seconds double precision,
      path_sample_count int, barrier_label_confidence text, updated_at_ms bigint
    ); insert into outcome_labels values
      ('open','[{"ts":1}]',false,null,null,1,'UNKNOWN',0),
      ('closed','[{"ts":1}]',true,null,null,1,'UNKNOWN',0);`);
    const payload = ['open','closed'].map(decision_id => ({decision_id,
      path: [{ts:1},{ts:2}], max_gap: 3, avg_gap: 3, confidence:'HIGH'}));
    await db.query(LABEL_PROGRESS_SQL, [JSON.stringify(payload), 10]);
    await db.query(LABEL_PROGRESS_SQL, [JSON.stringify([{...payload[0],path:[{ts:1}]}]), 20]);
    const result = await db.query('select decision_id,path_sample_count,barrier_label_confidence,updated_at_ms from outcome_labels order by decision_id');
    assert.deepEqual(result.rows, [
      {decision_id:'closed',path_sample_count:1,barrier_label_confidence:'UNKNOWN',updated_at_ms:0},
      {decision_id:'open',path_sample_count:2,barrier_label_confidence:'HIGH',updated_at_ms:10},
    ]);
  } finally { await db.close(); }
});

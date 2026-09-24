import type { Sql } from '../db.ts';
import { auditCorpus, type CorpusRecord } from './corpus-audit.ts';
export async function queryCorpusAudit(sql:Sql,epoch:string,now=Date.now()) {
 return sql.transaction(async tx=>{
  await tx.query('set transaction isolation level repeatable read read only');
  const asOf=now;
  const size=(await tx.query<{rows:number;points:number}>(`select count(*)::int as rows,
   coalesce(sum(jsonb_array_length(coalesce(o.path,'[]'::jsonb))),0)::int as points
   from candidate_considerations c left join outcome_labels o using(decision_id)
   where c.collection_epoch_id=$1`,[epoch]))[0];
  if(size.rows>50000 || size.points>250000)
   throw new Error('AUDIT_TOO_LARGE: use an offline consistent export; no truncated audit permitted');
  const records=await tx.query<CorpusRecord>(`select c.collection_epoch_id as epoch, s.snapshot as decision,
   jsonb_build_object('labels_complete',coalesce(o.labels_complete,false),
    'label_definition_version',o.label_definition_version,'barrier_label_confidence',o.barrier_label_confidence,
    'barrier_10_outcome',o.barrier_10_outcome,'path',coalesce(o.path,'[]'::jsonb)) as outcome
   from candidate_considerations c left join decision_snapshots s using(decision_id)
   left join outcome_labels o using(decision_id) where c.collection_epoch_id=$1
   order by c.decision_time_ms,c.decision_id limit 50001`,[epoch]);
  if(records.length>50000) throw new Error('AUDIT_TOO_LARGE: use an offline consistent export; no truncated audit permitted');
  if(records.some(r=>!r.decision)) throw new Error('AUDIT_MISSING_FROZEN_SNAPSHOT');
  return auditCorpus(records,epoch,asOf);
 });
}

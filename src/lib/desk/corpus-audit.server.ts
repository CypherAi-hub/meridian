import { getSql } from '@/lib/db';
import { currentEpochName } from './env';
import { auditCorpus, type CorpusRecord } from './corpus-audit';
export async function loadCorpusAudit() {
 const sql=await getSql(),epoch=currentEpochName();
 return sql.transaction(async tx=>{
  await tx.query('set transaction isolation level repeatable read read only');
  const asOf=Date.now();
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

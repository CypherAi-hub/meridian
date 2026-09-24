import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyQuality } from './types.ts';
import { researchHealth } from './research-health.ts';
import { trainingReadiness } from './training-readiness.ts';
const now=1_000_000_000;
function healthy() {
 return {...emptyQuality(), collectionEpoch:'test', epochUniqueTokens:500,
  epochGradeA:50,epochGradeB:0,epochGradeC:50,epochResearchOnly:0,
  holderCoverageAtDecisionPct:.8,epochRouteCheckCoveragePct:.9,
  epochHighConfidencePct:.35,epochMediumConfidencePct:.3,
  productionSoakStartedAtMs:now-72*3600000};
}
const audit={decisions:1000,completed:900,qualified:700,qualifiedTokens:500,leakageViolations:0,missingSnapshots:0};
test('full epoch metrics never borrow healthy lifetime coverage',()=>{
 const q={...healthy(),epochRouteCheckCoveragePct:null,holderCoverageAtDecisionPct:null,
 epochHolderCoveragePct:null,holderCoveragePct:1,routeCheckCoveragePct:1};
 const health=researchHealth(q,{useEpoch:true});
 assert.equal(health.status,'DEGRADED');
 assert.ok(health.blockingReasons.some(b=>b.metric==='routeCheckCoverage'));
 assert.ok(health.blockingReasons.some(b=>b.metric==='holderCoverageAtDecision'));
});
test('NaN metrics and invalid soak cannot pass readiness',()=>{
 assert.equal(researchHealth({...healthy(),epochRouteCheckCoveragePct:NaN},{useEpoch:true}).status,'DEGRADED');
 for(const soak of [NaN,Infinity,now+1,0])
  assert.equal(trainingReadiness({...healthy(),productionSoakStartedAtMs:soak},audit,true,now).collectionReady,false);
});
test('collection readiness never enables training and respects every audit gate',()=>{
 const result=trainingReadiness(healthy(),audit,true,now);
 assert.equal(result.collectionReady,true);
 assert.equal(result.trainingEnabled,false);
 for(const change of [{leakageViolations:1},{leakageViolations:NaN},{missingSnapshots:1},{qualifiedTokens:499}])
  assert.equal(trainingReadiness(healthy(),{...audit,...change},true,now).collectionReady,false);
 assert.equal(trainingReadiness(healthy(),audit,false,now).collectionReady,false);
});

test('warehouse audit counts full epoch frozen snapshots and excludes legacy labels',async()=>{
 const {PGlite}=await import('@electric-sql/pglite');
 const {TRAINING_AUDIT_SQL}=await import('./training-readiness-sql.ts');
 const db=new PGlite();
 try {
 await db.exec(`create table candidate_considerations(decision_id text,mint text,decision_time_ms bigint,collection_epoch_id text);
 create table decision_snapshots(decision_id text,snapshot jsonb);
 create table outcome_labels(decision_id text,labels_complete boolean,label_definition_version text,barrier_label_confidence text);`);
 for(const [id,version,time] of [['good','labels_v2',100],['future','labels_v2',101],['old','labels_v1',100]] as const) {
  await db.query('insert into candidate_considerations values($1,$1,100,$2)',[id,'epoch']);
  await db.query('insert into decision_snapshots values($1,$2)',[id,JSON.stringify({label_definition_version:version,feature_sources:{price:{ingestedAt:time,eventTime:100}}})]);
  await db.query('insert into outcome_labels values($1,true,$2,$3)',[id,version,'MEDIUM']);
 }
 await db.exec("insert into candidate_considerations values('missing','m',100,'epoch'),('other','o',100,'other')");
 const row=(await db.query(TRAINING_AUDIT_SQL,['epoch'])).rows[0] as Record<string,number>;
 assert.equal(row.decisions,4); assert.equal(row.completed,3);
 assert.equal(row.qualifiedTokens,1); assert.equal(row.leakageViolations,1); assert.equal(row.missingSnapshots,1);
 await db.query("update decision_snapshots set snapshot=snapshot || $1::jsonb where decision_id='good'",
  [JSON.stringify({holder_concentration:0.1,holder_ingested_at:101,holder_event_time:100})]);
 const late=(await db.query(TRAINING_AUDIT_SQL,['epoch'])).rows[0] as Record<string,number>;
 assert.equal(late.qualifiedTokens,0); assert.equal(late.leakageViolations,2);
 }finally{await db.close();}
});

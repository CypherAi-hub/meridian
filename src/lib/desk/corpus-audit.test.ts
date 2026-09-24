import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditRecord,auditCorpus, HORIZON_MS, type CorpusRecord } from './corpus-audit.ts';
const t=1_000_000;
function fixture():CorpusRecord {
 const meta={source:'test',eventTime:t,ingestedAt:t,lagMs:0};
 return {epoch:'test',decision:{decision_id:'d',tokenAddress:'mint',decision_time:t,label_definition_version:'labels_v2',
  price:1,liquidity:10000,market_cap:100000,volume_5m:100,holder_concentration:.1,mint_auth:0,freeze_auth:0,
  holder_status:'VALID',holder_source:'test',holder_event_time:t,holder_ingested_at:t,
  feature_sources:Object.fromEntries(['price','liquidity','mcap','volume5m','top10','mint','freeze'].map((k,i)=>[k,{...meta,value:[1,10000,100000,100,.1,false,false][i],status:'VALID',stale:false}]))},
  outcome:{labels_complete:true,label_definition_version:'labels_v2',barrier_label_confidence:'MEDIUM',barrier_10_outcome:'UPPER_FIRST',
   path:Array.from({length:601},(_,i)=>({ts:t+i*6000,px:i===2?1.2:1,liq:10000,sell:1}))}};
}
test('independent audit recomputes one-hour path and does not mutate source',()=>{
 const r=fixture(),before=JSON.stringify(r),a=auditRecord(r,t+HORIZON_MS);
 assert.deepEqual(a.reasons,[]);assert.equal(a.example?.y,1);assert.equal(a.example?.maxGapSeconds,6);
 assert.equal(JSON.stringify(r),before);
 const one=auditCorpus([r],'test',t+HORIZON_MS),two=auditCorpus([r],'test',t+HORIZON_MS+1);
 const reordered=JSON.parse(JSON.stringify(r),(_key,v)=>v && !Array.isArray(v) && typeof v==='object' ? Object.fromEntries(Object.entries(v).reverse()) : v);
 assert.equal(one.sourceSha256,auditCorpus([reordered],'test',t+HORIZON_MS).sourceSha256);
 assert.equal(one.sha256,two.sha256);assert.equal(one.trainingEnabled,false);
 const changed=fixture();changed.decision.liquidity=12000;
 (changed.decision.feature_sources.liquidity as {value?:number}).value=12000;
 assert.notEqual(auditCorpus([changed],'test',t+HORIZON_MS).sha256,one.sha256);
});
test('stored confidence cannot hide truncated, sparse, duplicated or post-horizon paths',()=>{
 for(const mutate of [
  (r:CorpusRecord)=>{r.outcome.path=r.outcome.path.slice(-40);},
  (r:CorpusRecord)=>{r.outcome.path.splice(10,20);},
  (r:CorpusRecord)=>{r.outcome.path.push(r.outcome.path.at(-1)!);},
  (r:CorpusRecord)=>{r.outcome.path.at(-1)!.ts++;},
  (r:CorpusRecord)=>{r.outcome.path[1].px=NaN;},
  (r:CorpusRecord)=>{r.outcome.barrier_10_outcome='LOWER_FIRST';},
  (r:CorpusRecord)=>{r.outcome.barrier_label_confidence='HIGH';},
 ]) {const r=fixture();mutate(r);assert.equal(auditRecord(r,t+HORIZON_MS).example,null);}
});
test('future provenance, legacy, incomplete and unelapsed outcomes are rejected',()=>{
 for(const mutate of [
  (r:CorpusRecord)=>{r.decision.feature_sources.price.ingestedAt=t+1;},
  (r:CorpusRecord)=>{r.decision.holder_event_time=t+1;},
  (r:CorpusRecord)=>{r.decision.liquidity=999;},
  (r:CorpusRecord)=>{r.decision.holder_concentration=.2;},
  (r:CorpusRecord)=>{r.decision.holder_source='different';},
  (r:CorpusRecord)=>{(r.decision.feature_sources.mint as {value?:unknown}).value=0;},
  (r:CorpusRecord)=>{r.decision.label_definition_version='labels_v1';},
  (r:CorpusRecord)=>{r.outcome.labels_complete=false;},
 ]){const r=fixture();mutate(r);assert.equal(auditRecord(r,t+HORIZON_MS).example,null);}
 assert.equal(auditRecord(fixture(),t+HORIZON_MS-1).example,null);
 assert.throws(()=>auditCorpus([fixture(),fixture()],'test',t+HORIZON_MS),/Duplicate/);
 assert.throws(()=>auditCorpus([fixture()],'other',t+HORIZON_MS),/Mixed/);
});
test('boolean authorization observations match their frozen numeric encodings',()=>{
 const r=fixture();r.decision.mint_auth=1;
 (r.decision.feature_sources.mint as {value?:unknown}).value=true;
 assert.ok(auditRecord(r,t+HORIZON_MS).example);
 r.decision.mint_auth=0;
 assert.equal(auditRecord(r,t+HORIZON_MS).example,null);
});

test('warehouse audit reads full paths and refuses missing frozen evidence',async()=>{
 const {PGlite}=await import('@electric-sql/pglite');
 const {queryCorpusAudit}=await import('./corpus-audit-query.ts');
 const db=new PGlite();
 const sql={query:async(text:string,params?:unknown[])=>(await db.query(text,params)).rows,
  transaction:async(work:(tx:unknown)=>Promise<unknown>)=>db.transaction(async tx=>work({query:async(text:string,params?:unknown[])=>(await tx.query(text,params)).rows}))} as unknown as import('../db.ts').Sql;
 try {
 await db.exec(`create table candidate_considerations(decision_id text,decision_time_ms bigint,collection_epoch_id text);
 create table decision_snapshots(decision_id text,snapshot jsonb);
 create table outcome_labels(decision_id text,labels_complete boolean,label_definition_version text,barrier_label_confidence text,barrier_10_outcome text,path jsonb);`);
 const r=fixture();
 await db.query('insert into candidate_considerations values($1,$2,$3)',['d',t,'test']);
 await db.query('insert into decision_snapshots values($1,$2)',['d',JSON.stringify(r.decision)]);
 await db.query('insert into outcome_labels values($1,true,$2,$3,$4,$5)',['d','labels_v2','MEDIUM','UPPER_FIRST',JSON.stringify(r.outcome.path)]);
 const audit=await queryCorpusAudit(sql,'test',t+HORIZON_MS);
 assert.equal(audit.acceptedRows,1);assert.equal(audit.trainingEnabled,false);
 assert.equal((await queryCorpusAudit(sql,'other',t+HORIZON_MS)).inputRows,0);
 await db.exec("insert into candidate_considerations values('missing',100,'test')");
 await assert.rejects(()=>queryCorpusAudit(sql,'test',t+HORIZON_MS),/MISSING_FROZEN/);
 }finally{await db.close();}
});

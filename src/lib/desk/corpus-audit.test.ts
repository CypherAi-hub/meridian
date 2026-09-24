import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditRecord,auditCorpus,independentSplits, HORIZON_MS, type CorpusRecord,type AuditedExample } from './corpus-audit.ts';
import { fitProbabilityBaseline,evaluateProbability,probability } from './probability-baseline.ts';
import type { LedgerRow } from './types.ts';
const t=1_000_000;
function fixture():CorpusRecord {
 const meta={source:'test',eventTime:t,ingestedAt:t,lagMs:0};
 return {epoch:'test',decision:{decision_id:'d',tokenAddress:'mint',decision_time:t,label_definition_version:'labels_v2',
  price:1,liquidity:10000,market_cap:100000,volume_5m:100,holder_concentration:.1,mint_auth:0,freeze_auth:0,
  holder_status:'VALID',holder_source:'test',holder_event_time:t,holder_ingested_at:t,
  feature_sources:Object.fromEntries(['price','liquidity','mcap','volume5m','mint','freeze'].map((k,i)=>[k,{...meta,value:[1,10000,100000,100,0,0][i],status:'VALID',stale:false}]))} as LedgerRow,
  outcome:{labels_complete:true,label_definition_version:'labels_v2',barrier_label_confidence:'MEDIUM',barrier_10_outcome:'UPPER_FIRST',
   path:Array.from({length:601},(_,i)=>({ts:t+i*6000,px:i===2?1.2:1,liq:10000,sell:1}))}};
}
test('independent audit recomputes one-hour path and does not mutate source',()=>{
 const r=fixture(),before=JSON.stringify(r),a=auditRecord(r,t+HORIZON_MS);
 assert.deepEqual(a.reasons,[]);assert.equal(a.example?.y,1);assert.equal(a.example?.maxGapSeconds,6);
 assert.equal(JSON.stringify(r),before);
 const one=auditCorpus([r],'test',t+HORIZON_MS),two=auditCorpus([r],'test',t+HORIZON_MS);
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
  (r:CorpusRecord)=>{r.decision.label_definition_version='labels_v1';},
  (r:CorpusRecord)=>{r.outcome.labels_complete=false;},
 ]){const r=fixture();mutate(r);assert.equal(auditRecord(r,t+HORIZON_MS).example,null);}
 assert.equal(auditRecord(fixture(),t+HORIZON_MS-1).example,null);
 assert.throws(()=>auditCorpus([fixture(),fixture()],'test',t+HORIZON_MS),/Duplicate/);
 assert.throws(()=>auditCorpus([fixture()],'other',t+HORIZON_MS),/Mixed/);
});
function examples():AuditedExample[] {
 return Array.from({length:100},(_,i)=>({id:`d${i}`,mint:`m${i}`,at:i*HORIZON_MS*2,end:i*HORIZON_MS*2+HORIZON_MS,x:[i%2?1:-1,7],y:i%2 as 0|1,maxGapSeconds:6}));
}
test('splits remove repeated mints and purge overlapping label horizons',()=>{
 const rows=examples();rows.push({...rows[0],id:'later',at:300*HORIZON_MS,end:301*HORIZON_MS});
 const split=independentSplits(rows);
 assert.equal(split.train.length+split.validation.length+split.test.length,100);
 assert.ok(split.train.every(r=>r.end<split.trainEnd));
 assert.ok(split.validation.every(r=>r.end<split.validationEnd));
 const sets=[split.train,split.validation,split.test].map(rs=>new Set(rs.map(r=>r.mint)));
 for(const mint of sets[0]) assert.ok(!sets[1].has(mint)&&!sets[2].has(mint));
 const sameTime=rows.map(r=>({...r,at:0,end:HORIZON_MS}));assert.throws(()=>independentSplits(sameTime),/elapsed/);
});
test('offline baseline learns synthetic signal, uses train-only normalization and reports calibration',()=>{
 const split=independentSplits(examples());
 const model=fitProbabilityBaseline(split.train),before=JSON.stringify(model);
 const result=evaluateProbability(model,split.test);
 assert.ok(result.brier<result.baselineBrier); assert.ok(probability(model,[1,7])>probability(model,[-1,7]));
 assert.equal(result.calibration.reduce((s,b)=>s+b.n,0),split.test.length);
 evaluateProbability(model,split.test.map(r=>({...r,x:[100000,100000]})));
 assert.equal(JSON.stringify(model),before); assert.equal(model.canTrade,false);
 assert.deepEqual(model.scales[1],1);
 assert.throws(()=>fitProbabilityBaseline(split.train.map(r=>({...r,y:0}))),/Both outcome/);
});

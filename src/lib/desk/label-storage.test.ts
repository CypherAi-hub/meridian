import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "../db.ts";
import type { LedgerRow, PathTick } from "./types.ts";
import { saveFastLabelProgress, saveMergedLabel } from "./label-storage.ts";
import { freezeLabels } from "./labels.ts";

const origin=1_000_000;
const point=(offset:number,px=1):PathTick=>({ts:origin+offset,px,liq:50000,sell:1});
const seed=():LedgerRow=>({decision_id:'d',decision_time:origin,ingested_at:origin,
  tokenAddress:'Mint',label_definition_version:'labels_v1',
  price:1,liquidity:50000,path:[point(0)],labels_complete:false,
  sell_quote_available:true,route_status:'QUOTE_ONLY',simulated_entry:1,
  holder_concentration:0.1,mint_auth:0,freeze_auth:0} as LedgerRow);

async function fixture() {
  const db=new PGlite();
  await db.exec(`create table candidate_considerations(decision_id text primary key);
    create table decision_snapshots(decision_id text primary key,snapshot jsonb);
    create table token_path_samples(token_mint text,event_time_ms bigint,ingested_at_ms bigint,provider_snapshot jsonb);
    create table outcome_labels(decision_id text primary key,path jsonb,labels_complete boolean,
      max_path_gap_seconds float8,avg_path_gap_seconds float8,path_sample_count int,
      barrier_label_confidence text,updated_at_ms bigint,result jsonb);
    insert into candidate_considerations values('d');`);
  await db.query('insert into decision_snapshots values($1,$2)', ['d',JSON.stringify(seed())]);
  const adapt=(runner:{query:typeof db.query}):Sql=>({
    query:async <T>(text:string,params:unknown[]=[]) => (await runner.query<T>(text,params)).rows,
    transaction:async <T>(work:(sql:Sql)=>Promise<T>)=>db.transaction(tx=>work(adapt(tx))),
  } as Sql);
  const sql=adapt(db);
  const write=async(tx:Sql,row:LedgerRow)=>{await tx.query(`insert into outcome_labels
    (decision_id,path,labels_complete,path_sample_count,barrier_label_confidence,updated_at_ms,result)
    values($1,$2,$3,$4,$5,0,$6) on conflict(decision_id) do update set
    path=excluded.path,labels_complete=excluded.labels_complete,path_sample_count=excluded.path_sample_count,
    barrier_label_confidence=excluded.barrier_label_confidence,result=excluded.result`,
    ['d',JSON.stringify(row.path),row.labels_complete,row.path_sample_count,row.barrier_label_confidence,JSON.stringify(row)]);};
  return {db,sql,write};
}

for (const fastFirst of [true,false]) test(`equal-length disjoint paths survive both write orders: fastFirst=${fastFirst}`,async()=>{
  const {db,sql,write}=await fixture();
  try {
    await saveMergedLabel(sql,seed(),origin,write);
    const fast={...seed(),path:[point(0),point(3000,1.12)]};
    const slow={...seed(),path:[point(0),point(6000,0.89)]};
    const f=()=>saveFastLabelProgress(sql,[fast],origin+6000);
    const s=()=>saveMergedLabel(sql,slow,origin+6000,write);
    if(fastFirst){await f();await s();}else{await s();await f();}
    const result=await saveMergedLabel(sql,seed(),origin+6000,write);
    assert.deepEqual(result?.path.map(p=>p.ts),[origin,origin+3000,origin+6000]);
    assert.equal(result?.hit_plus_10_before_minus_10,true);
    assert.equal(result?.barrier_10_outcome,'UPPER_FIRST');
  } finally {await db.close();}
});

test('one-hour closure derives barriers from saved fast samples and retains the entire path',async()=>{
  const {db,sql,write}=await fixture();
  try {
    await saveMergedLabel(sql,seed(),origin,write);
    const path=Array.from({length:1201},(_,i)=>point(i*3000,i===1?1.12:1));
    await saveFastLabelProgress(sql,[{...seed(),path}],origin+3600000);
    const closed=await saveMergedLabel(sql,{...seed(),labels_complete:true},origin+3600000,write);
    assert.equal(closed?.path.length,1201);
    assert.equal(closed?.barrier_label_confidence,'HIGH');
    assert.equal(closed?.hit_plus_10_before_minus_10,true);
    assert.equal(closed?.labels_complete,true);
    await saveFastLabelProgress(sql,[{...seed(),path:[point(0),point(4000000,2)]}],origin+4000000);
    assert.equal(await saveMergedLabel(sql,seed(),origin+4000000,write),null);
    assert.equal((await db.query<{n:number}>('select jsonb_array_length(path) n from outcome_labels')).rows[0].n,1201);
  } finally {await db.close();}
});

test('a save crossing one hour cannot close before the collector drain; rollback preserves prior path',async()=>{
  const {db,sql,write}=await fixture();
  try {
    await saveMergedLabel(sql,seed(),origin,write);
    const result=await saveMergedLabel(sql,seed(),origin+3600001,write);
    assert.equal(result?.labels_complete,false);
    await assert.rejects(saveMergedLabel(sql,{...seed(),path:[point(0),point(3000)]},origin+4000000,
      async(tx,row)=>{await write(tx,row);throw new Error('injected failure');}),/injected failure/);
    assert.equal((await db.query<{n:number}>('select jsonb_array_length(path) n from outcome_labels')).rows[0].n,1);
  } finally {await db.close();}
});

test('post-horizon prices cannot change the one-hour barrier or quality',()=>{
  const r=freezeLabels({...seed(),path:[point(0),point(3599000),point(3601000,2)]},origin+3601000);
  assert.equal(r.barrier_10_outcome,'NEITHER');
  assert.equal(r.path.length,2);
  assert.equal(r.barrier_label_confidence,'UNKNOWN');
});

test('new-version decisions recover durable polls after a missing label update; historical decisions do not',async()=>{
  const {db,sql,write}=await fixture();
  try {
    await db.query('insert into token_path_samples values($1,$2,$2,$3)',
      ['Mint',origin+3000,JSON.stringify({pathTick:point(3000,1.12)})]);
    // A crash before the initial label insert leaves only the shared poll journal.
    await saveFastLabelProgress(sql,[{...seed(),path:[point(0),point(3000,1.12)]}],origin+6000);
    const legacy=await saveMergedLabel(sql,seed(),origin+6000,write);
    assert.equal(legacy?.path.length,1);
    await db.query('update decision_snapshots set snapshot=$1',[JSON.stringify({...seed(),label_definition_version:'labels_v2'})]);
    const recovered=await saveMergedLabel(sql,seed(),origin+6000,write);
    assert.equal(recovered?.path.length,2);
    assert.equal(recovered?.barrier_10_outcome,'UPPER_FIRST');
  } finally {await db.close();}
});

import { createHash } from 'node:crypto';
import type { LedgerRow, PathTick } from './types.ts';

export const HORIZON_MS = 3_600_000;
export const MODEL_FIELDS = ['price','liquidity','market_cap','volume_5m','holder_concentration','mint_auth','freeze_auth'] as const;
export type CorpusRecord = { epoch: string; decision: LedgerRow; outcome: Pick<LedgerRow,'labels_complete'|'label_definition_version'|'barrier_label_confidence'|'barrier_10_outcome'|'path'> };
export type AuditedExample = { id:string; mint:string; at:number; end:number; x:number[]; y:0|1; maxGapSeconds:number };
const metaKeys = ['price','liquidity','mcap','volume5m',null,'mint','freeze'] as const;
const validTime = (v:unknown,t:number):v is number => typeof v==='number' && Number.isFinite(v) && v>=0 && v<=t;

/** This independently checks frozen inputs and raw paths; it never repairs history. */
export function auditRecord(record:CorpusRecord,now:number): { reasons:string[]; example:AuditedExample|null } {
 const d=record.decision, o=record.outcome, reasons:string[]=[];
 const t=d.decision_time, end=t+HORIZON_MS;
 if(!d.decision_id || !d.tokenAddress || !Number.isFinite(t) || t<0 || !Number.isFinite(now) || end>now) reasons.push('INVALID_OR_UNMATURED_DECISION');
 if(d.label_definition_version!=='labels_v2' || o.label_definition_version!=='labels_v2') reasons.push('LEGACY_LABEL');
 if(!o.labels_complete) reasons.push('INCOMPLETE_LABEL');
 if(!['HIGH','MEDIUM'].includes(o.barrier_label_confidence ?? '')) reasons.push('UNQUALIFIED_STORED_LABEL');
 const x:number[]=[];
 for(let i=0;i<MODEL_FIELDS.length;i++) {
  const key=MODEL_FIELDS[i], value=d[key];
  if(typeof value!=='number' || !Number.isFinite(value) || value<0 || (i<4 && value<=0) || (i===4 && value>1) || (i>4 && value!==0 && value!==1)) {
   reasons.push(`INVALID_FEATURE:${key}`); continue;
  }
  const metaKey=metaKeys[i];
  const meta=metaKey ? d.feature_sources?.[metaKey] : {source:d.holder_source,eventTime:d.holder_event_time,ingestedAt:d.holder_ingested_at};
  if(!meta?.source || !validTime(meta.eventTime,t) || !validTime(meta.ingestedAt,t)) reasons.push(`INVALID_PROVENANCE:${key}`);
  if(metaKey) {
   const cell=meta as typeof meta & {value?:unknown;status?:string;stale?:boolean};
   if(cell?.value!==value || cell?.status!=='VALID' || cell?.stale===true) reasons.push(`UNVERIFIED_FEATURE:${key}`);
  } else if(d.holder_status!=='VALID') reasons.push('UNVERIFIED_FEATURE:holder_concentration');
  x.push(i<4?Math.log1p(value):value);
 }
 const path=o.path;
 let maxGap=Infinity, y:0|1=0, barrier='NEITHER';
 if(!Array.isArray(path) || path.length<2) reasons.push('MISSING_FULL_PATH');
 else {
  let prior=t;
  maxGap=0;
  for(let i=0;i<path.length;i++) {
   const p=path[i] as PathTick | null;
   if(!p || !Number.isFinite(p.ts) || !Number.isFinite(p.px) || p.px<=0 || p.ts<t || p.ts>end || (i>0 && p.ts<=prior)) {
    reasons.push('INVALID_PATH'); maxGap=Infinity; break;
   }
   maxGap=Math.max(maxGap,(p.ts-prior)/1000); prior=p.ts;
   if(barrier==='NEITHER' && d.price!=null) {
    if(p.px>=d.price*1.1) {barrier='UPPER_FIRST';y=1;}
    else if(p.px<=d.price*.9) barrier='LOWER_FIRST';
   }
  }
  maxGap=Math.max(maxGap,(end-prior)/1000);
  if(maxGap>15) reasons.push('SPARSE_PATH');
  if(o.barrier_label_confidence==='HIGH' && maxGap>5) reasons.push('OVERSTATED_CONFIDENCE');
  if(barrier!==o.barrier_10_outcome) reasons.push('BARRIER_MISMATCH');
  if(path[0]?.ts===t && path[0]?.px!==d.price) reasons.push('ENTRY_PRICE_MISMATCH');
 }
 return {reasons:[...new Set(reasons)],example:reasons.length?null:{id:d.decision_id,mint:d.tokenAddress,at:t,end,x,y,maxGapSeconds:maxGap}};
}

export function auditCorpus(records:CorpusRecord[],epoch:string,now:number) {
 if(!epoch || !Number.isFinite(now)) throw new Error('Invalid audit context');
 const seen=new Set<string>(), rejected:Record<string,number>={}, examples:AuditedExample[]=[];
 for(const row of records) {
  if(row.epoch!==epoch) throw new Error('Mixed collection epochs');
  if(seen.has(row.decision.decision_id)) throw new Error('Duplicate decision');
  seen.add(row.decision.decision_id);
  const result=auditRecord(row,now);
  if(result.example) examples.push(result.example);
  for(const reason of result.reasons) rejected[reason]=(rejected[reason]??0)+1;
 }
 examples.sort((a,b)=>a.at-b.at || a.id.localeCompare(b.id));
 const payload={schema:'meridian-audit-v1',epoch,asOf:now,featureFields:MODEL_FIELDS,examples};
 return {...payload,sha256:createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
  sourceSha256:createHash('sha256').update(JSON.stringify([...records].sort((a,b)=>a.decision.decision_id.localeCompare(b.decision.decision_id)))).digest('hex'),
  inputRows:records.length,acceptedRows:examples.length,uniqueTokens:new Set(examples.map(r=>r.mint)).size,rejected,
  trainingEnabled:false as const, certification:'PATH_AND_INPUT_AUDIT_ONLY' as const};
}

/** One earliest eligible decision per mint, then chronological splits with a full horizon purge. */
export function independentSplits(rows:AuditedExample[]) {
 const first=new Map<string,AuditedExample>();
 for(const row of [...rows].sort((a,b)=>a.at-b.at || a.id.localeCompare(b.id))) if(!first.has(row.mint)) first.set(row.mint,row);
 const ordered=[...first.values()];
 if(ordered.length<20) throw new Error('Need at least 20 independent tokens for a diagnostic split');
 const trainEnd=ordered[Math.floor(ordered.length*.7)].at;
 const validationEnd=ordered[Math.floor(ordered.length*.85)].at;
 const train=ordered.filter(r=>r.end<trainEnd);
 const validation=ordered.filter(r=>r.at>=trainEnd && r.end<validationEnd);
 const test=ordered.filter(r=>r.at>=validationEnd);
 if(!train.length || !validation.length || !test.length) throw new Error('Insufficient elapsed time after horizon purge');
 return {train,validation,test,purged:ordered.length-train.length-validation.length-test.length,trainEnd,validationEnd};
}

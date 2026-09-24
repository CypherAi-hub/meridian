import type { AuditedExample } from './corpus-audit.ts';
export type ProbabilityModel={means:number[];scales:number[];weights:number[];intercept:number;baseRate:number;mode:'OFFLINE_DIAGNOSTIC';canTrade:false};
const sigmoid=(z:number)=>1/(1+Math.exp(-Math.max(-40,Math.min(40,z))));
function check(rows:AuditedExample[],width:number) {
 if(!rows.length || !width || rows.some(r=>r.x.length!==width || r.x.some(v=>!Number.isFinite(v)) || (r.y!==0 && r.y!==1))) throw new Error('Invalid model matrix');
}
/** Fixed regularization and iterations; preprocessing fits on train only. No execution integration. */
export function fitProbabilityBaseline(train:AuditedExample[]):ProbabilityModel {
 const width=train[0]?.x.length; check(train,width);
 const baseRate=train.reduce((s,r)=>s+r.y,0)/train.length;
 if(baseRate===0 || baseRate===1) throw new Error('Both outcome classes required');
 const means=Array.from({length:width},(_,j)=>train.reduce((s,r)=>s+r.x[j],0)/train.length);
 const scales=means.map((m,j)=>Math.sqrt(train.reduce((s,r)=>s+(r.x[j]-m)**2,0)/train.length)||1);
 if([...means,...scales].some(v=>!Number.isFinite(v))) throw new Error('Nonfinite normalization');
 const x=train.map(r=>r.x.map((v,j)=>(v-means[j])/scales[j]));
 const weights=Array(width).fill(0); let intercept=Math.log(baseRate/(1-baseRate));
 for(let step=0;step<1000;step++) {
  const gradient=Array(width).fill(0);let bias=0;
  for(let i=0;i<train.length;i++) {
   const error=sigmoid(intercept+x[i].reduce((s,v,j)=>s+v*weights[j],0))-train[i].y;
   bias+=error;
   for(let j=0;j<width;j++) gradient[j]+=error*x[i][j];
  }
  intercept-=.05*bias/train.length;
  for(let j=0;j<width;j++) weights[j]-=.05*(gradient[j]/train.length+.01*weights[j]);
 }
 return {means,scales,weights,intercept,baseRate,mode:'OFFLINE_DIAGNOSTIC',canTrade:false};
}
export function probability(model:ProbabilityModel,x:number[]) {
 if(x.length!==model.weights.length || x.some(v=>!Number.isFinite(v))) throw new Error('Invalid prediction inputs');
 return sigmoid(model.intercept+x.reduce((s,v,j)=>s+(v-model.means[j])/model.scales[j]*model.weights[j],0));
}
export function evaluateProbability(model:ProbabilityModel,rows:AuditedExample[]) {
 check(rows,model.weights.length);
 const bins=Array.from({length:10},(_,i)=>({from:i/10,to:(i+1)/10,n:0,predicted:0,observed:0}));
 let brier=0,baselineBrier=0,logLoss=0;
 for(const row of rows) {
  const p=probability(model,row.x),bin=bins[Math.min(9,Math.floor(p*10))];
  brier+=(p-row.y)**2;baselineBrier+=(model.baseRate-row.y)**2;
  logLoss-=row.y*Math.log(Math.max(p,1e-15))+(1-row.y)*Math.log(Math.max(1-p,1e-15));
  bin.n++;bin.predicted+=p;bin.observed+=row.y;
 }
 return {n:rows.length,brier:brier/rows.length,baselineBrier:baselineBrier/rows.length,logLoss:logLoss/rows.length,
  calibration:bins.map(b=>({...b,predicted:b.n?b.predicted/b.n:null,observed:b.n?b.observed/b.n:null})),canTrade:false as const};
}

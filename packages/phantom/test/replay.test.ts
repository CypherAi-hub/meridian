import { describe,it,expect } from 'vitest';
import { replay,walkForwardSplit,walkForward,performanceMetrics,type ReplayObservation,type ReplayOptions,type ReplayContext } from '../src/replay.ts';
const opts:ReplayOptions={strategy:'fixture',initialCapitalLamports:'10000',minimumLatencyMs:100,maxQuoteAgeMs:10,maxImpactBps:500,fixtureKind:'synthetic-fixture',rejectionHorizonMs:300};
const row=(id:string,at:number,mint='M'):ReplayObservation=>({id,mint,at,regime:'trend',features:{pressure:at}});
const quote=(at:number,inputRaw:string,outputRaw:string)=>({observedAt:at,inputRaw,outputRaw,networkFeeLamports:'10',priceImpactBps:50});
describe('historical exact-size quote replay',()=>{
 it('uses future observable quotes after latency and deducts network fees once',()=>{
   const rows=[{...row('a',0),buy:quote(0,'100','1000')},{...row('b',50),buy:quote(50,'100','999')},{...row('c',100),buy:quote(100,'100','900')},{...row('d',150),sell:quote(150,'900','140')},{...row('e',200),sell:quote(200,'900','130')}];
   const report=replay(rows,c=>!c.position?{action:'enter',reasons:['pressure'],amountLamports:'100'}:{action:'exit',reasons:['risk']},opts);
   expect(report.trades).toHaveLength(1);expect(report.trades[0]).toMatchObject({openedAt:100,closedAt:200,quantityRaw:'900',feesLamports:'20',pnlLamports:'10',entryLatencyMs:100,exitLatencyMs:100});
   expect(report.cashLamports).toBe('10010');
 });
 it('never gives the strategy future observations and makes its inputs immutable',()=>{
   let max=0;
   replay([row('a',0),row('b',100),row('c',200)],c=>{expect(c.history.every(r=>r.at<=c.now)).toBe(true);expect(Object.isFrozen(c.current.features)).toBe(true);max=Math.max(max,c.history.length);return {action:'hold',reasons:[]};},opts);
   expect(max).toBe(3);
 });
 it('rejects future or duplicate observations rather than manufacturing a timeline',()=>{
   expect(()=>replay([{...row('a',0),buy:quote(1,'100','10')}],()=>({action:'hold',reasons:[]}),opts)).toThrow('Future quote');
   expect(()=>replay([row('a',0),row('a',1)],()=>({action:'hold',reasons:[]}),opts)).toThrow('duplicate');
 });
 it('does not scale mismatched quotes, use stale quotes, or turn missing exits into profit',()=>{
   const rows=[row('a',0),{...row('b',100),buy:quote(100,'99','10')},{...row('c',200),buy:quote(100,'100','10')},{...row('d',300),buy:quote(300,'100','10')}];
   const report=replay(rows,c=>({action:c.position?'exit':'enter',amountLamports:'100',reasons:[]}),opts);
   expect(report.trades).toHaveLength(0);expect(report.unresolvedPositions).toHaveLength(1);expect(report.unresolvedPositions[0].openedAt).toBe(300);expect(report.metrics.winRate).toBeNull();expect(report.metrics.netRealizedPnlLamports).toBe('0');
 });
 it('keeps rejected future outcomes separate from strategy inputs',()=>{
   const report=replay([{...row('a',0),buy:quote(0,'100','10')},{...row('b',300),sell:quote(300,'10','140')}],()=>({action:'reject',reasons:['cluster']}),opts);
   expect(report.rejectedOutcomes[0].hypotheticalPnlLamports).toBe('20');expect(report.trades).toHaveLength(0);
 });
 it('maintains integer cash beyond Number.MAX_SAFE_INTEGER',()=>{
   const capital='90071992547409930000';
   const report=replay([row('a',0),{...row('b',100),buy:quote(100,'100','10')}],()=>({action:'enter',amountLamports:'100',reasons:[]}),{...opts,initialCapitalLamports:capital});
   expect(report.cashLamports).toBe((BigInt(capital)-110n).toString());
 });
 it('shows unknown inventory equity and unfilled orders explicitly',()=>{
   const report=replay([row('a',0),{...row('b',100),buy:quote(100,'100','10')}],c=>({action:c.position?'exit':'enter',amountLamports:'100',reasons:[]}),opts);
   expect(report.equity).toEqual([{at:0,equityLamports:'10000'},{at:100,equityLamports:null}]);
   expect(report.metrics.unknownEquityObservations).toBe(1);expect(report.unfilledOrders[0].action).toBe('exit');
 });
 it('requires provenance before identifying input as recorded chain data',()=>{
   expect(()=>replay([row('a',0)],()=>({action:'hold',reasons:[]}),{...opts,fixtureKind:'recorded-chain'})).toThrow('provenance');
 });
});
describe('out-of-sample partitions',()=>{
 it('excludes train tokens from test and embargo tokens from both',()=>{
   const split=walkForwardSplit([row('a',0,'old'),row('b',200,'old'),row('c',105,'embargo'),row('d',200,'embargo'),row('e',120,'new'),row('f',200,'new')],100,300,20);
   expect(split.train.map(r=>r.mint)).toEqual(['old']);expect(split.test.map(r=>r.mint)).toEqual(['new','new']);expect(split.excludedOverlappingMints).toEqual(['old']);
 });
 it('fits only training observations and rejects overlapping test windows',()=>{
   const rows=[row('a',0,'old'),row('b',200,'new')];
   const fits:number[][]=[];
   const fit=(train:readonly ReplayObservation[])=>{fits.push(train.map(r=>r.at));return (_:ReplayContext)=>({action:'hold' as const,reasons:[]});};
   walkForward(rows,[{trainEnd:100,testEnd:300}],0,fit,opts);expect(fits).toEqual([[0]]);
   expect(()=>walkForward(rows,[{trainEnd:100,testEnd:300},{trainEnd:200,testEnd:400}],0,fit,opts)).toThrow('overlap');
 });
 it('does not invent a profit factor or win rate with no trades',()=>{expect(performanceMetrics([],'10000')).toMatchObject({winRate:null,profitFactor:null,closedTrades:0});});
});

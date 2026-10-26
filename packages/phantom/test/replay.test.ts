import { describe,it,expect } from 'vitest';
import { replay,walkForwardSplit,walkForward,performanceMetrics,type ReplayObservation,type ReplayOptions,type ReplayContext } from '../src/replay.ts';
const opts:ReplayOptions={strategy:'fixture',initialCapitalLamports:'10000',minimumLatencyMs:100,maxQuoteAgeMs:10,maxImpactBps:500,fixtureKind:'synthetic-fixture',rejectionHorizonMs:300};
const row=(id:string,at:number,mint='M'):ReplayObservation=>({id,mint,at,regime:'trend',features:{pressure:at}});
const quote=(at:number,inputRaw:string,outputRaw:string)=>({observedAt:at,inputRaw,outputRaw,networkFeeLamports:'10',priceImpactBps:50});
describe('historical exact-size quote replay',()=>{
 it('requires quote observations after decision plus latency on both entry and exit',()=>{
   const rows=[row('a',0),{...row('b',100),buy:quote(99,'100','1000')},{...row('c',200),buy:quote(100,'100','900')},{...row('d',300),sell:quote(299,'900','140')},{...row('e',400),sell:quote(300,'900','130')}];
   const report=replay(rows,c=>c.now===0?{action:'enter',amountLamports:'100',reasons:[]}:c.now===200?{action:'exit',reasons:[]}: {action:'hold',reasons:[]},{...opts,maxQuoteAgeMs:1000});
   expect(report.trades).toHaveLength(1);
   expect(report.trades[0]).toMatchObject({openedAt:200,closedAt:400,quantityRaw:'900'});
 });
 it('rejects a recorded pre-delay request even when its response arrives after the delay',()=>{
   const rows=[row('a',0),{...row('b',100),buy:{...quote(100,'100','1000'),requestedAt:99}},{...row('c',200),buy:{...quote(200,'100','900'),requestedAt:100}}];
   const report=replay(rows,c=>c.now===0?{action:'enter',amountLamports:'100',reasons:[]}:{action:'hold',reasons:[]},{...opts,maxQuoteAgeMs:1000});
   expect(report.unresolvedPositions[0].openedAt).toBe(200);
   expect(report.unresolvedPositions[0].quantityRaw).toBe('900');
 });
 it('does not use a pre-target quote attached to a later rejection-horizon row',()=>{
   const report=replay([{...row('a',0),buy:quote(0,'100','10')},{...row('b',400),sell:quote(299,'10','140')}],()=>({action:'reject',reasons:[]}),{...opts,maxQuoteAgeMs:1000});
   expect(report.rejectedOutcomes[0].hypotheticalPnlLamports).toBeNull();
 });
 it('continues to the first valid horizon quote and reports its actual observation time',()=>{
   const report=replay([{...row('a',0),buy:quote(0,'100','10')},{...row('b',400),sell:quote(299,'10','999')},{...row('c',500),sell:quote(500,'10','140')}],()=>({action:'reject',reasons:[]}),{...opts,maxQuoteAgeMs:1000});
   expect(report.rejectedOutcomes[0]).toMatchObject({hypotheticalPnlLamports:'20',horizonAt:300,exitQuoteObservedAt:500});
 });
 it('checks captured exit request times and refuses malformed request clocks',()=>{
   const rows=[row('a',0),{...row('b',100),buy:quote(100,'100','900')},{...row('c',200),sell:{...quote(200,'900','140'),requestedAt:199}},{...row('d',300),sell:{...quote(300,'900','140'),requestedAt:301}},{...row('e',400),sell:{...quote(400,'900','130'),requestedAt:200}}];
   const report=replay(rows,c=>c.now===0?{action:'enter',amountLamports:'100',reasons:[]}:c.now===100?{action:'exit',reasons:[]}:{action:'hold',reasons:[]},{...opts,maxQuoteAgeMs:1000});
   expect(report.trades[0]).toMatchObject({openedAt:100,closedAt:400});
 });
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
 it('records stale other inventory at a rejected fill without same-row re-entry or duplicate history',()=>{
   // Synthetic quotes only: A becomes stale while B waits for its delayed fill.
   const rows=[row('a-signal',0,'A'),{...row('a-fill',100,'A'),buy:quote(100,'100','10'),sell:quote(100,'10','100')},row('b-signal',150,'B'),{...row('b-rejected',300,'B'),buy:quote(300,'100','10')},{...row('a-refresh',400,'A'),sell:quote(400,'10','100')}];
   const evaluated:string[]=[],guardHistories:string[][]=[];
   let finalHistory:string[]=[];
   const report=replay(rows,c=>{
     evaluated.push(c.current.id);
     finalHistory=c.history.map(r=>r.id);
     // Calling this again on b-rejected would incorrectly queue a new B entry.
     return c.current.id==='a-signal'||c.current.mint==='B'?{action:'enter',amountLamports:'100',reasons:['SYNTHETIC_SIGNAL']}:{action:'hold',reasons:[]};
   },{...opts,maxQuoteAgeMs:100,fillGuard:c=>{
     guardHistories.push(c.history.map(r=>r.id));
     return {allowed:c.current.mint!=='B',reasons:['SYNTHETIC_FILL_VETO']};
   }});
   expect(report.equity.map(p=>p.at)).toEqual(rows.map(r=>r.at));
   expect(report.equity.find(p=>p.at===300)?.equityLamports).toBeNull();
   expect(report.metrics.unknownEquityObservations).toBe(1);
   expect(report.cashLamports).toBe('9890');
   expect(report.unresolvedPositions.map(p=>p.mint)).toEqual(['A']);
   expect(report.unfilledOrders).toEqual([]);
   expect(report.decisions.filter(d=>d.at===300)).toEqual([{at:300,mint:'B',action:'reject',reasons:['SYNTHETIC_FILL_VETO']}]);
   expect(evaluated).not.toContain('b-rejected');
   expect(guardHistories.at(-1)).toEqual(rows.slice(0,4).map(r=>r.id));
   expect(finalHistory).toEqual(rows.map(r=>r.id));
 });
 it('does not queue a replacement entry on the same observation after an insufficient-cash fill rejection',()=>{
   const rows=[row('signal',0),{...row('unfunded-entry',100),buy:quote(100,'100','10')}];
   const evaluated:string[]=[];
   const report=replay(rows,c=>{
     evaluated.push(c.current.id);
     return {action:'enter',amountLamports:'100',reasons:['SYNTHETIC_SIGNAL']};
   },{...opts,initialCapitalLamports:'100'});
   // The 100 input plus 10 network fee cannot be paid from 100 cash.
   expect(report.decisions.filter(d=>d.at===100)).toEqual([{at:100,mint:'M',action:'reject',reasons:['INSUFFICIENT_CASH_AT_FILL']}]);
   expect(evaluated).toEqual(['signal']);
   expect(report.unfilledOrders).toEqual([]);
   expect(report.unresolvedPositions).toEqual([]);
   expect(report.trades).toEqual([]);
   expect(report.cashLamports).toBe('100');
   expect(report.equity).toEqual([{at:0,equityLamports:'100'},{at:100,equityLamports:'100'}]);
 });
 it('records history and unknown equity at an unfunded exit while retaining the original pending exit',()=>{
   const freeQuote=(at:number,input:string,output:string)=>({...quote(at,input,output),networkFeeLamports:'0'});
   const rows=[row('a-signal',0,'A'),{...row('a-fill',100,'A'),buy:freeQuote(100,'100','10'),sell:freeQuote(100,'10','100')},row('b-signal',150,'B'),{...row('b-fill',250,'B'),buy:freeQuote(250,'100','10'),sell:freeQuote(250,'10','100')},{...row('b-unfunded-exit',450,'B'),sell:{...freeQuote(450,'10','1'),networkFeeLamports:'802'}},row('later-observation',500,'C')];
   const evaluated:string[]=[];
   let finalHistory:string[]=[];
   const report=replay(rows,c=>{
     evaluated.push(c.current.id);
     finalHistory=c.history.map(r=>r.id);
     if(c.current.id==='a-signal'||c.current.id==='b-signal')return {action:'enter',amountLamports:'100',reasons:['SYNTHETIC_SIGNAL']};
     if(c.current.id==='b-fill')return {action:'exit',reasons:['SYNTHETIC_PROTECTIVE_EXIT']};
     return {action:'hold',reasons:[]};
   },{...opts,initialCapitalLamports:'1000',maxQuoteAgeMs:200});
   // Cash 800 + proceeds 1 cannot pay fee 802. A's last mark is also stale.
   expect(report.equity.map(p=>p.at)).toEqual(rows.map(r=>r.at));
   expect(report.equity.find(p=>p.at===450)?.equityLamports).toBeNull();
   expect(report.metrics.unknownEquityObservations).toBe(2);
   expect(report.cashLamports).toBe('800');
   expect(report.trades).toEqual([]);
   expect(report.unresolvedPositions.map(p=>p.mint)).toEqual(['A','B']);
   expect(report.unfilledOrders).toEqual([{mint:'B',action:'exit',decisionAt:250,amountRaw:'10'}]);
   expect(report.decisions.filter(d=>d.at===450)).toEqual([{at:450,mint:'B',action:'reject',reasons:['EXIT_NETWORK_FEE_UNFUNDED']}]);
   expect(evaluated).not.toContain('b-unfunded-exit');
   expect(finalHistory).toEqual(rows.map(r=>r.id));
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

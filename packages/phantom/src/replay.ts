/** Point-in-time, exact-size quote replay. No price interpolation or invented fills. */
export interface ReplayQuote {
  observedAt: number;
  /** Optional captured request time; absent legacy data cannot prove request timing. */
  requestedAt?: number;
  inputRaw: string;
  outputRaw: string;
  /** Trading fees and quoted slippage are already reflected in outputRaw. */
  networkFeeLamports: string;
  priceImpactBps: number;
}
export interface ReplayObservation {
  id: string;
  mint: string;
  at: number;
  regime: string;
  features: Readonly<Record<string, number | null>>;
  signature?: string;
  slot?: number;
  buy?: ReplayQuote;
  sell?: ReplayQuote;
}
export interface ReplayDecision {
  action: 'enter' | 'exit' | 'hold' | 'reject';
  reasons: string[];
  amountLamports?: string;
}
export interface ReplayContext {
  now: number;
  current: Readonly<ReplayObservation>;
  history: readonly Readonly<ReplayObservation>[];
  position: Readonly<ReplayPosition> | null;
  cashLamports: string;
  portfolio?: Readonly<{positions:readonly ReplayPosition[];trades:readonly ReplayTrade[];initialCapitalLamports:string;equityLamports:string|null;peakEquityLamports:string}>;
}
export interface ReplayPosition {
  id: string; mint: string; strategy: string; regime: string; quantityRaw: string;
  costLamports: string; entryFeeLamports: string; openedAt: number; decisionAt: number;
}
export interface ReplayTrade extends ReplayPosition {
  closedAt: number; proceedsLamports: string; feesLamports: string; pnlLamports: string;
  entryLatencyMs: number; exitLatencyMs: number; exitReason: string;
}
export interface RejectedOutcome {
  mint: string; at: number; reasons: string[]; horizonAt: number;
  exitQuoteObservedAt: number | null;
  /** Diagnostic only; never supplied to a strategy. Null when exact quotes are unavailable. */
  hypotheticalPnlLamports: string | null;
}
export interface ReplayOptions {
  strategy: string; initialCapitalLamports: string; minimumLatencyMs: number;
  maxQuoteAgeMs: number; maxImpactBps: number; rejectionHorizonMs?: number;
  fixtureKind: 'recorded-chain' | 'synthetic-fixture';
  fillGuard?: (ctx:ReplayContext,order:{amountLamports:string;decisionAt:number})=>{allowed:boolean;reasons:string[]};
}
export interface ReplayReport {
  fixtureKind: ReplayOptions['fixtureKind']; strategy: string;
  initialCapitalLamports: string; cashLamports: string;
  trades: ReplayTrade[]; unresolvedPositions: ReplayPosition[];
  unfilledOrders: Array<{mint:string;action:'enter'|'exit';decisionAt:number;amountRaw:string}>;
  equity: Array<{at:number;equityLamports:string|null}>;
  decisions: Array<{ at: number; mint: string; action: string; reasons: string[] }>;
  rejectedOutcomes: RejectedOutcome[]; metrics: ReturnType<typeof performanceMetrics>&{maximumObservedEquityDrawdownLamports:string|null;unknownEquityObservations:number};
  executionAssumptions: string[];
}
function natural(raw: string, positive = false): bigint {
  if (!/^(0|[1-9]\d*)$/.test(raw)) throw new Error('Invalid integer amount');
  const value = BigInt(raw);
  if (positive && value === 0n) throw new Error('Amount must be positive');
  return value;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
function validQuote(q: ReplayQuote | undefined, at: number, input: bigint, opts: ReplayOptions, notBefore = -Infinity): q is ReplayQuote {
  if (!q || !Number.isFinite(q.observedAt) || q.observedAt < notBefore || q.observedAt > at || at - q.observedAt > opts.maxQuoteAgeMs) return false;
  if (q.requestedAt !== undefined && (!Number.isFinite(q.requestedAt) || q.requestedAt < 0 || q.requestedAt < notBefore || q.requestedAt > q.observedAt)) return false;
  return natural(q.inputRaw, true) === input && natural(q.outputRaw, true) > 0n && natural(q.networkFeeLamports) >= 0n
    && Number.isFinite(q.priceImpactBps) && q.priceImpactBps >= 0 && q.priceImpactBps <= opts.maxImpactBps;
}

export function replay(observations: readonly ReplayObservation[], evaluate: (ctx: ReplayContext) => ReplayDecision, opts: ReplayOptions): ReplayReport {
  if (!Number.isFinite(opts.minimumLatencyMs) || opts.minimumLatencyMs < 1 || !Number.isFinite(opts.maxQuoteAgeMs) || opts.maxQuoteAgeMs < 0 || !Number.isInteger(opts.maxImpactBps) || opts.maxImpactBps < 0) throw new Error('Invalid replay execution limits');
  const rows = observations.map(row => structuredClone(row)).sort((a,b) => a.at-b.at || a.id.localeCompare(b.id));
  const ids = new Set<string>();
  for (const row of rows) {
    if (!Number.isFinite(row.at) || row.at<0 || !row.id || !row.mint || ids.has(row.id)) throw new Error('Malformed or duplicate replay observation');
    if(opts.fixtureKind==='recorded-chain'&&(!row.signature||!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(row.signature)||!Number.isSafeInteger(row.slot)||row.slot!<0))throw Error('Recorded-chain replay requires signature and slot provenance');
    if(!row.features||Object.values(row.features).some(v=>v!==null&&!Number.isFinite(v)))throw Error('Non-finite historical feature');
    ids.add(row.id);
    if (row.buy && row.buy.observedAt > row.at || row.sell && row.sell.observedAt > row.at) throw new Error('Future quote in historical observation');
    freeze(row);
  }
  let cash = natural(opts.initialCapitalLamports, true);
  const positions = new Map<string, ReplayPosition>();
  const pending = new Map<string, {at:number; action:'enter'|'exit';amount:bigint;reasons:string[]}>();
  const trades: ReplayTrade[] = [];
  const decisions: ReplayReport['decisions'] = [];
  const rejected: Array<{row:ReplayObservation;decision:ReplayDecision}> = [];
  const history: Readonly<ReplayObservation>[] = [];
  const lastRows=new Map<string,ReplayObservation>();
  const equityHistory:ReplayReport['equity']=[];
  let observedPeak=natural(opts.initialCapitalLamports);
  const observedEquityAt=(at:number)=>{
    let value:bigint=cash;
    for(const [mint,position] of positions){const latest=lastRows.get(mint);if(!latest||!validQuote(latest.sell,at,natural(position.quantityRaw),opts))return null;value+=natural(latest.sell.outputRaw)-natural(latest.sell.networkFeeLamports);}
    if(value>observedPeak)observedPeak=value;return value;
  };
  const context=(row:ReplayObservation,prefix:Readonly<ReplayObservation>[]):ReplayContext=>freeze({now:row.at,current:row,history:Object.freeze([...prefix]),position:positions.has(row.mint)?structuredClone(positions.get(row.mint)!):null,cashLamports:cash.toString(),portfolio:{positions:structuredClone([...positions.values()]),trades:structuredClone(trades),initialCapitalLamports:opts.initialCapitalLamports,equityLamports:observedEquityAt(row.at)?.toString()??null,peakEquityLamports:observedPeak.toString()}});
  for (const row of rows) {
    lastRows.set(row.mint,row);
    let settlementRejected=false;
    const order = pending.get(row.mint);
    if (order && row.at >= order.at + opts.minimumLatencyMs) {
      if (order.action === 'enter' && !positions.has(row.mint) && validQuote(row.buy,row.at,order.amount,opts,order.at+opts.minimumLatencyMs)) {
        const verdict=opts.fillGuard?.(context(row,[...history,row]),{amountLamports:order.amount.toString(),decisionAt:order.at});
        if(verdict&&!verdict.allowed){
          decisions.push({at:row.at,mint:row.mint,action:'reject',reasons:[...verdict.reasons]});
          pending.delete(row.mint);
          settlementRejected=true;
        } else {
          const fee=natural(row.buy.networkFeeLamports), total=order.amount+fee;
          if (cash >= total) {
            positions.set(row.mint,{id:`${opts.strategy}:${row.id}`,mint:row.mint,strategy:opts.strategy,regime:row.regime,quantityRaw:row.buy.outputRaw,costLamports:order.amount.toString(),entryFeeLamports:fee.toString(),openedAt:row.at,decisionAt:order.at});
            cash-=total;
            pending.delete(row.mint);
          } else {
            decisions.push({at:row.at,mint:row.mint,action:'reject',reasons:['INSUFFICIENT_CASH_AT_FILL']});
            pending.delete(row.mint);
            settlementRejected=true;
          }
        }
      } else if (order.action === 'exit') {
        const p=positions.get(row.mint);
        if (p && validQuote(row.sell,row.at,natural(p.quantityRaw),opts,order.at+opts.minimumLatencyMs)) {
          const proceeds=natural(row.sell.outputRaw), exitFee=natural(row.sell.networkFeeLamports);
          if (cash + proceeds < exitFee) {
            decisions.push({at:row.at,mint:row.mint,action:'reject',reasons:['EXIT_NETWORK_FEE_UNFUNDED']});
            settlementRejected=true;
          } else {
            cash+=proceeds-exitFee;
            const fees=natural(p.entryFeeLamports)+exitFee;
            trades.push({...p,closedAt:row.at,proceedsLamports:proceeds.toString(),feesLamports:fees.toString(),pnlLamports:(proceeds-natural(p.costLamports)-fees).toString(),entryLatencyMs:p.openedAt-p.decisionAt,exitLatencyMs:row.at-order.at,exitReason:order.reasons.join('; ')});
            positions.delete(row.mint);pending.delete(row.mint);
          }
        }
      }
    }
    history.push(row);
    const observedEquity=observedEquityAt(row.at);
    equityHistory.push({at:row.at,equityLamports:observedEquity?.toString()??null});
    // Rejected settlements still contribute one history/equity observation, but
    // cannot trigger a replacement order from the same observation.
    if(settlementRejected)continue;
    const decision=evaluate(context(row,history));
    if (!decision || !['enter','exit','hold','reject'].includes(decision.action) || !Array.isArray(decision.reasons)) throw new Error('Invalid replay strategy decision');
    decisions.push({at:row.at,mint:row.mint,action:decision.action,reasons:[...decision.reasons]});
    if(decision.action==='reject') rejected.push({row,decision:structuredClone(decision)});
    if (pending.has(row.mint)) continue;
    if(decision.action==='enter'&&!positions.has(row.mint)) pending.set(row.mint,{at:row.at,action:'enter',amount:natural(decision.amountLamports??'',true),reasons:[...decision.reasons]});
    if(decision.action==='exit'&&positions.has(row.mint)) pending.set(row.mint,{at:row.at,action:'exit',amount:natural(positions.get(row.mint)!.quantityRaw),reasons:[...decision.reasons]});
  }
  const horizon=opts.rejectionHorizonMs??60_000;
  const rejectedOutcomes=rejected.map(({row,decision})=>{
    const target=row.at+horizon;
    const later=row.buy&&validQuote(row.buy,row.at,natural(row.buy.inputRaw),opts)
      ? rows.find(r=>r.mint===row.mint&&r.at>=target&&validQuote(r.sell,r.at,natural(row.buy!.outputRaw),opts,target)) : undefined;
    let pnl:string|null=null;
    if(row.buy&&validQuote(row.buy,row.at,natural(row.buy.inputRaw),opts)&&later&&validQuote(later.sell,later.at,natural(row.buy.outputRaw),opts,target)) pnl=(natural(later.sell.outputRaw)-natural(row.buy.inputRaw)-natural(row.buy.networkFeeLamports)-natural(later.sell.networkFeeLamports)).toString();
    return {mint:row.mint,at:row.at,reasons:decision.reasons,horizonAt:target,exitQuoteObservedAt:pnl!==null?later!.sell!.observedAt:null,hypotheticalPnlLamports:pnl};
  });
  let equityPeak=natural(opts.initialCapitalLamports),observedDrawdown=0n,unknownEquity=0;
  for(const point of equityHistory){if(point.equityLamports===null){unknownEquity++;continue;}const value=BigInt(point.equityLamports);if(value>equityPeak)equityPeak=value;if(equityPeak-value>observedDrawdown)observedDrawdown=equityPeak-value;}
  const metrics={...performanceMetrics(trades,opts.initialCapitalLamports),maximumObservedEquityDrawdownLamports:equityHistory.length?observedDrawdown.toString():null,unknownEquityObservations:unknownEquity};
  return {fixtureKind:opts.fixtureKind,strategy:opts.strategy,initialCapitalLamports:opts.initialCapitalLamports,cashLamports:cash.toString(),trades,unresolvedPositions:[...positions.values()],unfilledOrders:[...pending].map(([mint,order])=>({mint,action:order.action,decisionAt:order.at,amountRaw:order.amount.toString()})),equity:equityHistory,decisions,rejectedOutcomes,metrics,executionAssumptions:['Exact-size contemporaneous observable quotes only; no linear price interpolation.','Quote output includes trading fees and quoted slippage; network fees charged once separately.','Fill quote observations must be at or after decision plus configured latency; captured request times must satisfy the same boundary. Missing request timestamps do not prove when a request began.','Unclosed inventory remains unresolved; realized metrics do not imply zero inventory loss.','Equity is unknown when any open inventory lacks a fresh exact-size exit quote; observed drawdown can understate losses across those gaps.','Rejected future outcomes are diagnostics only and never passed to strategy callbacks.']};
}

export function performanceMetrics(trades: readonly ReplayTrade[], initialCapitalLamports: string) {
  const initial=natural(initialCapitalLamports,true);
  let grossWins=0n,grossLosses=0n,fees=0n,pnl=0n,peak=initial,equity=initial,maxDrawdown=0n,maxDrawdownBps=0n;
  let wins=0,losses=0;
  for(const trade of [...trades].sort((a,b)=>a.closedAt-b.closedAt||a.id.localeCompare(b.id))){
    const net=BigInt(trade.pnlLamports);pnl+=net;fees+=natural(trade.feesLamports);
    if(net>0n){grossWins+=net;wins++;}else if(net<0n){grossLosses-=net;losses++;}
    equity+=net;if(equity>peak)peak=equity;
    const dd=peak-equity;if(dd>maxDrawdown)maxDrawdown=dd;
    const ddBps=dd*10_000n/peak;if(ddBps>maxDrawdownBps)maxDrawdownBps=ddBps;
  }
  const segment=(key:'strategy'|'regime')=>Object.fromEntries([...new Set(trades.map(t=>t[key]))].map(value=>[value,{trades:trades.filter(t=>t[key]===value).length,pnlLamports:trades.filter(t=>t[key]===value).reduce((n,t)=>n+BigInt(t.pnlLamports),0n).toString()}]));
  const latency=(key:'entryLatencyMs'|'exitLatencyMs')=>trades.length?trades.reduce((n,t)=>n+t[key],0)/trades.length:null;
  return {closedTrades:trades.length,netRealizedPnlLamports:pnl.toString(),winRate:trades.length?wins/trades.length:null,averageWinLamports:wins?(grossWins/BigInt(wins)).toString():null,averageLossLamports:losses?(grossLosses/BigInt(losses)).toString():null,profitFactor:grossLosses>0n?Number(grossWins*1_000_000n/grossLosses)/1_000_000:null,profitFactorStatus:grossLosses===0n?'NO_REALIZED_LOSSES':'DEFINED',maximumRealizedDrawdownLamports:maxDrawdown.toString(),maximumRealizedDrawdownBps:Number(maxDrawdownBps),feesLamports:fees.toString(),averageEntryLatencyMs:latency('entryLatencyMs'),averageExitLatencyMs:latency('exitLatencyMs'),byStrategy:segment('strategy'),byRegime:segment('regime')};
}

export function walkForwardSplit(rows:readonly ReplayObservation[], trainEnd:number,testEnd:number,embargoMs:number){
  if(!Number.isFinite(trainEnd)||!Number.isFinite(testEnd)||testEnd<=trainEnd||!Number.isFinite(embargoMs)||embargoMs<0)throw Error('Invalid walk-forward boundaries');
  const first=new Map<string,number>();
  for(const r of rows)first.set(r.mint,Math.min(first.get(r.mint)??Infinity,r.at));
  const train=rows.filter(r=>r.at<trainEnd).sort((a,b)=>a.at-b.at);
  const trainMints=new Set(train.map(r=>r.mint));
  const test=rows.filter(r=>r.at>=trainEnd+embargoMs&&r.at<testEnd&&!trainMints.has(r.mint)&&first.get(r.mint)!>=trainEnd+embargoMs).sort((a,b)=>a.at-b.at);
  return {train,test,trainEnd,testStart:trainEnd+embargoMs,testEnd,embargoMs,excludedOverlappingMints:[...new Set(rows.filter(r=>r.at>=trainEnd&&r.at<testEnd&&trainMints.has(r.mint)).map(r=>r.mint))]};
}

export function walkForward(rows:readonly ReplayObservation[],windows:Array<{trainEnd:number;testEnd:number}>,embargoMs:number,fit:(training:readonly ReplayObservation[])=>((ctx:ReplayContext)=>ReplayDecision),opts:ReplayOptions){
  let priorTestEnd=-Infinity;
  return windows.map(w=>{
    if(w.trainEnd<priorTestEnd)throw Error('Walk-forward test windows overlap');
    const split=walkForwardSplit(rows,w.trainEnd,w.testEnd,embargoMs);priorTestEnd=w.testEnd;
    const strategy=fit(freeze(structuredClone(split.train)));
    return {partition:{trainCount:split.train.length,testCount:split.test.length,trainEnd:split.trainEnd,testStart:split.testStart,testEnd:split.testEnd,embargoMs,excludedOverlappingMints:split.excludedOverlappingMints},report:replay(split.test,strategy,opts)};
  });
}

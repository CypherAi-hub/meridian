/** Deterministic, point-in-time research signals. No probabilities are implied. */
export interface FundingEdge {
  from: string;
  to: string;
  amountLamports: bigint;
  eventAt: number;
  observedAt: number;
  signature: string;
  /** Known exchange, bridge, faucet or shared distributor: never a relationship edge. */
  sharedService?: boolean;
}

export interface TradeObservation {
  signature: string;
  instructionIndex: string;
  mint: string;
  wallet: string;
  side: 'buy' | 'sell';
  quoteAmount: bigint;
  tokenAmount: bigint;
  quoteMint: string;
  eventAt: number;
  observedAt: number;
}

export interface CreatorOutcome {
  creator: string;
  mint: string;
  launchedAt: number;
  knownAt: number;
  outcome: 'rug_evidence' | 'liquidity_loss' | 'survived' | 'unresolved';
  evidenceSignatures: string[];
}

export interface WalletTrackRecord {
  wallet: string;
  /** These figures must be calculated from realized, cost-inclusive, out-of-sample fills. */
  evaluatedAt: number;
  sampleEndsAt: number;
  closedTrades: number;
  realizedNetLamports: bigint;
  maxDrawdownBps: number;
  outOfSample: boolean;
}

export interface WalletDemand {
  score: number;
  confidence: 'low' | 'medium' | 'high';
  independentBuyerUnits: number;
  uniqueBuyers: number;
  clusteredBuyers: number;
  creatorAssociatedBuyers: number;
  effectiveBuyVolume: bigint;
  evidence: string[];
}

function eligibleAt(eventAt: number, observedAt: number, asOf: number): boolean {
  return Number.isFinite(eventAt) && Number.isFinite(observedAt) && eventAt <= asOf && observedAt <= asOf;
}

/** Funding links are evidence of possible coordination, never identity assertions. */
export class WalletIntelligence {
  private funding = new Map<string, FundingEdge>();
  private outcomes = new Map<string, CreatorOutcome>();
  private records = new Map<string, WalletTrackRecord[]>();
  constructor(private readonly knownSharedServices = new Set<string>(), private readonly maxEdges = 100_000) {}

  addFunding(edge: FundingEdge): void {
    if (!edge.signature || !edge.from || !edge.to || edge.from === edge.to || edge.amountLamports <= 0n) return;
    this.funding.set(`${edge.signature}:${edge.from}:${edge.to}`, { ...edge });
    // Bounded cache only. Durable history belongs in the event store.
    if (this.funding.size > this.maxEdges) this.funding.delete(this.funding.keys().next().value!);
  }

  addCreatorOutcome(outcome: CreatorOutcome): void {
    if (outcome.knownAt < outcome.launchedAt || !outcome.evidenceSignatures.length) return;
    this.outcomes.set(`${outcome.creator}:${outcome.mint}:${outcome.knownAt}`, { ...outcome, evidenceSignatures: [...outcome.evidenceSignatures] });
  }

  addTrackRecord(record: WalletTrackRecord): void {
    if (!Number.isFinite(record.sampleEndsAt) || !Number.isFinite(record.evaluatedAt) || record.sampleEndsAt > record.evaluatedAt || !Number.isInteger(record.closedTrades) || record.closedTrades < 0 || !Number.isInteger(record.maxDrawdownBps) || record.maxDrawdownBps < 0 || record.maxDrawdownBps > 10_000) return;
    const list = this.records.get(record.wallet) ?? [];
    list.push({ ...record });
    this.records.set(record.wallet, list.sort((a, b) => b.evaluatedAt - a.evaluatedAt).slice(0, 100));
  }

  creatorHistory(creator: string, asOf: number): CreatorOutcome[] {
    return [...this.outcomes.values()].filter(x => x.creator === creator && x.knownAt <= asOf && x.launchedAt <= asOf).map(x => ({ ...x, evidenceSignatures: [...x.evidenceSignatures] }));
  }

  successfulWallets(wallets: Iterable<string>, asOf: number, minimumClosed = 30): string[] {
    return [...wallets].filter(wallet => {
      const r = this.records.get(wallet)?.find(x => x.evaluatedAt <= asOf && x.sampleEndsAt < asOf);
      return r && r.outOfSample && r.closedTrades >= minimumClosed && r.realizedNetLamports > 0n && r.maxDrawdownBps <= 2_500;
    });
  }

  demand(trades: TradeObservation[], asOf: number, creator?: string): WalletDemand {
    const buys = trades.filter(t => t.side === 'buy' && t.quoteAmount > 0n && eligibleAt(t.eventAt, t.observedAt, asOf));
    const wallets = new Set(buys.map(t => t.wallet));
    const parent = new Map<string, string>();
    const root = (wallet: string): string => {
      const p = parent.get(wallet);
      if (!p) { parent.set(wallet, wallet); return wallet; }
      if (p === wallet) return wallet;
      const r = root(p); parent.set(wallet, r); return r;
    };
    const unite = (a: string, b: string) => { const ar = root(a), br = root(b); if (ar !== br) parent.set(br, ar); };
    wallets.forEach(root);
    if (creator) root(creator);
    const evidence: string[] = [];
    for (const edge of this.funding.values()) {
      if (!eligibleAt(edge.eventAt, edge.observedAt, asOf) || edge.sharedService || this.knownSharedServices.has(edge.from) || this.knownSharedServices.has(edge.to)) continue;
      // Direct funding is stronger than mere co-purchase. Do not infer common-owner from common-funder alone.
      if ((wallets.has(edge.from) || edge.from === creator) && wallets.has(edge.to)) {
        unite(edge.from, edge.to);
        evidence.push(`possible direct-funding relationship ${edge.from} -> ${edge.to}; tx=${edge.signature}`);
      }
    }
    const groups = new Map<string, string[]>();
    for (const wallet of wallets) { const key = root(wallet); const group = groups.get(key) ?? []; group.push(wallet); groups.set(key, group); }
    const totals = new Map<string, bigint>();
    for (const buy of buys) totals.set(buy.wallet, (totals.get(buy.wallet) ?? 0n) + buy.quoteAmount);
    let adjusted = 0n, clustered = 0, creatorAssociated = 0;
    for (const [key, group] of groups) {
      const values = group.map(w => totals.get(w) ?? 0n);
      const sum = values.reduce((a, b) => a + b, 0n);
      // A funding-linked group counts as one independent demand unit and its largest buyer's volume.
      const max = values.reduce((a, b) => a > b ? a : b, 0n);
      if (group.length > 1) clustered += group.length;
      if (creator && key === root(creator)) { creatorAssociated += group.length; continue; }
      adjusted += group.length > 1 ? max : sum;
    }
    const raw = buys.reduce((n, t) => n + t.quoteAmount, 0n);
    const units = [...groups.keys()].filter(key => !creator || key !== root(creator)).length;
    // Bounded descriptive score, not a learned prediction or profitability estimate.
    const volumeRatio = raw ? Number(adjusted * 10_000n / raw) / 10_000 : 0;
    const breadth = Math.min(1, units / 10);
    const score = Math.round(100 * volumeRatio * breadth);
    return {
      score, confidence: wallets.size >= 20 && evidence.length >= 3 ? 'medium' : 'low',
      independentBuyerUnits: units, uniqueBuyers: wallets.size, clusteredBuyers: clustered,
      creatorAssociatedBuyers: creatorAssociated, effectiveBuyVolume: adjusted,
      evidence: [...evidence, 'Co-purchase and shared-exchange use are not relationship evidence.', 'Missing funding history limits confidence; this score does not prove independence.'],
    };
  }
}

export interface SignalContext {
  mint: string;
  quoteMint: string;
  launchAt: number | null;
  launchVerified: boolean;
  creator?: string;
  liquidityLamports: bigint | null;
  liquidityPreviousLamports?: bigint | null;
  liquidityObservedAt?: number;
  curveProgressBps: number | null;
  curveObservedAt?: number;
  executionCostBps: number | null;
  executionObservedAt?: number;
}

export interface SignalFeatures {
  asOf: number;
  mint: string;
  observations: number;
  verifiedLaunchAgeMs: number | null;
  imbalance: number | null;
  uniqueBuyers: number;
  uniqueBuyerAcceleration: number;
  priceVelocityBps: number | null;
  priceAccelerationBps: number | null;
  drawdownFromPeakBps: number | null;
  netInflowLamports: bigint;
  sellerConcentrationBps: number | null;
  organic: WalletDemand;
  smartBuyers: number;
  creatorSelling: boolean;
  creatorPriorLaunches: number;
  creatorPriorAdverseOutcomes: number;
  liquidityLamports: bigint | null;
  liquidityGrowing: boolean | null;
  curveProgressBps: number | null;
  executionCostBps: number | null;
}

function priceRatioBps(a: TradeObservation, b: TradeObservation): number | null {
  // (quote/token at b) / (quote/token at a), with integer arithmetic before bounded conversion.
  if (a.quoteAmount <= 0n || a.tokenAmount <= 0n || b.quoteAmount <= 0n || b.tokenAmount <= 0n) return null;
  const value = ((b.quoteAmount * a.tokenAmount * 10_000n) / (b.tokenAmount * a.quoteAmount)) - 10_000n;
  return Number(value > 1_000_000n ? 1_000_000n : value < -10_000n ? -10_000n : value);
}

export function featuresAt(trades: TradeObservation[], asOf: number, windowMs: number, intelligence: WalletIntelligence, context: SignalContext): SignalFeatures {
  if (!Number.isFinite(asOf) || !Number.isFinite(windowMs) || windowMs <= 0) throw new Error('Invalid signal time window');
  const seen = new Set<string>();
  const history = trades.filter(t => {
    const id = `${t.signature}:${t.instructionIndex}`;
    if (seen.has(id) || t.mint !== context.mint || t.quoteMint !== context.quoteMint || !eligibleAt(t.eventAt, t.observedAt, asOf) || t.eventAt < asOf - windowMs * 2 || t.quoteAmount <= 0n || t.tokenAmount <= 0n) return false;
    seen.add(id); return true;
  }).sort((a, b) => a.eventAt - b.eventAt || a.signature.localeCompare(b.signature));
  const current = history.filter(t => t.eventAt >= asOf - windowMs);
  const previous = history.filter(t => t.eventAt < asOf - windowMs);
  const buys = current.filter(t => t.side === 'buy'), sells = current.filter(t => t.side === 'sell');
  const buyVol = buys.reduce((n, t) => n + t.quoteAmount, 0n), sellVol = sells.reduce((n, t) => n + t.quoteAmount, 0n);
  const total = buyVol + sellVol;
  const buyers = new Set(buys.map(t => t.wallet));
  const oldBuyers = new Set(previous.filter(t => t.side === 'buy').map(t => t.wallet));
  const sellers = new Map<string, bigint>();
  for (const sell of sells) sellers.set(sell.wallet, (sellers.get(sell.wallet) ?? 0n) + sell.quoteAmount);
  const largestSeller = [...sellers.values()].reduce((a, b) => a > b ? a : b, 0n);
  const first = current[0], last = current.at(-1);
  const oldFirst = previous[0], oldLast = previous.at(-1);
  const velocity = first && last && first !== last ? priceRatioBps(first, last) : null;
  const oldVelocity = oldFirst && oldLast && oldFirst !== oldLast ? priceRatioBps(oldFirst, oldLast) : null;
  const peak = current.reduce<TradeObservation | undefined>((best, t) => !best || (priceRatioBps(best, t) ?? 0) > 0 ? t : best, undefined);
  const recentEvidence = (at: number | undefined) => at != null && at <= asOf && at >= asOf - windowMs;
  const creatorHistory = context.creator ? intelligence.creatorHistory(context.creator, asOf) : [];
  return {
    asOf, mint: context.mint, observations: current.length,
    verifiedLaunchAgeMs: context.launchVerified && context.launchAt != null && context.launchAt <= asOf ? asOf - context.launchAt : null,
    imbalance: total ? Number((buyVol - sellVol) * 10_000n / total) / 10_000 : null,
    uniqueBuyers: buyers.size, uniqueBuyerAcceleration: buyers.size - oldBuyers.size,
    priceVelocityBps: velocity, priceAccelerationBps: velocity != null && oldVelocity != null ? velocity - oldVelocity : null,
    drawdownFromPeakBps: peak && last ? Math.max(0, -(priceRatioBps(peak, last) ?? 0)) : null,
    netInflowLamports: buyVol - sellVol,
    sellerConcentrationBps: sellVol ? Number(largestSeller * 10_000n / sellVol) : null,
    organic: intelligence.demand(current, asOf, context.creator),
    smartBuyers: intelligence.successfulWallets(buyers, asOf).length,
    creatorSelling: sells.some(t => t.wallet === context.creator),
    creatorPriorLaunches: new Set(creatorHistory.map(x => x.mint)).size,
    creatorPriorAdverseOutcomes: new Set(creatorHistory.filter(x => x.outcome === 'rug_evidence' || x.outcome === 'liquidity_loss').map(x => x.mint)).size,
    liquidityLamports: recentEvidence(context.liquidityObservedAt) ? context.liquidityLamports : null,
    liquidityGrowing: recentEvidence(context.liquidityObservedAt) && context.liquidityLamports != null && context.liquidityPreviousLamports != null ? context.liquidityLamports > context.liquidityPreviousLamports : null,
    curveProgressBps: recentEvidence(context.curveObservedAt) ? context.curveProgressBps : null,
    executionCostBps: recentEvidence(context.executionObservedAt) ? context.executionCostBps : null,
  };
}

export type StrategyId = 'launch_sniper' | 'momentum_breakout' | 'early_reversal' | 'smart_wallet_confirmation';
export interface StrategyRules {
  minimumIndependentBuyers: number;
  minimumOrganicScore: number;
  minimumLiquidityLamports: bigint;
  maximumCostBps: number;
  minimumImbalance: number;
  minimumVelocityBps: number;
  reversalDrawdownBps: number;
  maximumLaunchAgeMs: number;
}
export const DEFAULT_STRATEGY_RULES: StrategyRules = {
  minimumIndependentBuyers: 5, minimumOrganicScore: 40, minimumLiquidityLamports: 20_000_000_000n,
  maximumCostBps: 150, minimumImbalance: 0.2, minimumVelocityBps: 100,
  reversalDrawdownBps: 1_000, maximumLaunchAgeMs: 120_000,
};
export interface StrategyDecision { strategy: StrategyId; enter: boolean; reasons: string[]; asOf: number; score: number; }

export function evaluateStrategies(f: SignalFeatures, rules: StrategyRules = DEFAULT_STRATEGY_RULES): StrategyDecision[] {
  const common: string[] = [];
  if (f.observations < 3) common.push('INSUFFICIENT_OBSERVATIONS');
  if (f.organic.independentBuyerUnits < rules.minimumIndependentBuyers) common.push('INSUFFICIENT_INDEPENDENT_BUYERS');
  if (f.organic.score < rules.minimumOrganicScore) common.push('ORGANIC_DEMAND_TOO_LOW');
  if (f.liquidityLamports == null) common.push('LIQUIDITY_UNKNOWN_OR_STALE');
  else if (f.liquidityLamports < rules.minimumLiquidityLamports) common.push('LIQUIDITY_TOO_LOW');
  if (f.executionCostBps == null) common.push('EXECUTION_COST_UNKNOWN_OR_STALE');
  else if (f.executionCostBps > rules.maximumCostBps) common.push('COST_BUDGET_EXCEEDED');
  if (f.creatorSelling) common.push('CREATOR_SELLING');
  if (f.creatorPriorAdverseOutcomes > 0) common.push('CREATOR_PRIOR_ADVERSE_OUTCOMES');
  const decision = (strategy: StrategyId, checks: [boolean, string][]): StrategyDecision => {
    const reasons = [...common, ...checks.filter(([pass]) => !pass).map(([, reason]) => reason)];
    return { strategy, enter: reasons.length === 0, reasons: reasons.length ? reasons : ['RULES_PASSED_REQUIRES_FINAL_RISK_GOVERNOR'], asOf: f.asOf, score: f.organic.score };
  };
  const positiveFlow = f.imbalance != null && f.imbalance >= rules.minimumImbalance && f.netInflowLamports > 0n;
  return [
    decision('launch_sniper', [
      [f.verifiedLaunchAgeMs != null && f.verifiedLaunchAgeMs <= rules.maximumLaunchAgeMs, 'VERIFIED_RECENT_LAUNCH_REQUIRED'],
      [positiveFlow, 'INDEPENDENT_BUY_FLOW_REQUIRED'], [f.uniqueBuyerAcceleration > 0, 'BUYER_ACCELERATION_REQUIRED'],
    ]),
    decision('momentum_breakout', [
      [positiveFlow, 'POSITIVE_FLOW_REQUIRED'], [f.liquidityGrowing === true, 'GROWING_LIQUIDITY_REQUIRED'],
      [f.priceVelocityBps != null && f.priceVelocityBps >= rules.minimumVelocityBps, 'PRICE_VELOCITY_REQUIRED'],
      [f.uniqueBuyerAcceleration > 0, 'BUYER_ACCELERATION_REQUIRED'],
    ]),
    decision('early_reversal', [
      [f.verifiedLaunchAgeMs != null && f.verifiedLaunchAgeMs < 3_600_000, 'EARLY_VERIFIED_TOKEN_REQUIRED'],
      [f.drawdownFromPeakBps != null && f.drawdownFromPeakBps >= rules.reversalDrawdownBps, 'PRIOR_DRAWDOWN_REQUIRED'],
      [positiveFlow, 'RECOVERING_DEMAND_REQUIRED'],
      [f.priceAccelerationBps != null && f.priceAccelerationBps > 0 && (f.priceVelocityBps ?? 0) > 0, 'PRICE_RECOVERY_REQUIRED'],
    ]),
    decision('smart_wallet_confirmation', [
      [f.smartBuyers >= 2, 'TWO_OUT_OF_SAMPLE_SUCCESSFUL_WALLETS_REQUIRED'],
      [positiveFlow, 'INDEPENDENT_FLOW_CONFIRMATION_REQUIRED'],
      [f.priceVelocityBps != null && f.priceVelocityBps > 0, 'PRICE_CONFIRMATION_REQUIRED'],
    ]),
  ];
}

export interface ValidatedStrategyConfig {
  id: string;
  strategy: StrategyId;
  regime: string;
  validatedAt: number;
  trainingEndsAt: number;
  validationStartsAt: number;
  validationEndsAt: number;
  validationTrades: number;
  outOfSampleNetLamports: bigint;
  outOfSampleMaxDrawdownBps: number;
  configurationHash: string;
  validationArtifactHash: string;
  approved: boolean;
}

/** Adaptive selection can only rank explicitly validated, frozen past configurations. */
export function selectValidatedStrategy(configs: ValidatedStrategyConfig[], regime: string, asOf: number): { selected: ValidatedStrategyConfig | null; reasons: string[] } {
  const eligible = configs.filter(c => c.regime === regime && c.approved && c.trainingEndsAt < c.validationStartsAt && c.validationStartsAt < c.validationEndsAt && c.validationEndsAt <= c.validatedAt && c.validatedAt < asOf && c.validationTrades >= 30 && c.outOfSampleNetLamports > 0n && c.outOfSampleMaxDrawdownBps > 0 && c.outOfSampleMaxDrawdownBps <= 2_500 && /^[a-f0-9]{64}$/i.test(c.configurationHash) && /^[a-f0-9]{64}$/i.test(c.validationArtifactHash));
  eligible.sort((a, b) => {
    const left = a.outOfSampleNetLamports * BigInt(b.outOfSampleMaxDrawdownBps), right = b.outOfSampleNetLamports * BigInt(a.outOfSampleMaxDrawdownBps);
    return left === right ? a.id.localeCompare(b.id) : left > right ? -1 : 1;
  });
  return { selected: eligible[0] ?? null, reasons: eligible.length ? ['RANKED_APPROVED_OUT_OF_SAMPLE_NET_RETURN_PER_DRAWDOWN', 'REQUIRES_FINAL_RISK_GOVERNOR'] : ['NO_PREVALIDATED_CONFIGURATION_FOR_REGIME_STAND_DOWN'] };
}

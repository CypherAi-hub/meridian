import { describe, expect, it } from 'vitest';
import { DEFAULT_STRATEGY_RULES, WalletIntelligence, evaluateStrategies, featuresAt, selectValidatedStrategy, type SignalContext, type TradeObservation, type ValidatedStrategyConfig } from '../src/intelligence.ts';

// All observations in this test file are synthetic fixtures, never captured market data.
const now = 100_000;
const trade = (wallet: string, overrides: Partial<TradeObservation> = {}): TradeObservation => ({
  signature: `synthetic-${wallet}`, instructionIndex: '0', mint: 'test-mint', quoteMint: 'SOL', wallet,
  side: 'buy', quoteAmount: 100n, tokenAmount: 100n, eventAt: now - 100, observedAt: now - 90, ...overrides,
});
const context: SignalContext = { mint: 'test-mint', quoteMint: 'SOL', launchAt: now - 1000, launchVerified: true, liquidityLamports: 50_000_000_000n, liquidityPreviousLamports: 40_000_000_000n, liquidityObservedAt: now - 10, curveProgressBps: 3000, curveObservedAt: now - 10, executionCostBps: 100, executionObservedAt: now - 10 };

describe('point-in-time wallet graph', () => {
  it('does not cluster wallets merely because they bought the same token or use an exchange', () => {
    const intelligence = new WalletIntelligence(new Set(['exchange']));
    intelligence.addFunding({ from: 'exchange', to: 'a', amountLamports: 1n, eventAt: now - 1000, observedAt: now - 900, signature: 'e1' });
    intelligence.addFunding({ from: 'exchange', to: 'b', amountLamports: 1n, eventAt: now - 1000, observedAt: now - 900, signature: 'e2' });
    const result = intelligence.demand([trade('a'), trade('b')], now);
    expect(result.independentBuyerUnits).toBe(2);
    expect(result.clusteredBuyers).toBe(0);
    expect(result.confidence).toBe('low');
  });
  it('discounts funded buyer groups and creator-linked demand with evidence', () => {
    const intelligence = new WalletIntelligence();
    for (const [from, to] of [['a', 'b'], ['creator', 'c']]) intelligence.addFunding({ from, to, amountLamports: 100n, eventAt: now - 1000, observedAt: now - 900, signature: `${from}-${to}` });
    const result = intelligence.demand([trade('a'), trade('b'), trade('c'), trade('independent')], now, 'creator');
    expect(result.independentBuyerUnits).toBe(2);
    expect(result.clusteredBuyers).toBe(2);
    expect(result.creatorAssociatedBuyers).toBe(1);
    expect(result.effectiveBuyVolume).toBe(200n);
    expect(result.evidence.some(e => e.includes('creator-c'))).toBe(true);
  });
  it('does not infer common ownership solely from a common funder', () => {
    const intelligence = new WalletIntelligence();
    for (const to of ['a', 'b']) intelligence.addFunding({ from: 'distributor', to, amountLamports: 1n, eventAt: now - 1000, observedAt: now - 900, signature: to });
    expect(intelligence.demand([trade('a'), trade('b')], now).independentBuyerUnits).toBe(2);
  });
  it('cannot consume future relationships or outcomes in historical signals', () => {
    const intelligence = new WalletIntelligence();
    intelligence.addFunding({ from: 'a', to: 'b', amountLamports: 1n, eventAt: now - 1000, observedAt: now + 1, signature: 'future' });
    intelligence.addCreatorOutcome({ creator: 'creator', mint: 'test-mint', launchedAt: 1, knownAt: now + 1, outcome: 'rug_evidence', evidenceSignatures: ['rug'] });
    expect(intelligence.demand([trade('a'), trade('b')], now).independentBuyerUnits).toBe(2);
    expect(intelligence.creatorHistory('creator', now)).toHaveLength(0);
  });
  it('requires past out-of-sample cost-inclusive wallet performance', () => {
    const intelligence = new WalletIntelligence();
    for (const [wallet, outOfSample, evaluatedAt] of [['past', true, now - 1], ['training', false, now - 1], ['future', true, now + 1]] as const) intelligence.addTrackRecord({ wallet, outOfSample, evaluatedAt, sampleEndsAt: now - 10, closedTrades: 40, realizedNetLamports: 1000n, maxDrawdownBps: 500 });
    expect(intelligence.successfulWallets(['past', 'training', 'future'], now)).toEqual(['past']);
  });
});

describe('point-in-time quantitative features', () => {
  it('deduplicates instructions, excludes future or not-yet-received events and quote mismatches', () => {
    const a = trade('a');
    const result = featuresAt([a, a, trade('future', { eventAt: now + 1 }), trade('late', { observedAt: now + 1 }), trade('other', { quoteMint: 'USDC' })], now, 10_000, new WalletIntelligence(), context);
    expect(result.observations).toBe(1);
    expect(result.uniqueBuyers).toBe(1);
    expect(result.netInflowLamports).toBe(100n);
  });
  it('computes price ratios without floating point amount loss', () => {
    const huge = 100_000_000_000_000_000_000n;
    const result = featuresAt([trade('a', { eventAt: now - 200, quoteAmount: huge, tokenAmount: huge }), trade('b', { quoteAmount: huge * 2n, tokenAmount: huge })], now, 10_000, new WalletIntelligence(), context);
    expect(result.priceVelocityBps).toBe(10_000);
    expect(result.netInflowLamports).toBe(huge * 3n);
  });
  it('fails closed when liquidity, curve or execution-cost evidence is stale or future', () => {
    const result = featuresAt([trade('a')], now, 10_000, new WalletIntelligence(), { ...context, liquidityObservedAt: now + 1, curveObservedAt: now - 20_000, executionObservedAt: undefined });
    expect(result.liquidityLamports).toBeNull();
    expect(result.curveProgressBps).toBeNull();
    expect(result.executionCostBps).toBeNull();
    expect(evaluateStrategies(result).every(x => !x.enter && x.reasons.includes('LIQUIDITY_UNKNOWN_OR_STALE'))).toBe(true);
  });
  it('explains all four independent strategies and requires the final governor', () => {
    const trades = Array.from({ length: 10 }, (_, i) => trade(`buyer${i}`, { eventAt: now - 1000 + i * 50, quoteAmount: BigInt(100 + i * 10) }));
    const f = featuresAt(trades, now, 10_000, new WalletIntelligence(), context);
    const results = evaluateStrategies(f);
    expect(results.map(x => x.strategy)).toEqual(['launch_sniper', 'momentum_breakout', 'early_reversal', 'smart_wallet_confirmation']);
    expect(results.find(x => x.strategy === 'launch_sniper')?.enter).toBe(true);
    expect(results.find(x => x.strategy === 'momentum_breakout')?.enter).toBe(true);
    expect(results.find(x => x.strategy === 'early_reversal')?.reasons).toContain('PRIOR_DRAWDOWN_REQUIRED');
    expect(results.find(x => x.strategy === 'smart_wallet_confirmation')?.reasons).toContain('TWO_OUT_OF_SAMPLE_SUCCESSFUL_WALLETS_REQUIRED');
    expect(results[0].reasons).toContain('RULES_PASSED_REQUIRES_FINAL_RISK_GOVERNOR');
    expect(DEFAULT_STRATEGY_RULES.maximumCostBps).toBeGreaterThan(0);
  });
  it('vetoes a creator with evidenced adverse prior launches without leaking future outcomes', () => {
    const intelligence = new WalletIntelligence();
    intelligence.addCreatorOutcome({ creator: 'bad', mint: 'prior', launchedAt: 1, knownAt: now - 1, outcome: 'rug_evidence', evidenceSignatures: ['synthetic-rug'] });
    intelligence.addCreatorOutcome({ creator: 'bad', mint: 'future', launchedAt: 1, knownAt: now + 1, outcome: 'rug_evidence', evidenceSignatures: ['synthetic-future'] });
    const f = featuresAt([trade('a')], now, 10_000, intelligence, { ...context, creator: 'bad' });
    expect(f.creatorPriorLaunches).toBe(1);
    expect(f.creatorPriorAdverseOutcomes).toBe(1);
    expect(evaluateStrategies(f).every(x => x.reasons.includes('CREATOR_PRIOR_ADVERSE_OUTCOMES'))).toBe(true);
  });
});

describe('adaptive prevalidated selector', () => {
  const good: ValidatedStrategyConfig = { id: 'validated', strategy: 'launch_sniper', regime: 'trend', validatedAt: now - 1, trainingEndsAt: 100, validationStartsAt: 101, validationEndsAt: 500, validationTrades: 40, outOfSampleNetLamports: 10_000n, outOfSampleMaxDrawdownBps: 500, configurationHash: 'a'.repeat(64), validationArtifactHash: 'b'.repeat(64), approved: true };
  it('stands down for unvalidated, future, overlapping or losing configurations', () => {
    const configs = [{ ...good, approved: false }, { ...good, validatedAt: now + 1 }, { ...good, trainingEndsAt: good.validationStartsAt }, { ...good, outOfSampleNetLamports: -1n }];
    expect(selectValidatedStrategy(configs, 'trend', now).selected).toBeNull();
  });
  it('ranks only validated configurations by net return per drawdown', () => {
    const weak = { ...good, id: 'weak', outOfSampleMaxDrawdownBps: 1000 };
    expect(selectValidatedStrategy([weak, good], 'trend', now).selected?.id).toBe('validated');
    expect(selectValidatedStrategy([good], 'chop', now).selected).toBeNull();
  });
});

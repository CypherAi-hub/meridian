import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PUBLISHED_HYPOTHESES,
  RANDOM_ELIGIBLE_SEED,
  V33B_HYPOTHESIS_COUNT,
  matchRandomEligible,
  matchSafetyOnly,
  publishedMeta,
} from "./baseline-strategy.ts";
import { SCHEMA_VERSION, MERIDIAN_MIGRATIONS, REQUIRED_TABLES } from "./neon-steps.ts";
import { currentEpochName, officialSoakAllowed } from "./env.ts";
import { runDeterministicReplayBaselines } from "./replay-baseline.ts";
import { labelReplayConsideration, replayConsider, type ReplayObservation } from "./replay.ts";
import { buildReplayTradeStats, isoWeek, rMultiple, tradeReturn } from "./replay-stats.ts";
import { STRATEGIES } from "./strategies.ts";
import type { Features, LedgerRow, Predictions, TokenLive } from "./types.ts";
import { field } from "./providers/normalize.ts";
import { freezeHolderAtDecision } from "./holder-at-decision.ts";

test("schema v33b ends at 0010 and requires replay_experiments", () => {
  assert.equal(SCHEMA_VERSION, "v33b");
  assert.equal(MERIDIAN_MIGRATIONS.at(-1), "0010_v33b_closure.sql");
  assert.ok(REQUIRED_TABLES.includes("replay_experiments"));
});

test("next official epoch is v33b_production and preview soak is not counted", () => {
  assert.equal(currentEpochName("preview"), "v33b_preview");
  assert.equal(currentEpochName("development"), "v33b_preview");
  assert.equal(currentEpochName("production"), "v33b_production_blocked");
  assert.equal(officialSoakAllowed("preview"), false);
  assert.equal(officialSoakAllowed("production"), false);
});

test("published V3.3B set is exactly three hypotheses with seed 1337", () => {
  assert.equal(V33B_HYPOTHESIS_COUNT, 3);
  assert.equal(PUBLISHED_HYPOTHESES.length, 3);
  assert.deepEqual(
    PUBLISHED_HYPOTHESES.map((h) => h.name),
    ["random_eligible", "baseline_safe_momentum", "safety_only"],
  );
  assert.equal(RANDOM_ELIGIBLE_SEED, 1337);
  assert.equal(publishedMeta("random_eligible")?.seed, 1337);
  assert.equal(publishedMeta("eligible_universe"), null);
});

function row(partial: Partial<LedgerRow> & { decision_time: number; tokenAddress: string; ret: number }): LedgerRow {
  const entry = 1;
  return {
    decision_id: `${partial.tokenAddress}-${partial.decision_time}`,
    event_time: partial.decision_time,
    ingested_at: partial.decision_time,
    token: partial.tokenAddress,
    pair_address: "",
    token_age: 60,
    bucket: "new_launch",
    price: entry,
    market_cap: null,
    liquidity: 80_000,
    volume_1m: null,
    volume_5m: null,
    volume_acceleration: 2,
    buy_sell_imbalance: 0.2,
    unique_buyers: null,
    unique_sellers: null,
    holder_count: null,
    holder_concentration: 0.2,
    mint_auth: 0,
    freeze_auth: 0,
    entry_impact: 0.004,
    exit_impact: 0.005,
    stressed_exit: 0,
    momentum_score: 60,
    flow_score: 60,
    safety_score: 80,
    edge_score: 55,
    regime: "meme_mania",
    strategy_id: "safety_only",
    strategy_version: "1",
    feature_engine_version: "v1.3.0",
    label_definition_version: "labels_v1",
    governor_result: "authorized",
    veto_reason: "TRADE AUTHORIZED",
    veto_reason_code: "TRADE_AUTHORIZED",
    proposed_size: 0,
    proposed_entry: entry,
    proposed_stop: entry * 0.9,
    trade_taken: false,
    trade_action: "ignore",
    sell_quote_available: true,
    route_status: "ROUTABLE",
    feature_sources: {},
    features: {} as Features,
    gates: [],
    path: [],
    price_after_1m: null,
    price_after_5m: null,
    price_after_15m: entry * (1 + partial.ret),
    price_after_30m: null,
    price_after_1h: null,
    max_gain_5m: null,
    max_gain_15m: null,
    max_drawdown_5m: null,
    max_drawdown_15m: null,
    max_drawdown_1h: null,
    mfe_1m: null,
    mfe_30m: null,
    mae_1m: null,
    mae_30m: null,
    hit_plus_10_before_minus_10: null,
    hit_plus_20_before_minus_10: null,
    barrier_10_outcome: null,
    barrier_20_outcome: null,
    barrier_label_confidence: null,
    max_path_gap_seconds: null,
    avg_path_gap_seconds: null,
    path_sample_count: null,
    liquidity_collapse: false,
    sell_route_lost: false,
    first_sell_route_loss_at: null,
    sell_route_restored_at: null,
    rug_detected: false,
    simulated_entry: entry,
    simulated_exit: entry * (1 + partial.ret),
    theoretical_return: partial.ret,
    net_execution_return: partial.ret,
    execution_adjusted_return: partial.ret,
    research_quality_score: null,
    research_grade: null,
    provider_disagreement: false,
    labels_complete: true,
    outcome: "not_taken",
    ...partial,
  } as LedgerRow;
}

test("1R is entry-to-stop (default 10%) and expectancy / profit factor / consecutive losses compute", () => {
  const win = row({ decision_time: 1_000, tokenAddress: "A", ret: 0.2 });
  const loss = row({ decision_time: 2_000, tokenAddress: "B", ret: -0.1 });
  assert.equal(tradeReturn(win), 0.2);
  assert.ok(Math.abs((rMultiple(win) as number) - 2) < 1e-9);
  assert.ok(Math.abs((rMultiple(loss) as number) - -1) < 1e-9);

  const stats = buildReplayTradeStats({
    labeled: [win, loss],
    considerations: 4,
    authorized: 2,
    vetoed: 2,
  });
  assert.equal(stats.eligibleEvents, 4);
  assert.equal(stats.candidateTrades, 2);
  assert.equal(stats.vetoed, 2);
  assert.equal(stats.paperEntries, 2);
  assert.equal(stats.wins, 1);
  assert.equal(stats.losses, 1);
  assert.equal(stats.winRate, 0.5);
  assert.ok(Math.abs((stats.expectancy as number) - 0.05) < 1e-9);
  assert.ok(Math.abs((stats.profitFactor as number) - 2) < 1e-9);
  assert.ok(Math.abs((stats.meanR as number) - 0.5) < 1e-9);
  assert.equal(stats.maxConsecutiveLosses, 1);
  assert.ok((stats.maxDrawdown as number) > 0);
  assert.ok(stats.byRegime.meme_mania);
  assert.ok(stats.byBucket.new_launch);
  assert.ok(stats.byWeek[isoWeek(1_000)]);
  assert.equal(win.trade_taken, false);
});

test("replay labels carry the decision-time regime, not a hardcoded chop", () => {
  const mint = "Mint111111111111111111111111111111111111111";
  const series: ReplayObservation[] = [
    {
      mint,
      symbol: "TEST",
      ingestedAt: 1_000,
      eventTime: 1_000,
      price: 1,
      liquidity: 90_000,
      volume5m: 20_000,
      volume1m: 4_000,
      mcap: 400_000,
      buys5m: 40,
      sells5m: 10,
      uniqueBuyers: 30,
      uniqueSellers: 8,
      holders: 200,
      top10Pct: 0.18,
      mintAuth: false,
      freezeAuth: false,
      sellRoute: true,
      buyRoute: true,
      entryImpact: 0.004,
      exitImpact: 0.005,
      source: "dexscreener",
    },
  ];
  const considered = replayConsider({
    observations: series,
    mint,
    decisionTime: 1_000,
    strategy: STRATEGIES[3],
    regime: "meme_mania",
  });
  assert.ok(considered);
  assert.equal(considered.regime, "meme_mania");
  const labeled = labelReplayConsideration(considered, series, 1_000 + 60 * 60_000);
  assert.equal(labeled.regime, "meme_mania");
  assert.equal(labeled.trade_taken, false);
});

function obs(partial: Partial<ReplayObservation> & { ingestedAt: number; price: number | null }): ReplayObservation {
  return {
    mint: "Mint111111111111111111111111111111111111111",
    symbol: "TEST",
    eventTime: partial.eventTime ?? partial.ingestedAt,
    liquidity: 90_000,
    volume5m: 20_000,
    volume1m: 4_000,
    mcap: 400_000,
    buys5m: 40,
    sells5m: 10,
    uniqueBuyers: 30,
    uniqueSellers: 8,
    holders: 200,
    top10Pct: 0.18,
    mintAuth: false,
    freezeAuth: false,
    sellRoute: true,
    buyRoute: true,
    entryImpact: 0.004,
    exitImpact: 0.005,
    source: "dexscreener",
    ...partial,
  };
}

test("warehouse replay publishes three hypotheses, ML stays closed, random seed is 1337", () => {
  const series = [
    obs({ ingestedAt: 1_000, price: 1 }),
    obs({ ingestedAt: 21_000, price: 1.02, volume5m: 40_000 }),
    obs({ ingestedAt: 41_000, price: 1.03 }),
    obs({ ingestedAt: 15 * 60_000 + 1_000, price: 1.1, eventTime: 15 * 60_000 + 1_000 }),
  ];
  const a = runDeterministicReplayBaselines(series, { stepMs: 20_000, mints: 4 });
  const b = runDeterministicReplayBaselines(series, { stepMs: 20_000, mints: 4 });
  assert.equal(a.readyForReplay, true);
  assert.equal(a.readyForModeling, false);
  assert.equal(a.hypothesisCount, 3);
  assert.equal(a.publishedSeed, 1337);
  const published = a.strategies.filter((s) => s.published);
  assert.equal(published.length, 3);
  assert.deepEqual(
    published.map((s) => s.id),
    ["random_eligible", "baseline_safe_momentum", "safety_only"],
  );
  assert.equal(published.every((s) => s.liveWired === false), true);
  const random = published.find((s) => s.id === "random_eligible");
  assert.equal(random?.seed, 1337);
  assert.equal(random?.hypothesisIndex, 1);
  assert.ok(random?.stats);
  const eligible = a.strategies.find((s) => s.id === "eligible_universe");
  assert.equal(eligible?.published, false);
  const live = a.strategies.find((s) => s.id === "launch_velocity_pullback");
  assert.equal(live?.liveWired, true);
  assert.equal(live?.published, false);
  for (let i = 0; i < a.strategies.length; i++) {
    assert.equal(a.strategies[i].fingerprint, b.strategies[i].fingerprint);
  }
  const safety = a.strategies.find((s) => s.id === "safety_only");
  assert.equal(safety?.authorized, eligible?.authorized);
  assert.ok(a.note.includes("Ready for ML NO"));
});

test("random_eligible is seed-stable and matchSafetyOnly equals the eligible universe gate", () => {
  const token = {
    address: "M",
    pairAddress: "P",
    symbol: "T",
    name: "t",
    decimals: 6,
    createdAt: 1_000 - 60_000,
    priceUsd: field(1, 1_000, 1_000, "dexscreener"),
    priceCrossUsd: field(1, 1_000, 1_000, "geckoterminal"),
    liquidityUsd: field(40_000, 1_000, 1_000, "dexscreener"),
    mcapUsd: field(200_000, 1_000, 1_000, "dexscreener"),
    fdvUsd: field(200_000, 1_000, 1_000, "dexscreener"),
    volume1mUsd: field(1000, 1_000, 1_000, "derived"),
    volume5mUsd: field(8000, 1_000, 1_000, "dexscreener"),
    volume1hUsd: field(20_000, 1_000, 1_000, "dexscreener"),
    buys5m: field(10, 1_000, 1_000, "dexscreener"),
    sells5m: field(4, 1_000, 1_000, "dexscreener"),
    uniqueBuyers5m: field(8, 1_000, 1_000, "geckoterminal"),
    uniqueSellers5m: field(3, 1_000, 1_000, "geckoterminal"),
    holders: field(100, 1_000, 1_000, "rugcheck"),
    top10Pct: field(0.2, 1_000, 1_000, "rugcheck"),
    mintAuth: field(false, 1_000, 1_000, "solana"),
    freezeAuth: field(false, 1_000, 1_000, "solana"),
    buyQuote: null,
    sellQuote: {
      available: true,
      inMint: "M",
      outMint: "So11111111111111111111111111111111111111112",
      inAmount: "1",
      outAmount: "1",
      notionalUsd: 120,
      priceImpactPct: 0.01,
      impliedPriceUsd: 1,
      routeLabels: ["test"],
      latencyMs: 0,
      eventTime: 1_000,
      ingestedAt: 1_000,
      source: "jupiter" as const,
      routeState: "ROUTABLE" as const,
    },
    history: [1],
    prevLiq: 40_000,
    prevVolume5m: 4000,
    prevBuyers: 4,
    rugged: false,
  } as TokenLive;
  const features = {
    bucket: "new_launch",
    volAccel: 2,
    top10Pct: 0.2,
    mintAuth: 0,
    freezeAuth: 0,
    sellQuoteAvailable: 1,
    snapshotAgeMs: 1_000,
  } as Features;
  const predictions = { safetyScore: 80 } as Predictions;
  const args = { token, features, predictions, regime: "meme_mania" as const };
  assert.equal(matchSafetyOnly(args), true);
  const a = matchRandomEligible(args, 1337);
  const b = matchRandomEligible(args, 1337);
  assert.equal(a, b);
});

test("holder freeze is point-in-time: unknown if not yet ingested, valid if known before T and fresh", () => {
  const T = 50_000;
  const base = {
    address: "M",
    pairAddress: "P",
    symbol: "T",
    name: "t",
    decimals: 6,
    createdAt: T - 60_000,
    priceUsd: field(1, T, T, "dexscreener"),
    priceCrossUsd: field(1, T, T, "geckoterminal"),
    liquidityUsd: field(40_000, T, T, "dexscreener"),
    mcapUsd: field(200_000, T, T, "dexscreener"),
    fdvUsd: field(200_000, T, T, "dexscreener"),
    volume1mUsd: field(1, T, T, "derived"),
    volume5mUsd: field(1, T, T, "dexscreener"),
    volume1hUsd: field(1, T, T, "dexscreener"),
    buys5m: field(1, T, T, "dexscreener"),
    sells5m: field(1, T, T, "dexscreener"),
    uniqueBuyers5m: field(1, T, T, "geckoterminal"),
    uniqueSellers5m: field(1, T, T, "geckoterminal"),
    mintAuth: field(false, T, T, "solana"),
    freezeAuth: field(false, T, T, "solana"),
    buyQuote: null,
    sellQuote: null,
  };
  const known = freezeHolderAtDecision({
    decisionTime: T,
    tokenAgeS: 60,
    snapshot: {
      ...base,
      holders: field(80, T - 5_000, T - 4_000, "helius", "VALID"),
      top10Pct: field(0.22, T - 5_000, T - 4_000, "helius", "VALID"),
    },
  });
  assert.equal(known.status, "VALID");
  assert.equal(known.concentration, 0.22);
  assert.equal(known.ingestedAt, T - 4_000);
  assert.equal(known.source, "helius");
  assert.equal(known.ageMs, 4_000);

  const future = freezeHolderAtDecision({
    decisionTime: T,
    tokenAgeS: 60,
    snapshot: {
      ...base,
      holders: field(80, T + 1_000, T + 2_000, "helius", "VALID"),
      top10Pct: field(0.22, T + 1_000, T + 2_000, "helius", "VALID"),
    },
  });
  assert.equal(future.status, "UNKNOWN");
  assert.equal(future.concentration, null);

  const stale = freezeHolderAtDecision({
    decisionTime: T,
    tokenAgeS: 60,
    snapshot: {
      ...base,
      holders: field(80, T - 120_000, T - 120_000, "helius", "VALID"),
      top10Pct: field(0.22, T - 120_000, T - 120_000, "helius", "VALID"),
    },
  });
  assert.equal(stale.status, "UNKNOWN");
  assert.equal(stale.concentration, null);
  assert.equal(stale.ingestedAt, T - 120_000);
});

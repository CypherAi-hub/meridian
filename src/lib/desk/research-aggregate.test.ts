import assert from "node:assert/strict";
import { test } from "node:test";
import type { LedgerRow } from "./types.ts";
import { aggregateResearchFacts, factsFromLedger, summaryFromLedger, RESEARCH_AGGREGATE_IS_READONLY } from "./research-aggregate.ts";

function row(partial: Partial<LedgerRow> = {}): LedgerRow {
  const t0 = 1_000_000;
  return {
    decision_id: partial.decision_id ?? "d1",
    event_time: t0,
    ingested_at: t0,
    decision_time: t0,
    token: "TEST",
    tokenAddress: "Mint",
    pair_address: "Pair",
    token_age: 120,
    bucket: "new_launch",
    price: 1,
    market_cap: 100_000,
    liquidity: 50_000,
    volume_1m: 1000,
    volume_5m: 4000,
    volume_acceleration: 1.4,
    buy_sell_imbalance: 0.2,
    unique_buyers: null,
    unique_sellers: null,
    holder_count: null,
    holder_concentration: null,
    mint_auth: 0,
    freeze_auth: 0,
    entry_impact: 0.004,
    exit_impact: 0.005,
    stressed_exit: 0.03,
    momentum_score: 60,
    flow_score: 55,
    safety_score: 70,
    edge_score: 58,
    regime: "chop",
    strategy_id: "launch_velocity_pullback",
    strategy_version: "3.3.0",
    feature_engine_version: "v1.3.0",
    label_definition_version: "labels_v1",
    veto_reason_code: "test",
    route_status: "ROUTABLE",
    research_quality_score: null,
    research_grade: null,
    provider_disagreement: false,
    barrier_10_outcome: null,
    barrier_20_outcome: null,
    barrier_label_confidence: null,
    max_path_gap_seconds: null,
    avg_path_gap_seconds: null,
    path_sample_count: null,
    governor_result: "vetoed",
    veto_reason: "test",
    proposed_size: 200,
    proposed_entry: 1,
    proposed_stop: 0.9,
    trade_taken: false,
    trade_action: "veto",
    sell_quote_available: true,
    feature_sources: {},
    gates: [],
    features: {
      tokenAgeS: 120,
      bucket: "new_launch",
      ret1m: 0.02,
      rv5m: 0.04,
      volAccel: 1.4,
      usdImbalance: 0.2,
      holderGrowth5m: 0,
      top10Pct: null,
      liqChange1m: 0,
      liqMcapRatio: 0.5,
      uniqueBuyerShare: 0.5,
      mintAuth: 0,
      freezeAuth: 0,
      sellQuoteAvailable: 1,
      maxDd5m: 0.02,
      entryImpactPct: 0.004,
      exitImpactPct: 0.005,
      snapshotAgeMs: 400,
      priceDisagreement: null,
    },
    path: [],
    price_after_1m: null,
    price_after_5m: null,
    price_after_15m: null,
    price_after_30m: null,
    price_after_1h: null,
    max_gain_5m: null,
    max_gain_15m: null,
    max_gain_1h: null,
    max_drawdown_5m: null,
    max_drawdown_15m: null,
    max_drawdown_1h: null,
    hit_plus_10_before_minus_10: null,
    hit_plus_20_before_minus_10: null,
    liquidity_collapse: false,
    sell_route_lost: false,
    first_sell_route_loss_at: null,
    rug_detected: false,
    simulated_entry: null,
    simulated_exit: null,
    theoretical_return: null,
    net_execution_return: null,
    labels_complete: false,
    outcome: "open",
    ...partial,
  } as LedgerRow;
}

function assertSame(a: ReturnType<typeof summaryFromLedger>, b: ReturnType<typeof summaryFromLedger>) {
  assert.equal(a.considerations, b.considerations);
  assert.equal(a.vetoed, b.vetoed);
  assert.equal(a.authorized, b.authorized);
  assert.equal(a.taken, b.taken);
  assert.equal(a.labeled, b.labeled);
  assert.equal(a.incomplete, b.incomplete);
  assert.equal(a.errors, b.errors);
  assert.deepEqual(a.coverage, b.coverage);
  for (const k of Object.keys(a.byRegime) as Array<keyof typeof a.byRegime>) {
    assert.deepEqual(a.byRegime[k], b.byRegime[k], `regime ${k}`);
  }
  for (const k of Object.keys(a.byBucket) as Array<keyof typeof a.byBucket>) {
    assert.deepEqual(a.byBucket[k], b.byBucket[k], `bucket ${k}`);
  }
  const keys = new Set([...Object.keys(a.byStrategy), ...Object.keys(b.byStrategy)]);
  for (const k of keys) {
    const empty = { n: 0, taken: 0, labeled: 0, sum5m: 0, n5m: 0, sumNet: 0, nNet: 0 };
    assert.deepEqual(a.byStrategy[k] ?? empty, b.byStrategy[k] ?? empty, `strategy ${k}`);
  }
}

test("research aggregate is read-only and matches rebuildSummary on mixed fixtures", () => {
  assert.equal(RESEARCH_AGGREGATE_IS_READONLY, true);
  const now = 10_000_000;
  const rows = [
    row({
      decision_id: "veto",
      governor_result: "vetoed",
      trade_taken: false,
      labels_complete: false,
      regime: "chop",
      bucket: "new_launch",
      strategy_id: "launch_velocity_pullback",
    }),
    row({
      decision_id: "auth",
      governor_result: "authorized",
      trade_taken: false,
      labels_complete: false,
      regime: "trend",
      bucket: "early",
      strategy_id: "trend_continuation",
    }),
    row({
      decision_id: "take",
      governor_result: "authorized",
      trade_taken: true,
      trade_action: "take",
      labels_complete: true,
      price: 2,
      price_after_5m: 2.2,
      net_execution_return: 0.08,
      regime: "meme_mania",
      bucket: "emerging",
      strategy_id: "launch_velocity_pullback",
    }),
    row({
      decision_id: "complete",
      governor_result: "authorized",
      trade_taken: false,
      labels_complete: true,
      price: 1,
      price_after_5m: 0.9,
      net_execution_return: -0.12,
      regime: "risk_off",
      bucket: "established",
      strategy_id: "chop_mean_revert",
    }),
    row({
      decision_id: "incomplete",
      governor_result: "authorized",
      trade_taken: false,
      labels_complete: false,
      decision_time: now - 10 * 60_000,
      regime: "trend",
      bucket: "new_launch",
    }),
    row({
      decision_id: "stale",
      governor_result: "vetoed",
      trade_taken: false,
      labels_complete: false,
      decision_time: now - 80 * 60_000,
      regime: "chop",
      bucket: "mature",
    }),
    row({
      decision_id: "null-labels",
      governor_result: "authorized",
      trade_taken: false,
      labels_complete: false,
      price: null,
      price_after_5m: null,
      net_execution_return: null,
      regime: "trend",
      bucket: "unknown",
      strategy_id: "flat",
    }),
  ];
  const oldWay = summaryFromLedger(rows, now);
  const newWay = aggregateResearchFacts(factsFromLedger(rows), now);
  assertSame(oldWay, newWay);
  assert.equal(oldWay.vetoed, 2);
  assert.equal(oldWay.authorized, 5);
  assert.equal(oldWay.taken, 1);
  assert.equal(oldWay.labeled, 2);
  assert.equal(oldWay.errors, 4);
  assert.equal(oldWay.byRegime.meme_mania.n5m, 1);
  assert.ok(Math.abs(oldWay.byRegime.meme_mania.sum5m - 0.1) < 1e-9);
});

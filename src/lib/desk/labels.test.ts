import assert from "node:assert/strict";
import { test } from "node:test";
import { freezeLabels } from "./labels.ts";
import type { LedgerRow, PathTick } from "./types.ts";

function tick(ts: number, px: number, liq = 50_000, sell: 0 | 1 = 1): PathTick {
  return { ts, px, liq, sell };
}

function row(partial: Partial<LedgerRow> = {}): LedgerRow {
  const t0 = 1_000_000;
  return {
    decision_id: "d1",
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
      maxDd5m: 0.04,
      entryImpactPct: 0.004,
      exitImpactPct: 0.005,
      snapshotAgeMs: 200,
      priceDisagreement: 0.01,
    },
    path: [tick(t0, 1)],
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
    liquidity_collapse: null,
    sell_route_lost: null,
    rug_detected: null,
    simulated_entry: 1.01,
    simulated_exit: null,
    theoretical_return: null,
    net_execution_return: null,
    execution_adjusted_return: null,
    mfe_1m: null,
    mfe_30m: null,
    mae_1m: null,
    mae_30m: null,
    first_sell_route_loss_at: null,
    sell_route_restored_at: null,
    labels_complete: false,
    outcome: "not_taken",
    ...partial,
  };
}

test("plus 10 before minus 10 walks the path", () => {
  const t0 = 1_000_000;
  const labeled = freezeLabels(
    row({
      path: [tick(t0, 1), tick(t0 + 20_000, 1.12), tick(t0 + 40_000, 0.88)],
    }),
    t0 + 60_000,
  );
  assert.equal(labeled.hit_plus_10_before_minus_10, true);
  assert.equal(labeled.hit_plus_20_before_minus_10, false);
});

test("minus 10 first fails the barrier", () => {
  const t0 = 1_000_000;
  const labeled = freezeLabels(
    row({
      path: [tick(t0, 1), tick(t0 + 10_000, 0.89), tick(t0 + 20_000, 1.3)],
    }),
    t0 + 60_000,
  );
  assert.equal(labeled.hit_plus_10_before_minus_10, false);
});

test("horizon prices freeze at 1m and 5m and stay immutable", () => {
  const t0 = 1_000_000;
  const first = freezeLabels(
    row({
      path: [tick(t0, 1), tick(t0 + 60_000, 1.04), tick(t0 + 5 * 60_000, 0.97)],
    }),
    t0 + 5 * 60_000,
  );
  assert.equal(first.price_after_1m, 1.04);
  assert.equal(first.price_after_5m, 0.97);
  const later = freezeLabels(
    { ...first, path: [...first.path, tick(t0 + 6 * 60_000, 2)] },
    t0 + 6 * 60_000,
  );
  assert.equal(later.price_after_1m, 1.04);
  assert.equal(later.price_after_5m, 0.97);
});

test("liquidity collapse and lost sell route label a rug", () => {
  const t0 = 1_000_000;
  const labeled = freezeLabels(
    row({
      path: [tick(t0, 1, 50_000, 1), tick(t0 + 30_000, 0.4, 400, 0)],
    }),
    t0 + 60_000,
  );
  assert.equal(labeled.liquidity_collapse, true);
  assert.equal(labeled.sell_route_lost, true);
  assert.equal(labeled.rug_detected, true);
});

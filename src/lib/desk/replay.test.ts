import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeEdgeMonotonicity, spearman, kendallTau, edgeBucket } from "./baseline.ts";
import {
  ReplayClock,
  labelReplayConsideration,
  observationsAsOf,
  reconstructToken,
  replayConsider,
  replayStrategy,
  replayVisible,
  type ReplayObservation,
} from "./replay.ts";
import { STRATEGIES } from "./strategies.ts";
import type { LedgerRow } from "./types.ts";

function obs(partial: Partial<ReplayObservation> & { ingestedAt: number; price: number | null }): ReplayObservation {
  return {
    mint: "Mint111111111111111111111111111111111111111",
    symbol: "TEST",
    name: "Test",
    pairAddress: "Pair",
    createdAt: 1_000_000,
    eventTime: partial.eventTime ?? partial.ingestedAt,
    liquidity: 80_000,
    volume5m: 12_000,
    volume1m: 2_000,
    mcap: 400_000,
    buys5m: 40,
    sells5m: 20,
    uniqueBuyers: 30,
    uniqueSellers: 10,
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

test("replay clock refuses to go backwards and hides future ingestion", () => {
  const clock = new ReplayClock(1000);
  clock.advanceTo(2000);
  assert.equal(clock.now, 2000);
  assert.throws(() => clock.advanceTo(1500));
  const visible = replayVisible(
    [
      { ingestedAt: 500, v: 1 },
      { ingestedAt: 2500, v: 2 },
    ],
    clock.now,
  );
  assert.equal(visible.length, 1);
  assert.equal(visible[0].v, 1);
});

test("reconstructed snapshot at T cannot see a later ingested price", () => {
  const mint = "Mint111111111111111111111111111111111111111";
  const series = [
    obs({ ingestedAt: 1_000, eventTime: 1_000, price: 1.0 }),
    obs({ ingestedAt: 2_000, eventTime: 2_000, price: 1.2 }),
    obs({ ingestedAt: 4_000, eventTime: 3_000, price: 9.9 }),
  ];
  const t = 2_500;
  assert.equal(observationsAsOf(series, t).length, 2);
  const token = reconstructToken(series, mint, t);
  assert.ok(token);
  assert.equal(token.priceUsd.value, 1.2);
  assert.ok(token.priceUsd.ingestedAt <= t);
  const late = replayConsider({
    observations: series,
    mint,
    decisionTime: t,
    strategy: STRATEGIES[0],
    regime: "meme_mania",
  });
  assert.ok(late);
  assert.equal(late.price, 1.2);
  assert.equal(late.leaked, false);
  assert.equal(late.hiddenCount, 1);
});

test("a strategy that did not exist at collection time can still replay old observations", () => {
  const mint = "Mint111111111111111111111111111111111111111";
  const series = [
    obs({ ingestedAt: 1_000, price: 1.0, volume5m: 8_000 }),
    obs({ ingestedAt: 21_000, price: 1.08, volume5m: 20_000, uniqueBuyers: 80 }),
  ];
  const futureStrategy = {
    ...STRATEGIES[0],
    id: "launch_velocity_pullback" as const,
    name: "Replay-only velocity",
    thesis: "Invented after the tape was written.",
  };
  const run = replayStrategy({
    observations: series,
    strategy: futureStrategy,
    from: 1_000,
    to: 21_000,
    stepMs: 20_000,
    regime: "meme_mania",
    mints: [mint],
  });
  assert.ok(run.considerations.length >= 1);
  assert.equal(run.leakageViolations, 0);
  assert.equal(run.considerations.every((c) => c.strategyId === futureStrategy.id), true);
});

test("labels may use later market path; features may not", () => {
  const mint = "Mint111111111111111111111111111111111111111";
  const t0 = 1_000_000;
  const series = [
    obs({ ingestedAt: t0, eventTime: t0, price: 1.0 }),
    obs({ ingestedAt: t0 + 60_000, eventTime: t0 + 60_000, price: 1.04 }),
    obs({ ingestedAt: t0 + 15 * 60_000, eventTime: t0 + 15 * 60_000, price: 1.25 }),
  ];
  const considered = replayConsider({
    observations: series,
    mint,
    decisionTime: t0,
    strategy: STRATEGIES[3],
    regime: "chop",
  });
  assert.ok(considered);
  assert.equal(considered.price, 1.0);
  const labeled = labelReplayConsideration(considered, series, t0 + 60 * 60_000);
  assert.equal(labeled.price, 1.0);
  assert.equal(labeled.price_after_15m, 1.25);
  assert.ok(labeled.theoretical_return != null);
  assert.ok(Math.abs((labeled.theoretical_return as number) - 0.25) < 1e-9);
});

test("replay run reports zero leakage on a delayed observation", () => {
  const mint = "Mint111111111111111111111111111111111111111";
  const series = [
    obs({ ingestedAt: 0, eventTime: 0, price: 1 }),
    obs({ ingestedAt: 20_000, eventTime: 18_000, price: 1.01 }),
    obs({ ingestedAt: 45_000, eventTime: 30_000, price: 1.4 }),
  ];
  const run = replayStrategy({
    observations: series,
    strategy: STRATEGIES[3],
    from: 0,
    to: 40_000,
    stepMs: 20_000,
    mints: [mint],
  });
  assert.equal(run.leakageViolations, 0);
  const at20 = run.considerations.find((c) => c.decisionTime === 20_000);
  assert.ok(at20);
  assert.equal(at20.price, 1.01);
  assert.ok(at20.hiddenCount >= 1);
});

test("spearman is 1 on a perfectly ordered edge vs return series", () => {
  const rho = spearman([1, 2, 3, 4, 5], [10, 20, 30, 40, 50]);
  assert.ok(rho != null && Math.abs(rho - 1) < 1e-9);
  const tau = kendallTau([1, 2, 3, 4, 5], [10, 20, 30, 40, 50]);
  assert.ok(tau != null && Math.abs(tau - 1) < 1e-9);
});

test("edge monotonicity detects increasing bucket medians", () => {
  const mk = (edge: number, r15: number, token: string): LedgerRow =>
    ({
      tokenAddress: token,
      edge_score: edge,
      labels_complete: true,
      price: 1,
      price_after_15m: 1 + r15,
      bucket: "early",
      regime: "chop",
    }) as LedgerRow;
  const rows: LedgerRow[] = [];
  for (let i = 0; i < 12; i++) rows.push(mk(10, -0.08, `a${i}`));
  for (let i = 0; i < 12; i++) rows.push(mk(50, 0.01, `b${i}`));
  for (let i = 0; i < 12; i++) rows.push(mk(90, 0.12, `c${i}`));
  const report = analyzeEdgeMonotonicity(rows);
  assert.equal(report.verdict, "monotonic");
  assert.equal(report.weaklyIncreasingMedians, true);
  assert.ok((report.spearman15m ?? 0) > 0.5);
  assert.equal(edgeBucket(90), "80-100");
});

test("edge monotonicity is honest when the score is inverted", () => {
  const mk = (edge: number, r15: number, token: string): LedgerRow =>
    ({
      tokenAddress: token,
      edge_score: edge,
      labels_complete: true,
      price: 1,
      price_after_15m: 1 + r15,
      bucket: "early",
      regime: "chop",
    }) as LedgerRow;
  const rows: LedgerRow[] = [];
  for (let i = 0; i < 12; i++) rows.push(mk(10, 0.15, `a${i}`));
  for (let i = 0; i < 12; i++) rows.push(mk(50, 0.00, `b${i}`));
  for (let i = 0; i < 12; i++) rows.push(mk(90, -0.12, `c${i}`));
  const report = analyzeEdgeMonotonicity(rows);
  assert.equal(report.verdict, "not_monotonic");
  assert.equal(report.weaklyIncreasingMedians, false);
  assert.ok((report.spearman15m ?? 0) < 0);
});

test("monotonicity is insufficient below 30 labeled pairs", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    tokenAddress: `t${i}`,
    edge_score: i * 10,
    labels_complete: true,
    price: 1,
    price_after_15m: 1.01,
    bucket: "early",
    regime: "chop",
  })) as LedgerRow[];
  const report = analyzeEdgeMonotonicity(rows);
  assert.equal(report.verdict, "insufficient");
});

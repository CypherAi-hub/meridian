import assert from "node:assert/strict";
import { test } from "node:test";
import { AdaptiveRateBudget, parseRetryAfter, resetBudgets, budgetFor } from "./rate-budget.ts";
import {
  MERIDIAN_MIGRATIONS,
  SCHEMA_VERSION,
  evaluateNeonMigrationSteps,
  neonMigrationSteps,
  pendingMeridianMigrations,
} from "./neon-steps.ts";
import { walkForwardPurgeSplit, walkForwardSplit } from "./dataset.ts";
import { matchBaselineSafeMomentum, matchEligibleUniverse, matchRandomEligible, BASELINE_SAFE_MOMENTUM_V1 } from "./baseline-strategy.ts";
import { runDeterministicReplayBaselines, replayTapeFingerprint, universeBuyAndHold15m } from "./replay-baseline.ts";
import type { ReplayObservation } from "./replay.ts";
import { field } from "./providers/normalize.ts";
import { classifyRouteFailure, governorRoutePolicy, routeStateFromFailure } from "./routes.ts";
import type { Features, Predictions, TokenLive } from "./types.ts";

test("retry-after header becomes a millisecond cooldown", () => {
  assert.equal(parseRetryAfter("2"), 2000);
  assert.equal(parseRetryAfter(null), 0);
  const later = new Date(Date.now() + 5000).toUTCString();
  const wait = parseRetryAfter(later);
  assert.ok(wait > 1000 && wait <= 6000);
});

test("adaptive budget halves on 429, honors retry-after, then recovers additively", () => {
  resetBudgets();
  const b = new AdaptiveRateBudget(1, 0.1, 2, 0, "jupiter");
  b.onRateLimit(5_000, 0);
  assert.ok(b.rate <= 0.5 + 1e-9);
  assert.equal(b.take(1, 1000), false);
  assert.equal(b.take(1, 6_000), true);
  const before = b.rate;
  for (let i = 0; i < 8; i++) b.onSuccess(20_000);
  assert.ok(b.rate > before);
  assert.ok(b.rate <= before + b.additiveStep + 1e-9);
});

test("three 429s inside 30s trip a rate-limit storm and pin rate to min", () => {
  const b = new AdaptiveRateBudget(1, 0.1, 2, 0, "jupiter");
  b.onRateLimit(0, 0);
  b.onRateLimit(0, 1_000);
  b.onRateLimit(0, 2_000);
  assert.equal(b.storming, true);
  assert.ok(b.stormCount >= 1);
  assert.equal(b.rate, 0.1);
});

test("family budget skip is not a fake NO_ROUTE", () => {
  resetBudgets();
  const b = budgetFor("rugcheck");
  b.tokens = 0;
  b.lastRefill = Date.now();
  assert.equal(b.take(1), false);
  assert.ok(b.skipped >= 1);
  assert.equal(classifyRouteFailure("rate budget empty"), "NOT_CHECKED");
  assert.equal(governorRoutePolicy(routeStateFromFailure("NOT_CHECKED")), "UNKNOWN");
  assert.notEqual(routeStateFromFailure(classifyRouteFailure("rate budget empty")), "NO_ROUTE");
});

test("sub-1 jupiter rate can still take because burst cap is at least 1 token", () => {
  resetBudgets();
  const b = new AdaptiveRateBudget(0.3, 0.05, 0.8, 0, "jupiter-low");
  assert.equal(b.take(1, 0), true);
  assert.equal(b.take(1, 0), false);
  assert.equal(b.take(1, 4_000), true);
});

test("neon migration steps are ordered, status-aware, and 0010 is last", () => {
  const steps = neonMigrationSteps();
  assert.equal(steps.length, 6);
  assert.equal(steps[0].name, "provision");
  assert.equal(steps[4].name, "isolate");
  assert.equal(steps[5].name, "epoch");
  assert.equal(MERIDIAN_MIGRATIONS.at(-1), "0010_v33b_closure.sql");
  assert.equal(SCHEMA_VERSION, "v33b");
  assert.deepEqual(pendingMeridianMigrations(["0002_meridian.sql"]), MERIDIAN_MIGRATIONS.slice(1));
  assert.deepEqual(pendingMeridianMigrations([...MERIDIAN_MIGRATIONS]), []);

  const preview = evaluateNeonMigrationSteps({
    canonical: "pglite",
    applied: [...MERIDIAN_MIGRATIONS],
    tables: {},
    schemaVersion: null,
    soakAllowed: false,
    soakStarted: false,
  });
  // tables missing on purpose — provision is still the current preview step
  assert.equal(preview.current, "provision");
  assert.equal(preview.steps.find((s) => s.name === "epoch")?.status, "blocked");

  const tables = {
    market_observations: true,
    feature_vectors: true,
    candidate_considerations: true,
    outcome_labels: true,
    token_path_samples: true,
    token_watch_state: true,
    worker_heartbeat: true,
    collection_epochs: true,
    warehouse_metadata: true,
    rate_budget_snapshots: true,
    replay_runs: true,
    replay_experiments: true,
  };
  const neonReady = evaluateNeonMigrationSteps({
    canonical: "neon",
    applied: [...MERIDIAN_MIGRATIONS],
    tables,
    schemaVersion: "v33b",
    soakAllowed: true,
    soakStarted: false,
  });
  assert.equal(neonReady.current, "epoch");
  assert.equal(neonReady.steps.find((s) => s.name === "stamp")?.status, "done");
  assert.equal(neonReady.steps.find((s) => s.name === "isolate")?.status, "done");
});

test("walk-forward purge drops train rows whose 1h label would leak", () => {
  const rows = [
    { decision_time: 0, tokenAddress: "A" },
    { decision_time: 3_000_000, tokenAddress: "B" },
    { decision_time: 4_000_000, tokenAddress: "C" },
  ];
  const naive = walkForwardSplit(rows, 3_600_000, 5_000_000);
  const purged = walkForwardPurgeSplit(rows, 3_600_000, 5_000_000, 3_600_000);
  assert.equal(naive.train.length, 2);
  assert.equal(purged.train.length, 0);
  assert.equal(purged.test.length, 0);
});

function token(partial: Partial<TokenLive> & { liq: number; top10: number | null }): TokenLive {
  const now = 1_000;
  return {
    address: "M",
    pairAddress: "P",
    symbol: "T",
    name: "t",
    decimals: 6,
    createdAt: now - 60_000,
    priceUsd: field(1, now, now, "dexscreener"),
    priceCrossUsd: field(1, now, now, "geckoterminal"),
    liquidityUsd: field(partial.liq, now, now, "dexscreener"),
    mcapUsd: field(200_000, now, now, "dexscreener"),
    fdvUsd: field(200_000, now, now, "dexscreener"),
    volume1mUsd: field(1000, now, now, "derived"),
    volume5mUsd: field(8000, now, now, "dexscreener"),
    volume1hUsd: field(20_000, now, now, "dexscreener"),
    buys5m: field(10, now, now, "dexscreener"),
    sells5m: field(4, now, now, "dexscreener"),
    uniqueBuyers5m: field(8, now, now, "geckoterminal"),
    uniqueSellers5m: field(3, now, now, "geckoterminal"),
    holders: field(100, now, now, "rugcheck"),
    top10Pct: field(partial.top10, now, now, "rugcheck"),
    mintAuth: field(false, now, now, "solana"),
    freezeAuth: field(false, now, now, "solana"),
    buyQuote: null,
    sellQuote: null,
    history: [1],
    prevLiq: partial.liq,
    prevVolume5m: 4000,
    prevBuyers: 4,
    rugged: false,
    ...partial,
  } as TokenLive;
}

test("baseline_safe_momentum rejects missing holders and is not live-wired", () => {
  assert.ok(BASELINE_SAFE_MOMENTUM_V1.note.includes("Not live-wired"));
  const features = {
    bucket: "new_launch",
    volAccel: 2,
    top10Pct: null,
    mintAuth: 0,
    freezeAuth: 0,
    sellQuoteAvailable: 1,
  } as Features;
  const predictions = { safetyScore: 80 } as Predictions;
  assert.equal(
    matchBaselineSafeMomentum({
      token: token({ liq: 90_000, top10: null }),
      features,
      predictions,
      regime: "meme_mania",
    }),
    false,
  );
  assert.equal(
    matchBaselineSafeMomentum({
      token: token({ liq: 90_000, top10: 0.2 }),
      features: { ...features, top10Pct: 0.2, volAccel: 2 },
      predictions,
      regime: "meme_mania",
    }),
    true,
  );
  assert.equal(
    matchEligibleUniverse({
      token: token({ liq: 40_000, top10: 0.2 }),
      features: { ...features, top10Pct: 0.2 },
      predictions,
      regime: "chop",
    }),
    true,
  );
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

test("deterministic replay baselines are stable across two runs and not claimed as ML-ready", () => {
  const series = [
    obs({ ingestedAt: 1_000, price: 1 }),
    obs({ ingestedAt: 21_000, price: 1.02, volume5m: 40_000 }),
    obs({ ingestedAt: 41_000, price: 1.03 }),
    obs({ ingestedAt: 15 * 60_000 + 1_000, price: 1.1, eventTime: 15 * 60_000 + 1_000 }),
  ];
  const a = runDeterministicReplayBaselines(series, { stepMs: 20_000, mints: 4 });
  const b = runDeterministicReplayBaselines(series, { stepMs: 20_000, mints: 4 });
  assert.equal(a.tapeFingerprint, b.tapeFingerprint);
  assert.equal(a.tapeFingerprint, replayTapeFingerprint(series, a.from, a.to, a.stepMs));
  assert.equal(a.readyForModeling, false);
  assert.equal(a.leakageViolations, b.leakageViolations);
  const ids = a.strategies.map((s) => s.id);
  assert.ok(ids.includes("baseline_safe_momentum"));
  assert.ok(ids.includes("eligible_universe"));
  assert.ok(ids.includes("random_eligible"));
  assert.ok(ids.includes("safety_only"));
  assert.ok(ids.includes("launch_velocity_pullback"));
  assert.equal(a.readyForReplay, true);
  assert.equal(a.hypothesisCount, 3);
  assert.equal(a.publishedSeed, 1337);
  for (let i = 0; i < a.strategies.length; i++) {
    assert.equal(a.strategies[i].fingerprint, b.strategies[i].fingerprint);
    assert.equal(a.strategies[i].authorized, b.strategies[i].authorized);
  }
  const safe = a.strategies.find((s) => s.id === "baseline_safe_momentum");
  assert.equal(safe?.liveWired, false);
  assert.ok(a.universe.uniqueTokens >= 1);
  const uni = universeBuyAndHold15m(series);
  assert.equal(a.universe.median15m, uni.median15m);
});

test("random_eligible is deterministic for a mint+time pair", () => {
  const t = token({ liq: 40_000, top10: 0.2 });
  const features = {
    bucket: "new_launch",
    volAccel: 2,
    top10Pct: 0.2,
    mintAuth: 0,
    freezeAuth: 0,
    sellQuoteAvailable: 1,
  } as Features;
  const predictions = { safetyScore: 80 } as Predictions;
  const a = matchRandomEligible({ token: t, features, predictions, regime: "meme_mania" });
  const b = matchRandomEligible({ token: t, features, predictions, regime: "meme_mania" });
  assert.equal(a, b);
});

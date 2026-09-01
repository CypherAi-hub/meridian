import assert from "node:assert/strict";
import { test } from "node:test";
import { freezeDecisionSnapshot, insertFrozenSnapshot } from "./snapshots.ts";
import { blankSnapshot, field } from "./providers/normalize.ts";
import type { Intent } from "./types.ts";

function intent(): Intent {
  const now = 1_000_000;
  const snap = blankSnapshot("Mint", now, now);
  snap.priceUsd = field(1.1, now, now, "dexscreener");
  return {
    intentId: "d1",
    tokenAddress: "Mint",
    symbol: "TEST",
    strategyId: "launch_velocity_pullback",
    decisionTs: now,
    features: {
      tokenAgeS: 120,
      bucket: "new_launch",
      ret1m: 0.02,
      rv5m: 0.04,
      volAccel: 1.4,
      usdImbalance: 0.2,
      holderGrowth5m: 0,
      top10Pct: 0.2,
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
    featureMeta: {},
    predictions: {
      momentumScore: 60,
      flowScore: 55,
      safetyScore: 70,
      edgeScore: 58,
      pCatastrophic15m: 0.04,
      pTpBeforeSl: 0.6,
      returnQ50: 0.04,
      maeQ90: 0.08,
      mfeQ50: 0.12,
      expectedExecCostBps: 40,
      expectedNetEdgeBps: 120,
      uncertainty: 0.2,
    },
    regime: "chop",
    governor: {
      approved: true,
      reasons: [],
      reasonCodes: [],
      sizedUsd: 200,
      stressedLoss: 10,
      stressedExitPct: 0.03,
      entryImpactPct: 0.004,
      exitImpactPct: 0.005,
      unknownCount: 0,
      layers: [],
    },
    snapshot: snap,
  };
}

test("frozen decision snapshot cannot be rewritten", () => {
  const first = freezeDecisionSnapshot(intent());
  const store = new Map<string, ReturnType<typeof freezeDecisionSnapshot>>();
  assert.equal(insertFrozenSnapshot(store, "d1", first), true);
  const mutated = freezeDecisionSnapshot({ ...intent(), snapshot: { ...intent().snapshot, symbol: "HACK" } });
  assert.equal(insertFrozenSnapshot(store, "d1", mutated), false);
  assert.equal(store.get("d1")?.market.symbol, "UNK");
  assert.equal(store.get("d1")?.immutable, true);
});

test("freeze copies governor layers so later mutation does not leak", () => {
  const i = intent();
  const frozen = freezeDecisionSnapshot(i);
  i.governor.layers.push({ name: "Liquidity", status: "FAIL", reason: "later" });
  assert.equal(frozen.governor.layers.length, 0);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { brierScore, type BinaryPair } from "./v34-eval.ts";
import { brierDecomposition, expectedCalibrationError, fitHistogramCalibrator, applyCalibrator, CALIBRATOR_VERSION } from "./v34-calibrate.ts";
import { walkForwardEvaluate } from "./v34-walkforward.ts";
import { baseRateOf, compareToBaselines } from "./v34-baselines.ts";
import { freezePrediction, labelPrediction } from "./v34-ledger.ts";
import { runShadowInference } from "./v34-shadow-runtime.ts";
import { modelScorecard } from "./v34-scorecard.ts";
import { evaluateKillConditions } from "./v34-kill.ts";
import { evaluatePromotion } from "./v34-promote-eval.ts";
import { monitorDrift } from "./v34-monitor.ts";
import { runSyntheticTournament } from "./v34-tournament.ts";
import { trainModel } from "./v34-model.ts";
import { PRODUCTION_EPOCH, V34_PREP_VERSION } from "./v34-lock.ts";
import type { FeatureMatrixRow } from "./v34-matrix.ts";
import type { ProbabilityPrediction } from "./v34-model.ts";

function pred(p: number, key = "k"): ProbabilityPrediction {
  return {
    modelId: "m",
    modelVersion: "1",
    decisionKey: key,
    predictedAt: 1,
    pUp10: p,
    pRug: 1 - p,
    pHorizonRetPositive: p,
  };
}

test("brier decomposition and ECE are honest; calibrator is versioned", () => {
  const perfect: BinaryPair[] = [
    { p: 0, y: 0 },
    { p: 0, y: 0 },
    { p: 1, y: 1 },
    { p: 1, y: 1 },
    { p: 0.5, y: 0 },
    { p: 0.5, y: 1 },
  ];
  const decomp = brierDecomposition(perfect, 10);
  assert.ok(decomp);
  assert.ok(Math.abs(decomp.brier - (decomp.reliability - decomp.resolution + decomp.uncertainty)) < 1e-9);
  assert.ok((expectedCalibrationError(perfect, 10) ?? 1) < 0.05);
  const cal = fitHistogramCalibrator(perfect, 10);
  assert.equal(cal.version, CALIBRATOR_VERSION);
  const applied = applyCalibrator([{ p: 0.91, y: 1 }], cal);
  assert.ok(applied[0].p >= 0 && applied[0].p <= 1);
});

test("walk-forward reports the worst fold instead of hiding it", () => {
  const report = walkForwardEvaluate([
    { name: "a", pairs: [{ p: 0.9, y: 1 }, { p: 0.1, y: 0 }] },
    { name: "b", pairs: [{ p: 0.9, y: 0 }, { p: 0.9, y: 0 }, { p: 0.8, y: 0 }] },
  ]);
  assert.equal(report.nFolds, 2);
  assert.ok((report.worstBrier ?? 0) > (report.bestBrier ?? 1));
  assert.equal(report.hiddenByBestFold, true);
});

test("base-rate beats a high-accuracy always-positive model on imbalanced labels", () => {
  const y: BinaryPair[] = [
    ...Array.from({ length: 72 }, () => ({ p: 1, y: 1 as const })),
    ...Array.from({ length: 28 }, () => ({ p: 1, y: 0 as const })),
  ];
  const acc = y.filter((r) => (r.p >= 0.5 ? 1 : 0) === r.y).length / y.length;
  assert.equal(acc, 0.72);
  const always = brierScore(y);
  const rate = baseRateOf(y.map((r) => ({ p: 0, y: r.y })));
  assert.ok(Math.abs(rate - 0.72) < 1e-9);
  const base = brierScore(y.map((r) => ({ p: rate, y: r.y })));
  assert.ok(base != null && always != null && base < always);
});

test("prediction ledger freezes probabilities; labels attach later", () => {
  const frozen = freezePrediction(pred(0.42, "A:1"), "id1");
  const labeled = labelPrediction(frozen, 1, 99);
  assert.equal(labeled.pUp10, 0.42);
  assert.equal(labeled.yUp10, 1);
  assert.equal(labeled.usedForCapital, false);
});

test("shadow runtime cannot mutate governor or place orders", () => {
  const out = runShadowInference(
    {
      modelId: "m",
      modelVersion: "1",
      predict: () => ({ pUp10: 0.3, pRug: 0.1, pHorizonRetPositive: 0.4 }),
    },
    [{ decisionKey: "A:1", predictedAt: 1, features: { ret1m: 0.01 } }],
  );
  assert.equal(out.mutatedGovernor, false);
  assert.equal(out.placedOrder, false);
  assert.equal(out.ledger[0].frozen, true);
});

test("scorecard, kill, and promotion never grant capital authority", () => {
  const pairs: BinaryPair[] = [
    { p: 0.8, y: 1 },
    { p: 0.2, y: 0 },
    { p: 0.7, y: 1 },
  ];
  const card = modelScorecard(pairs, { attempted: 4, minN: 2 });
  assert.equal(card.coverage, 0.75);
  assert.ok(card.ece != null);
  const kill = evaluateKillConditions({ ece: 0.4, schemaMatch: false, coverage: 0.2, leakage: true });
  assert.equal(kill.suspend, true);
  assert.ok(kill.reasons.includes("FEATURE_SCHEMA_MISMATCH"));
  const held = evaluatePromotion({ n: 3, brier: 0.3, baseRateBrier: 0.2, beatsBaseRate: false, kill: { suspend: false, reasons: [] } });
  assert.equal(held.advice, "HOLD");
  assert.equal(held.capitalAuthority, false);
  const demote = evaluatePromotion({ n: 40, brier: 0.1, kill });
  assert.equal(demote.advice, "DEMOTE");
  assert.equal(demote.capitalAuthority, false);
});

test("drift monitor flags schema mismatch via expected hash and mean shift", () => {
  const mk = (v: number, i: number): FeatureMatrixRow => ({
    decisionKey: `k${i}`,
    tokenAddress: "T",
    decisionTime: i,
    features: { ret1m: v },
    labels: { hit10: 1, hit20: 0, ret15m: 0, rug: 0 },
  });
  const base = Array.from({ length: 30 }, (_, i) => mk(0.01, i));
  const cur = Array.from({ length: 30 }, (_, i) => mk(0.9, i));
  const mon = monitorDrift(base, cur, { expectedSchemaHash: "nope" });
  assert.equal(mon.schemaMatch, false);
  assert.ok(mon.meanShift.includes("ret1m") || mon.unseenRanges.includes("ret1m"));
});

test("synthetic tournament runs the lifecycle without production data or capital", () => {
  const t = runSyntheticTournament({ n: 120, seed: 1337 });
  assert.equal(t.usedProductionCorpus, false);
  assert.equal(t.shadowMutatedGovernor, false);
  assert.equal(t.capitalAuthority, false);
  assert.equal(t.logistic.status, "CANDIDATE");
  assert.equal(t.logistic.usedForCapital, false);
  assert.equal(t.promotion.capitalAuthority, false);
  assert.equal(t.walkForward.nFolds, 4);
  assert.ok(t.scorecard.n > 0);
  assert.throws(() => trainModel(), /ML_TRAINING_LOCKED/);
  assert.notEqual(V34_PREP_VERSION.includes("production"), true);
  assert.notEqual(PRODUCTION_EPOCH, "synthetic");
});

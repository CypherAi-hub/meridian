import assert from "node:assert/strict";
import { test } from "node:test";
import { FEATURE_ENGINE_VERSION, LABEL_DEFINITION_VERSION } from "./versions.ts";
import { emptyQuality, type Features, type LedgerRow } from "./types.ts";
import { ML_TRAINING_LOCKED, canTrain, assertTrainingLocked, trainingUnlockReasons, PRODUCTION_EPOCH } from "./v34-lock.ts";
import { buildDataset, defaultDatasetRequest, type DatasetSourceRow } from "./v34-dataset.ts";
import { purgedEmbargoTokenSplit } from "./v34-splits.ts";
import { toFeatureMatrix, matrixToJsonl } from "./v34-matrix.ts";
import { assertProbabilityContract, registerModel, trainModel, type ProbabilityPrediction } from "./v34-model.ts";
import { brierScore, logLoss, rocAuc, evaluateProbabilities } from "./v34-eval.ts";
import { recordShadow, compareChampionChallenger, leaderboard } from "./v34-shadow.ts";
import { driftReport } from "./v34-drift.ts";
import { evaluateProductionAlerts } from "./v34-alerts.ts";
import { V34_PREP_MIGRATIONS } from "./neon-steps.ts";

const HOUR = 60 * 60_000;

function features(): Features {
  return {
    tokenAgeS: 120,
    bucket: "new_launch",
    ret1m: 0.02,
    rv5m: 0.01,
    volAccel: 1.2,
    usdImbalance: 0.1,
    holderGrowth5m: 0.05,
    top10Pct: 0.2,
    liqChange1m: 0.01,
    liqMcapRatio: 0.1,
    uniqueBuyerShare: 0.6,
    mintAuth: 0,
    freezeAuth: 0,
    sellQuoteAvailable: 1,
    maxDd5m: 0.04,
    entryImpactPct: 0.01,
    exitImpactPct: 0.02,
    snapshotAgeMs: 400,
    priceDisagreement: 0.001,
  };
}

function row(
  partial: Partial<LedgerRow> & { tokenAddress: string; decision_time: number; collection_epoch_id?: string },
): DatasetSourceRow {
  const { tokenAddress, decision_time, collection_epoch_id, ...rest } = partial;
  return {
    decision_id: `${tokenAddress}:${decision_time}`,
    tokenAddress,
    symbol: "X",
    decision_time,
    ingested_at: decision_time,
    collection_epoch_id: collection_epoch_id ?? PRODUCTION_EPOCH,
    labels_complete: true,
    research_quality_score: 90,
    research_grade: "TRAINING_GRADE_A",
    barrier_label_confidence: "HIGH",
    feature_engine_version: FEATURE_ENGINE_VERSION,
    label_definition_version: LABEL_DEFINITION_VERSION,
    strategy_id: "launch_velocity_pullback",
    strategy_version: "1",
    governor_result: "authorized",
    veto_reason: "",
    veto_reason_code: "",
    proposed_size: 100,
    proposed_entry: 1,
    proposed_stop: 0.9,
    trade_taken: false,
    trade_action: "ignore",
    sell_quote_available: true,
    route_status: "ROUTABLE",
    feature_sources: {},
    features: features(),
    gates: [],
    path: [],
    hit_plus_10_before_minus_10: true,
    hit_plus_20_before_minus_10: false,
    theoretical_return: 0.12,
    rug_detected: false,
    provider_disagreement: false,
    outcome: "open",
    regime: "trend",
    bucket: "new_launch",
    ...rest,
  } as DatasetSourceRow;
}

test("training is locked even when quality looks healthy", () => {
  assert.equal(ML_TRAINING_LOCKED, true);
  assert.equal(canTrain(emptyQuality()), false);
  assert.throws(() => assertTrainingLocked(), /ML_TRAINING_LOCKED/);
  assert.throws(() => trainModel(), /ML_TRAINING_LOCKED/);
  const q = emptyQuality();
  q.productionSoakStartedAtMs = Date.now();
  assert.ok(trainingUnlockReasons(q).some((r) => /LOCKED|soak|holder/i.test(r)));
});

test("dataset builder keeps only v33b_production Grade A/B HIGH/MEDIUM matching versions", () => {
  const rows = [
    row({ tokenAddress: "A", decision_time: 1_000 }),
    row({ tokenAddress: "B", decision_time: 2_000, collection_epoch_id: "v33b_preview" }),
    row({ tokenAddress: "C", decision_time: 3_000, research_grade: "RESEARCH_ONLY" }),
    row({ tokenAddress: "D", decision_time: 4_000, barrier_label_confidence: "LOW" }),
    row({ tokenAddress: "E", decision_time: 5_000, labels_complete: false }),
    row({ tokenAddress: "F", decision_time: 6_000, feature_engine_version: "old" }),
  ];
  const { manifest, rows: kept } = buildDataset(rows);
  assert.equal(manifest.request.epoch, PRODUCTION_EPOCH);
  assert.equal(manifest.trainingAllowed, false);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].tokenAddress, "A");
  assert.ok(manifest.dropped.wrongEpoch >= 1);
  assert.ok(manifest.dropped.lowGrade >= 1);
  assert.equal(defaultDatasetRequest().confidence.join(","), "HIGH,MEDIUM");
});

test("purged embargo token split never leaks a mint across folds", () => {
  const rows = [
    row({ tokenAddress: "OLD", decision_time: 1 * HOUR }),
    row({ tokenAddress: "OLD", decision_time: 2 * HOUR }),
    row({ tokenAddress: "MID", decision_time: 12 * HOUR }),
    row({ tokenAddress: "NEW", decision_time: 30 * HOUR }),
  ];
  const split = purgedEmbargoTokenSplit(rows, {
    trainEnd: 8 * HOUR,
    validationEnd: 20 * HOUR,
    horizonMs: HOUR,
    embargoMs: HOUR,
  });
  assert.deepEqual(split.leakedTokens, []);
  const mints = (xs: typeof rows) => new Set(xs.map((r) => r.tokenAddress));
  const train = mints(split.train);
  const val = mints(split.validation);
  const test = mints(split.test);
  for (const a of train) assert.equal(val.has(a) || test.has(a), false);
  for (const a of val) assert.equal(test.has(a), false);
  assert.ok(train.has("OLD"));
  assert.ok(test.has("NEW"));
});

test("feature matrix is point-in-time columns plus labels, exportable as jsonl", () => {
  const { rows } = buildDataset([row({ tokenAddress: "A", decision_time: 1_000 })]);
  const matrix = toFeatureMatrix(rows);
  assert.ok(matrix.columns.includes("ret1m"));
  assert.equal(matrix.rows[0].labels.hit10, 1);
  assert.ok(matrixToJsonl(matrix).includes('"tokenAddress":"A"'));
});

test("prediction contract is probabilities, never BUY/SELL", () => {
  const ok: ProbabilityPrediction = {
    modelId: "shadow",
    modelVersion: "0",
    decisionKey: "A:1",
    predictedAt: 1,
    pUp10: 0.4,
    pRug: 0.1,
    pHorizonRetPositive: 0.55,
  };
  assertProbabilityContract(ok);
  assert.throws(
    () => assertProbabilityContract({ ...ok, pUp10: 1.4 }),
    /PREDICTION_CONTRACT/,
  );
  assert.throws(
    () => assertProbabilityContract({ ...ok, side: "BUY" } as ProbabilityPrediction),
    /BUY\/SELL/,
  );
});

test("eval metrics: perfect ranking and honest 0.5 brier", () => {
  const perfect = evaluateProbabilities([
    { p: 0.9, y: 1 },
    { p: 0.1, y: 0 },
  ]);
  assert.equal(perfect.rocAuc, 1);
  assert.ok((perfect.brier ?? 1) < 0.05);
  const half = brierScore([
    { p: 0.5, y: 1 },
    { p: 0.5, y: 0 },
  ]);
  assert.equal(half, 0.25);
  assert.ok((logLoss([{ p: 0.5, y: 1 }]) ?? 0) > 0);
  assert.equal(rocAuc([{ p: 0.2, y: 1 }]), null);
});

test("shadow inference cannot control capital; champion compares on brier", () => {
  const pred = recordShadow(
    {
      modelId: "m1",
      modelVersion: "1",
      decisionKey: "A:1",
      predictedAt: 1,
      pUp10: 0.7,
      pRug: 0.05,
      pHorizonRetPositive: 0.6,
    },
    1,
  );
  assert.equal(pred.usedForCapital, false);
  const a = registerModel({
    modelId: "champ",
    version: "1",
    featureSet: "v1.3.0",
    featureSchemaHash: "x",
    trainingWindow: null,
    datasetHash: null,
    metrics: evaluateProbabilities([{ p: 0.2, y: 1 }]),
  });
  const b = registerModel({
    modelId: "chal",
    version: "1",
    featureSet: "v1.3.0",
    featureSchemaHash: "x",
    trainingWindow: null,
    datasetHash: null,
    metrics: evaluateProbabilities([{ p: 0.9, y: 1 }]),
    status: "challenger",
  });
  const cmp = compareChampionChallenger(a, b);
  assert.equal(cmp.winner, "challenger");
  assert.equal(leaderboard([a, b])[0].modelId, "chal");
});

test("drift report flags a large mean shift only when n is sufficient", () => {
  const base = Array.from({ length: 40 }, (_, i) => ({
    decisionKey: `b${i}`,
    tokenAddress: "T",
    decisionTime: i,
    features: { ret1m: 0.01 },
    labels: { hit10: 1, hit20: 0, ret15m: 0.1, rug: 0 },
  }));
  const cur = Array.from({ length: 40 }, (_, i) => ({
    decisionKey: `c${i}`,
    tokenAddress: "T",
    decisionTime: i,
    features: { ret1m: 0.5 },
    labels: { hit10: 1, hit20: 0, ret15m: 0.1, rug: 0 },
  }));
  const report = driftReport(base, cur, { minN: 30, absDelta: 0.2 });
  assert.ok(report.shifted.includes("ret1m"));
  const tiny = driftReport(base.slice(0, 2), cur.slice(0, 2), { minN: 30, absDelta: 0.2 });
  assert.deepEqual(tiny.shifted, []);
});

test("production alerts fire on dead worker, missing lease, stale tick, coverage collapse", () => {
  const now = 1_000_000;
  const alerts = evaluateProductionAlerts({
    now,
    workerStatus: "offline",
    leaseExpiresAtMs: null,
    lastTickAtMs: now - 200_000,
    holderAtDecisionPct: 0.01,
    routeCheckPct: 0.01,
    activeMedianGapMs: 20_000,
    soakIncidentOpen: true,
  });
  const codes = alerts.map((a) => a.code);
  assert.ok(codes.includes("WORKER_DOWN"));
  assert.ok(codes.includes("LEASE_MISSING"));
  assert.ok(codes.includes("TICK_STALE"));
  assert.ok(codes.includes("HOLDER_COVERAGE_COLLAPSE"));
  assert.ok(codes.includes("PATH_GAP_BLOWOUT"));
  assert.ok(codes.includes("SOAK_INCIDENT"));
  const healthy = evaluateProductionAlerts({
    now,
    workerStatus: "live",
    leaseExpiresAtMs: now + 25_000,
    lastTickAtMs: now - 5_000,
    holderAtDecisionPct: 0.5,
    routeCheckPct: 0.5,
    activeMedianGapMs: 3_000,
  });
  assert.deepEqual(healthy, []);
});

test("v34-prep migration is additive and not part of the frozen v33b collection list", () => {
  assert.deepEqual(V34_PREP_MIGRATIONS, ["0011_v34_prep.sql"]);
});

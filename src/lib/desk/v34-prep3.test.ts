import assert from "node:assert/strict";
import { test } from "node:test";
import { brierScore } from "./v34-eval.ts";
import { preregisterExperiment, mutatePreregistration } from "./v34-preregister.ts";
import { createHoldoutVault, hideHoldout, peekHoldout, unlockHoldout } from "./v34-holdout.ts";
import { createTrialLedger, registerTrial, disclosedWinner } from "./v34-trials.ts";
import { tokenClusterBootstrap } from "./v34-bootstrap.ts";
import { economicEvaluate, stressMatrix, capacityCurve, BASE_COSTS } from "./v34-economic.ts";
import { regimeRobustness, probabilityMonotonicity } from "./v34-regime.ts";
import { evaluatePromotionContract } from "./v34-contract.ts";
import { buildReproBundle, sameRepro } from "./v34-repro.ts";
import { writeModelCard } from "./v34-card.ts";
import { freezeTrainingManifest } from "./v34-manifest.ts";
import { buildDataset } from "./v34-dataset.ts";
import { purgedEmbargoTokenSplit } from "./v34-splits.ts";
import { createTrainingJob, registerArtifact } from "./v34-job.ts";
import { trainModel } from "./v34-model.ts";
import { PRODUCTION_EPOCH, V34_PREP_VERSION } from "./v34-lock.ts";
import { FEATURE_ENGINE_VERSION, LABEL_DEFINITION_VERSION, FEATURE_SCHEMA } from "./versions.ts";
import type { Features, LedgerRow } from "./types.ts";
import type { DatasetSourceRow } from "./v34-dataset.ts";

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
  tokenAddress: string,
  decision_time: number,
  rest: Partial<LedgerRow> = {},
): DatasetSourceRow {
  return {
    decision_id: `${tokenAddress}:${decision_time}`,
    tokenAddress,
    symbol: "X",
    decision_time,
    ingested_at: decision_time,
    collection_epoch_id: PRODUCTION_EPOCH,
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

const thresholds = {
  maxBrier: 0.25,
  maxEce: 0.12,
  maxWorstFoldBrier: 0.3,
  maxTailLoss: 0.5,
  minCoverage: 0.7,
  minEconomicExpectancy: 0,
  minN: 10,
};

test("preregistration is frozen and train remains locked", () => {
  const p = preregisterExperiment({
    experimentId: "exp1",
    target: "hit10",
    featureSet: FEATURE_SCHEMA.fields,
    hyperSearch: { lr: [0.1, 0.3] },
    splits: { trainEnd: 10, validationEnd: 20, holdoutStart: 20 },
    primaryMetric: "brier",
    promotionThresholds: thresholds,
    failureCriteria: ["ece>0.12", "holdout worse than base-rate"],
  });
  assert.equal(p.trainingAllowed, false);
  assert.ok(p.hash.length > 8);
  assert.throws(() => mutatePreregistration(p), /PREREG_FROZEN/);
  assert.throws(() => trainModel(), /ML_TRAINING_LOCKED/);
});

test("holdout vault hides the test period and unlocks once", () => {
  const vault = createHoldoutVault(20, 40);
  const rows = [
    { decision_time: 5, id: "a" },
    { decision_time: 25, id: "hold" },
    { decision_time: 50, id: "c" },
  ];
  assert.deepEqual(hideHoldout(rows, vault).map((r) => r.id), ["a", "c"]);
  assert.throws(() => peekHoldout(rows, vault), /HOLDOUT_LOCKED/);
  const open = unlockHoldout(vault);
  assert.equal(open.unlockCount, 1);
  assert.equal(peekHoldout(rows, open)[0].id, "hold");
  assert.throws(() => unlockHoldout(open), /HOLDOUT_ALREADY_UNLOCKED/);
});

test("multiple-testing ledger refuses to present the winner as hypothesis #1", () => {
  let ledger = createTrialLedger("exp1");
  ledger = registerTrial(ledger, { lr: 0.1 }, 0.3);
  ledger = registerTrial(ledger, { lr: 0.2 }, 0.21);
  ledger = registerTrial(ledger, { lr: 0.3 }, 0.28);
  const w = disclosedWinner(ledger);
  assert.equal(w.nTried, 3);
  assert.equal(w.winner?.trial, 2);
  assert.ok(w.note.includes("of 3"));
});

test("token-cluster bootstrap does not treat one coin as 100 independent samples", () => {
  const oneCoin = Array.from({ length: 100 }, () => ({ tokenAddress: "ONLY", value: 1 }));
  const many = Array.from({ length: 100 }, (_, i) => ({ tokenAddress: `t${i}`, value: i % 2 }));
  const a = tokenClusterBootstrap(oneCoin, { draws: 50, seed: 1 });
  const b = tokenClusterBootstrap(many, { draws: 50, seed: 1 });
  assert.equal(a.nTokens, 1);
  assert.equal(a.nObs, 100);
  assert.equal(b.nTokens, 100);
  assert.ok(b.ciHigh - b.ciLow > a.ciHigh - a.ciLow || a.nTokens === 1);
});

test("economic evaluator, stress matrix, and capacity curve never size capital", () => {
  const rows = [
    { p: 0.8, y: 1 as const, tokenAddress: "A", notional: 20, impactBps: 10 },
    { p: 0.8, y: 0 as const, tokenAddress: "B", notional: 20, impactBps: 10, routeLost: true },
  ];
  const ev = economicEvaluate(rows, BASE_COSTS);
  assert.equal(ev.sizedCapital, false);
  const stress = stressMatrix(rows);
  assert.ok(stress.latency_x5.costs >= stress.base.costs);
  assert.ok(Math.abs(stress.liq_m50.gross) <= Math.abs(stress.base.gross) + 1e-9);
  const cap = capacityCurve(rows, [20, 200, 2000]);
  assert.equal(cap.length, 3);
  assert.ok(cap[2].notional === 2000);
});

test("regime robustness flags a catastrophe hidden by the overall score", () => {
  const rows = [
    ...Array.from({ length: 40 }, () => ({ p: 0.2, y: 0 as const, regime: "trend" as const })),
    ...Array.from({ length: 20 }, () => ({ p: 0.9, y: 0 as const, regime: "risk_off" as const })),
  ];
  const r = regimeRobustness(rows, { minN: 10, catastropheBrier: 0.3 });
  assert.equal(r.concealedCatastrophe, true);
  const mono = probabilityMonotonicity([
    { p: 0.6, y: 0 },
    { p: 0.6, y: 1 },
    { p: 0.8, y: 1 },
    { p: 0.8, y: 1 },
  ]);
  assert.equal(mono.monotonic, true);
  const broken = probabilityMonotonicity([
    { p: 0.6, y: 1 },
    { p: 0.6, y: 1 },
    { p: 0.8, y: 0 },
    { p: 0.8, y: 0 },
  ]);
  assert.equal(broken.monotonic, false);
});

test("promotion contract must pass before holdout unlock; capital stays false", () => {
  const prereg = preregisterExperiment({
    experimentId: "exp1",
    target: "hit10",
    featureSet: ["ret1m"],
    hyperSearch: {},
    splits: { trainEnd: 1, validationEnd: 2, holdoutStart: 2 },
    primaryMetric: "brier",
    promotionThresholds: thresholds,
    failureCriteria: [],
  });
  const vault = createHoldoutVault(2, 3);
  const fail = evaluatePromotionContract(prereg, {
    brier: 0.4,
    ece: 0.2,
    worstFoldBrier: 0.5,
    tailLoss: 0.9,
    coverage: 0.2,
    expectancy: -1,
    n: 2,
    monotonic: false,
    concealedCatastrophe: true,
    nTried: 3,
  }, vault);
  assert.equal(fail.eligibleToUnlockHoldout, false);
  assert.equal(fail.capitalAuthority, false);
  const pass = evaluatePromotionContract(prereg, {
    brier: 0.1,
    ece: 0.05,
    worstFoldBrier: 0.12,
    tailLoss: 0.1,
    coverage: 0.9,
    expectancy: 1,
    n: 40,
    monotonic: true,
    concealedCatastrophe: false,
    nTried: 2,
  }, vault);
  assert.equal(pass.eligibleToUnlockHoldout, true);
  assert.equal(pass.capitalAuthority, false);
});

test("repro bundle is deterministic and model card records reject vs holdout", () => {
  const built = buildDataset([row("OLD", 1 * HOUR), row("NEW", 30 * HOUR)]);
  const splits = purgedEmbargoTokenSplit(built.rows, { trainEnd: 8 * HOUR, validationEnd: 20 * HOUR });
  const manifest = freezeTrainingManifest({
    rows: built.rows,
    dataset: built.manifest,
    splits,
    trainEnd: 8 * HOUR,
    validationEnd: 20 * HOUR,
    codeCommit: "abc",
  });
  const prereg = preregisterExperiment({
    experimentId: "exp1",
    target: "hit10",
    featureSet: FEATURE_SCHEMA.fields,
    hyperSearch: {},
    splits: { trainEnd: 8 * HOUR, validationEnd: 20 * HOUR, holdoutStart: 20 * HOUR },
    primaryMetric: "brier",
    promotionThresholds: thresholds,
    failureCriteria: [],
  });
  const job = createTrainingJob(manifest, { algorithm: "logistic_regression", seed: 1337, target: "hit10" });
  const artifact = registerArtifact({
    modelId: "m17",
    version: "1",
    datasetHash: manifest.datasetHash,
    jobHash: job.jobHash,
    featureList: FEATURE_SCHEMA.fields,
    metrics: null,
    calibration: null,
    commitSha: "abc",
    trainedAt: 1,
    seed: 1337,
  });
  const a = buildReproBundle({ prereg, manifest, job, artifact });
  const b = buildReproBundle({ prereg, manifest, job, artifact });
  assert.equal(sameRepro(a, b), true);
  assert.ok(a.reconstructs.includes("promotion_recommendation"));
  const vault = createHoldoutVault(20 * HOUR, 40 * HOUR);
  const contract = evaluatePromotionContract(prereg, {
    brier: 0.4,
    ece: 0.2,
    worstFoldBrier: 0.5,
    tailLoss: 0.9,
    coverage: 0.1,
    expectancy: -2,
    n: 3,
    monotonic: false,
    concealedCatastrophe: true,
    nTried: 17,
  }, vault);
  const card = writeModelCard({
    artifact,
    prereg,
    trials: registerTrial(createTrialLedger("exp1"), { i: 17 }, 0.1),
    bootstrap: tokenClusterBootstrap([{ tokenAddress: "OLD", value: 1 }]),
    economic: economicEvaluate([], BASE_COSTS),
    regime: regimeRobustness([]),
    mono: probabilityMonotonicity([]),
    contract,
    vault,
  });
  assert.equal(card.decision, "rejected");
  assert.equal(card.capitalAuthority, false);
  assert.equal(card.holdoutUnlocked, false);
  assert.ok(card.why.includes("failed"));
  assert.equal(V34_PREP_VERSION, "v34-prep.3");
});

test("model 17 can look great in validation and still fail the untouched holdout", () => {
  const vault = createHoldoutVault(100, 200);
  const rows = [
    { decision_time: 10, p: 0.9, y: 1 as const },
    { decision_time: 20, p: 0.1, y: 0 as const },
    { decision_time: 150, p: 0.9, y: 0 as const },
    { decision_time: 160, p: 0.85, y: 0 as const },
  ];
  assert.throws(() => peekHoldout(rows, vault), /HOLDOUT_LOCKED/);
  const open = unlockHoldout(vault);
  const hold = peekHoldout(rows, open);
  const val = brierScore(rows.filter((r) => r.decision_time < 100).map((r) => ({ p: r.p, y: r.y })));
  const holdBrier = brierScore(hold.map((r) => ({ p: r.p, y: r.y })));
  assert.ok(val != null && holdBrier != null && holdBrier > val);
  assert.throws(() => unlockHoldout(open), /HOLDOUT_ALREADY_UNLOCKED/);
  assert.equal(open.unlockCount, 1);
});


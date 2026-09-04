import assert from "node:assert/strict";
import { test } from "node:test";
import { FEATURE_ENGINE_VERSION, LABEL_DEFINITION_VERSION } from "./versions.ts";
import { emptyQuality, type Features, type LedgerRow } from "./types.ts";
import { PRODUCTION_EPOCH, ML_TRAINING_LOCKED } from "./v34-lock.ts";
import { buildDataset, type DatasetSourceRow } from "./v34-dataset.ts";
import { purgedEmbargoTokenSplit } from "./v34-splits.ts";
import { toFeatureMatrix } from "./v34-matrix.ts";
import { certifyCorpus, formatCertification } from "./v34-certify.ts";
import { freezeTrainingManifest } from "./v34-manifest.ts";
import { missingnessAudit, featureDistributionAudit, targetBalanceAudit, splitReport } from "./v34-audit.ts";
import { createTrainingJob, runTrainingJob, promote, promoteArtifact, registerArtifact } from "./v34-job.ts";
import { rowLeakage } from "./v34-leakage.ts";
import { runSyntheticLogistic, assertSyntheticOnly } from "./v34-harness.ts";
import { trainModel } from "./v34-model.ts";

const HOUR = 60 * 60_000;

function features(over: Partial<Features> = {}): Features {
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
    ...over,
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

function readyQuality(): ReturnType<typeof emptyQuality> {
  const q = emptyQuality();
  q.collectionEpoch = PRODUCTION_EPOCH;
  q.productionSoakStartedAtMs = Date.now() - 73 * 3_600_000;
  q.epochUniqueTokens = 600;
  q.holderCoverageAtDecisionPct = 0.85;
  q.epochRouteCheckCoveragePct = 0.95;
  q.epochHighConfidencePct = 0.5;
  q.epochMediumConfidencePct = 0.2;
  q.epochGradeA = 40;
  q.epochGradeB = 20;
  q.epochGradeC = 10;
  q.epochResearchOnly = 10;
  return q;
}

test("certification is NOT READY on the live soak and READY only when every gate passes", () => {
  const cold = certifyCorpus(emptyQuality(), { leakedTokens: 0, eligibleRows: 0 });
  assert.equal(cold.status, "NOT READY");
  assert.equal(cold.training, "LOCKED");
  assert.ok(cold.gates.some((g) => g.name === "SOAK" && !g.pass));
  const hot = certifyCorpus(readyQuality(), { leakedTokens: 0, eligibleRows: 80, uniqueTokens: 600 });
  assert.equal(hot.status, "READY");
  assert.equal(hot.training, "LOCKED");
  assert.ok(formatCertification(hot).includes("READY"));
  const leaky = certifyCorpus(readyQuality(), { leakedTokens: 2, eligibleRows: 80, uniqueTokens: 600 });
  assert.equal(leaky.status, "NOT READY");
});

test("frozen manifest hashes ids, versions, splits, commit; train still locked", () => {
  const rows = [
    row({ tokenAddress: "OLD", decision_time: 1 * HOUR }),
    row({ tokenAddress: "NEW", decision_time: 30 * HOUR }),
  ];
  const built = buildDataset(rows);
  const splits = purgedEmbargoTokenSplit(built.rows, { trainEnd: 8 * HOUR, validationEnd: 20 * HOUR });
  const a = freezeTrainingManifest({
    rows: built.rows,
    dataset: built.manifest,
    splits,
    trainEnd: 8 * HOUR,
    validationEnd: 20 * HOUR,
    codeCommit: "abc123",
  });
  const b = freezeTrainingManifest({
    rows: built.rows,
    dataset: built.manifest,
    splits,
    trainEnd: 8 * HOUR,
    validationEnd: 20 * HOUR,
    codeCommit: "abc123",
  });
  assert.equal(a.hash, b.hash);
  assert.equal(a.trainingAllowed, false);
  assert.equal(a.featureEngineVersion, FEATURE_ENGINE_VERSION);
  assert.ok(a.observationIds.includes("OLD:3600000"));
  const job = createTrainingJob(a, { algorithm: "logistic_regression", seed: 1337, target: "hit10" });
  const job2 = createTrainingJob(a, { algorithm: "logistic_regression", seed: 1337, target: "hit10" });
  assert.equal(job.jobHash, job2.jobHash);
  assert.equal(job.trainingAllowed, false);
  assert.throws(() => runTrainingJob(job), /ML_TRAINING_LOCKED/);
  assert.throws(() => trainModel(), /ML_TRAINING_LOCKED/);
});

test("adversarial leakage is rejected by DatasetBuilder", () => {
  const future = row({
    tokenAddress: "FUT",
    decision_time: 10_000,
    feature_sources: {
      price: { source: "birdeye", eventTime: 20_000, ingestedAt: 20_000, lagMs: 0 },
    },
  });
  const holder = row({
    tokenAddress: "HLD",
    decision_time: 10_000,
    holder_ingested_at: 50_000,
  });
  const badTs = row({ tokenAddress: "BAD", decision_time: 0 });
  assert.deepEqual(rowLeakage(future), ["future_field"]);
  assert.deepEqual(rowLeakage(holder), ["post_decision_holder"]);
  assert.ok(rowLeakage(badTs).includes("bad_timestamp"));
  const { manifest, rows } = buildDataset([
    row({ tokenAddress: "OK", decision_time: 10_000 }),
    future,
    holder,
    badTs,
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tokenAddress, "OK");
  assert.ok(manifest.dropped.futureLeak >= 1);
  assert.ok(manifest.dropped.postDecisionHolder >= 1);
  assert.ok(manifest.dropped.badTimestamp >= 1);
});

test("missingness, distribution, targets, and split reports are honest", () => {
  const built = buildDataset([
    row({ tokenAddress: "A", decision_time: 1 * HOUR, features: features({ top10Pct: null }) }),
    row({ tokenAddress: "B", decision_time: 12 * HOUR }),
    row({ tokenAddress: "C", decision_time: 30 * HOUR, theoretical_return: -0.04, rug_detected: true, hit_plus_10_before_minus_10: false }),
  ]);
  const matrix = toFeatureMatrix(built.rows);
  const miss = missingnessAudit(matrix.rows);
  assert.ok(miss.columns.some((c) => c.column === "top10Pct"));
  const dist = featureDistributionAudit(matrix.rows);
  assert.ok(dist.columns.some((c) => c.column === "ret1m" && c.n >= 1));
  const targets = targetBalanceAudit(matrix.rows);
  assert.equal(targets.n, built.rows.length);
  const splits = purgedEmbargoTokenSplit(built.rows, { trainEnd: 8 * HOUR, validationEnd: 20 * HOUR });
  const report = splitReport(splits, { trainEnd: 8 * HOUR });
  assert.equal(report.leakedTokens.length, 0);
  assert.equal(report.tokenGroupedOk, true);
  assert.equal(report.purgeOk, true);
});

test("promotion is CANDIDATE → SHADOW → CHALLENGER → CHAMPION with no skip to capital", () => {
  const art = registerArtifact({
    modelId: "m",
    version: "1",
    datasetHash: "d",
    jobHash: "j",
    featureList: ["ret1m"],
    metrics: null,
    calibration: null,
    commitSha: "abc",
    trainedAt: 1,
    seed: 1337,
  });
  assert.equal(art.status, "CANDIDATE");
  assert.equal(art.usedForCapital, false);
  const shadow = promoteArtifact(art, "SHADOW");
  const chal = promoteArtifact(shadow, "CHALLENGER");
  const champ = promoteArtifact(chal, "CHAMPION");
  assert.equal(champ.status, "CHAMPION");
  assert.equal(champ.usedForCapital, false);
  assert.throws(() => promote("CANDIDATE", "CHAMPION"), /PROMOTION_FORBIDDEN/);
  assert.throws(() => promote("SHADOW", "CHAMPION"), /PROMOTION_FORBIDDEN/);
  assert.equal(ML_TRAINING_LOCKED, true);
});

test("synthetic logistic harness is reproducible and refuses production corpus", () => {
  const a = runSyntheticLogistic({ n: 80, seed: 1337 });
  const b = runSyntheticLogistic({ n: 80, seed: 1337 });
  assert.equal(a.usedProductionCorpus, false);
  assert.equal(a.weightsHash, b.weightsHash);
  assert.ok(a.metrics.n === 80);
  assert.throws(() => assertSyntheticOnly([{ collection_epoch_id: PRODUCTION_EPOCH }]), /SYNTHETIC_ONLY/);
  const other = runSyntheticLogistic({ n: 80, seed: 42 });
  assert.notEqual(other.weightsHash, a.weightsHash);
});

import { FEATURE_SCHEMA_HASH } from "./versions.ts";
import { generateSyntheticCorpus, runSyntheticLogistic, assertSyntheticOnly } from "./v34-harness.ts";
import { compareToBaselines } from "./v34-baselines.ts";
import { modelScorecard } from "./v34-scorecard.ts";
import { walkForwardEvaluate } from "./v34-walkforward.ts";
import { fitHistogramCalibrator, applyCalibrator, expectedCalibrationError } from "./v34-calibrate.ts";
import { runShadowInference } from "./v34-shadow-runtime.ts";
import { labelPrediction, ledgerPairs } from "./v34-ledger.ts";
import { evaluateKillConditions } from "./v34-kill.ts";
import { evaluatePromotion } from "./v34-promote-eval.ts";
import { registerArtifact, type ModelArtifact } from "./v34-job.ts";
import { monitorDrift } from "./v34-monitor.ts";
import type { BinaryPair } from "./v34-eval.ts";
import type { FeatureMatrixRow } from "./v34-matrix.ts";

export type TournamentResult = {
  usedProductionCorpus: false;
  logistic: ModelArtifact;
  baseRate: { brier: number | null };
  beatsBaseRate: boolean;
  walkForward: ReturnType<typeof walkForwardEvaluate>;
  scorecard: ReturnType<typeof modelScorecard>;
  kill: ReturnType<typeof evaluateKillConditions>;
  promotion: ReturnType<typeof evaluatePromotion>;
  shadowMutatedGovernor: false;
  capitalAuthority: false;
};

/** Prove the lifecycle with fake models. Never trains on v33b_production. */
export function runSyntheticTournament(opts?: { n?: number; seed?: number }): TournamentResult {
  const seed = opts?.seed ?? 1337;
  const n = opts?.n ?? 180;
  const { points, epoch } = generateSyntheticCorpus(n, seed);
  assertSyntheticOnly([{ collection_epoch_id: epoch }]);
  const fitted = runSyntheticLogistic({ n, seed });
  const rows: FeatureMatrixRow[] = fitted.matrixPreview;
  const labeled: BinaryPair[] = points.map((p, i) => ({ p: fitted.predictions[i].pUp10, y: p.y }));
  const foldSize = Math.floor(labeled.length / 4) || 1;
  const folds = [0, 1, 2, 3].map((i) => ({
    name: `fold_${i}`,
    pairs: labeled.slice(i * foldSize, i === 3 ? labeled.length : (i + 1) * foldSize),
  }));
  const walk = walkForwardEvaluate(folds);
  const cal = fitHistogramCalibrator(labeled);
  const calibrated = applyCalibrator(labeled, cal);
  const comparison = compareToBaselines(calibrated, rows, labeled.map((r) => ({ p: r.p, y: r.y })));
  const byKey = new Map(fitted.predictions.map((p) => [p.decisionKey, p]));
  const shadow = runShadowInference(
    {
      modelId: "synthetic_logistic",
      modelVersion: "harness",
      predict: (state) => {
        const hit = byKey.get(state.decisionKey) ?? fitted.predictions[0];
        return { pUp10: hit.pUp10, pRug: hit.pRug, pHorizonRetPositive: hit.pHorizonRetPositive };
      },
    },
    rows.slice(0, 8).map((r) => ({ decisionKey: r.decisionKey, predictedAt: r.decisionTime, features: r.features })),
  );
  const labeledLedger = shadow.ledger.map((e, i) => labelPrediction(e, (points[i]?.y ?? 0) as 0 | 1, e.predictedAt + 1));
  void ledgerPairs(labeledLedger);
  const card = modelScorecard(calibrated, { attempted: n, minN: 30 });
  const kill = evaluateKillConditions({
    ece: expectedCalibrationError(calibrated),
    leakage: false,
    schemaMatch: true,
    coverage: card.coverage,
  });
  const promotion = evaluatePromotion({
    n: card.n,
    brier: card.brier,
    baseRateBrier: comparison.baselines.base_rate.brier,
    ece: card.ece,
    beatsBaseRate: comparison.beatsBaseRateBrier,
    kill,
  });
  const mid = Math.floor(rows.length / 2);
  void monitorDrift(rows.slice(0, mid), rows.slice(mid));
  const logistic = registerArtifact({
    modelId: "synthetic_logistic",
    version: "harness",
    datasetHash: "synthetic",
    jobHash: fitted.weightsHash,
    featureList: ["ret1m", "top10Pct"],
    featureSchemaHash: FEATURE_SCHEMA_HASH,
    calibratorVersion: cal.version,
    metrics: fitted.metrics,
    calibration: cal.bins,
    commitSha: "synthetic",
    trainedAt: 0,
    seed,
    status: "CANDIDATE",
  });
  return {
    usedProductionCorpus: false,
    logistic,
    baseRate: { brier: comparison.baselines.base_rate.brier },
    beatsBaseRate: comparison.beatsBaseRateBrier,
    walkForward: walk,
    scorecard: card,
    kill,
    promotion: { ...promotion, capitalAuthority: false },
    shadowMutatedGovernor: shadow.mutatedGovernor,
    capitalAuthority: false,
  };
}

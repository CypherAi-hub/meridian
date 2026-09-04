import { assertProbabilityContract, type ProbabilityPrediction } from "./v34-model.ts";
import { freezePrediction, type PredictionLedgerEntry } from "./v34-ledger.ts";

export type FrozenDecisionState = {
  decisionKey: string;
  predictedAt: number;
  features: Record<string, number | null>;
};

export type ShadowModel = {
  modelId: string;
  modelVersion: string;
  predict: (state: FrozenDecisionState) => {
    pUp10: number;
    pRug: number;
    pHorizonRetPositive: number;
  };
};

/**
 * Shadow inference consumes frozen decision-time state and writes predictions only.
 * No governor mutation, sizing, or order path.
 */
export function runShadowInference(
  model: ShadowModel,
  states: FrozenDecisionState[],
): { predictions: ProbabilityPrediction[]; ledger: PredictionLedgerEntry[]; mutatedGovernor: false; placedOrder: false } {
  const predictions: ProbabilityPrediction[] = [];
  const ledger: PredictionLedgerEntry[] = [];
  for (const s of states) {
    const out = model.predict(s);
    const pred: ProbabilityPrediction = {
      modelId: model.modelId,
      modelVersion: model.modelVersion,
      decisionKey: s.decisionKey,
      predictedAt: s.predictedAt,
      pUp10: out.pUp10,
      pRug: out.pRug,
      pHorizonRetPositive: out.pHorizonRetPositive,
    };
    assertProbabilityContract(pred);
    predictions.push(pred);
    ledger.push(freezePrediction(pred, `${pred.modelId}:${pred.decisionKey}`));
  }
  return { predictions, ledger, mutatedGovernor: false, placedOrder: false };
}

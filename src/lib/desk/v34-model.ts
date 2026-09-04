import { assertTrainingLocked, ML_TRAINING_LOCKED, V34_PREP_VERSION } from "./v34-lock.ts";
import type { EvalReport } from "./v34-eval.ts";

export type ModelStatus = "registered" | "shadow" | "challenger" | "champion" | "retired";

export type ModelCard = {
  modelId: string;
  version: string;
  featureSet: string;
  featureSchemaHash: string;
  trainingWindow: { from: number; to: number } | null;
  datasetHash: string | null;
  metrics: EvalReport | null;
  status: ModelStatus;
  trainingAllowed: false;
  createdAt: number;
};

export type ProbabilityPrediction = {
  modelId: string;
  modelVersion: string;
  decisionKey: string;
  predictedAt: number;
  pUp10: number;
  pRug: number;
  pHorizonRetPositive: number;
};

function isProb(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
}

export function assertProbabilityContract(p: ProbabilityPrediction) {
  if (!isProb(p.pUp10) || !isProb(p.pRug) || !isProb(p.pHorizonRetPositive)) {
    throw new Error("PREDICTION_CONTRACT: probabilities must be in [0, 1]");
  }
  const rec = p as ProbabilityPrediction & { side?: string; action?: string };
  if (rec.side === "BUY" || rec.side === "SELL" || rec.action === "BUY" || rec.action === "SELL") {
    throw new Error("PREDICTION_CONTRACT: models output probabilities, not BUY/SELL");
  }
}

export function registerModel(input: Omit<ModelCard, "trainingAllowed" | "createdAt" | "status"> & { status?: ModelStatus }): ModelCard {
  if (!ML_TRAINING_LOCKED && input.trainingWindow) {
    /* still locked in this phase */
  }
  return {
    ...input,
    status: input.status ?? "registered",
    trainingAllowed: false,
    createdAt: Date.now(),
  };
}

export function trainModel(): never {
  return assertTrainingLocked("train");
}

export const V34_INTERFACE = {
  version: V34_PREP_VERSION,
  outputs: ["pUp10", "pRug", "pHorizonRetPositive"] as const,
  forbids: ["BUY", "SELL", "live_execution"] as const,
};

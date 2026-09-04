import { createHash } from "node:crypto";
import { ML_TRAINING_LOCKED, V34_PREP_VERSION } from "./v34-lock.ts";

export type Preregistration = {
  experimentId: string;
  hash: string;
  target: "hit10" | "rug" | "positiveHorizon";
  featureSet: readonly string[];
  hyperSearch: Record<string, unknown>;
  splits: { trainEnd: number; validationEnd: number; holdoutStart: number };
  primaryMetric: "brier" | "logLoss";
  promotionThresholds: {
    maxBrier: number;
    maxEce: number;
    maxWorstFoldBrier: number;
    maxTailLoss: number;
    minCoverage: number;
    minEconomicExpectancy: number;
    minN: number;
  };
  failureCriteria: string[];
  frozenAt: number;
  trainingAllowed: false;
  prepVersion: string;
};

export function preregisterExperiment(
  input: Omit<Preregistration, "hash" | "frozenAt" | "trainingAllowed" | "prepVersion">,
): Preregistration {
  const body = {
    experimentId: input.experimentId,
    target: input.target,
    featureSet: input.featureSet,
    hyperSearch: input.hyperSearch,
    splits: input.splits,
    primaryMetric: input.primaryMetric,
    promotionThresholds: input.promotionThresholds,
    failureCriteria: input.failureCriteria,
  };
  const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  void ML_TRAINING_LOCKED;
  return {
    ...body,
    hash,
    frozenAt: Date.now(),
    trainingAllowed: false,
    prepVersion: V34_PREP_VERSION,
  };
}

export function mutatePreregistration(_p: Preregistration): never {
  throw new Error("PREREG_FROZEN: experiment cannot be edited after freeze");
}

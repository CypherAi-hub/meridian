import { createHash } from "node:crypto";
import { assertTrainingLocked, ML_TRAINING_LOCKED, V34_PREP_VERSION } from "./v34-lock.ts";
import type { FrozenTrainingManifest } from "./v34-manifest.ts";
import type { EvalReport } from "./v34-eval.ts";
import type { CalibrationBin } from "./v34-eval.ts";

export type TrainingJobConfig = {
  algorithm: "logistic_regression";
  seed: number;
  target: "hit10" | "rug" | "positiveHorizon";
};

export type TrainingJobContract = {
  jobHash: string;
  datasetHash: string;
  manifestHash: string;
  seed: number;
  algorithm: string;
  target: string;
  featureList: readonly string[];
  codeCommit: string;
  trainingAllowed: false;
};

export function createTrainingJob(manifest: FrozenTrainingManifest, config: TrainingJobConfig): TrainingJobContract {
  const jobHash = createHash("sha256")
    .update(
      JSON.stringify({
        datasetHash: manifest.datasetHash,
        manifestHash: manifest.hash,
        seed: config.seed,
        algorithm: config.algorithm,
        target: config.target,
        featureList: manifest.featureList,
        codeCommit: manifest.codeCommit,
      }),
    )
    .digest("hex");
  void ML_TRAINING_LOCKED;
  return {
    jobHash,
    datasetHash: manifest.datasetHash,
    manifestHash: manifest.hash,
    seed: config.seed,
    algorithm: config.algorithm,
    target: config.target,
    featureList: manifest.featureList,
    codeCommit: manifest.codeCommit,
    trainingAllowed: false,
  };
}

export function runTrainingJob(_job: TrainingJobContract): never {
  return assertTrainingLocked("runTrainingJob");
}

export type PromotionState = "CANDIDATE" | "SHADOW" | "CHALLENGER" | "CHAMPION";

export const PROMOTION_CHAIN: readonly PromotionState[] = ["CANDIDATE", "SHADOW", "CHALLENGER", "CHAMPION"];

export type ModelArtifact = {
  artifactId: string;
  modelId: string;
  version: string;
  datasetHash: string;
  jobHash: string;
  featureList: readonly string[];
  featureSchemaHash: string;
  calibratorVersion: string;
  metrics: EvalReport | null;
  calibration: CalibrationBin[] | null;
  commitSha: string;
  trainedAt: number;
  seed: number;
  status: PromotionState;
  usedForCapital: false;
  prepVersion: string;
};

export function registerArtifact(
  input: Omit<ModelArtifact, "usedForCapital" | "status" | "prepVersion" | "artifactId" | "featureSchemaHash" | "calibratorVersion"> & {
    status?: PromotionState;
    artifactId?: string;
    featureSchemaHash?: string;
    calibratorVersion?: string;
  },
): ModelArtifact {
  const artifactId =
    input.artifactId ??
    createHash("sha256")
      .update(`${input.modelId}:${input.version}:${input.datasetHash}:${input.jobHash}:${input.commitSha}:${input.seed}`)
      .digest("hex")
      .slice(0, 16);
  return {
    ...input,
    artifactId,
    featureSchemaHash: input.featureSchemaHash ?? "unknown",
    calibratorVersion: input.calibratorVersion ?? "none",
    status: input.status ?? "CANDIDATE",
    usedForCapital: false,
    prepVersion: V34_PREP_VERSION,
  };
}

export function promote(from: PromotionState, to: PromotionState): PromotionState {
  const i = PROMOTION_CHAIN.indexOf(from);
  const j = PROMOTION_CHAIN.indexOf(to);
  if (i < 0 || j !== i + 1) {
    throw new Error(`PROMOTION_FORBIDDEN: ${from} → ${to}. Chain is CANDIDATE → SHADOW → CHALLENGER → CHAMPION`);
  }
  return to;
}

export function assertNoCapitalAuthority(_artifact: ModelArtifact): void {
  if (_artifact.usedForCapital) throw new Error("CAPITAL_AUTHORITY_FORBIDDEN");
}

export function promoteArtifact(artifact: ModelArtifact, to: PromotionState): ModelArtifact {
  const status = promote(artifact.status, to);
  return { ...artifact, status, usedForCapital: false };
}

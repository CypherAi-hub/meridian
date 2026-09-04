import { createHash } from "node:crypto";
import { V34_PREP_VERSION } from "./v34-lock.ts";
import type { Preregistration } from "./v34-preregister.ts";
import type { FrozenTrainingManifest } from "./v34-manifest.ts";
import type { TrainingJobContract } from "./v34-job.ts";
import type { ModelArtifact } from "./v34-job.ts";

export type ReproBundle = {
  bundleHash: string;
  preregHash: string;
  datasetHash: string;
  jobHash: string;
  artifactId: string;
  calibratorVersion: string;
  seed: number;
  commitSha: string;
  prepVersion: string;
  reconstructs: string[];
};

export function buildReproBundle(input: {
  prereg: Preregistration;
  manifest: FrozenTrainingManifest;
  job: TrainingJobContract;
  artifact: ModelArtifact;
}): ReproBundle {
  const reconstructs = [
    "dataset_manifest",
    "training_job",
    "model_artifact",
    "calibrator",
    "scorecard",
    "promotion_recommendation",
  ];
  const payload = {
    preregHash: input.prereg.hash,
    datasetHash: input.manifest.datasetHash,
    jobHash: input.job.jobHash,
    artifactId: input.artifact.artifactId,
    calibratorVersion: input.artifact.calibratorVersion,
    seed: input.artifact.seed,
    commitSha: input.artifact.commitSha,
    reconstructs,
  };
  return {
    bundleHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
    ...payload,
    prepVersion: V34_PREP_VERSION,
  };
}

export function sameRepro(a: ReproBundle, b: ReproBundle): boolean {
  return a.bundleHash === b.bundleHash;
}

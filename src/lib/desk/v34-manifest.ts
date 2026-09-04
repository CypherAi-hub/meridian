import { createHash } from "node:crypto";
import { FEATURE_SCHEMA, FEATURE_SCHEMA_HASH, FEATURE_ENGINE_VERSION, LABEL_DEFINITION_VERSION } from "./versions.ts";
import { ML_TRAINING_LOCKED, PRODUCTION_EPOCH, V34_PREP_VERSION } from "./v34-lock.ts";
import type { DatasetRow } from "./dataset.ts";
import type { DatasetManifest } from "./v34-dataset.ts";
import type { SplitAssignment } from "./v34-splits.ts";
import type { CertificationReport } from "./v34-certify.ts";

export type FrozenTrainingManifest = {
  id: string;
  hash: string;
  epoch: string;
  observationIds: string[];
  tokenIds: string[];
  featureEngineVersion: string;
  labelDefinitionVersion: string;
  featureSchemaHash: string;
  featureList: readonly string[];
  splitBoundaries: { trainEnd: number; validationEnd: number; horizonMs: number; embargoMs: number };
  splitCounts: { train: number; validation: number; test: number };
  datasetHash: string;
  codeCommit: string;
  configHash: string;
  certified: boolean;
  trainingAllowed: false;
  createdAt: number;
  prepVersion: string;
};

export function freezeTrainingManifest(input: {
  rows: DatasetRow[];
  dataset: DatasetManifest;
  splits: SplitAssignment<DatasetRow>;
  trainEnd: number;
  validationEnd: number;
  horizonMs?: number;
  embargoMs?: number;
  codeCommit?: string;
  config?: unknown;
  certification?: CertificationReport;
}): FrozenTrainingManifest {
  const horizonMs = input.horizonMs ?? 60 * 60_000;
  const embargoMs = input.embargoMs ?? 60 * 60_000;
  const observationIds = [...new Set(input.rows.map((r) => `${r.tokenAddress}:${r.decision_time}`))].sort();
  const tokenIds = [...new Set(input.rows.map((r) => r.tokenAddress))].sort();
  const configHash = createHash("sha256")
    .update(JSON.stringify(input.config ?? input.dataset.request))
    .digest("hex")
    .slice(0, 16);
  const payload = {
    observationIds,
    tokenIds,
    featureEngineVersion: FEATURE_ENGINE_VERSION,
    labelDefinitionVersion: LABEL_DEFINITION_VERSION,
    featureSchemaHash: FEATURE_SCHEMA_HASH,
    featureList: FEATURE_SCHEMA.fields,
    splitBoundaries: { trainEnd: input.trainEnd, validationEnd: input.validationEnd, horizonMs, embargoMs },
    datasetHash: input.dataset.hash,
    codeCommit: input.codeCommit ?? "unknown",
    configHash,
    epoch: PRODUCTION_EPOCH,
  };
  const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  void ML_TRAINING_LOCKED;
  return {
    id: `ftm_${hash.slice(0, 16)}`,
    hash,
    epoch: PRODUCTION_EPOCH,
    observationIds,
    tokenIds,
    featureEngineVersion: FEATURE_ENGINE_VERSION,
    labelDefinitionVersion: LABEL_DEFINITION_VERSION,
    featureSchemaHash: FEATURE_SCHEMA_HASH,
    featureList: FEATURE_SCHEMA.fields,
    splitBoundaries: payload.splitBoundaries,
    splitCounts: {
      train: input.splits.train.length,
      validation: input.splits.validation.length,
      test: input.splits.test.length,
    },
    datasetHash: input.dataset.hash,
    codeCommit: payload.codeCommit,
    configHash,
    certified: input.certification?.status === "READY",
    trainingAllowed: false,
    createdAt: Date.now(),
    prepVersion: V34_PREP_VERSION,
  };
}

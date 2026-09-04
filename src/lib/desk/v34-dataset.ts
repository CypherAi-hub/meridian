import { createHash } from "node:crypto";
import { sanitizeTrainingRows, corpusIndependence, type DatasetRow } from "./dataset.ts";
import { FEATURE_ENGINE_VERSION, LABEL_DEFINITION_VERSION } from "./versions.ts";
import { PRODUCTION_EPOCH, ML_TRAINING_LOCKED } from "./v34-lock.ts";
import type { LedgerRow } from "./types.ts";
import type { ResearchGrade } from "./quality-score.ts";

export type DatasetSourceRow = LedgerRow & { collection_epoch_id?: string | null };

export type DatasetRequest = {
  epoch?: string;
  grades?: ResearchGrade[];
  confidence?: Array<"HIGH" | "MEDIUM">;
  featureEngineVersion?: string;
  labelDefinitionVersion?: string;
  minQuality?: number;
};

export type DatasetDropReason =
  | "incomplete"
  | "lowGrade"
  | "lowConfidence"
  | "wrongEpoch"
  | "wrongFeatureVersion"
  | "wrongLabelVersion"
  | "lowQuality";

export type DatasetManifest = {
  id: string;
  request: Required<DatasetRequest>;
  rowCount: number;
  uniqueTokens: number;
  dropped: Record<DatasetDropReason, number>;
  featureEngineVersion: string;
  labelDefinitionVersion: string;
  trainingAllowed: false;
  hash: string;
};

const DEFAULT_GRADES: ResearchGrade[] = ["TRAINING_GRADE_A", "TRAINING_GRADE_B"];

export function defaultDatasetRequest(): Required<DatasetRequest> {
  return {
    epoch: PRODUCTION_EPOCH,
    grades: [...DEFAULT_GRADES],
    confidence: ["HIGH", "MEDIUM"],
    featureEngineVersion: FEATURE_ENGINE_VERSION,
    labelDefinitionVersion: LABEL_DEFINITION_VERSION,
    minQuality: 75,
  };
}

export function buildDataset(
  rows: DatasetSourceRow[],
  request: DatasetRequest = {},
): { manifest: DatasetManifest; rows: DatasetRow[] } {
  const req = { ...defaultDatasetRequest(), ...request };
  const dropped: Record<DatasetDropReason, number> = {
    incomplete: 0,
    lowGrade: 0,
    lowConfidence: 0,
    wrongEpoch: 0,
    wrongFeatureVersion: 0,
    wrongLabelVersion: 0,
    lowQuality: 0,
  };
  const filtered: DatasetSourceRow[] = [];
  for (const row of rows) {
    if (!row.labels_complete) {
      dropped.incomplete += 1;
      continue;
    }
    const epoch = row.collection_epoch_id ?? "";
    if (epoch !== req.epoch) {
      dropped.wrongEpoch += 1;
      continue;
    }
    if (row.feature_engine_version !== req.featureEngineVersion) {
      dropped.wrongFeatureVersion += 1;
      continue;
    }
    if (row.label_definition_version !== req.labelDefinitionVersion) {
      dropped.wrongLabelVersion += 1;
      continue;
    }
    const grade = row.research_grade_v2 ?? row.research_grade;
    if (!grade || !req.grades.includes(grade)) {
      dropped.lowGrade += 1;
      continue;
    }
    filtered.push(row);
  }
  const sanitized = sanitizeTrainingRows(filtered, {
    minQuality: req.minQuality,
    allowConfidence: req.confidence,
  });
  dropped.lowQuality += filtered.filter((r) => (r.research_quality_score ?? 0) < req.minQuality).length;
  dropped.lowConfidence += filtered.filter((r) => {
    const conf = r.barrier_label_confidence ?? "UNKNOWN";
    return !req.confidence.includes(conf as "HIGH" | "MEDIUM");
  }).length;
  const independence = corpusIndependence(sanitized);
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        request: req,
        ids: sanitized.map((r) => `${r.tokenAddress}:${r.decision_time}`).sort(),
      }),
    )
    .digest("hex")
    .slice(0, 16);
  const manifest: DatasetManifest = {
    id: `ds_${hash}`,
    request: req,
    rowCount: sanitized.length,
    uniqueTokens: independence.uniqueTokens,
    dropped,
    featureEngineVersion: req.featureEngineVersion,
    labelDefinitionVersion: req.labelDefinitionVersion,
    trainingAllowed: false,
    hash,
  };
  void ML_TRAINING_LOCKED;
  return { manifest, rows: sanitized };
}

import { researchHealth } from "./research-health.ts";
import type { DataQuality } from "./types.ts";

/** Training stays off until the production corpus earns it. Not a feature flag to flip for curiosity. */
export const ML_TRAINING_LOCKED = true;
export const V34_PREP_VERSION = "v34-prep.3";
export const PRODUCTION_EPOCH = "v33b_production";

export function assertTrainingLocked(action = "train"): never {
  throw new Error(
    `ML_TRAINING_LOCKED: cannot ${action}. V3.4 training is not earned until v33b_production quality gates pass.`,
  );
}

export function canTrain(_quality?: DataQuality): false {
  void _quality;
  return false;
}

export function trainingUnlockReasons(quality: DataQuality): string[] {
  const reasons = [`training switch ${ML_TRAINING_LOCKED ? "LOCKED" : "OPEN"}`];
  const health = researchHealth(quality, { useEpoch: true });
  reasons.push(...health.blockers);
  if (!quality.productionSoakStartedAtMs) reasons.push("production soak not started");
  else if (Date.now() - quality.productionSoakStartedAtMs < 72 * 3_600_000) {
    reasons.push("72h production soak incomplete");
  }
  return reasons;
}

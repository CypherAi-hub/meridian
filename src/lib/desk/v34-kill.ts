export type KillReason =
  | "CALIBRATION_COLLAPSE"
  | "LEAKAGE"
  | "FEATURE_SCHEMA_MISMATCH"
  | "PREDICTION_COVERAGE"
  | "ECE_HIGH";

export type KillVerdict = {
  suspend: boolean;
  reasons: KillReason[];
};

export function evaluateKillConditions(input: {
  ece?: number | null;
  priorEce?: number | null;
  leakage?: boolean;
  schemaMatch?: boolean;
  coverage?: number | null;
}): KillVerdict {
  const reasons: KillReason[] = [];
  if (input.ece != null && input.ece > 0.15) reasons.push("ECE_HIGH");
  if (input.ece != null && input.priorEce != null && input.ece > input.priorEce * 2 && input.ece > 0.08) {
    reasons.push("CALIBRATION_COLLAPSE");
  }
  if (input.leakage) reasons.push("LEAKAGE");
  if (input.schemaMatch === false) reasons.push("FEATURE_SCHEMA_MISMATCH");
  if (input.coverage != null && input.coverage < 0.5) reasons.push("PREDICTION_COVERAGE");
  return { suspend: reasons.length > 0, reasons };
}

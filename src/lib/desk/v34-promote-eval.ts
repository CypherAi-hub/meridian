import type { KillVerdict } from "./v34-kill.ts";

export type PromotionAdvice = "HOLD" | "DEMOTE" | "ELIGIBLE_FOR_NEXT_STAGE";

export type PromotionEvaluation = {
  advice: PromotionAdvice;
  capitalAuthority: false;
  reasons: string[];
};

/**
 * Never promotes to capital control. Governor stays above the model.
 */
export function evaluatePromotion(input: {
  n: number;
  brier: number | null;
  championBrier?: number | null;
  baseRateBrier?: number | null;
  ece?: number | null;
  beatsBaseRate?: boolean;
  kill?: KillVerdict;
  minN?: number;
}): PromotionEvaluation {
  const reasons: string[] = [];
  if (input.kill?.suspend) {
    return { advice: "DEMOTE", capitalAuthority: false, reasons: input.kill.reasons };
  }
  if (input.n < (input.minN ?? 30)) {
    reasons.push(`n ${input.n} below minimum`);
    return { advice: "HOLD", capitalAuthority: false, reasons };
  }
  if (input.ece != null && input.ece > 0.12) {
    reasons.push(`ECE ${input.ece.toFixed(3)} too high`);
    return { advice: "HOLD", capitalAuthority: false, reasons };
  }
  if (input.beatsBaseRate === false || (input.brier != null && input.baseRateBrier != null && input.brier >= input.baseRateBrier)) {
    reasons.push("does not beat base-rate Brier");
    return { advice: "HOLD", capitalAuthority: false, reasons };
  }
  if (input.championBrier != null && input.brier != null && input.brier >= input.championBrier) {
    reasons.push("does not beat champion Brier");
    return { advice: "HOLD", capitalAuthority: false, reasons };
  }
  reasons.push("beats required comparators; eligible for next stage only");
  return { advice: "ELIGIBLE_FOR_NEXT_STAGE", capitalAuthority: false, reasons };
}

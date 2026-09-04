import type { Preregistration } from "./v34-preregister.ts";
import type { HoldoutVault } from "./v34-holdout.ts";

export type ContractCheck = { name: string; pass: boolean; actual: string; required: string };

export type PromotionContractResult = {
  eligibleToUnlockHoldout: boolean;
  capitalAuthority: false;
  checks: ContractCheck[];
};

/**
 * Thresholds are frozen in the preregistration before seeing holdout.
 * Passing this only unlocks holdout — never capital.
 */
export function evaluatePromotionContract(
  prereg: Preregistration,
  observed: {
    brier: number | null;
    ece: number | null;
    worstFoldBrier: number | null;
    tailLoss: number | null;
    coverage: number | null;
    expectancy: number | null;
    n: number;
    monotonic: boolean | null;
    concealedCatastrophe: boolean;
    nTried: number;
  },
  vault: HoldoutVault,
): PromotionContractResult {
  const t = prereg.promotionThresholds;
  const checks: ContractCheck[] = [
    { name: "n", pass: observed.n >= t.minN, actual: String(observed.n), required: `>= ${t.minN}` },
    {
      name: "brier",
      pass: observed.brier != null && observed.brier <= t.maxBrier,
      actual: String(observed.brier),
      required: `<= ${t.maxBrier}`,
    },
    {
      name: "ece",
      pass: observed.ece != null && observed.ece <= t.maxEce,
      actual: String(observed.ece),
      required: `<= ${t.maxEce}`,
    },
    {
      name: "worstFold",
      pass: observed.worstFoldBrier != null && observed.worstFoldBrier <= t.maxWorstFoldBrier,
      actual: String(observed.worstFoldBrier),
      required: `<= ${t.maxWorstFoldBrier}`,
    },
    {
      name: "tailLoss",
      pass: observed.tailLoss != null && observed.tailLoss <= t.maxTailLoss,
      actual: String(observed.tailLoss),
      required: `<= ${t.maxTailLoss}`,
    },
    {
      name: "coverage",
      pass: observed.coverage != null && observed.coverage >= t.minCoverage,
      actual: String(observed.coverage),
      required: `>= ${t.minCoverage}`,
    },
    {
      name: "expectancy",
      pass: observed.expectancy != null && observed.expectancy >= t.minEconomicExpectancy,
      actual: String(observed.expectancy),
      required: `>= ${t.minEconomicExpectancy}`,
    },
    { name: "monotonicity", pass: observed.monotonic !== false, actual: String(observed.monotonic), required: "high > low" },
    { name: "regime", pass: !observed.concealedCatastrophe, actual: String(observed.concealedCatastrophe), required: "no hidden catastrophe" },
    { name: "trialsDisclosed", pass: observed.nTried >= 1, actual: String(observed.nTried), required: ">= 1" },
    { name: "holdoutStillLocked", pass: vault.locked, actual: vault.locked ? "locked" : "open", required: "locked until this gate" },
  ];
  return { eligibleToUnlockHoldout: checks.every((c) => c.pass), capitalAuthority: false, checks };
}

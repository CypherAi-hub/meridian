import type { Preregistration } from "./v34-preregister.ts";
import type { ModelArtifact } from "./v34-job.ts";
import type { MultipleTestingLedger } from "./v34-trials.ts";
import type { ClusterBootstrap } from "./v34-bootstrap.ts";
import type { EconomicReport } from "./v34-economic.ts";
import type { RegimeRobustness, MonotonicityCheck } from "./v34-regime.ts";
import type { PromotionContractResult } from "./v34-contract.ts";
import type { HoldoutVault } from "./v34-holdout.ts";

export type ModelCardDoc = {
  modelId: string;
  artifactId: string;
  experimentId: string;
  trainingWindow: { trainEnd: number; validationEnd: number; holdoutStart: number };
  eligibleTokens: number;
  missingness: string[];
  target: string;
  nTried: number;
  limitations: string[];
  regimeResults: RegimeRobustness;
  stressPass: boolean;
  knownFailureModes: string[];
  decision: "promoted_to_holdout" | "rejected";
  why: string;
  holdoutUnlocked: boolean;
  capitalAuthority: false;
};

export function writeModelCard(input: {
  artifact: ModelArtifact;
  prereg: Preregistration;
  trials: MultipleTestingLedger;
  bootstrap: ClusterBootstrap;
  economic: EconomicReport;
  regime: RegimeRobustness;
  mono: MonotonicityCheck;
  contract: PromotionContractResult;
  vault: HoldoutVault;
  missingness?: string[];
}): ModelCardDoc {
  const limitations: string[] = [];
  if (input.bootstrap.nTokens < 50) limitations.push(`token-cluster n=${input.bootstrap.nTokens} is small`);
  if (input.mono.monotonic === false) limitations.push("probability not monotonic");
  if (input.regime.concealedCatastrophe) limitations.push("overall score conceals a regime catastrophe");
  if (input.trials.trials.length > 1) {
    limitations.push(`${input.trials.trials.length} configs tried; winner is not a single preregistered shot`);
  }
  const fails = input.contract.checks.filter((c) => !c.pass).map((c) => c.name);
  const decision = input.contract.eligibleToUnlockHoldout ? "promoted_to_holdout" : "rejected";
  const why = decision === "rejected" ? `failed ${fails.join(", ") || "contract"}` : "passed frozen promotion contract; holdout still required";
  return {
    modelId: input.artifact.modelId,
    artifactId: input.artifact.artifactId,
    experimentId: input.prereg.experimentId,
    trainingWindow: input.prereg.splits,
    eligibleTokens: input.bootstrap.nTokens,
    missingness: input.missingness ?? [],
    target: input.prereg.target,
    nTried: input.trials.trials.length,
    limitations,
    regimeResults: input.regime,
    stressPass: input.economic.expectancy >= input.prereg.promotionThresholds.minEconomicExpectancy,
    knownFailureModes: fails,
    decision,
    why,
    holdoutUnlocked: !input.vault.locked,
    capitalAuthority: false,
  };
}

import { assertProbabilityContract, type ModelCard, type ProbabilityPrediction } from "./v34-model.ts";
import { evaluateProbabilities, type BinaryPair, type EvalReport } from "./v34-eval.ts";

export type ShadowRecord = ProbabilityPrediction & {
  usedForCapital: false;
  actualUp10?: 0 | 1 | null;
};

export function recordShadow(pred: ProbabilityPrediction, actualUp10?: 0 | 1 | null): ShadowRecord {
  assertProbabilityContract(pred);
  return { ...pred, usedForCapital: false, actualUp10: actualUp10 ?? null };
}

export type ChampionChallenger = {
  champion: ModelCard | null;
  challenger: ModelCard | null;
  winner: "champion" | "challenger" | "insufficient" | "locked";
  championBrier: number | null;
  challengerBrier: number | null;
};

export function compareChampionChallenger(
  champion: ModelCard | null,
  challenger: ModelCard | null,
): ChampionChallenger {
  const cB = champion?.metrics?.brier ?? null;
  const hB = challenger?.metrics?.brier ?? null;
  let winner: ChampionChallenger["winner"] = "locked";
  if (cB == null && hB == null) winner = "insufficient";
  else if (cB == null && hB != null) winner = "challenger";
  else if (hB == null && cB != null) winner = "champion";
  else if (hB! + 1e-9 < cB!) winner = "challenger";
  else winner = "champion";
  return {
    champion,
    challenger,
    winner,
    championBrier: cB,
    challengerBrier: hB,
  };
}

export function shadowReport(records: ShadowRecord[]): EvalReport {
  const pairs: BinaryPair[] = [];
  for (const r of records) {
    if (r.actualUp10 === 0 || r.actualUp10 === 1) pairs.push({ p: r.pUp10, y: r.actualUp10 });
  }
  return evaluateProbabilities(pairs);
}

export function leaderboard(cards: ModelCard[]): ModelCard[] {
  return [...cards].sort((a, b) => {
    const ba = a.metrics?.brier;
    const bb = b.metrics?.brier;
    if (ba == null && bb == null) return a.modelId.localeCompare(b.modelId);
    if (ba == null) return 1;
    if (bb == null) return -1;
    return ba - bb;
  });
}

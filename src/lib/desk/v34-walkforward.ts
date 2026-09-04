import { evaluateProbabilities, type BinaryPair, type EvalReport } from "./v34-eval.ts";

export type WalkFold = {
  name: string;
  n: number;
  brier: number | null;
  logLoss: number | null;
  rocAuc: number | null;
};

export type WalkForwardReport = {
  folds: WalkFold[];
  meanBrier: number | null;
  worstBrier: number | null;
  bestBrier: number | null;
  /** True when the best fold would hide a failing worst fold. */
  hiddenByBestFold: boolean;
  nFolds: number;
  nLabeled: number;
};

export function walkForwardEvaluate(folds: Array<{ name: string; pairs: BinaryPair[] }>): WalkForwardReport {
  const scored: WalkFold[] = folds.map((f) => {
    const r = evaluateProbabilities(f.pairs);
    return { name: f.name, n: r.n, brier: r.brier, logLoss: r.logLoss, rocAuc: r.rocAuc };
  });
  const briers = scored.map((f) => f.brier).filter((x): x is number => x != null);
  const meanBrier = briers.length ? briers.reduce((s, v) => s + v, 0) / briers.length : null;
  const worstBrier = briers.length ? Math.max(...briers) : null;
  const bestBrier = briers.length ? Math.min(...briers) : null;
  const hiddenByBestFold =
    bestBrier != null && worstBrier != null && worstBrier - bestBrier >= 0.08 && (meanBrier ?? 1) > bestBrier + 0.03;
  return {
    folds: scored,
    meanBrier,
    worstBrier,
    bestBrier,
    hiddenByBestFold,
    nFolds: scored.length,
    nLabeled: scored.reduce((s, f) => s + f.n, 0),
  };
}

export function foldReport(name: string, pairs: BinaryPair[]): { name: string; report: EvalReport } {
  return { name, report: evaluateProbabilities(pairs) };
}

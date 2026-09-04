import { assertProbabilityContract, type ProbabilityPrediction } from "./v34-model.ts";

export type PredictionLedgerEntry = {
  id: string;
  modelId: string;
  modelVersion: string;
  decisionKey: string;
  predictedAt: number;
  pUp10: number;
  pRug: number;
  pHorizonRetPositive: number;
  labeledAt: number | null;
  yUp10: 0 | 1 | null;
  frozen: true;
  usedForCapital: false;
};

export function freezePrediction(pred: ProbabilityPrediction, id: string): PredictionLedgerEntry {
  assertProbabilityContract(pred);
  return {
    id,
    modelId: pred.modelId,
    modelVersion: pred.modelVersion,
    decisionKey: pred.decisionKey,
    predictedAt: pred.predictedAt,
    pUp10: pred.pUp10,
    pRug: pred.pRug,
    pHorizonRetPositive: pred.pHorizonRetPositive,
    labeledAt: null,
    yUp10: null,
    frozen: true,
    usedForCapital: false,
  };
}

/** Labels attach later. Frozen probabilities cannot change. */
export function labelPrediction(entry: PredictionLedgerEntry, yUp10: 0 | 1, labeledAt: number): PredictionLedgerEntry {
  if (!entry.frozen) throw new Error("LEDGER: entry must be frozen before labeling");
  return { ...entry, yUp10, labeledAt, pUp10: entry.pUp10, pRug: entry.pRug, pHorizonRetPositive: entry.pHorizonRetPositive };
}

export function ledgerPairs(entries: PredictionLedgerEntry[]): Array<{ p: number; y: 0 | 1 }> {
  const out: Array<{ p: number; y: 0 | 1 }> = [];
  for (const e of entries) {
    if (e.yUp10 === 0 || e.yUp10 === 1) out.push({ p: e.pUp10, y: e.yUp10 });
  }
  return out;
}

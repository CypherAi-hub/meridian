import { brierScore, logLoss, type BinaryPair } from "./v34-eval.ts";
import type { FeatureMatrixRow } from "./v34-matrix.ts";

export type BaselineId = "base_rate" | "random" | "safety_only" | "safe_momentum";

export type BaselinePredictor = {
  id: BaselineId;
  note: string;
  predict: (row: FeatureMatrixRow) => number;
};

function hash01(s: string, seed: number): number {
  let h = 2166136261 ^ seed;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

export function baseRateOf(pairs: BinaryPair[]): number {
  if (!pairs.length) return 0.5;
  return pairs.reduce((s, r) => s + r.y, 0) / pairs.length;
}

export function baseRatePredictor(rate: number): BaselinePredictor {
  return {
    id: "base_rate",
    note: "Constant base-rate. Legitimate, dumb, required comparator.",
    predict: () => rate,
  };
}

export function randomPredictor(seed = 1337): BaselinePredictor {
  return {
    id: "random",
    note: "Seeded noise in [0,1]. Not a strategy.",
    predict: (row) => hash01(row.decisionKey, seed),
  };
}

export function safetyOnlyPredictor(rate: number): BaselinePredictor {
  return {
    id: "safety_only",
    note: "Safety gates only. Research control. Not live-wired.",
    predict: (row) => {
      const top = row.features.top10Pct;
      const mint = row.features.mintAuth;
      const sell = row.features.sellQuoteAvailable;
      const safe = top != null && top < 0.35 && mint === 0 && sell === 1;
      return safe ? rate : 0.05;
    },
  };
}

export function safeMomentumPredictor(rate: number): BaselinePredictor {
  return {
    id: "safe_momentum",
    note: "Safety + positive ret1m. Not live-wired. Not claimed alpha.",
    predict: (row) => {
      const top = row.features.top10Pct;
      const ret = row.features.ret1m ?? 0;
      const mint = row.features.mintAuth;
      const safe = top != null && mint === 0;
      if (safe && ret > 0.04) return Math.min(0.85, rate + 0.25);
      if (safe) return rate;
      return 0.08;
    },
  };
}

export type BaselineComparison = {
  modelBrier: number | null;
  modelLogLoss: number | null;
  baselines: Record<BaselineId, { brier: number | null; logLoss: number | null }>;
  beatsBaseRateBrier: boolean;
  beatsBaseRateLogLoss: boolean;
};

export function compareToBaselines(
  model: BinaryPair[],
  rows: FeatureMatrixRow[],
  labeled: BinaryPair[],
): BaselineComparison {
  const rate = baseRateOf(labeled);
  const preds: BaselinePredictor[] = [
    baseRatePredictor(rate),
    randomPredictor(1337),
    safetyOnlyPredictor(rate),
    safeMomentumPredictor(rate),
  ];
  const baselines = {} as BaselineComparison["baselines"];
  for (const p of preds) {
    const pairs: BinaryPair[] = rows.map((row, i) => ({ p: p.predict(row), y: labeled[i]?.y ?? 0 }));
    baselines[p.id] = { brier: brierScore(pairs), logLoss: logLoss(pairs) };
  }
  const modelBrier = brierScore(model);
  const modelLogLoss = logLoss(model);
  const br = baselines.base_rate;
  return {
    modelBrier,
    modelLogLoss,
    baselines,
    beatsBaseRateBrier: modelBrier != null && br.brier != null && modelBrier < br.brier - 1e-9,
    beatsBaseRateLogLoss: modelLogLoss != null && br.logLoss != null && modelLogLoss < br.logLoss - 1e-9,
  };
}

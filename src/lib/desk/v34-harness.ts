import { PRODUCTION_EPOCH } from "./v34-lock.ts";
import { evaluateProbabilities, type BinaryPair } from "./v34-eval.ts";
import { assertProbabilityContract, type ProbabilityPrediction } from "./v34-model.ts";
import type { FeatureMatrixRow } from "./v34-matrix.ts";

export type SyntheticPoint = {
  x: number[];
  y: 0 | 1;
  tokenAddress: string;
  decisionTime: number;
};

function mulberry32(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fixture data only. Never tagged as v33b_production. */
export function generateSyntheticCorpus(n: number, seed: number): { points: SyntheticPoint[]; epoch: "synthetic" } {
  const rnd = mulberry32(seed);
  const points: SyntheticPoint[] = [];
  for (let i = 0; i < n; i++) {
    const ret1m = rnd() * 0.2 - 0.05;
    const top10 = rnd() * 0.4;
    const y: 0 | 1 = ret1m > 0.04 && top10 < 0.25 ? 1 : 0;
    points.push({
      x: [1, ret1m, top10],
      y,
      tokenAddress: `syn_${(i % 17).toString(16)}`,
      decisionTime: 1_000_000 + i * 60_000,
    });
  }
  return { points, epoch: "synthetic" };
}

function sigmoid(z: number) {
  if (z > 20) return 1;
  if (z < -20) return 0;
  return 1 / (1 + Math.exp(-z));
}

function fitLogistic(points: SyntheticPoint[], seed: number, steps = 80, lr = 0.35): number[] {
  const dim = points[0]?.x.length ?? 0;
  const rnd = mulberry32(seed ^ 0x9e3779b9);
  const w = Array.from({ length: dim }, () => rnd() * 0.02 - 0.01);
  for (let s = 0; s < steps; s++) {
    const g = Array(dim).fill(0);
    for (const p of points) {
      const z = w.reduce((acc, wi, i) => acc + wi * p.x[i], 0);
      const err = sigmoid(z) - p.y;
      for (let i = 0; i < dim; i++) g[i] += err * p.x[i];
    }
    for (let i = 0; i < dim; i++) w[i] -= (lr / Math.max(points.length, 1)) * g[i];
  }
  return w;
}

export function assertSyntheticOnly(rows: Array<{ collection_epoch_id?: string | null }>) {
  if (rows.some((r) => r.collection_epoch_id === PRODUCTION_EPOCH)) {
    throw new Error("SYNTHETIC_ONLY: harness refused production corpus");
  }
}

export type SyntheticHarnessResult = {
  usedProductionCorpus: false;
  seed: number;
  n: number;
  weights: number[];
  weightsHash: string;
  metrics: ReturnType<typeof evaluateProbabilities>;
  predictions: ProbabilityPrediction[];
  matrixPreview: FeatureMatrixRow[];
};

function hashWeights(w: number[]): string {
  return w.map((x) => x.toFixed(6)).join(",");
}

export function runSyntheticLogistic(opts: { n?: number; seed?: number }): SyntheticHarnessResult {
  const seed = opts.seed ?? 1337;
  const { points } = generateSyntheticCorpus(opts.n ?? 120, seed);
  assertSyntheticOnly(points.map(() => ({ collection_epoch_id: "synthetic" })));
  const w = fitLogistic(points, seed);
  const pairs: BinaryPair[] = [];
  const predictions: ProbabilityPrediction[] = [];
  const matrixPreview: FeatureMatrixRow[] = [];
  for (const p of points) {
    const z = w.reduce((acc, wi, i) => acc + wi * p.x[i], 0);
    const prob = sigmoid(z);
    pairs.push({ p: prob, y: p.y });
    const pred: ProbabilityPrediction = {
      modelId: "synthetic_logistic",
      modelVersion: "harness",
      decisionKey: `${p.tokenAddress}:${p.decisionTime}`,
      predictedAt: p.decisionTime,
      pUp10: prob,
      pRug: 1 - prob,
      pHorizonRetPositive: prob,
    };
    assertProbabilityContract(pred);
    predictions.push(pred);
    matrixPreview.push({
      decisionKey: pred.decisionKey,
      tokenAddress: p.tokenAddress,
      decisionTime: p.decisionTime,
      features: { ret1m: p.x[1], top10Pct: p.x[2] },
      labels: { hit10: p.y, hit20: null, ret15m: null, rug: 0 },
    });
  }
  return {
    usedProductionCorpus: false,
    seed,
    n: points.length,
    weights: w,
    weightsHash: hashWeights(w),
    metrics: evaluateProbabilities(pairs),
    predictions,
    matrixPreview,
  };
}

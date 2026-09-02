import type { LedgerRow } from "./types.ts";
import { edgeBucket, type EdgeBucket } from "./baseline.ts";

export type DistCompare = {
  name: string;
  nA: number;
  nB: number;
  tokensA: number;
  tokensB: number;
  w1: number | null;
  w2: number | null;
  w1Body: number | null;
  w1OverIqr: number | null;
  permutationP: number | null;
  permutationPBody: number | null;
  meanA: number | null;
  meanB: number | null;
  outlierShareA: number | null;
  outlierShareB: number | null;
};

export type WassersteinReport = {
  generatedAt: number;
  labeled: number;
  uniqueTokens: number;
  unit: "return";
  edgeLowVsMid: DistCompare;
  edgeMidVsHigh: DistCompare;
  tokenLowVsMid: DistCompare;
  theoVsExec: DistCompare;
  trainVsHoldout: DistCompare;
  trainPurged: boolean;
  executionGapMeanAbs: number | null;
  clip: { lo: number; hi: number };
  note: string;
};

const BODY_LO = -1;
const BODY_HI = 2;

function clip(xs: number[], lo = BODY_LO, hi = BODY_HI) {
  return xs.map((x) => Math.max(lo, Math.min(hi, x)));
}

function outlierShare(xs: number[], lo = BODY_LO, hi = BODY_HI): number | null {
  if (!xs.length) return null;
  return xs.filter((x) => x < lo || x > hi).length / xs.length;
}

function mean(xs: number[]): number | null {
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  if (p <= 0) return sorted[0];
  if (p >= 1) return sorted[sorted.length - 1];
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

function iqr(xs: number[]): number {
  if (xs.length < 4) {
    const s = [...xs].sort((a, b) => a - b);
    return (s.at(-1) ?? 0) - (s[0] ?? 0);
  }
  const s = [...xs].sort((a, b) => a - b);
  return quantile(s, 0.75) - quantile(s, 0.25);
}

function knots(n: number, m: number): number[] {
  const set = new Set<number>([0, 1]);
  for (let i = 1; i < n; i++) set.add(i / n);
  for (let j = 1; j < m; j++) set.add(j / m);
  return [...set].sort((a, b) => a - b);
}

/** 1-Wasserstein (Earth Mover) between two 1-D empirical samples. */
export function wasserstein1(a: number[], b: number[]): number | null {
  if (!a.length || !b.length) return null;
  const A = [...a].sort((x, y) => x - y);
  const B = [...b].sort((x, y) => x - y);
  const u = knots(A.length, B.length);
  let area = 0;
  for (let k = 0; k < u.length - 1; k++) {
    const lo = u[k];
    const hi = u[k + 1];
    const mid = (lo + hi) / 2;
    area += Math.abs(quantile(A, mid) - quantile(B, mid)) * (hi - lo);
  }
  return area;
}

/** 2-Wasserstein between two 1-D empirical samples. */
export function wasserstein2(a: number[], b: number[]): number | null {
  if (!a.length || !b.length) return null;
  const A = [...a].sort((x, y) => x - y);
  const B = [...b].sort((x, y) => x - y);
  const u = knots(A.length, B.length);
  let area = 0;
  for (let k = 0; k < u.length - 1; k++) {
    const lo = u[k];
    const hi = u[k + 1];
    const mid = (lo + hi) / 2;
    const d = quantile(A, mid) - quantile(B, mid);
    area += d * d * (hi - lo);
  }
  return Math.sqrt(area);
}

export function mulberry32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace<T>(xs: T[], rand: () => number) {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
}

export function permutationP(
  a: number[],
  b: number[],
  observed: number,
  rounds = 199,
  seed = 7,
): number | null {
  if (!a.length || !b.length) return null;
  const rand = mulberry32(seed);
  const pool = [...a, ...b];
  const nA = a.length;
  let ge = 0;
  for (let r = 0; r < rounds; r++) {
    shuffleInPlace(pool, rand);
    const w = wasserstein1(pool.slice(0, nA), pool.slice(nA));
    if (w != null && w >= observed - 1e-15) ge += 1;
  }
  return (ge + 1) / (rounds + 1);
}

function ret15(row: LedgerRow): number | null {
  if (row.price == null || !row.price || row.price_after_15m == null) return null;
  return row.price_after_15m / row.price - 1;
}

function compare(name: string, a: number[], b: number[], tokensA: number, tokensB: number, seed = 7): DistCompare {
  const w1 = wasserstein1(a, b);
  const w2 = wasserstein2(a, b);
  const aBody = clip(a);
  const bBody = clip(b);
  const w1Body = wasserstein1(aBody, bBody);
  const pooledIqr = iqr([...aBody, ...bBody]);
  return {
    name,
    nA: a.length,
    nB: b.length,
    tokensA,
    tokensB,
    w1,
    w2,
    w1Body,
    w1OverIqr: w1Body == null || pooledIqr < 1e-12 ? null : w1Body / pooledIqr,
    permutationP: w1 == null ? null : permutationP(a, b, w1, 199, seed),
    permutationPBody: w1Body == null ? null : permutationP(aBody, bBody, w1Body, 199, seed + 17),
    meanA: mean(a),
    meanB: mean(b),
    outlierShareA: outlierShare(a),
    outlierShareB: outlierShare(b),
  };
}

function emptyCompare(name: string): DistCompare {
  return {
    name,
    nA: 0,
    nB: 0,
    tokensA: 0,
    tokensB: 0,
    w1: null,
    w2: null,
    w1Body: null,
    w1OverIqr: null,
    permutationP: null,
    permutationPBody: null,
    meanA: null,
    meanB: null,
    outlierShareA: null,
    outlierShareB: null,
  };
}

function tokenMedians(rows: LedgerRow[]): Array<{ token: string; edge: number; r15: number }> {
  const g = new Map<string, { edges: number[]; rets: number[] }>();
  for (const r of rows) {
    const y = ret15(r);
    if (y == null || r.edge_score == null) continue;
    const cur = g.get(r.tokenAddress) ?? { edges: [], rets: [] };
    cur.edges.push(r.edge_score);
    cur.rets.push(y);
    g.set(r.tokenAddress, cur);
  }
  const out: Array<{ token: string; edge: number; r15: number }> = [];
  for (const [token, v] of g) {
    const es = [...v.edges].sort((a, b) => a - b);
    const rs = [...v.rets].sort((a, b) => a - b);
    const midE = es[Math.floor(es.length / 2)];
    const midR = rs[Math.floor(rs.length / 2)];
    out.push({ token, edge: midE, r15: midR });
  }
  return out;
}

function bucketReturns(rows: LedgerRow[], bucket: EdgeBucket) {
  const hit = rows.filter((r) => edgeBucket(r.edge_score) === bucket);
  const ys = hit.map(ret15).filter((n): n is number => n != null);
  return { ys, tokens: new Set(hit.map((r) => r.tokenAddress)).size };
}

export function analyzeWasserstein(rows: LedgerRow[]): WassersteinReport {
  const labeled = rows.filter((r) => r.labels_complete && r.edge_score != null);
  const low = bucketReturns(labeled, "20-40");
  const mid = bucketReturns(labeled, "40-60");
  const high = bucketReturns(labeled, "60-80");
  const high2 = bucketReturns(labeled, "80-100");
  const highYs = [...high.ys, ...high2.ys];
  const highTokens = high.tokens + high2.tokens;

  const tokens = tokenMedians(labeled);
  const tokLow = tokens.filter((t) => edgeBucket(t.edge) === "20-40").map((t) => t.r15);
  const tokMid = tokens.filter((t) => edgeBucket(t.edge) === "40-60").map((t) => t.r15);

  const theo = labeled.map((r) => r.theoretical_return).filter((n): n is number => n != null);
  const exec = labeled.map((r) => r.execution_adjusted_return ?? r.net_execution_return).filter((n): n is number => n != null);
  const paired = labeled
    .map((r) => {
      const t = r.theoretical_return;
      const e = r.execution_adjusted_return ?? r.net_execution_return;
      return t != null && e != null ? Math.abs(t - e) : null;
    })
    .filter((n): n is number => n != null);

  const times = labeled.map((r) => r.decision_time).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  let trainVsHoldout = emptyCompare("train vs holdout 15m");
  let trainPurged = false;
  if (times.length >= 40) {
    const trainEnd = times[Math.floor(times.length * 0.6)] ?? times[0];
    const validationEnd = times[Math.floor(times.length * 0.8)] ?? trainEnd;
    const purgedTrain = labeled.filter((r) => r.decision_time + 60 * 60_000 < trainEnd);
    const holdRaw = labeled.filter((r) => r.decision_time >= trainEnd);
    trainPurged = purgedTrain.length >= 20;
    const trainRows = trainPurged ? purgedTrain : labeled.filter((r) => r.decision_time < trainEnd);
    const trainMints = new Set(trainRows.map((r) => r.tokenAddress));
    const hold = holdRaw.filter((r) => !trainMints.has(r.tokenAddress));
    const a = trainRows.map(ret15).filter((n): n is number => n != null);
    const b = hold.map(ret15).filter((n): n is number => n != null);
    trainVsHoldout = compare(
      trainPurged ? "train vs holdout 15m (purged)" : "train vs holdout 15m (unpurged — span < 1h)",
      a,
      b,
      trainMints.size,
      new Set(hold.map((r) => r.tokenAddress)).size,
      11,
    );
    void validationEnd;
  }

  const edgeLowVsMid = compare("edge 20-40 vs 40-60 (considerations)", low.ys, mid.ys, low.tokens, mid.tokens, 3);
  const edgeMidVsHigh = highYs.length
    ? compare("edge 40-60 vs 60+", mid.ys, highYs, mid.tokens, highTokens, 5)
    : emptyCompare("edge 40-60 vs 60+");
  const tokenLowVsMid = compare("edge 20-40 vs 40-60 (tokens)", tokLow, tokMid, tokLow.length, tokMid.length, 9);
  const theoVsExec = compare("theoretical vs execution-adjusted", theo, exec, labeled.length, labeled.length, 13);

  const pTok = tokenLowVsMid.permutationPBody ?? tokenLowVsMid.permutationP;
  const pHold = trainVsHoldout.permutationPBody ?? trainVsHoldout.permutationP;
  let note = "Wasserstein W1 is the earth-mover cost to turn one return distribution into another. It is not a trading signal.";
  if (tokenLowVsMid.w1Body == null) {
    note = "Not enough labeled returns to compare edge buckets with Wasserstein.";
  } else if (pTok != null && pTok <= 0.05) {
    note = `Clipped token-level W1 (returns in [-100%, +200%]) between 20-40 and 40-60 is ${tokenLowVsMid.w1Body.toFixed(4)} (p≈${pTok.toFixed(3)}). Body distributions differ. Raw W1 is dominated by moonshot/rug tails and is not a rank signal.`;
  } else {
    note = `Clipped token-level W1 between 20-40 and 40-60 is ${tokenLowVsMid.w1Body.toFixed(4)} (p≈${(pTok ?? 1).toFixed(3)}). No evidence the typical outcome distributions differ. Raw W1 is tail-dominated and is not alpha.`;
  }
  if (!trainPurged) {
    note += " Label-horizon purge emptied train — corpus span is shorter than 1h, so walk-forward W1 is diagnostic only.";
  } else if (pHold != null && pHold <= 0.05 && trainVsHoldout.w1Body != null) {
    note += ` Train vs holdout clipped W1 ${trainVsHoldout.w1Body.toFixed(4)} (p≈${pHold.toFixed(3)}) — distribution shift, not extra sample size.`;
  }

  return {
    generatedAt: Date.now(),
    labeled: labeled.length,
    uniqueTokens: new Set(labeled.map((r) => r.tokenAddress)).size,
    unit: "return",
    edgeLowVsMid,
    edgeMidVsHigh,
    tokenLowVsMid,
    theoVsExec,
    trainVsHoldout,
    trainPurged,
    executionGapMeanAbs: mean(paired),
    clip: { lo: BODY_LO, hi: BODY_HI },
    note,
  };
}

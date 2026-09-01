import type { LedgerRow } from "./types.ts";

export type EdgeBucket = "0-20" | "20-40" | "40-60" | "60-80" | "80-100";

export type BaselineSlice = {
  bucket: EdgeBucket;
  n: number;
  uniqueTokens: number;
  medianReturn5m: number | null;
  medianReturn15m: number | null;
  medianReturn1h: number | null;
  meanExec: number | null;
  pPlus10: number | null;
  pPlus20: number | null;
  rugRate: number | null;
  collapseRate: number | null;
  p25_15m: number | null;
  p75_15m: number | null;
};

export type MonotonicityReport = {
  n: number;
  uniqueTokens: number;
  spearman15m: number | null;
  kendall15m: number | null;
  spearmanExec: number | null;
  kendallExec: number | null;
  bucketMedians15m: Array<{ bucket: EdgeBucket; n: number; median: number | null }>;
  weaklyIncreasingMedians: boolean | null;
  strictlyIncreasingMedians: boolean | null;
  verdict: "monotonic" | "not_monotonic" | "insufficient";
  note: string;
};

export type BaselineReport = {
  generatedAt: number;
  labeled: number;
  uniqueTokens: number;
  considerations: number;
  considerationsPerToken: number;
  readyForModeling: boolean;
  note: string;
  monotonicEdge15m: boolean | null;
  monotonicity: MonotonicityReport;
  byEdge: BaselineSlice[];
  byBucket: Record<string, { n: number; uniqueTokens: number; median15m: number | null }>;
  byRegime: Record<string, { n: number; uniqueTokens: number; median15m: number | null }>;
};

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(xs: number[]): number | null {
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function pctile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)));
  return s[i];
}

function rate(xs: Array<boolean | null | undefined>): number | null {
  const known = xs.filter((x): x is boolean => x === true || x === false);
  if (!known.length) return null;
  return known.filter(Boolean).length / known.length;
}

export function edgeBucket(score: number): EdgeBucket {
  if (score < 20) return "0-20";
  if (score < 40) return "20-40";
  if (score < 60) return "40-60";
  if (score < 80) return "60-80";
  return "80-100";
}

function ret(row: LedgerRow, after: number | null): number | null {
  if (row.price == null || !row.price || after == null) return null;
  return after / row.price - 1;
}

function sliceOf(bucket: EdgeBucket, rows: LedgerRow[]): BaselineSlice {
  const r5 = rows.map((r) => ret(r, r.price_after_5m)).filter((n): n is number => n != null);
  const r15 = rows.map((r) => ret(r, r.price_after_15m)).filter((n): n is number => n != null);
  const r1h = rows.map((r) => ret(r, r.price_after_1h)).filter((n): n is number => n != null);
  const exec = rows.map((r) => r.execution_adjusted_return ?? r.net_execution_return).filter((n): n is number => n != null);
  return {
    bucket,
    n: rows.length,
    uniqueTokens: new Set(rows.map((r) => r.tokenAddress)).size,
    medianReturn5m: median(r5),
    medianReturn15m: median(r15),
    medianReturn1h: median(r1h),
    meanExec: mean(exec),
    pPlus10: rate(rows.map((r) => r.hit_plus_10_before_minus_10)),
    pPlus20: rate(rows.map((r) => r.hit_plus_20_before_minus_10)),
    rugRate: rate(rows.map((r) => r.rug_detected)),
    collapseRate: rate(rows.map((r) => r.liquidity_collapse)),
    p25_15m: pctile(r15, 0.25),
    p75_15m: pctile(r15, 0.75),
  };
}

function groupStats(rows: LedgerRow[]) {
  const r15 = rows.map((r) => ret(r, r.price_after_15m)).filter((n): n is number => n != null);
  return {
    n: rows.length,
    uniqueTokens: new Set(rows.map((r) => r.tokenAddress)).size,
    median15m: median(r15),
  };
}

export function ranks(values: number[]): number[] {
  const sorted = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = Array(values.length).fill(0);
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j < sorted.length && sorted[j].v === sorted[i].v) j += 1;
    const avg = (i + j - 1) / 2 + 1;
    for (let k = i; k < j; k++) out[sorted[k].i] = avg;
    i = j;
  }
  return out;
}

export function pearson(a: number[], b: number[]): number | null {
  const n = a.length;
  if (n < 3) return null;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  if (da === 0 || db === 0) return null;
  return num / Math.sqrt(da * db);
}

export function spearman(x: number[], y: number[]): number | null {
  if (x.length !== y.length || x.length < 3) return null;
  return pearson(ranks(x), ranks(y));
}

export function kendallTau(x: number[], y: number[]): number | null {
  const n = x.length;
  if (n !== y.length || n < 3) return null;
  let conc = 0;
  let disc = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = Math.sign(x[j] - x[i]);
      const dy = Math.sign(y[j] - y[i]);
      if (dx === 0 || dy === 0) continue;
      if (dx === dy) conc += 1;
      else disc += 1;
    }
  }
  const tot = conc + disc;
  if (!tot) return null;
  return (conc - disc) / tot;
}

export function analyzeEdgeMonotonicity(rows: LedgerRow[]): MonotonicityReport {
  const labeled = rows.filter((r) => r.labels_complete && r.edge_score != null);
  const pairs15 = labeled
    .map((r) => {
      const y = ret(r, r.price_after_15m);
      return y == null ? null : { x: r.edge_score, y };
    })
    .filter((p): p is { x: number; y: number } => p != null);
  const pairsExec = labeled
    .map((r) => {
      const y = r.execution_adjusted_return ?? r.net_execution_return;
      return y == null ? null : { x: r.edge_score, y };
    })
    .filter((p): p is { x: number; y: number } => p != null);

  const edges: EdgeBucket[] = ["0-20", "20-40", "40-60", "60-80", "80-100"];
  const bucketMedians15m = edges.map((bucket) => {
    const inB = labeled.filter((r) => edgeBucket(r.edge_score) === bucket);
    const ys = inB.map((r) => ret(r, r.price_after_15m)).filter((n): n is number => n != null);
    return { bucket, n: inB.length, median: median(ys) };
  });
  const filled = bucketMedians15m.filter((b) => b.median != null && b.n >= 3);
  let weaklyIncreasingMedians: boolean | null = null;
  let strictlyIncreasingMedians: boolean | null = null;
  if (filled.length >= 3) {
    weaklyIncreasingMedians = filled.every((b, i) => i === 0 || (b.median as number) >= (filled[i - 1].median as number) - 1e-12);
    strictlyIncreasingMedians = filled.every((b, i) => i === 0 || (b.median as number) > (filled[i - 1].median as number) + 1e-12);
  }

  const spearman15m = spearman(
    pairs15.map((p) => p.x),
    pairs15.map((p) => p.y),
  );
  const kendall15m = kendallTau(
    pairs15.map((p) => p.x),
    pairs15.map((p) => p.y),
  );
  const spearmanExec = spearman(
    pairsExec.map((p) => p.x),
    pairsExec.map((p) => p.y),
  );
  const kendallExec = kendallTau(
    pairsExec.map((p) => p.x),
    pairsExec.map((p) => p.y),
  );

  let verdict: MonotonicityReport["verdict"] = "insufficient";
  let note = `Only ${pairs15.length} labeled 15m pairs across ${new Set(labeled.map((r) => r.tokenAddress)).size} tokens. Need 30+ before treating edge ordering as a result.`;
  if (pairs15.length >= 30 && weaklyIncreasingMedians != null) {
    const rho = spearman15m ?? 0;
    if (weaklyIncreasingMedians && rho > 0.1) {
      verdict = "monotonic";
      note = `Edge score is weakly monotonic vs median 15m return (Spearman ${rho.toFixed(2)}). Diagnostic only — not a trading signal.`;
    } else {
      verdict = "not_monotonic";
      note = `Edge score is not monotonic vs 15m return (Spearman ${rho.toFixed(2)}). Do not treat edge_score as standalone alpha.`;
    }
  }

  return {
    n: pairs15.length,
    uniqueTokens: new Set(labeled.map((r) => r.tokenAddress)).size,
    spearman15m,
    kendall15m,
    spearmanExec,
    kendallExec,
    bucketMedians15m,
    weaklyIncreasingMedians,
    strictlyIncreasingMedians,
    verdict,
    note,
  };
}

export function buildBaselineReport(rows: LedgerRow[]): BaselineReport {
  const labeled = rows.filter((r) => r.labels_complete);
  const tokens = new Set(rows.map((r) => r.tokenAddress));
  const edges: EdgeBucket[] = ["0-20", "20-40", "40-60", "60-80", "80-100"];
  const byEdge = edges.map((b) => sliceOf(b, labeled.filter((r) => edgeBucket(r.edge_score) === b)));
  const monotonicity = analyzeEdgeMonotonicity(rows);
  const byBucket: BaselineReport["byBucket"] = {};
  const byRegime: BaselineReport["byRegime"] = {};
  for (const r of labeled) {
    byBucket[r.bucket] ??= { n: 0, uniqueTokens: 0, median15m: null };
    byRegime[r.regime] ??= { n: 0, uniqueTokens: 0, median15m: null };
  }
  for (const key of Object.keys(byBucket)) byBucket[key] = groupStats(labeled.filter((r) => r.bucket === key));
  for (const key of Object.keys(byRegime)) byRegime[key] = groupStats(labeled.filter((r) => r.regime === key));
  const ready = labeled.length >= 1000;
  return {
    generatedAt: Date.now(),
    labeled: labeled.length,
    uniqueTokens: tokens.size,
    considerations: rows.length,
    considerationsPerToken: tokens.size ? rows.length / tokens.size : 0,
    readyForModeling: ready,
    note: ready
      ? monotonicity.note
      : `Only ${labeled.length} completed labels. Need 1000+ before baseline modeling. ${monotonicity.note}`,
    monotonicEdge15m: monotonicity.verdict === "monotonic" ? true : monotonicity.verdict === "not_monotonic" ? false : null,
    monotonicity,
    byEdge,
    byBucket,
    byRegime,
  };
}

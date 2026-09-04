export type BinaryPair = { p: number; y: 0 | 1 };

function clamp01(p: number) {
  return Math.min(1 - 1e-12, Math.max(1e-12, p));
}

export function brierScore(pairs: BinaryPair[]): number | null {
  if (!pairs.length) return null;
  return pairs.reduce((s, r) => s + (r.p - r.y) ** 2, 0) / pairs.length;
}

export function logLoss(pairs: BinaryPair[]): number | null {
  if (!pairs.length) return null;
  return (
    -pairs.reduce((s, r) => {
      const p = clamp01(r.p);
      return s + (r.y === 1 ? Math.log(p) : Math.log(1 - p));
    }, 0) / pairs.length
  );
}

export function rocAuc(pairs: BinaryPair[]): number | null {
  const pos = pairs.filter((r) => r.y === 1);
  const neg = pairs.filter((r) => r.y === 0);
  if (!pos.length || !neg.length) return null;
  let wins = 0;
  let ties = 0;
  for (const p of pos) {
    for (const n of neg) {
      if (p.p > n.p) wins += 1;
      else if (p.p === n.p) ties += 1;
    }
  }
  return (wins + ties / 2) / (pos.length * neg.length);
}

export function prAuc(pairs: BinaryPair[]): number | null {
  const pos = pairs.filter((r) => r.y === 1).length;
  if (!pos || pos === pairs.length) return null;
  const sorted = [...pairs].sort((a, b) => b.p - a.p);
  let tp = 0;
  let fp = 0;
  let prevRecall = 0;
  let area = 0;
  for (const r of sorted) {
    if (r.y === 1) tp += 1;
    else fp += 1;
    const recall = tp / pos;
    const precision = tp / (tp + fp);
    area += (recall - prevRecall) * precision;
    prevRecall = recall;
  }
  return area;
}

export type CalibrationBin = { lo: number; hi: number; n: number; meanP: number; meanY: number };

export function calibrationBins(pairs: BinaryPair[], n = 10): CalibrationBin[] {
  const bins: CalibrationBin[] = Array.from({ length: n }, (_, i) => ({
    lo: i / n,
    hi: (i + 1) / n,
    n: 0,
    meanP: 0,
    meanY: 0,
  }));
  for (const r of pairs) {
    const idx = Math.min(n - 1, Math.max(0, Math.floor(r.p * n)));
    const b = bins[idx];
    b.n += 1;
    b.meanP += r.p;
    b.meanY += r.y;
  }
  for (const b of bins) {
    if (!b.n) continue;
    b.meanP /= b.n;
    b.meanY /= b.n;
  }
  return bins;
}

export type EvalReport = {
  n: number;
  brier: number | null;
  logLoss: number | null;
  rocAuc: number | null;
  prAuc: number | null;
  calibration: CalibrationBin[];
};

export function evaluateProbabilities(pairs: BinaryPair[]): EvalReport {
  return {
    n: pairs.length,
    brier: brierScore(pairs),
    logLoss: logLoss(pairs),
    rocAuc: rocAuc(pairs),
    prAuc: prAuc(pairs),
    calibration: calibrationBins(pairs),
  };
}

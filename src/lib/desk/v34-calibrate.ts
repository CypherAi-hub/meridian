import { calibrationBins, type BinaryPair, type CalibrationBin } from "./v34-eval.ts";

export const CALIBRATOR_VERSION = "histogram_v1";

export type BrierDecomposition = {
  brier: number;
  reliability: number;
  resolution: number;
  uncertainty: number;
};

export function brierDecomposition(pairs: BinaryPair[], bins = 10): BrierDecomposition | null {
  if (!pairs.length) return null;
  const bar = pairs.reduce((s, r) => s + r.y, 0) / pairs.length;
  const uncertainty = bar * (1 - bar);
  const cal = calibrationBins(pairs, bins).filter((b) => b.n > 0);
  const n = pairs.length;
  let reliability = 0;
  let resolution = 0;
  for (const b of cal) {
    reliability += (b.n / n) * (b.meanP - b.meanY) ** 2;
    resolution += (b.n / n) * (b.meanY - bar) ** 2;
  }
  return { brier: reliability - resolution + uncertainty, reliability, resolution, uncertainty };
}

export function expectedCalibrationError(pairs: BinaryPair[], bins = 10): number | null {
  if (!pairs.length) return null;
  const n = pairs.length;
  return calibrationBins(pairs, bins).reduce((s, b) => s + (b.n / n) * Math.abs(b.meanP - b.meanY), 0);
}

export type ReliabilityPlot = { bins: CalibrationBin[]; ece: number | null; decomp: BrierDecomposition | null };

export function reliabilityPlot(pairs: BinaryPair[], bins = 10): ReliabilityPlot {
  return { bins: calibrationBins(pairs, bins), ece: expectedCalibrationError(pairs, bins), decomp: brierDecomposition(pairs, bins) };
}

export type HistogramCalibrator = {
  version: typeof CALIBRATOR_VERSION;
  bins: CalibrationBin[];
  apply: (p: number) => number;
};

export function fitHistogramCalibrator(pairs: BinaryPair[], bins = 10): HistogramCalibrator {
  const fitted = calibrationBins(pairs, bins);
  return {
    version: CALIBRATOR_VERSION,
    bins: fitted,
    apply(p: number) {
      const idx = Math.min(fitted.length - 1, Math.max(0, Math.floor(p * fitted.length)));
      const b = fitted[idx];
      if (!b.n) return p;
      return b.meanY;
    },
  };
}

export function applyCalibrator(pairs: BinaryPair[], cal: HistogramCalibrator): BinaryPair[] {
  return pairs.map((r) => ({ p: cal.apply(r.p), y: r.y }));
}

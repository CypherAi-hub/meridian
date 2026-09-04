import { evaluateProbabilities, calibrationBins, type BinaryPair } from "./v34-eval.ts";
import { expectedCalibrationError, brierDecomposition } from "./v34-calibrate.ts";

export type BucketExpectancy = { lo: number; hi: number; n: number; meanP: number; meanY: number; expectancy: number };

export type ModelScorecard = {
  n: number;
  coverage: number;
  brier: number | null;
  logLoss: number | null;
  rocAuc: number | null;
  prAuc: number | null;
  ece: number | null;
  reliability: number | null;
  resolution: number | null;
  buckets: BucketExpectancy[];
  tailLoss: number | null;
  regimeBrier: Record<string, number | null>;
  sampleSizeOk: boolean;
};

export function modelScorecard(
  pairs: BinaryPair[],
  opts?: { attempted?: number; regimes?: Array<{ name: string; pairs: BinaryPair[] }>; minN?: number },
): ModelScorecard {
  const attempted = opts?.attempted ?? pairs.length;
  const ev = evaluateProbabilities(pairs);
  const decomp = brierDecomposition(pairs);
  const bins = calibrationBins(pairs);
  const buckets: BucketExpectancy[] = bins.map((b) => ({
    lo: b.lo,
    hi: b.hi,
    n: b.n,
    meanP: b.meanP,
    meanY: b.meanY,
    expectancy: b.n ? b.meanY - b.meanP : 0,
  }));
  const tail = pairs.filter((r) => r.p >= 0.8);
  const tailLoss = tail.length ? tail.filter((r) => r.y === 0).length / tail.length : null;
  const regimeBrier: Record<string, number | null> = {};
  for (const r of opts?.regimes ?? []) {
    regimeBrier[r.name] = evaluateProbabilities(r.pairs).brier;
  }
  return {
    n: pairs.length,
    coverage: attempted ? pairs.length / attempted : 0,
    brier: ev.brier,
    logLoss: ev.logLoss,
    rocAuc: ev.rocAuc,
    prAuc: ev.prAuc,
    ece: expectedCalibrationError(pairs),
    reliability: decomp?.reliability ?? null,
    resolution: decomp?.resolution ?? null,
    buckets,
    tailLoss,
    regimeBrier,
    sampleSizeOk: pairs.length >= (opts?.minN ?? 30),
  };
}

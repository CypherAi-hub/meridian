import type { Regime } from "./types.ts";
import { brierScore, type BinaryPair } from "./v34-eval.ts";

export type RegimeRow = BinaryPair & { regime: Regime };

export type RegimeSlice = {
  regime: Regime;
  n: number;
  brier: number | null;
  hitRate: number | null;
  sampleOk: boolean;
  catastrophic: boolean;
};

export type RegimeRobustness = {
  slices: RegimeSlice[];
  overallBrier: number | null;
  concealedCatastrophe: boolean;
};

const REGIMES: Regime[] = ["meme_mania", "trend", "chop", "risk_off"];

export function regimeRobustness(rows: RegimeRow[], opts?: { minN?: number; catastropheBrier?: number }): RegimeRobustness {
  const minN = opts?.minN ?? 20;
  const catastropheBrier = opts?.catastropheBrier ?? 0.35;
  const slices: RegimeSlice[] = REGIMES.map((regime) => {
    const rs = rows.filter((r) => r.regime === regime);
    const brier = brierScore(rs);
    const hitRate = rs.length ? rs.reduce((s, r) => s + r.y, 0) / rs.length : null;
    return {
      regime,
      n: rs.length,
      brier,
      hitRate,
      sampleOk: rs.length >= minN,
      catastrophic: brier != null && rs.length >= minN && brier >= catastropheBrier,
    };
  });
  const overallBrier = brierScore(rows);
  const concealedCatastrophe = slices.some((s) => s.catastrophic) && (overallBrier ?? 1) < catastropheBrier;
  return { slices, overallBrier, concealedCatastrophe };
}

export type MonotonicityCheck = {
  low: { lo: number; hi: number; n: number; hitRate: number | null };
  high: { lo: number; hi: number; n: number; hitRate: number | null };
  monotonic: boolean | null;
};

/** 0.80 predictions must empirically beat 0.60. Otherwise unusable for policy. */
export function probabilityMonotonicity(
  pairs: BinaryPair[],
  opts?: { low?: [number, number]; high?: [number, number] },
): MonotonicityCheck {
  const lowR = opts?.low ?? [0.55, 0.65];
  const highR = opts?.high ?? [0.75, 0.85];
  const inR = (a: number, b: number) => pairs.filter((p) => p.p >= a && p.p < b);
  const hit = (xs: BinaryPair[]) => (xs.length ? xs.reduce((s, r) => s + r.y, 0) / xs.length : null);
  const lowXs = inR(lowR[0], lowR[1]);
  const highXs = inR(highR[0], highR[1]);
  const lowHit = hit(lowXs);
  const highHit = hit(highXs);
  const monotonic = lowHit == null || highHit == null ? null : highHit > lowHit;
  return {
    low: { lo: lowR[0], hi: lowR[1], n: lowXs.length, hitRate: lowHit },
    high: { lo: highR[0], hi: highR[1], n: highXs.length, hitRate: highHit },
    monotonic,
  };
}

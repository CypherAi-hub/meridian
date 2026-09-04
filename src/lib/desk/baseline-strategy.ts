import type { Features, Predictions, Regime, TokenLive } from "./types.ts";

/** Published V3.3B hypothesis count. Do not expand without recording the search. */
export const V33B_HYPOTHESIS_COUNT = 3;
export const RANDOM_ELIGIBLE_SEED = 1337;

export const BASELINE_SAFE_MOMENTUM_V1 = {
  name: "baseline_safe_momentum",
  version: 1,
  eligibleBuckets: ["new_launch", "early", "emerging"],
  allowedRegimes: ["meme_mania", "trend"],
  entry: [
    { feature: "safetyScore", op: "gte", value: 70 },
    { feature: "liquidityUsd", op: "gte", value: 75000 },
    { feature: "volumeAccel5m", op: "gte", value: 1.5 },
  ],
  requiredGates: ["contract", "holder", "liquidity", "route", "freshness"],
  risk: { riskBps: 25 },
  note: "Initial research parameters. Not claimed optimal. Not live-wired.",
} as const;

export const SAFETY_ONLY_V1 = {
  name: "safety_only",
  version: 1,
  eligibleBuckets: ["new_launch", "early", "emerging"],
  requiredGates: ["contract", "holder", "liquidity", "route", "freshness"],
  minLiquidityUsd: 35_000,
  risk: { riskBps: 25 },
  note: "Safety gates only. No momentum filter. Research control. Not live-wired.",
} as const;

export const RANDOM_ELIGIBLE_V1 = {
  name: "random_eligible",
  version: 1,
  seed: RANDOM_ELIGIBLE_SEED,
  fraction: 0.1,
  note: "Deterministic 1-in-10 of eligible universe. Seed 1337. Not live-wired.",
} as const;

export const ELIGIBLE_UNIVERSE_V1 = {
  name: "eligible_universe",
  version: 1,
  note: "Gate for random_eligible. Not a published V3.3B hypothesis.",
} as const;

/** Exactly three published V3.3B hypotheses. Do not append without recording the search. */
export const PUBLISHED_HYPOTHESES = [
  { name: "random_eligible", version: 1, seed: RANDOM_ELIGIBLE_SEED, index: 1 },
  { name: "baseline_safe_momentum", version: 1, seed: null, index: 2 },
  { name: "safety_only", version: 1, seed: null, index: 3 },
] as const;

export function publishedMeta(id: string) {
  return PUBLISHED_HYPOTHESES.find((h) => h.name === id) ?? null;
}

function detBucket(mint: string, t: number, seed: number): number {
  let h = 2166136261;
  const raw = `${seed}:${mint}:${t}`;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 10;
}

export function matchEligibleUniverse(opts: {
  token: TokenLive;
  features: Features;
  predictions: Predictions;
  regime: Regime;
}): boolean {
  if (!["new_launch", "early", "emerging"].includes(opts.features.bucket)) return false;
  if ((opts.token.liquidityUsd.value ?? 0) < 35_000) return false;
  if (opts.features.top10Pct == null) return false;
  if (opts.features.mintAuth == null || opts.features.freezeAuth == null) return false;
  if (opts.features.sellQuoteAvailable !== 1) return false;
  if (opts.features.snapshotAgeMs != null && opts.features.snapshotAgeMs > 30_000) return false;
  return true;
}

export function matchSafetyOnly(opts: {
  token: TokenLive;
  features: Features;
  predictions: Predictions;
  regime: Regime;
}): boolean {
  return matchEligibleUniverse(opts);
}

export function matchRandomEligible(
  opts: {
    token: TokenLive;
    features: Features;
    predictions: Predictions;
    regime: Regime;
  },
  seed = RANDOM_ELIGIBLE_SEED,
): boolean {
  if (!matchEligibleUniverse(opts)) return false;
  return detBucket(opts.token.address, opts.token.priceUsd.ingestedAt, seed) === 0;
}

export function matchBaselineSafeMomentum(opts: {
  token: TokenLive;
  features: Features;
  predictions: Predictions;
  regime: Regime;
}): boolean {
  const spec = BASELINE_SAFE_MOMENTUM_V1;
  if (!(spec.allowedRegimes as readonly string[]).includes(opts.regime)) return false;
  if (!(spec.eligibleBuckets as readonly string[]).includes(opts.features.bucket)) return false;
  if (opts.predictions.safetyScore < 70) return false;
  if ((opts.token.liquidityUsd.value ?? 0) < 75_000) return false;
  if (opts.features.volAccel < 1.5) return false;
  if (opts.features.top10Pct == null) return false;
  if (opts.features.mintAuth == null || opts.features.freezeAuth == null) return false;
  if (opts.features.sellQuoteAvailable !== 1) return false;
  if (opts.features.snapshotAgeMs != null && opts.features.snapshotAgeMs > 30_000) return false;
  return true;
}

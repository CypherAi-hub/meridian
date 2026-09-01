export const FEATURE_ENGINE_VERSION = "v1.3.0";
export const LABEL_DEFINITION_VERSION = "labels_v1";
export const EXECUTION_ASSUMPTION_VERSION = "exec_v1";
export const STRATEGY_CODE_VERSION = "3.3.0";

export const LABEL_DEFINITION = {
  version: LABEL_DEFINITION_VERSION,
  liquidity_collapse_threshold: 0.6,
  upper_barrier_1: 0.1,
  upper_barrier_2: 0.2,
  lower_barrier: 0.1,
  horizons: ["1m", "5m", "15m", "30m", "1h"],
} as const;

export const EXECUTION_ASSUMPTION = {
  version: EXECUTION_ASSUMPTION_VERSION,
  slippage_bps: 50,
  fee_bps: 25,
  extra_adverse_bps: 0,
  note: "Quote impact is already in Jupiter implied price when used; simulator adds slippage+fee only when quote missing.",
} as const;

export const FEATURE_SCHEMA = {
  version: FEATURE_ENGINE_VERSION,
  fields: [
    "tokenAgeS",
    "bucket",
    "ret1m",
    "rv5m",
    "volAccel",
    "usdImbalance",
    "holderGrowth5m",
    "top10Pct",
    "liqChange1m",
    "liqMcapRatio",
    "uniqueBuyerShare",
    "mintAuth",
    "freezeAuth",
    "sellQuoteAvailable",
    "maxDd5m",
    "entryImpactPct",
    "exitImpactPct",
    "snapshotAgeMs",
    "priceDisagreement",
  ],
} as const;

export function stableHash(value: unknown): string {
  const raw = JSON.stringify(value);
  let h = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `fnv1a:${(h >>> 0).toString(16).padStart(8, "0")}`;
}

export const FEATURE_SCHEMA_HASH = stableHash(FEATURE_SCHEMA);

export function strategyHash(strategy: unknown): string {
  return stableHash(strategy);
}

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

import type { UniverseBucket } from "./buckets.ts";
import type { Features, Predictions, Regime, StrategyId } from "./types.ts";

export type StrategyDef = {
  id: StrategyId;
  name: string;
  thesis: string;
  eligible: Regime[];
  eligibleBuckets: UniverseBucket[];
  gates: { feature: string; op: string; value: number | boolean }[];
  entry: { feature: string; op: string; value: number }[];
};

export const STRATEGIES: StrategyDef[] = [
  {
    id: "launch_velocity_pullback",
    name: "Launch velocity",
    thesis: "Fresh listings with accelerating flow and a calibrated barrier edge.",
    eligible: ["meme_mania", "trend"],
    eligibleBuckets: ["new_launch", "early"],
    gates: [
      { feature: "sellQuoteAvailable", op: "==", value: 1 },
      { feature: "pCatastrophic15m", op: "<", value: 0.08 },
    ],
    entry: [
      { feature: "volAccel", op: ">", value: 1.35 },
      { feature: "usdImbalance", op: ">", value: 0.12 },
      { feature: "pTpBeforeSl", op: ">", value: 0.54 },
    ],
  },
  {
    id: "trend_continuation",
    name: "Continuation",
    thesis: "Holders still accumulating after the first impulse, low rug odds.",
    eligible: ["trend", "meme_mania"],
    eligibleBuckets: ["early", "emerging"],
    gates: [
      { feature: "sellQuoteAvailable", op: "==", value: 1 },
      { feature: "pCatastrophic15m", op: "<", value: 0.06 },
    ],
    entry: [
      { feature: "holderGrowth5m", op: ">", value: 0.04 },
      { feature: "ret1m", op: ">", value: 0.01 },
      { feature: "expectedNetEdgeBps", op: ">", value: 40 },
    ],
  },
  {
    id: "chop_mean_revert",
    name: "Chop fade",
    thesis: "Fade stretched one-minute returns when the book is two-sided.",
    eligible: ["chop"],
    eligibleBuckets: ["early", "emerging"],
    gates: [
      { feature: "sellQuoteAvailable", op: "==", value: 1 },
      { feature: "pCatastrophic15m", op: "<", value: 0.05 },
    ],
    entry: [
      { feature: "ret1m", op: "<", value: -0.04 },
      { feature: "usdImbalance", op: ">", value: -0.05 },
      { feature: "rv5m", op: "<", value: 0.18 },
    ],
  },
  {
    id: "flat",
    name: "Stand down",
    thesis: "No approved strategy in this regime.",
    eligible: ["risk_off"],
    eligibleBuckets: ["new_launch", "early", "emerging", "established", "mature", "unknown"],
    gates: [],
    entry: [],
  },
];

export function strategyForRegime(regime: Regime): StrategyDef {
  return STRATEGIES.find((s) => s.eligible.includes(regime) && s.id !== "flat") ?? STRATEGIES[3];
}

type Ctx = Features & Predictions;

const OPS: Record<string, (a: number | boolean, b: number | boolean) => boolean> = {
  ">": (a, b) => Number(a) > Number(b),
  ">=": (a, b) => Number(a) >= Number(b),
  "<": (a, b) => Number(a) < Number(b),
  "<=": (a, b) => Number(a) <= Number(b),
  "==": (a, b) => a === b,
  gt: (a, b) => Number(a) > Number(b),
  gte: (a, b) => Number(a) >= Number(b),
  lt: (a, b) => Number(a) < Number(b),
  lte: (a, b) => Number(a) <= Number(b),
};

export function evaluateCondition(
  condition: { feature: string; op: string; value: number | boolean },
  features: Record<string, unknown>,
): boolean | null {
  if (!(condition.op in OPS)) throw new Error(`unsupported operator ${condition.op}`);
  const value = features[condition.feature];
  if (value == null) return null;
  return OPS[condition.op](value as number | boolean, condition.value);
}

export function validateStrategyDef(def: StrategyDef) {
  for (const c of [...def.gates, ...def.entry]) {
    if (!(c.op in OPS)) throw new Error(`unsupported operator ${c.op}`);
    if (!c.feature) throw new Error("invalid feature");
  }
  return true;
}

function pass(ctx: Ctx, rule: { feature: string; op: string; value: number | boolean }): boolean {
  const hit = evaluateCondition(rule, ctx as unknown as Record<string, unknown>);
  if (hit == null) return false;
  return hit;
}

export function strategyMatches(def: StrategyDef, ctx: Ctx): boolean {
  if (def.id === "flat") return false;
  if (!def.eligibleBuckets.includes(ctx.bucket)) return false;
  return def.gates.every((g) => pass(ctx, g)) && def.entry.every((g) => pass(ctx, g));
}

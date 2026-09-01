import type { UniverseBucket } from "./buckets";
import type { Features, Predictions, Regime, StrategyId } from "./types";

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

function read(ctx: Ctx, key: string): number | boolean | null {
  const v = (ctx as unknown as Record<string, number | boolean | null | undefined>)[key];
  return v == null ? null : v;
}

function pass(ctx: Ctx, rule: { feature: string; op: string; value: number | boolean }): boolean {
  const v = read(ctx, rule.feature);
  if (v == null) return false;
  if (rule.op === "==") return v === rule.value;
  const n = Number(v);
  const t = Number(rule.value);
  if (!Number.isFinite(n)) return false;
  if (rule.op === "<") return n < t;
  if (rule.op === ">") return n > t;
  if (rule.op === "<=") return n <= t;
  if (rule.op === ">=") return n >= t;
  return false;
}

export function strategyMatches(def: StrategyDef, ctx: Ctx): boolean {
  if (def.id === "flat") return false;
  if (!def.eligibleBuckets.includes(ctx.bucket)) return false;
  return def.gates.every((g) => pass(ctx, g)) && def.entry.every((g) => pass(ctx, g));
}

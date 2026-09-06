import { ML_TRAINING_LOCKED } from "./v34-lock.ts";

export const V35_VERSION = "v35-participant-intelligence";
export const PARTICIPANT_EVENT_SCHEMA = "participant_event_schema_v1";
export const PARTICIPANT_FEATURE_ENGINE = "participant_feature_engine_v1";
export const SNIPER_TRIGGER_VERSION = "sniper_trigger_v1";
export const SNIPER_SNAPSHOT_VERSION = "sniper_snapshot_v1";
export const WALLET_COHORT_VERSION = "wallet_cohort_v1";
export const SNIPER_LABEL_VERSION = "sniper_label_v1";

export type SniperMode = "SHADOW" | "DISABLED";

const FORBIDDEN_MODES = new Set(["PAPER", "LIVE", "AUTO", "EXECUTE", "ON", "TRUE", "1"]);

export function parseSniperMode(raw?: string | null): SniperMode {
  const v = (raw ?? "SHADOW").trim().toUpperCase();
  if (!v || v === "SHADOW") return "SHADOW";
  if (v === "DISABLED" || v === "OFF") return "DISABLED";
  if (FORBIDDEN_MODES.has(v)) {
    throw new Error(`SNIPER_MODE_FAIL_CLOSED: ${v} is not allowed. Only SHADOW or DISABLED.`);
  }
  throw new Error(`SNIPER_MODE_FAIL_CLOSED: unknown mode ${v}`);
}

export const SNIPER_FORBIDDEN_MUTATIONS = [
  "paper_orders",
  "paper_fills",
  "paper_positions",
  "strategy_decisions",
  "governor_gate_results",
  "portfolio",
  "jupiter_swap",
  "sign",
  "broadcast",
  "wallet",
  "authorize_strategy",
] as const;

export function assertShadowOnly(action: string): never {
  throw new Error(`SNIPER_SHADOW: cannot ${action}. Shadow sniper observes, freezes, and labels later.`);
}

export function assertNoCapitalMutation(action: string) {
  if ((SNIPER_FORBIDDEN_MUTATIONS as readonly string[]).includes(action) || /order|fill|position|swap|sign|broadcast/i.test(action)) {
    assertShadowOnly(action);
  }
}

export function assertTrainingStillLocked() {
  if (!ML_TRAINING_LOCKED) throw new Error("V35: trainModel must remain locked");
  return true as const;
}

export function sniperInterestName(): "sniper_interest_score" {
  return "sniper_interest_score";
}

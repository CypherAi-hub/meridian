import type { BehaviorCandidate, ParticipantFeatureVector } from "./v35-types.ts";

export type StateAssignment = {
  state: BehaviorCandidate;
  evidence: string[];
  version: "behavior_state_v1";
};

export function classifyBehaviorCandidate(v: ParticipantFeatureVector): StateAssignment {
  const w = v.w60s;
  const evidence: string[] = [];
  if (v.dataStatus !== "OK") return { state: "UNKNOWN", evidence: ["participant_data_unknown"], version: "behavior_state_v1" };

  const priceUp = (w.priceChange ?? 0) > 0.04;
  const priceDown = (w.priceChange ?? 0) < -0.08;
  const distributed = (w.uniqueBuyers ?? 0) >= 20 && (w.top1BuyerShare ?? 1) < 0.2;
  const concentrated = (w.top1BuyerShare ?? 0) >= 0.25 || (w.uniqueBuyers ?? 99) <= 20;
  const liqUp = (w.liquidityDeltaPct ?? 0) > 0.05;
  const liqDown = (w.liquidityDeltaPct ?? 0) < -0.05;
  const repeats = (w.repeatBuyerRatio ?? 0) >= 0.35;
  const newHeavy = (w.newBuyerRatio ?? 0) >= 0.7;
  const sellHeavy = (w.sellNotional ?? 0) > (w.buyNotional ?? 0) * 1.2;
  const absorb = sellHeavy && Math.abs(w.priceChange ?? 1) < 0.02 && !liqDown;

  if (absorb) {
    evidence.push("large_sell_flow", "price_stable", "liquidity_not_falling");
    return { state: "ABSORPTION_CANDIDATE", evidence, version: "behavior_state_v1" };
  }
  if (priceUp && concentrated && liqDown) {
    evidence.push("price_up", "flow_concentrated", "liquidity_delta_negative");
    return { state: "DISTRIBUTION_CANDIDATE", evidence, version: "behavior_state_v1" };
  }
  if (priceUp && newHeavy && (w.uniqueBuyers ?? 0) >= 8) {
    evidence.push("price_up", "new_buyers_high");
    return { state: "NEW_BUYER_CHASE_CANDIDATE", evidence, version: "behavior_state_v1" };
  }
  if (priceUp && distributed && liqUp && repeats) {
    evidence.push("distributed_buyers", "repeat_buyers_rising", "liquidity_increasing");
    return { state: "ACCUMULATION_CANDIDATE", evidence, version: "behavior_state_v1" };
  }
  if (priceUp && (w.top1BuyerShare ?? 0) >= 0.35) {
    evidence.push("large_wallet_buy_share");
    return { state: "LARGE_WALLET_ACCUMULATION_CANDIDATE", evidence, version: "behavior_state_v1" };
  }
  if (priceDown && sellHeavy && liqDown) {
    evidence.push("price_down", "sell_notional_high", "liquidity_delta_negative");
    return { state: "CAPITULATION_CANDIDATE", evidence, version: "behavior_state_v1" };
  }
  if (liqDown && (w.uniqueBuyers ?? 0) < 3) {
    evidence.push("liquidity_delta_negative");
    return { state: "LIQUIDITY_FLIGHT_CANDIDATE", evidence, version: "behavior_state_v1" };
  }
  if (priceUp && (w.buyerGrowthRate ?? 0) > 1) {
    evidence.push("buyer_acceleration", "price_up");
    return { state: "FOMO_CANDIDATE", evidence, version: "behavior_state_v1" };
  }
  return { state: "UNKNOWN", evidence: ["no_state_rule_matched"], version: "behavior_state_v1" };
}

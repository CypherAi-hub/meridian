import { createHash } from "node:crypto";
import { SNIPER_TRIGGER_VERSION } from "./v35-lock.ts";
import { classifyBehaviorCandidate } from "./v35-states.ts";
import type { ParticipantFeatureVector, SniperTrigger, TriggerFamily } from "./v35-types.ts";

export const SNIPER_TRIGGER_DEF = {
  version: SNIPER_TRIGGER_VERSION,
  algorithm: "deterministic_v1",
  minUniqueBuyersForExpansion: 12,
  minSampleEvents: 4,
} as const;

export function triggerFingerprint(instrumentId: string, family: TriggerFamily, T: number, bucketMs = 60_000): string {
  const bucket = Math.floor(T / bucketMs);
  return createHash("sha256")
    .update(`${instrumentId}|${family}|${bucket}|${SNIPER_TRIGGER_VERSION}`)
    .digest("hex")
    .slice(0, 24);
}

export function sniperInterestScore(v: ParticipantFeatureVector): number {
  const w = v.w60s;
  let s = 0;
  s += Math.min(40, (w.uniqueBuyers ?? 0) * 1.5);
  s += Math.min(20, Math.abs(w.priceChange ?? 0) * 80);
  s += Math.min(15, Math.abs(w.liquidityDeltaPct ?? 0) * 40);
  s += Math.min(15, (w.buyerGrowthRate ?? 0) * 8);
  if (v.priceUpFlowDown) s += 10;
  if (v.dataStatus !== "OK") s *= 0.2;
  return Math.round(s * 10) / 10;
}

export function evaluateTriggers(v: ParticipantFeatureVector): SniperTrigger {
  if (v.dataStatus !== "OK" || v.eventCoverage === 0) {
    return { fired: false, family: null, reasonCodes: ["UNKNOWN_PARTICIPANT"], interestScore: 0, fingerprint: "" };
  }
  const w = v.w60s;
  const state = classifyBehaviorCandidate(v);
  const score = sniperInterestScore(v);
  const reasons: string[] = [...state.evidence];
  let family: TriggerFamily | null = null;

  if (state.state === "ABSORPTION_CANDIDATE") family = "ABSORPTION";
  else if (state.state === "DISTRIBUTION_CANDIDATE") family = "DISTRIBUTION_DIVERGENCE";
  else if (state.state === "CAPITULATION_CANDIDATE") family = "CAPITULATION";
  else if ((w.uniqueBuyers ?? 0) >= SNIPER_TRIGGER_DEF.minUniqueBuyersForExpansion && (w.buyerGrowthRate ?? 0) > 0.3) {
    family = "PARTICIPANT_EXPANSION";
    reasons.push("buyer_expansion");
  } else if ((w.priceChange ?? 0) > 0.05 && (w.buyNotional ?? 0) > 0 && (w.buyerGrowthRate ?? 0) > 0.5) {
    family = "MOMENTUM_ACCELERATION";
    reasons.push("price_and_flow_acceleration");
  } else if ((w.top1BuyerShare ?? 0) >= 0.35 && (w.netNotionalFlow ?? 0) > 0) family = "LARGE_WALLET";
  else if (Math.abs(w.liquidityDeltaPct ?? 0) >= 0.2) family = "LIQUIDITY_EVENT";

  if (!family) {
    return { fired: false, family: null, reasonCodes: reasons.length ? reasons : ["no_trigger"], interestScore: score, fingerprint: "" };
  }
  return {
    fired: true,
    family,
    reasonCodes: reasons,
    interestScore: score,
    fingerprint: triggerFingerprint(v.instrumentId, family, v.featureTime),
    suppressed: null,
  };
}

export function applyCooldown(
  trigger: SniperTrigger,
  recentFingerprints: Set<string>,
): SniperTrigger {
  if (!trigger.fired || !trigger.fingerprint) return trigger;
  if (recentFingerprints.has(trigger.fingerprint)) {
    return { ...trigger, fired: false, suppressed: "cooldown" };
  }
  return trigger;
}

export function applyBudget(
  candidates: Array<SniperTrigger & { instrumentId: string }>,
  maxSessions: number,
): Array<SniperTrigger & { instrumentId: string; promoted: boolean }> {
  const fired = candidates.filter((c) => c.fired).sort((a, b) => b.interestScore - a.interestScore);
  return candidates.map((c) => {
    if (!c.fired) return { ...c, promoted: false };
    const rank = fired.findIndex((x) => x.fingerprint === c.fingerprint && x.instrumentId === c.instrumentId);
    if (rank >= 0 && rank < maxSessions) return { ...c, promoted: true };
    return { ...c, fired: false, suppressed: "budget" as const, promoted: false };
  });
}

import { createHash } from "node:crypto";
import { EXECUTION_ASSUMPTION_VERSION } from "./versions.ts";
import { SNIPER_SNAPSHOT_VERSION, SNIPER_TRIGGER_VERSION, V35_VERSION, assertShadowOnly, parseSniperMode } from "./v35-lock.ts";
import { computeParticipantFeatures } from "./v35-features.ts";
import { evaluateTriggers, applyCooldown, applyBudget, sniperInterestScore } from "./v35-triggers.ts";
import { classifyBehaviorCandidate } from "./v35-states.ts";
import { promoteWatch, type WatchState } from "./watch.ts";
import type {
  ParticipantEvent,
  ParticipantFeatureVector,
  SniperCounterfactual,
  SniperSession,
  SniperWatchPhase,
  TriggerFamily,
} from "./v35-types.ts";

export const MAX_SHADOW_SNIPER_SESSIONS = 25;

export type SniperSnapshot = {
  id: string;
  sessionId: string;
  instrumentId: string;
  eventTime: number;
  ingestedAt: number;
  marketObservationId: string | null;
  participantFeatureVector: ParticipantFeatureVector;
  snapshotVersion: string;
};

export function advanceWatchPhase(phase: SniperWatchPhase, fired: boolean, ended: boolean): SniperWatchPhase {
  if (ended) return "COMPLETED";
  if (phase === "DISCOVERED") return "WATCH";
  if (phase === "WATCH" && fired) return "TRIGGERED";
  if (phase === "TRIGGERED") return "SNIPER_ACTIVE";
  if (phase === "SNIPER_ACTIVE" && ended) return "COOLDOWN";
  return phase;
}

export function requestActiveWatch(mint: string, now: number, family: TriggerFamily): WatchState {
  return promoteWatch(mint, now, `shadow_sniper:${family}`, 400);
}

export function openSession(opts: {
  instrumentId: string;
  tokenMint?: string | null;
  T: number;
  ingestedAt: number;
  family: TriggerFamily;
  reasons: string[];
  fingerprint: string;
  priority: number;
  epoch?: string;
}): SniperSession {
  parseSniperMode("SHADOW");
  const id = `snp_${opts.fingerprint}`;
  return {
    id,
    instrumentId: opts.instrumentId,
    tokenMint: opts.tokenMint ?? opts.instrumentId,
    triggerVersion: SNIPER_TRIGGER_VERSION,
    triggerTime: opts.T,
    triggerIngestedAt: opts.ingestedAt,
    triggerReasonCodes: opts.reasons,
    family: opts.family,
    sessionState: "ACTIVE",
    watchPhase: "SNIPER_ACTIVE",
    priority: opts.priority,
    fingerprint: opts.fingerprint,
    collectionEpoch: opts.epoch ?? "v33b_production",
    commitSha: V35_VERSION,
  };
}

export function freezeSnapshot(session: SniperSession, vector: ParticipantFeatureVector, obsId: string | null = null): SniperSnapshot {
  const id = createHash("sha256")
    .update(`${session.id}|${vector.featureTime}|${SNIPER_SNAPSHOT_VERSION}`)
    .digest("hex")
    .slice(0, 20);
  return {
    id: `snap_${id}`,
    sessionId: session.id,
    instrumentId: session.instrumentId,
    eventTime: vector.featureTime,
    ingestedAt: vector.ingestedAt,
    marketObservationId: obsId,
    participantFeatureVector: vector,
    snapshotVersion: SNIPER_SNAPSHOT_VERSION,
  };
}

export function counterfactuals(session: SniperSession, triggerPrice: number): SniperCounterfactual[] {
  const offsets = [
    ["TRIGGER", 0],
    ["TRIGGER_PLUS_3S", 3_000],
    ["TRIGGER_PLUS_10S", 10_000],
    ["TRIGGER_PLUS_30S", 30_000],
  ] as const;
  return offsets.map(([basis, dt]) => ({
    id: `${session.id}:${basis}`,
    sessionId: session.id,
    instrumentId: session.instrumentId,
    referenceTime: session.triggerTime + dt,
    referencePrice: triggerPrice,
    hypotheticalEntryBasis: basis,
    executionAssumptionVersion: EXECUTION_ASSUMPTION_VERSION,
  }));
}

export function shadowPlaceOrder(): never {
  return assertShadowOnly("paper_orders");
}
export function shadowFill(): never {
  return assertShadowOnly("paper_fills");
}
export function shadowPosition(): never {
  return assertShadowOnly("paper_positions");
}
export function shadowSwap(): never {
  return assertShadowOnly("jupiter_swap");
}
export function shadowSign(): never {
  return assertShadowOnly("sign");
}

export function evaluateShadowTape(opts: {
  events: ParticipantEvent[];
  instruments: string[];
  T: number;
  recentFingerprints?: Set<string>;
  maxSessions?: number;
  mode?: string;
}): { sessions: SniperSession[]; snapshots: SniperSnapshot[]; suppressed: number } {
  const mode = parseSniperMode(opts.mode ?? "SHADOW");
  if (mode === "DISABLED") return { sessions: [], snapshots: [], suppressed: 0 };
  const recent = opts.recentFingerprints ?? new Set<string>();
  const scored = opts.instruments.map((id) => {
    const vec = computeParticipantFeatures(opts.events, { instrumentId: id, T: opts.T });
    const trig = applyCooldown(evaluateTriggers(vec), recent);
    return { instrumentId: id, vec, trig, interestScore: sniperInterestScore(vec) };
  });
  const budgeted = applyBudget(
    scored.map((s) => ({ ...s.trig, instrumentId: s.instrumentId })),
    opts.maxSessions ?? MAX_SHADOW_SNIPER_SESSIONS,
  );
  let suppressed = 0;
  const sessions: SniperSession[] = [];
  const snapshots: SniperSnapshot[] = [];
  for (const row of scored) {
    const b = budgeted.find((x) => x.instrumentId === row.instrumentId)!;
    if (b.suppressed) suppressed += 1;
    if (!b.fired || !b.family || !b.promoted) continue;
    const session = openSession({
      instrumentId: row.instrumentId,
      T: opts.T,
      ingestedAt: row.vec.ingestedAt,
      family: b.family,
      reasons: b.reasonCodes,
      fingerprint: b.fingerprint,
      priority: Math.round(b.interestScore),
    });
    sessions.push(session);
    snapshots.push(freezeSnapshot(session, row.vec));
    recent.add(b.fingerprint);
  }
  void classifyBehaviorCandidate;
  return { sessions, snapshots, suppressed };
}

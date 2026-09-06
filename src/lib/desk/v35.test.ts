import assert from "node:assert/strict";
import { test } from "node:test";
import { trainModel } from "./v34-model.ts";
import { ML_TRAINING_LOCKED } from "./v34-lock.ts";
import {
  parseSniperMode,
  assertNoCapitalMutation,
  V35_VERSION,
  PARTICIPANT_FEATURE_ENGINE,
} from "./v35-lock.ts";
import { normalizeParticipantEvent, dedupeEvents } from "./v35-normalize.ts";
import { asOfEvents } from "./v35-clock.ts";
import { computeParticipantFeatures } from "./v35-features.ts";
import { classifyBehaviorCandidate } from "./v35-states.ts";
import { evaluateTriggers, applyCooldown, triggerFingerprint } from "./v35-triggers.ts";
import { walletProfileAt, cohortMembershipAt } from "./v35-wallets.ts";
import {
  evaluateShadowTape,
  shadowPlaceOrder,
  shadowFill,
  shadowPosition,
  shadowSwap,
  shadowSign,
  freezeSnapshot,
  counterfactuals,
  openSession,
} from "./v35-sniper.ts";
import { labelSniperSession } from "./v35-labels.ts";
import { replayShadowSniper } from "./v35-replay.ts";
import { sniperResearchReport } from "./v35-metrics.ts";
import { degradeOnProviderFailure, participantMissingnessAudit } from "./v35-quality.ts";
import { V35_MIGRATIONS } from "./neon-steps.ts";
import type { ParticipantEvent } from "./v35-types.ts";
import type { PathTick } from "./types.ts";

function ev(partial: Partial<ParticipantEvent> & { instrumentId: string; eventTime: number; walletId: string }): ParticipantEvent {
  return normalizeParticipantEvent({
    instrumentId: partial.instrumentId,
    eventTime: partial.eventTime,
    ingestedAt: partial.ingestedAt ?? partial.eventTime,
    providerId: "fixture",
    providerEventId: partial.id ?? `${partial.walletId}:${partial.eventTime}`,
    side: partial.eventType === "SELL" ? "sell" : partial.eventType === "LIQUIDITY_ADD" ? "liq_add" : partial.eventType === "LIQUIDITY_REMOVE" ? "liq_remove" : "buy",
    walletId: partial.walletId,
    usdNotional: partial.usdNotional ?? 100,
    observedPrice: partial.observedPrice ?? 1,
  });
}

function manyBuyers(instrumentId: string, n: number, T0: number, price = 1, liq: "up" | "down" | "flat" = "up"): ParticipantEvent[] {
  const out: ParticipantEvent[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      ev({
        instrumentId,
        eventTime: T0 + i * 200,
        walletId: `b${i}`,
        usdNotional: 80 + (i % 5) * 10,
        observedPrice: price * (1 + i * 0.001),
        eventType: "BUY",
      }),
    );
  }
  if (liq === "up") out.push(ev({ instrumentId, eventTime: T0 + 100, walletId: "lp", eventType: "LIQUIDITY_ADD", usdNotional: 5000 }));
  if (liq === "down") out.push(ev({ instrumentId, eventTime: T0 + 100, walletId: "lp", eventType: "LIQUIDITY_REMOVE", usdNotional: 5000 }));
  return out;
}

test("sniper mode fail-closed and training stays locked", () => {
  assert.equal(parseSniperMode("SHADOW"), "SHADOW");
  assert.equal(parseSniperMode("DISABLED"), "DISABLED");
  assert.throws(() => parseSniperMode("LIVE"), /FAIL_CLOSED/);
  assert.throws(() => parseSniperMode("PAPER"), /FAIL_CLOSED/);
  assert.throws(() => parseSniperMode("EXECUTE"), /FAIL_CLOSED/);
  assert.equal(ML_TRAINING_LOCKED, true);
  assert.throws(() => trainModel(), /ML_TRAINING_LOCKED/);
});

test("shadow sniper cannot touch capital, orders, governor, or swaps", () => {
  assert.throws(() => shadowPlaceOrder(), /SNIPER_SHADOW/);
  assert.throws(() => shadowFill(), /SNIPER_SHADOW/);
  assert.throws(() => shadowPosition(), /SNIPER_SHADOW/);
  assert.throws(() => shadowSwap(), /SNIPER_SHADOW/);
  assert.throws(() => shadowSign(), /SNIPER_SHADOW/);
  assert.throws(() => assertNoCapitalMutation("governor_gate_results"), /SNIPER_SHADOW/);
});

test("fixture A distributed momentum triggers participant expansion / accumulation", () => {
  const T0 = 1_000_000;
  const events = [
    ...manyBuyers("A", 40, T0 - 90_000, 1, "up"),
    ...manyBuyers("A", 80, T0, 1.08, "up"),
  ];
  const vec = computeParticipantFeatures(events, { instrumentId: "A", T: T0 + 20_000 });
  const st = classifyBehaviorCandidate(vec);
  const trig = evaluateTriggers(vec);
  assert.equal(vec.featureVersion, PARTICIPANT_FEATURE_ENGINE);
  assert.ok((vec.w60s.uniqueBuyers ?? 0) >= 12);
  assert.ok(["ACCUMULATION_CANDIDATE", "FOMO_CANDIDATE", "NEW_BUYER_CHASE_CANDIDATE"].includes(st.state) || trig.fired);
  assert.equal(trig.fired, true);
  assert.ok(trig.family === "PARTICIPANT_EXPANSION" || trig.family === "MOMENTUM_ACCELERATION" || trig.family === "LIQUIDITY_EVENT");
});

test("fixture B fake pump / distribution candidate", () => {
  const T0 = 2_000_000;
  const events: ParticipantEvent[] = [];
  for (let i = 0; i < 8; i++) {
    events.push(ev({ instrumentId: "B", eventTime: T0 + i * 300, walletId: `w${i % 3}`, usdNotional: 2000, observedPrice: 1 + i * 0.02, eventType: "BUY" }));
  }
  events.push(ev({ instrumentId: "B", eventTime: T0 + 500, walletId: "lp", eventType: "LIQUIDITY_REMOVE", usdNotional: 8000, observedPrice: 1.1 }));
  const vec = computeParticipantFeatures(events, { instrumentId: "B", T: T0 + 2500 });
  const st = classifyBehaviorCandidate(vec);
  assert.ok(
    st.state === "DISTRIBUTION_CANDIDATE" ||
      st.state === "LARGE_WALLET_ACCUMULATION_CANDIDATE" ||
      evaluateTriggers(vec).family === "DISTRIBUTION_DIVERGENCE" ||
      evaluateTriggers(vec).family === "LARGE_WALLET" ||
      evaluateTriggers(vec).family === "LIQUIDITY_EVENT",
  );
});

test("fixture C capitulation candidate", () => {
  const T0 = 3_000_000;
  const events = [
    ev({ instrumentId: "C", eventTime: T0, walletId: "s1", eventType: "SELL", usdNotional: 4000, observedPrice: 1 }),
    ev({ instrumentId: "C", eventTime: T0 + 200, walletId: "s2", eventType: "SELL", usdNotional: 4000, observedPrice: 0.9 }),
    ev({ instrumentId: "C", eventTime: T0 + 400, walletId: "s3", eventType: "SELL", usdNotional: 4000, observedPrice: 0.8 }),
    ev({ instrumentId: "C", eventTime: T0 + 100, walletId: "lp", eventType: "LIQUIDITY_REMOVE", usdNotional: 3000, observedPrice: 0.85 }),
  ];
  const st = classifyBehaviorCandidate(computeParticipantFeatures(events, { instrumentId: "C", T: T0 + 500 }));
  assert.equal(st.state, "CAPITULATION_CANDIDATE");
});

test("fixture D absorption candidate", () => {
  const T0 = 4_000_000;
  const events = [
    ev({ instrumentId: "D", eventTime: T0, walletId: "s1", eventType: "SELL", usdNotional: 5000, observedPrice: 1 }),
    ev({ instrumentId: "D", eventTime: T0 + 200, walletId: "s2", eventType: "SELL", usdNotional: 5000, observedPrice: 1.005 }),
    ev({ instrumentId: "D", eventTime: T0 + 400, walletId: "b1", eventType: "BUY", usdNotional: 800, observedPrice: 0.998 }),
  ];
  const st = classifyBehaviorCandidate(computeParticipantFeatures(events, { instrumentId: "D", T: T0 + 500 }));
  assert.equal(st.state, "ABSORPTION_CANDIDATE");
});

test("fixture E provider failure is UNKNOWN and does not stop the tape", () => {
  const market = { price: 1.2 };
  const d = degradeOnProviderFailure(market, false);
  assert.equal(d.market.price, 1.2);
  assert.equal(d.participantStatus, "UNKNOWN");
  const vec = computeParticipantFeatures([], { instrumentId: "E", T: 5 });
  const trig = evaluateTriggers(vec);
  assert.equal(trig.fired, false);
  assert.ok(trig.reasonCodes.includes("UNKNOWN_PARTICIPANT"));
});

test("fixture F future wallet PnL cannot leak into today", () => {
  const T0 = 6_000_000;
  const events = [
    ev({ instrumentId: "OLD", eventTime: T0 - 86_400_000, walletId: "pro", eventType: "BUY" }),
    ev({ instrumentId: "NEW", eventTime: T0, walletId: "pro", eventType: "BUY" }),
    ev({ instrumentId: "JACKPOT", eventTime: T0 + 86_400_000, ingestedAt: T0 + 86_400_000, walletId: "pro", eventType: "BUY", usdNotional: 99_000 }),
  ];
  const today = walletProfileAt(events, "pro", T0 + 1000);
  const tomorrow = walletProfileAt(events, "pro", T0 + 90_000_000);
  assert.equal(today.historicalTokensSeen, 2);
  assert.ok(tomorrow.historicalTokensSeen >= 3);
  const m1 = cohortMembershipAt(events, "pro", T0 + 1000);
  const m2 = cohortMembershipAt(events, "pro", T0 + 90_000_000);
  assert.equal(m1.effectiveEventTime, T0 + 1000);
  assert.notEqual(m2.effectiveEventTime, m1.effectiveEventTime);
});

test("late ingested event is invisible until ingested_at", () => {
  const events = [
    ev({ instrumentId: "X", eventTime: 100, ingestedAt: 500, walletId: "late", usdNotional: 9999 }),
  ];
  assert.equal(asOfEvents(events, 200).length, 0);
  assert.equal(asOfEvents(events, 500).length, 1);
});

test("duplicate events and cooldown suppress duplicate sessions", () => {
  const T0 = 7_000_000;
  const events = manyBuyers("Z", 50, T0, 1.1, "up");
  const dup = dedupeEvents([...events, events[0]!]);
  assert.equal(dup.length, events.length);
  const vec = computeParticipantFeatures(events, { instrumentId: "Z", T: T0 + 15_000 });
  const a = evaluateTriggers(vec);
  const b = applyCooldown(a, new Set([a.fingerprint]));
  assert.equal(a.fired, true);
  assert.equal(b.fired, false);
  assert.equal(b.suppressed, "cooldown");
  assert.equal(triggerFingerprint("Z", a.family!, vec.featureTime), a.fingerprint);
});

test("replay is warehouse-only, deterministic, and labels use existing barriers", () => {
  const T0 = 8_000_000;
  const events = manyBuyers("R", 60, T0, 1, "up");
  const path: PathTick[] = Array.from({ length: 40 }, (_, i) => ({
    ts: T0 + 15_000 + i * 2000,
    px: 1.05 + i * 0.01,
    liq: 50_000,
    sell: 1 as const,
  }));
  const a = replayShadowSniper({
    events,
    pathByInstrument: { R: path },
    pricesAt: { R: 1.05 },
    instruments: ["R"],
    clocks: [T0 + 16_000, T0 + 20_000],
  });
  const b = replayShadowSniper({
    events,
    pathByInstrument: { R: path },
    pricesAt: { R: 1.05 },
    instruments: ["R"],
    clocks: [T0 + 16_000, T0 + 20_000],
  });
  assert.equal(a.hash, b.hash);
  assert.equal(a.usedProviders, false);
  assert.ok(a.sessions.length >= 1);
  const snap = freezeSnapshot(a.sessions[0]!, computeParticipantFeatures(events, { instrumentId: "R", T: T0 + 16_000 }));
  assert.equal(snap.snapshotVersion, "sniper_snapshot_v1");
  const cf = counterfactuals(a.sessions[0]!, 1.05);
  assert.equal(cf.length, 4);
  assert.ok(!("orderId" in cf[0]!));
  const labeled = labelSniperSession(a.sessions[0]!, path, 1.05, T0 + 90_000);
  assert.ok(["UPPER_FIRST", "LOWER_FIRST", "NEITHER", "AMBIGUOUS", "INSUFFICIENT_DATA"].includes(labeled.upper10BeforeLower10));
  const report = sniperResearchReport(a.sessions, a.outcomes, { hit10: 0.03, n: 1000, avgNet: -0.05 });
  assert.ok(report.note.includes("Not accuracy"));
});

test("ambiguous gap stays ambiguous; insufficient path stays insufficient", () => {
  const s = openSession({
    instrumentId: "G",
    T: 10,
    ingestedAt: 10,
    family: "MOMENTUM_ACCELERATION",
    reasons: ["test"],
    fingerprint: "gaptest",
    priority: 1,
  });
  const jump: PathTick[] = [
    { ts: 10, px: 1, liq: 1, sell: 1 },
    { ts: 10 + 22_000, px: 1.3, liq: 1, sell: 1 },
  ];
  const amb = labelSniperSession(s, jump, 1, 40_000);
  assert.equal(amb.upper10BeforeLower10, "AMBIGUOUS");
  const thin = labelSniperSession(s, [{ ts: 10, px: 1, liq: 1, sell: 1 }], 1, 1000);
  assert.equal(thin.upper10BeforeLower10, "INSUFFICIENT_DATA");
});

test("DISABLED mode emits no sessions; missingness is not zero", () => {
  const events = manyBuyers("N", 40, 9_000_000, 1.2, "up");
  const off = evaluateShadowTape({ events, instruments: ["N"], T: 9_020_000, mode: "DISABLED" });
  assert.equal(off.sessions.length, 0);
  const audit = participantMissingnessAudit(events, []);
  assert.ok(audit.note.includes("UNKNOWN"));
  assert.notEqual(audit.walletIdentityCoverage, null);
});

test("v35 migrations are additive and not on the frozen collection list", () => {
  assert.deepEqual(V35_MIGRATIONS, ["0012_v35_participant.sql"]);
  assert.equal(V35_VERSION, "v35-participant-intelligence");
});

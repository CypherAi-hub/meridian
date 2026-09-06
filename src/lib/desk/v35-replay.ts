import { createHash } from "node:crypto";
import { evaluateShadowTape } from "./v35-sniper.ts";
import { labelSniperSession } from "./v35-labels.ts";
import { asOfEvents } from "./v35-clock.ts";
import type { PathTick } from "./types.ts";
import type { ParticipantEvent, SniperSession } from "./v35-types.ts";

export type SniperReplayInput = {
  events: ParticipantEvent[];
  pathByInstrument: Record<string, PathTick[]>;
  pricesAt: Record<string, number>;
  instruments: string[];
  clocks: number[];
  maxSessions?: number;
};

export function replayShadowSniper(input: SniperReplayInput) {
  const fingerprints = new Set<string>();
  const sessions: SniperSession[] = [];
  for (const T of input.clocks) {
    const visibleEvents = asOfEvents(input.events, T);
    const step = evaluateShadowTape({
      events: visibleEvents,
      instruments: input.instruments,
      T,
      recentFingerprints: fingerprints,
      maxSessions: input.maxSessions,
      mode: "SHADOW",
    });
    sessions.push(...step.sessions);
  }
  const outcomes = sessions.map((s) => {
    const path = (input.pathByInstrument[s.instrumentId] ?? []).filter((p) => p.ts >= s.triggerTime);
    const px = input.pricesAt[s.instrumentId] ?? path[0]?.px ?? 1;
    const last = path.at(-1)?.ts ?? s.triggerTime;
    return labelSniperSession(s, path, px, last + 1);
  });
  const hash = createHash("sha256")
    .update(JSON.stringify({ ids: sessions.map((s) => s.id), fps: sessions.map((s) => s.fingerprint) }))
    .digest("hex")
    .slice(0, 16);
  return { sessions, outcomes, hash, usedProviders: false };
}

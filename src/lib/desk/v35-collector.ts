import { parseSniperMode, assertTrainingStillLocked } from "./v35-lock.ts";
import { assertShadowWarehouse } from "./v35-dev-lease.ts";
import { fetchHeliusParticipantEvents } from "./v35-helius.ts";
import { dedupeEvents } from "./v35-normalize.ts";
import { computeParticipantFeatures } from "./v35-features.ts";
import { evaluateShadowTape } from "./v35-sniper.ts";
import { walletProfileAt } from "./v35-wallets.ts";
import type { ParticipantEvent, SniperSession } from "./v35-types.ts";

export const V35_1_VERSION = "v35.1-participant-collector";
export const MAX_MINTS_PER_TICK = 8;
export const MAX_TX_PER_MINT = 20;

export type CollectorTick = {
  at: number;
  mints: string[];
  events: ParticipantEvent[];
  eventsIngested: number;
  sessions: SniperSession[];
  providerUnknown: number;
  errors: string[];
};

export function parseWatchMints(raw?: string | null): string[] {
  return (raw ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_MINTS_PER_TICK);
}

export async function runCollectorTick(opts: {
  mints: string[];
  apiKey: string | null;
  events?: ParticipantEvent[];
  ingestedAt?: number;
  fetchImpl?: typeof fetch;
  sniperMode?: string;
}): Promise<CollectorTick> {
  parseSniperMode(opts.sniperMode ?? "SHADOW");
  assertTrainingStillLocked();
  const at = opts.ingestedAt ?? Date.now();
  const mints = opts.mints.slice(0, MAX_MINTS_PER_TICK);
  const bag: ParticipantEvent[] = [...(opts.events ?? [])];
  const errors: string[] = [];
  let providerUnknown = 0;
  for (const mint of mints) {
    const got = await fetchHeliusParticipantEvents(mint, {
      apiKey: opts.apiKey,
      ingestedAt: at,
      limit: MAX_TX_PER_MINT,
      fetchImpl: opts.fetchImpl,
    });
    if (!got.ok) {
      providerUnknown += 1;
      if (got.error) errors.push(`${mint}: ${got.error}`);
      continue;
    }
    bag.push(...got.events);
  }
  const events = dedupeEvents(bag);
  const tape = evaluateShadowTape({
    events,
    instruments: mints,
    T: at,
    mode: opts.sniperMode ?? "SHADOW",
  });
  return {
    at,
    mints,
    events,
    eventsIngested: events.length,
    sessions: tape.sessions,
    providerUnknown,
    errors,
  };
}

export function profilesForTick(events: ParticipantEvent[], T: number) {
  const wallets = [...new Set(events.map((e) => e.walletId).filter((w) => w !== "UNKNOWN"))].slice(0, 50);
  return wallets.map((w) => walletProfileAt(events, w, T));
}

export function collectorBootGuard(env: NodeJS.ProcessEnv = process.env) {
  parseSniperMode(env.SNIPER_MODE ?? "SHADOW");
  return assertShadowWarehouse(env);
}

export type WatchTier = "universe" | "active";

export const UNIVERSE_INTERVAL_MS = 15_000;
export const ACTIVE_INTERVAL_MS = 4_000;
export const ACTIVE_HOLD_MS = 60 * 60_000;

export type WatchState = {
  mint: string;
  tier: WatchTier;
  nextDueAt: number;
  promotedAt: number | null;
  expiresAt: number | null;
  reason: string | null;
};

export function desiredIntervalMs(tier: WatchTier): number {
  return tier === "active" ? ACTIVE_INTERVAL_MS : UNIVERSE_INTERVAL_MS;
}

export function shouldPromote(opts: {
  considered?: boolean;
  edgeScore?: number | null;
  volAccel?: number | null;
  liqChange?: number | null;
}): boolean {
  if (opts.considered) return true;
  if ((opts.edgeScore ?? 0) >= 55) return true;
  if ((opts.volAccel ?? 0) >= 2) return true;
  if ((opts.liqChange ?? 0) >= 0.2) return true;
  return false;
}

export function promoteWatch(mint: string, now: number, reason: string): WatchState {
  return {
    mint,
    tier: "active",
    nextDueAt: now,
    promotedAt: now,
    expiresAt: now + ACTIVE_HOLD_MS,
    reason,
  };
}

export function expireWatch(state: WatchState, now: number, opts: { dead?: boolean; collapsed?: boolean; complete?: boolean }): WatchState {
  const expired = Boolean(
    opts.dead || opts.collapsed || opts.complete || (state.expiresAt != null && now >= state.expiresAt),
  );
  if (!expired) return state;
  return {
    ...state,
    tier: "universe",
    nextDueAt: now + UNIVERSE_INTERVAL_MS,
    reason: opts.dead ? "dead" : opts.collapsed ? "liq_collapse" : opts.complete ? "horizon" : "expired",
  };
}

export function dueWatches(states: WatchState[], now: number, limit = 24): WatchState[] {
  return states
    .filter((s) => s.nextDueAt <= now)
    .sort((a, b) => a.nextDueAt - b.nextDueAt)
    .slice(0, limit);
}

export function bumpDue(state: WatchState, now: number): WatchState {
  return { ...state, nextDueAt: now + desiredIntervalMs(state.tier) };
}

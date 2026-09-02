export type WatchTier = "universe" | "active";
export type WatchPhase = "UNIVERSE" | "PROMOTING" | "ACTIVE" | "COOLDOWN" | "EXPIRED";

export const UNIVERSE_INTERVAL_MS = 15_000;
export const ACTIVE_INTERVAL_MS = 3_000;
export const ACTIVE_HOLD_MS = 60 * 60_000;
export const MAX_ACTIVE_WATCHES = 25;
export const SLOW_ENRICHMENT_MS = 45_000;

export type WatchState = {
  mint: string;
  tier: WatchTier;
  phase: WatchPhase;
  nextDueAt: number;
  promotedAt: number | null;
  expiresAt: number | null;
  reason: string | null;
  urgency: number;
};

export type ResearchUrgencyContext = {
  hasOpenPaperPosition?: boolean;
  hasPendingLabel?: boolean;
  wasJustConsidered?: boolean;
  isNewLaunch?: boolean;
  edgeScore?: number | null;
};

export function desiredIntervalMs(tier: WatchTier): number {
  return tier === "active" ? ACTIVE_INTERVAL_MS : UNIVERSE_INTERVAL_MS;
}

export function researchUrgency(ctx: ResearchUrgencyContext): number {
  let score = 0;
  if (ctx.hasOpenPaperPosition) score += 1000;
  if (ctx.hasPendingLabel) score += 500;
  if (ctx.wasJustConsidered) score += 300;
  if (ctx.isNewLaunch) score += 100;
  score += Math.min(100, ctx.edgeScore ?? 0);
  return score;
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

export function promoteWatch(mint: string, now: number, reason: string, urgency = 0): WatchState {
  return {
    mint,
    tier: "active",
    phase: "PROMOTING",
    nextDueAt: now,
    promotedAt: now,
    expiresAt: now + ACTIVE_HOLD_MS,
    reason,
    urgency,
  };
}

export function activateWatch(state: WatchState): WatchState {
  if (state.tier !== "active") return state;
  return { ...state, phase: "ACTIVE" };
}

export function expireWatch(
  state: WatchState,
  now: number,
  opts: { dead?: boolean; collapsed?: boolean; complete?: boolean },
): WatchState {
  const expired = Boolean(
    opts.dead || opts.collapsed || opts.complete || (state.expiresAt != null && now >= state.expiresAt),
  );
  if (!expired) return state;
  return {
    ...state,
    tier: "universe",
    phase: opts.complete ? "COOLDOWN" : "EXPIRED",
    nextDueAt: now + UNIVERSE_INTERVAL_MS,
    reason: opts.dead ? "dead" : opts.collapsed ? "liq_collapse" : opts.complete ? "horizon" : "expired",
  };
}

export function demoteWatch(state: WatchState, now: number, reason: string): WatchState {
  return {
    ...state,
    tier: "universe",
    phase: "UNIVERSE",
    nextDueAt: now + UNIVERSE_INTERVAL_MS,
    reason,
  };
}

export function selectActiveWatches(
  candidates: Array<{ mint: string; urgency: number }>,
  max = MAX_ACTIVE_WATCHES,
): { keep: string[]; demote: string[] } {
  const ranked = [...candidates].sort((a, b) => b.urgency - a.urgency);
  return {
    keep: ranked.slice(0, max).map((c) => c.mint),
    demote: ranked.slice(max).map((c) => c.mint),
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

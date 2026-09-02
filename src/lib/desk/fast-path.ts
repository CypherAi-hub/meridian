import type { RouteState, TokenSnapshot } from "./schema.ts";
import { observationFingerprint } from "./fingerprint.ts";

export const FAST_PATH_FIELDS = ["priceUsd", "liquidityUsd", "routeState"] as const;
export const SLOW_ENRICHMENT_FIELDS = ["holders", "security", "jupiter", "features"] as const;

export type FastPathSample = {
  mint: string;
  eventTime: number;
  ingestedAt: number;
  priceUsd: number | null;
  liquidityUsd: number | null;
  routeState?: RouteState | null;
  slot?: number | null;
  source: string;
  sampleFingerprint: string;
};

export function toFastPathSample(t: TokenSnapshot): FastPathSample {
  const eventTime = t.priceUsd.eventTime || Date.now();
  const ingestedAt = t.priceUsd.ingestedAt || Date.now();
  return {
    mint: t.address,
    eventTime,
    ingestedAt,
    priceUsd: t.priceUsd.value,
    liquidityUsd: t.liquidityUsd.value,
    routeState: t.sellQuote?.routeState ?? null,
    source: String(t.priceUsd.source),
    sampleFingerprint: observationFingerprint({
      mint: t.address,
      eventTime,
      price: t.priceUsd.value,
      liquidity: t.liquidityUsd.value,
      provider: String(t.priceUsd.source),
    }),
  };
}

export function watchDeadline(opts: {
  scheduledAt: number;
  startedAt: number;
  completedAt: number;
  deadlineMs: number;
}) {
  const queueDelayMs = Math.max(0, opts.startedAt - opts.scheduledAt);
  const totalDelayMs = Math.max(0, opts.completedAt - opts.scheduledAt);
  return {
    queueDelayMs,
    totalDelayMs,
    deadlineMissed: totalDelayMs > opts.deadlineMs,
  };
}

export function fastPathForbidden(step: string) {
  return (SLOW_ENRICHMENT_FIELDS as readonly string[]).includes(step);
}

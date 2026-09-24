import type { QuoteObs } from "./schema.ts";

export type RouteJobReason =
  | "OPEN_POSITION"
  | "CANDIDATE"
  | "LABEL_ROUTE_LOSS"
  | "NEAR_THRESHOLD"
  | "RESEARCH";

export type RouteJob = {
  mint: string;
  priority: number;
  reason: RouteJobReason;
  lastQuotedAt?: number | null;
};

export function routePriority(reason: RouteJobReason): number {
  switch (reason) {
    case "OPEN_POSITION":
      return 0;
    case "CANDIDATE":
      return 1;
    case "LABEL_ROUTE_LOSS":
      return 2;
    case "NEAR_THRESHOLD":
      return 3;
    default:
      return 4;
  }
}

export function selectRouteJobs(jobs: RouteJob[], limit: number): RouteJob[] {
  return [...jobs].sort((a, b) => a.priority - b.priority ||
    (a.lastQuotedAt ?? -Infinity) - (b.lastQuotedAt ?? -Infinity)).slice(0, Math.max(0, limit));
}

export const ROUTE_TTL_MS = 45_000;
export const CRITICAL_ROUTE_TTL_MS = 8_000;

export function shouldRefreshRoute(opts: {
  lastQuotedAt: number | null;
  now: number;
  priority: number;
}): boolean {
  if (opts.lastQuotedAt == null) return true;
  const age = opts.now - opts.lastQuotedAt;
  const ttl = opts.priority <= 1 ? CRITICAL_ROUTE_TTL_MS : ROUTE_TTL_MS;
  return age >= ttl;
}

/** Preserve the quote's actual timestamps; a cache hit is not a new quote. */
export function routeObservedAt(quote: QuoteObs | null | undefined, now: number): number | null {
  if (!quote || !Number.isFinite(quote.ingestedAt) || !Number.isFinite(quote.eventTime) ||
      quote.ingestedAt < 0 || quote.eventTime < 0 || quote.ingestedAt > now || quote.eventTime > now ||
      !quote.routeState || !['QUOTE_ONLY','ROUTABLE','NO_ROUTE','TIMEOUT','RATE_LIMITED','ERROR'].includes(quote.routeState) ||
      quote.failureReason === 'NOT_CHECKED') return null;
  return Math.min(quote.ingestedAt, quote.eventTime);
}

export function freshCachedRoute(quote: QuoteObs | null | undefined, now: number, priority: number): QuoteObs | null {
  const at = routeObservedAt(quote, now);
  return at == null || shouldRefreshRoute({lastQuotedAt:at,now,priority}) ? null : quote!;
}

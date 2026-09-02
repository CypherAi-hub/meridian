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
  return [...jobs].sort((a, b) => a.priority - b.priority).slice(0, Math.max(0, limit));
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

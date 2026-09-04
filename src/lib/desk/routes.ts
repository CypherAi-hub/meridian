export type RouteState = "ROUTABLE" | "QUOTE_ONLY" | "NO_ROUTE" | "UNKNOWN" | "TIMEOUT" | "RATE_LIMITED" | "ERROR";

export type RouteFailureReason =
  | "NO_ROUTE"
  | "TOKEN_UNSUPPORTED"
  | "QUOTE_TIMEOUT"
  | "PROVIDER_ERROR"
  | "INSUFFICIENT_LIQUIDITY"
  | "INVALID_MINT"
  | "RATE_LIMIT"
  | "STALE_TOKEN"
  | "NOT_CHECKED"
  | "CIRCUIT_OPEN"
  | "UNKNOWN_ERROR";

export function classifyRouteFailure(message: string | null | undefined, httpStatus?: number | null): RouteFailureReason {
  if (httpStatus === 429) return "RATE_LIMIT";
  if (httpStatus === 404) return "TOKEN_UNSUPPORTED";
  const msg = (message ?? "").toLowerCase();
  if (!msg) return "UNKNOWN_ERROR";
  if (msg.includes("not_checked") || msg.includes("not checked")) return "NOT_CHECKED";
  if (msg.includes("rate budget") || msg.includes("budget empty")) return "NOT_CHECKED";
  if (msg.includes("circuit")) return "CIRCUIT_OPEN";
  if (msg.includes("timeout") || msg.includes("aborted") || msg.includes("timed out")) return "QUOTE_TIMEOUT";
  if (msg.includes("429") || msg.includes("rate limit")) return "RATE_LIMIT";
  if (msg.includes("could not find") || msg.includes("no route") || msg.includes("no routes") || msg.includes("route not found"))
    return "NO_ROUTE";
  if (msg.includes("not tradable") || msg.includes("unsupported") || msg.includes("token_not_tradable"))
    return "TOKEN_UNSUPPORTED";
  if (msg.includes("insufficient") || msg.includes("liquidity")) return "INSUFFICIENT_LIQUIDITY";
  if (msg.includes("invalid mint") || msg.includes("invalid public key")) return "INVALID_MINT";
  if (msg.includes("http 5") || msg.includes("provider")) return "PROVIDER_ERROR";
  if (msg.startsWith("http ")) return "PROVIDER_ERROR";
  return "UNKNOWN_ERROR";
}

export function routeStateFromFailure(reason: RouteFailureReason): RouteState {
  switch (reason) {
    case "NO_ROUTE":
    case "TOKEN_UNSUPPORTED":
    case "INVALID_MINT":
    case "INSUFFICIENT_LIQUIDITY":
      return "NO_ROUTE";
    case "QUOTE_TIMEOUT":
      return "TIMEOUT";
    case "RATE_LIMIT":
    case "CIRCUIT_OPEN":
      return "RATE_LIMITED";
    case "NOT_CHECKED":
    case "STALE_TOKEN":
      return "UNKNOWN";
    default:
      return "ERROR";
  }
}

export function governorRoutePolicy(state: RouteState | null | undefined): "PASS" | "FAIL" | "UNKNOWN" {
  if (state === "ROUTABLE" || state === "QUOTE_ONLY") return "PASS";
  if (state === "NO_ROUTE") return "FAIL";
  return "UNKNOWN";
}

export function routeStateOf(opts: {
  available?: boolean;
  routeState?: RouteState | null;
  error?: string | null;
}): RouteState {
  if (opts.routeState) return opts.routeState;
  if (opts.available) return "ROUTABLE";
  if (!opts.error && opts.available === false) return "NO_ROUTE";
  if (!opts.error) return "UNKNOWN";
  return routeStateFromFailure(classifyRouteFailure(opts.error));
}

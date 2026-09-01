import { HEARTBEAT_STALE_MS, STALE_MS, type FieldObs, type QuoteObs, type TokenSnapshot } from "./schema.ts";

/**
 * A decision at T may only use fields Meridian had received by T.
 * event_time is when the market moved; ingested_at is when we learned it.
 */
export function usableAt<T>(obs: FieldObs<T>, decisionTime: number): boolean {
  const status = obs.status ?? (obs.value == null ? "UNKNOWN" : "VALID");
  return status === "VALID" && obs.ingestedAt <= decisionTime && obs.value != null;
}

export function asOfField<T>(obs: FieldObs<T>, decisionTime: number): FieldObs<T> {
  if (obs.ingestedAt > decisionTime) {
    return {
      ...obs,
      value: null,
      stale: true,
      error: "ingested_after_decision",
      status: "UNKNOWN",
    };
  }
  const stale = decisionTime - obs.ingestedAt > STALE_MS;
  return { ...obs, stale, error: stale ? obs.error ?? "stale" : obs.error, status: stale ? "STALE" : obs.status };
}

export function asOfQuote(quote: QuoteObs | null, decisionTime: number): QuoteObs | null {
  if (!quote) return null;
  if (quote.ingestedAt > decisionTime) return null;
  return quote;
}

export function asOfSnapshot(snap: TokenSnapshot, decisionTime: number): TokenSnapshot {
  return {
    ...snap,
    priceUsd: asOfField(snap.priceUsd, decisionTime),
    priceCrossUsd: asOfField(snap.priceCrossUsd, decisionTime),
    liquidityUsd: asOfField(snap.liquidityUsd, decisionTime),
    mcapUsd: asOfField(snap.mcapUsd, decisionTime),
    fdvUsd: asOfField(snap.fdvUsd, decisionTime),
    volume1mUsd: asOfField(snap.volume1mUsd, decisionTime),
    volume5mUsd: asOfField(snap.volume5mUsd, decisionTime),
    volume1hUsd: asOfField(snap.volume1hUsd, decisionTime),
    buys5m: asOfField(snap.buys5m, decisionTime),
    sells5m: asOfField(snap.sells5m, decisionTime),
    uniqueBuyers5m: asOfField(snap.uniqueBuyers5m, decisionTime),
    uniqueSellers5m: asOfField(snap.uniqueSellers5m, decisionTime),
    holders: asOfField(snap.holders, decisionTime),
    top10Pct: asOfField(snap.top10Pct, decisionTime),
    mintAuth: asOfField(snap.mintAuth, decisionTime),
    freezeAuth: asOfField(snap.freezeAuth, decisionTime),
    buyQuote: asOfQuote(snap.buyQuote, decisionTime),
    sellQuote: asOfQuote(snap.sellQuote, decisionTime),
  };
}

export function cooldownKey(
  mint: string,
  strategyVersion: string,
  decisionTime: number,
  cooldownMs = 20_000,
) {
  return `${mint}:${strategyVersion}:${Math.floor(decisionTime / cooldownMs)}`;
}

export function workerStatusFromHeartbeat(
  lastTickMs: number | null,
  lastError: string | null,
  now = Date.now(),
  staleMs = HEARTBEAT_STALE_MS,
): "live" | "offline" | "starting" {
  if (!lastTickMs) return "starting";
  if (lastError) return "offline";
  if (now - lastTickMs > staleMs) return "offline";
  return "live";
}


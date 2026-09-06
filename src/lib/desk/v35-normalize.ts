import { PARTICIPANT_EVENT_SCHEMA } from "./v35-lock.ts";
import type { DataStatus, ParticipantCapability, ParticipantEvent, ParticipantEventType } from "./v35-types.ts";

export type RawParticipantHint = {
  instrumentId: string;
  tokenMint?: string | null;
  eventTime: number;
  ingestedAt: number;
  providerId: string;
  providerEventId?: string | null;
  side?: "buy" | "sell" | "transfer" | "liq_add" | "liq_remove" | "unknown";
  walletId?: string | null;
  usdNotional?: number | null;
  observedPrice?: number | null;
  liquidityDelta?: number | null;
};

export const SOLANA_CAPABILITIES: ParticipantCapability[] = [
  "WALLET_TX_FLOW",
  "HOLDER_LIST",
  "LIQUIDITY_EVENTS",
  "ROUTE_ACTIVITY",
  "FIRST_SEEN",
];

export function capabilityOrUnknown(have: ParticipantCapability[], need: ParticipantCapability): DataStatus {
  return have.includes(need) ? "OK" : "NOT_APPLICABLE";
}

function eventType(side: RawParticipantHint["side"]): ParticipantEventType {
  if (side === "buy") return "BUY";
  if (side === "sell") return "SELL";
  if (side === "transfer") return "TRANSFER";
  if (side === "liq_add") return "LIQUIDITY_ADD";
  if (side === "liq_remove") return "LIQUIDITY_REMOVE";
  return "UNKNOWN";
}

export function normalizeParticipantEvent(raw: RawParticipantHint, epoch = "v33b_production"): ParticipantEvent {
  const wallet = (raw.walletId ?? "").trim();
  return {
    id: `${raw.providerId}:${raw.providerEventId ?? `${raw.eventTime}:${wallet}:${raw.side}`}`,
    instrumentId: raw.instrumentId,
    tokenMint: raw.tokenMint ?? raw.instrumentId,
    eventTime: raw.eventTime,
    ingestedAt: raw.ingestedAt,
    providerId: raw.providerId,
    providerEventId: raw.providerEventId ?? null,
    eventType: eventType(raw.side),
    walletId: wallet || "UNKNOWN",
    counterpartyId: null,
    baseAmount: null,
    quoteAmount: null,
    usdNotional: raw.usdNotional ?? null,
    observedPrice: raw.observedPrice ?? null,
    transactionSignature: raw.providerEventId ?? null,
    dataStatus: wallet ? "OK" : "UNKNOWN",
    collectionEpoch: epoch,
    schemaVersion: PARTICIPANT_EVENT_SCHEMA,
  };
}

export function fingerprintEvent(e: ParticipantEvent): string {
  return [e.instrumentId, e.eventTime, e.walletId, e.eventType, e.providerEventId ?? e.id].join("|");
}

export function dedupeEvents(events: ParticipantEvent[]): ParticipantEvent[] {
  const seen = new Set<string>();
  const out: ParticipantEvent[] = [];
  for (const e of events) {
    const k = fingerprintEvent(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

import { normalizeParticipantEvent, type RawParticipantHint } from "./v35-normalize.ts";
import type { ParticipantEvent } from "./v35-types.ts";

export type HeliusTokenTransfer = {
  fromUserAccount?: string;
  toUserAccount?: string;
  mint?: string;
  tokenAmount?: number | string;
};

export type HeliusEnhancedTx = {
  signature?: string;
  timestamp?: number;
  type?: string;
  source?: string;
  tokenTransfers?: HeliusTokenTransfer[];
  nativeTransfers?: Array<{ amount?: number }>;
};

export type HeliusFetchResult = {
  ok: boolean;
  events: ParticipantEvent[];
  error?: string;
  providerStatus: "OK" | "UNKNOWN";
};

export function mapHeliusTx(tx: HeliusEnhancedTx, mint: string, ingestedAt: number): RawParticipantHint[] {
  const eventTime = (tx.timestamp ?? 0) * 1000;
  if (!eventTime) return [];
  const transfers = (tx.tokenTransfers ?? []).filter((t) => t.mint === mint);
  if (!transfers.length) return [];
  const out: RawParticipantHint[] = [];
  for (const tr of transfers) {
    const amount = typeof tr.tokenAmount === "number" ? tr.tokenAmount : Number(tr.tokenAmount);
    const notional = Number.isFinite(amount) ? amount : null;
    const base = {
      instrumentId: mint,
      tokenMint: mint,
      eventTime,
      ingestedAt,
      providerId: "helius" as const,
      providerEventId: tx.signature ?? null,
      usdNotional: notional,
      observedPrice: null,
    };
    const t = (tx.type ?? "").toUpperCase();
    if (t.includes("ADD_LIQUIDITY") || t.includes("INCREASE_LIQUIDITY")) {
      out.push({ ...base, side: "liq_add", walletId: tr.toUserAccount || tr.fromUserAccount || null });
      continue;
    }
    if (t.includes("REMOVE_LIQUIDITY") || t.includes("DECREASE_LIQUIDITY")) {
      out.push({ ...base, side: "liq_remove", walletId: tr.fromUserAccount || tr.toUserAccount || null });
      continue;
    }
    if (tr.fromUserAccount) out.push({ ...base, side: t === "TRANSFER" ? "transfer" : "sell", walletId: tr.fromUserAccount });
    if (tr.toUserAccount) out.push({ ...base, side: t === "TRANSFER" ? "transfer" : "buy", walletId: tr.toUserAccount });
  }
  return out;
}

export function heliusHistoryUrl(mint: string, apiKey: string, limit = 20): string {
  const u = new URL(`https://api.helius.xyz/v0/addresses/${mint}/transactions`);
  u.searchParams.set("api-key", apiKey);
  u.searchParams.set("limit", String(limit));
  return u.toString();
}

export async function fetchHeliusParticipantEvents(
  mint: string,
  opts: {
    apiKey: string | null;
    ingestedAt?: number;
    limit?: number;
    fetchImpl?: typeof fetch;
  },
): Promise<HeliusFetchResult> {
  if (!opts.apiKey) {
    return { ok: false, events: [], error: "HELIUS_API_KEY missing", providerStatus: "UNKNOWN" };
  }
  const ingestedAt = opts.ingestedAt ?? Date.now();
  try {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const r = await fetchImpl(heliusHistoryUrl(mint, opts.apiKey, opts.limit ?? 20), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      return { ok: false, events: [], error: `helius ${r.status}`, providerStatus: "UNKNOWN" };
    }
    const body = (await r.json()) as HeliusEnhancedTx[] | { error?: string };
    if (!Array.isArray(body)) {
      return { ok: false, events: [], error: "helius payload not array", providerStatus: "UNKNOWN" };
    }
    const events = body.flatMap((tx) => mapHeliusTx(tx, mint, ingestedAt)).map((raw) => normalizeParticipantEvent(raw, "v35_shadow"));
    return { ok: true, events, providerStatus: "OK" };
  } catch (e) {
    return {
      ok: false,
      events: [],
      error: e instanceof Error ? e.message : "helius failed",
      providerStatus: "UNKNOWN",
    };
  }
}

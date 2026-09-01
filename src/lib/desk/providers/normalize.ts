import type { FieldObs, QuoteObs, SourceId, TokenSnapshot } from "../schema";

export function field<T>(
  value: T | null,
  eventTime: number,
  ingestedAt: number,
  source: SourceId | "derived",
): FieldObs<T> {
  return {
    value,
    eventTime,
    ingestedAt,
    source,
    lagMs: Math.max(0, ingestedAt - eventTime),
  };
}

export function emptyField<T>(
  eventTime: number,
  ingestedAt: number,
  source: SourceId | "derived",
): FieldObs<T> {
  return field<T>(null, eventTime, ingestedAt, source);
}

export function ageMs(obs: FieldObs<unknown> | null | undefined, now: number) {
  if (!obs) return Number.POSITIVE_INFINITY;
  return now - obs.ingestedAt;
}

export function prefer<T>(primary: FieldObs<T>, fallback: FieldObs<T>): FieldObs<T> {
  return primary.value != null ? primary : fallback;
}

export function blankSnapshot(
  address: string,
  eventTime: number,
  ingestedAt: number,
): TokenSnapshot {
  return {
    address,
    pairAddress: "",
    symbol: "UNK",
    name: "unknown",
    decimals: 6,
    createdAt: null,
    priceUsd: emptyField(eventTime, ingestedAt, "dexscreener"),
    priceCrossUsd: emptyField(eventTime, ingestedAt, "geckoterminal"),
    liquidityUsd: emptyField(eventTime, ingestedAt, "dexscreener"),
    mcapUsd: emptyField(eventTime, ingestedAt, "dexscreener"),
    fdvUsd: emptyField(eventTime, ingestedAt, "dexscreener"),
    volume1mUsd: emptyField(eventTime, ingestedAt, "derived"),
    volume5mUsd: emptyField(eventTime, ingestedAt, "dexscreener"),
    volume1hUsd: emptyField(eventTime, ingestedAt, "dexscreener"),
    buys5m: emptyField(eventTime, ingestedAt, "dexscreener"),
    sells5m: emptyField(eventTime, ingestedAt, "dexscreener"),
    uniqueBuyers5m: emptyField(eventTime, ingestedAt, "geckoterminal"),
    uniqueSellers5m: emptyField(eventTime, ingestedAt, "geckoterminal"),
    holders: emptyField(eventTime, ingestedAt, "solana"),
    top10Pct: emptyField(eventTime, ingestedAt, "solana"),
    mintAuth: emptyField(eventTime, ingestedAt, "solana"),
    freezeAuth: emptyField(eventTime, ingestedAt, "solana"),
    buyQuote: null,
    sellQuote: null,
  };
}

export function mergeSnap(a: TokenSnapshot, b: TokenSnapshot): TokenSnapshot {
  return {
    address: a.address || b.address,
    pairAddress: a.pairAddress || b.pairAddress,
    symbol: a.symbol !== "UNK" ? a.symbol : b.symbol,
    name: a.name !== "unknown" ? a.name : b.name,
    decimals: a.decimals !== 6 ? a.decimals : b.decimals,
    createdAt: a.createdAt ?? b.createdAt,
    priceUsd: prefer(a.priceUsd, b.priceUsd),
    priceCrossUsd: prefer(b.priceUsd.source !== a.priceUsd.source ? b.priceUsd : a.priceCrossUsd, a.priceCrossUsd),
    liquidityUsd: prefer(a.liquidityUsd, b.liquidityUsd),
    mcapUsd: prefer(a.mcapUsd, b.mcapUsd),
    fdvUsd: prefer(a.fdvUsd, b.fdvUsd),
    volume1mUsd: prefer(a.volume1mUsd, b.volume1mUsd),
    volume5mUsd: prefer(a.volume5mUsd, b.volume5mUsd),
    volume1hUsd: prefer(a.volume1hUsd, b.volume1hUsd),
    buys5m: prefer(a.buys5m, b.buys5m),
    sells5m: prefer(a.sells5m, b.sells5m),
    uniqueBuyers5m: prefer(a.uniqueBuyers5m, b.uniqueBuyers5m),
    uniqueSellers5m: prefer(a.uniqueSellers5m, b.uniqueSellers5m),
    holders: prefer(a.holders, b.holders),
    top10Pct: prefer(a.top10Pct, b.top10Pct),
    mintAuth: prefer(a.mintAuth, b.mintAuth),
    freezeAuth: prefer(a.freezeAuth, b.freezeAuth),
    buyQuote: a.buyQuote ?? b.buyQuote,
    sellQuote: a.sellQuote ?? b.sellQuote,
  };
}

export function deriveVolume1m(volume5m: FieldObs<number>, eventTime: number, ingestedAt: number): FieldObs<number> {
  if (volume5m.value == null) return emptyField(eventTime, ingestedAt, "derived");
  return field(volume5m.value / 5, eventTime, ingestedAt, "derived");
}

export function blankQuote(
  inMint: string,
  outMint: string,
  amount: string,
  notionalUsd: number,
  error: string,
  latencyMs = 0,
): QuoteObs {
  const now = Date.now();
  return {
    available: false,
    inMint,
    outMint,
    inAmount: amount,
    outAmount: "0",
    notionalUsd,
    priceImpactPct: null,
    impliedPriceUsd: null,
    routeLabels: [],
    latencyMs,
    eventTime: now,
    ingestedAt: now,
    source: "jupiter",
    error,
  };
}

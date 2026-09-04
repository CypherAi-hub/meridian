import type { TokenSnapshot } from "../schema";
import { blankSnapshot, deriveVolume1m, field, mergeSnap } from "./normalize";
import { getJson, getJsonRetry } from "./http";

type DsPair = {
  chainId?: string;
  pairAddress?: string;
  dexId?: string;
  baseToken?: { address: string; symbol: string; name: string };
  quoteToken?: { address: string };
  priceUsd?: string;
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  liquidity?: { usd?: number };
  volume?: { m5?: number; h1?: number };
  txns?: { m5?: { buys?: number; sells?: number } };
};

const WSOL = "So11111111111111111111111111111111111111112";

function pairToSnap(p: DsPair, eventTime: number, ingestedAt: number): TokenSnapshot | null {
  const base = p.baseToken;
  if (!base?.address) return null;
  if (p.chainId && p.chainId !== "solana") return null;
  if (p.quoteToken?.address && p.quoteToken.address !== WSOL) return null;
  const price = p.priceUsd ? Number(p.priceUsd) : null;
  const vol5 = field(p.volume?.m5 ?? null, eventTime, ingestedAt, "dexscreener");
  return {
    ...blankSnapshot(base.address, eventTime, ingestedAt),
    pairAddress: p.pairAddress ?? "",
    symbol: (base.symbol || "UNK").slice(0, 10),
    name: base.name || base.symbol || "unknown",
    createdAt: p.pairCreatedAt ?? null,
    priceUsd: field(price, eventTime, ingestedAt, "dexscreener"),
    liquidityUsd: field(p.liquidity?.usd ?? null, eventTime, ingestedAt, "dexscreener"),
    mcapUsd: field(p.marketCap ?? p.fdv ?? null, eventTime, ingestedAt, "dexscreener"),
    fdvUsd: field(p.fdv ?? null, eventTime, ingestedAt, "dexscreener"),
    volume5mUsd: vol5,
    volume1mUsd: deriveVolume1m(vol5, eventTime, ingestedAt),
    volume1hUsd: field(p.volume?.h1 ?? null, eventTime, ingestedAt, "dexscreener"),
    buys5m: field(p.txns?.m5?.buys ?? null, eventTime, ingestedAt, "dexscreener"),
    sells5m: field(p.txns?.m5?.sells ?? null, eventTime, ingestedAt, "dexscreener"),
  };
}

export async function discoverDexScreener(): Promise<{
  tokens: TokenSnapshot[];
  lagMs: number;
  error?: string;
}> {
  const t0 = Date.now();
  const eventTime = Date.now();
  const ingestedAt = eventTime;
  try {
    const queries = ["pump.fun", "raydium", "solana"];
    const byMint = new Map<string, TokenSnapshot>();
    for (const q of queries) {
      try {
        const r = await getJsonRetry(
          `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`,
          7000,
          3,
          "dexscreener",
        );
        if (!r.ok) continue;
        const body = (await r.json()) as { pairs?: DsPair[] };
        for (const p of body.pairs ?? []) {
          const snap = pairToSnap(p, eventTime, ingestedAt);
          if (!snap) continue;
          const prev = byMint.get(snap.address);
          if (!prev || (snap.liquidityUsd.value ?? 0) > (prev.liquidityUsd.value ?? 0)) {
            byMint.set(snap.address, snap);
          }
        }
      } catch {
        /* next query */
      }
      if (byMint.size >= 40) break;
    }
    try {
      const r = await getJsonRetry("https://api.dexscreener.com/token-boosts/latest/v1", 6000, 2, "dexscreener");
      if (r.ok) {
        const rows = (await r.json()) as { chainId?: string; tokenAddress?: string }[];
        const missing = rows
          .filter((x) => x.chainId === "solana" && x.tokenAddress && !byMint.has(x.tokenAddress))
          .map((x) => x.tokenAddress as string)
          .slice(0, 12);
        if (missing.length) {
          const extra = await lookupDexTokens(missing);
          for (const snap of extra) {
            const prev = byMint.get(snap.address);
            if (!prev || (snap.liquidityUsd.value ?? 0) > (prev.liquidityUsd.value ?? 0)) {
              byMint.set(snap.address, snap);
            }
          }
        }
      }
    } catch {
      /* boosts optional */
    }
    return {
      tokens: [...byMint.values()],
      lagMs: Date.now() - t0,
      error: byMint.size ? undefined : "dexscreener empty",
    };
  } catch (e) {
    return {
      tokens: [],
      lagMs: Date.now() - t0,
      error: e instanceof Error ? e.message : "dexscreener failed",
    };
  }
}

export async function lookupDexTokens(mints: string[]): Promise<TokenSnapshot[]> {
  const unique = [...new Set(mints.filter(Boolean))].slice(0, 30);
  if (!unique.length) return [];
  const eventTime = Date.now();
  const ingestedAt = eventTime;
  try {
    const r = await getJsonRetry(`https://api.dexscreener.com/latest/dex/tokens/${unique.join(",")}`, 8000, 3, "dexscreener");
    if (!r.ok) return [];
    const extra = (await r.json()) as { pairs?: DsPair[] };
    const byMint = new Map<string, TokenSnapshot>();
    for (const p of extra.pairs ?? []) {
      const snap = pairToSnap(p, eventTime, ingestedAt);
      if (!snap) continue;
      const prev = byMint.get(snap.address);
      if (!prev || (snap.liquidityUsd.value ?? 0) > (prev.liquidityUsd.value ?? 0)) {
        byMint.set(snap.address, snap);
      }
    }
    return unique.map((m) => byMint.get(m)).filter((t): t is TokenSnapshot => Boolean(t));
  } catch {
    return [];
  }
}

export async function enrichDexScreener(tokens: TokenSnapshot[]): Promise<{
  tokens: TokenSnapshot[];
  lagMs: number;
  error?: string;
}> {
  const t0 = Date.now();
  if (!tokens.length) return { tokens, lagMs: 0 };
  try {
    const extra = await lookupDexTokens(tokens.slice(0, 30).map((t) => t.address));
    const best = new Map(extra.map((t) => [t.address, t]));
    const next = tokens.map((t) => {
      const fresh = best.get(t.address);
      if (!fresh) return t;
      const merged = mergeSnap(fresh, t);
      if ((fresh.liquidityUsd.value ?? 0) <= 0 && (t.liquidityUsd.value ?? 0) > 0) {
        return { ...merged, liquidityUsd: t.liquidityUsd };
      }
      return merged;
    });
    return { tokens: next, lagMs: Date.now() - t0 };
  } catch (e) {
    return {
      tokens,
      lagMs: Date.now() - t0,
      error: e instanceof Error ? e.message : "dexscreener failed",
    };
  }
}

export async function fetchSolPriceDex(): Promise<number | null> {
  try {
    const r = await getJsonRetry(
      "https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112",
      6000,
      2,
      "dexscreener",
    );
    if (!r.ok) return null;
    const body = (await r.json()) as { pairs?: DsPair[] };
    const usdc = (body.pairs ?? []).find(
      (p) =>
        p.chainId === "solana" &&
        p.quoteToken?.address === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    );
    return usdc?.priceUsd ? Number(usdc.priceUsd) : null;
  } catch {
    return null;
  }
}

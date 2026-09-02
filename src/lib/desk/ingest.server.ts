import { bucketOf, bucketRank } from "./buckets";
import { discoverDexScreener, enrichDexScreener, fetchSolPriceDex, lookupDexTokens } from "./providers/dexscreener";
import { fetchGeckoPools } from "./providers/gecko";
import { enrichHolders } from "./providers/holders";
import { quoteSolUsdc, quoteToken } from "./providers/jupiter";
import { mergeSnap } from "./providers/normalize";
import { enrichSolana } from "./providers/solana";
import type { MarketTape, SourceHealth, TokenSnapshot } from "./schema";

function health(
  id: SourceHealth["id"],
  ok: boolean,
  lagMs: number | null,
  detail: string,
  unconfigured = false,
  degraded = false,
): SourceHealth {
  return {
    id,
    status: unconfigured ? "unconfigured" : !ok ? "offline" : degraded ? "degraded" : "live",
    lagMs,
    lastOkAt: ok ? Date.now() : null,
    detail,
  };
}

type Cache = { at: number; key: string; tape: MarketTape };
let cache: Cache | null = null;
let lastGood: MarketTape | null = null;
const TTL = 8_000;

export async function ingestTape(opts?: {
  held?: string[];
  focus?: string | null;
  watch?: string[];
}): Promise<MarketTape> {
  const key = `${[...(opts?.held ?? [])].sort().join(",")}|${opts?.focus ?? ""}|${[...(opts?.watch ?? [])].sort().join(",")}`;
  if (cache && cache.key === key && Date.now() - cache.at < TTL && cache.tape.tokens.length) return cache.tape;
  try {
    const tape = await ingestOnce(opts);
    if (tape.tokens.length) {
      cache = { at: Date.now(), key, tape };
      lastGood = tape;
      return tape;
    }
    if (lastGood?.tokens.length) {
      return {
        ...lastGood,
        fetchMs: tape.fetchMs,
        sources: tape.sources.map((s) =>
          s.status === "live"
            ? { ...s, status: "degraded" as const, detail: `${s.detail} · last-good tape` }
            : s,
        ),
      };
    }
    return tape;
  } catch (e) {
    if (lastGood?.tokens.length) {
      return {
        ...lastGood,
        sources: lastGood.sources.map((s) => ({
          ...s,
          status: s.status === "live" ? ("degraded" as const) : s.status,
          detail: `${s.detail} · ${e instanceof Error ? e.message : "ingest failed"}`,
        })),
      };
    }
    throw e;
  }
}

export async function ingestActive(opts: {
  tape: MarketTape;
  mints: string[];
}): Promise<MarketTape> {
  const t0 = Date.now();
  const want = new Set(opts.mints);
  const targets = opts.tape.tokens.filter((t) => want.has(t.address)).slice(0, 12);
  if (!targets.length || !opts.tape.solPriceUsd) return opts.tape;
  const dex = await enrichDexScreener(targets);
  const holders = await enrichHolders(dex.tokens, { priority: opts.mints });
  const quoted = holders.tokens;
  const results = await Promise.all(
    quoted.map(async (t) => {
      try {
        const q = await quoteToken({
          mint: t.address,
          decimals: t.decimals,
          priceUsd: t.priceUsd.value,
          solPriceUsd: opts.tape.solPriceUsd!,
          notionalUsd: 120,
        });
        return { addr: t.address, q };
      } catch {
        return { addr: t.address, q: null };
      }
    }),
  );
  const byBuy = new Map(results.map((r) => [r.addr, r.q?.buy]));
  const bySell = new Map(results.map((r) => [r.addr, r.q?.sell]));
  const byFresh = new Map(quoted.map((t) => [t.address, t]));
  const tokens = opts.tape.tokens.map((t) => {
    const fresh = byFresh.get(t.address);
    const base = fresh ?? t;
    return {
      ...base,
      buyQuote: byBuy.get(t.address) ?? base.buyQuote,
      sellQuote: bySell.get(t.address) ?? base.sellQuote,
    };
  });
  return {
    ...opts.tape,
    tokens,
    ingestedAt: Date.now(),
    fetchMs: Date.now() - t0,
  };
}

function vol(t: TokenSnapshot) {
  return t.volume1hUsd.value ?? t.volume5mUsd.value ?? 0;
}

async function ingestOnce(opts?: {
  held?: string[];
  focus?: string | null;
  watch?: string[];
}): Promise<MarketTape> {
  const t0 = Date.now();
  const pin = [...new Set([...(opts?.held ?? []), ...(opts?.focus ? [opts.focus] : []), ...(opts?.watch ?? [])])].slice(
    0,
    16,
  );
  const [dsDisc, gecko] = await Promise.all([discoverDexScreener(), fetchGeckoPools()]);

  const byMint = new Map<string, TokenSnapshot>();
  for (const t of dsDisc.tokens) byMint.set(t.address, t);
  for (const t of gecko.tokens) {
    const prev = byMint.get(t.address);
    byMint.set(t.address, prev ? mergeSnap(prev, t) : t);
  }

  const missingPin = pin.filter((a) => !byMint.has(a));
  if (missingPin.length) {
    for (const t of await lookupDexTokens(missingPin)) {
      const prev = byMint.get(t.address);
      byMint.set(t.address, prev ? mergeSnap(prev, t) : t);
    }
  }

  const now = Date.now();
  const ranked = [...byMint.values()]
    .filter((t) => (t.liquidityUsd.value ?? 0) >= 2500 && t.priceUsd.value)
    .sort((a, b) => {
      const ba = bucketRank(bucketOf(a.createdAt ? (now - a.createdAt) / 1000 : null));
      const bb = bucketRank(bucketOf(b.createdAt ? (now - b.createdAt) / 1000 : null));
      if (ba !== bb) return ba - bb;
      return vol(b) - vol(a);
    });
  const pinned = pin.map((a) => byMint.get(a)).filter((t): t is TokenSnapshot => Boolean(t));
  const seen = new Set<string>();
  const selected: TokenSnapshot[] = [];
  for (const t of ranked) {
    if (seen.has(t.address)) continue;
    seen.add(t.address);
    selected.push(t);
    if (selected.length >= 24) break;
  }
  for (const t of pinned) {
    if (seen.has(t.address)) continue;
    seen.add(t.address);
    selected.push(t);
    if (selected.length >= 30) break;
  }

  const dex = await enrichDexScreener(selected);
  let solPrice = gecko.solPrice ?? (await fetchSolPriceDex());

  const jupProbe = await quoteSolUsdc();
  if (jupProbe.available && Number(jupProbe.outAmount) > 0) {
    solPrice = Number(jupProbe.outAmount) / 1e6 / 0.01;
  }

  const sol = await enrichSolana(dex.tokens);
  const holders = await enrichHolders(sol.tokens, { priority: pin });
  const enriched = holders.tokens;

  const focusSet = new Set<string>(pin);
  const young = enriched.filter((t) => {
    const b = bucketOf(t.createdAt ? (now - t.createdAt) / 1000 : null);
    return b === "new_launch" || b === "early" || b === "emerging";
  });
  const quoteTargets = [
    ...enriched.filter((t) => focusSet.has(t.address)),
    ...young.filter((t) => !focusSet.has(t.address)),
    ...enriched.filter((t) => !focusSet.has(t.address) && !young.includes(t)),
  ].slice(0, 16);

  const quoteMap = new Map<string, TokenSnapshot["buyQuote"]>();
  const sellMap = new Map<string, TokenSnapshot["sellQuote"]>();
  if (solPrice) {
    const results = await Promise.all(
      quoteTargets.map(async (t) => {
        const q = await quoteToken({
          mint: t.address,
          decimals: t.decimals,
          priceUsd: t.priceUsd.value,
          solPriceUsd: solPrice,
          notionalUsd: 120,
        });
        return { addr: t.address, q };
      }),
    );
    for (const r of results) {
      quoteMap.set(r.addr, r.q.buy);
      sellMap.set(r.addr, r.q.sell);
    }
  }

  const quoted: TokenSnapshot[] = enriched.map((t) => ({
    ...t,
    buyQuote: quoteMap.get(t.address) ?? t.buyQuote,
    sellQuote: sellMap.get(t.address) ?? t.sellQuote,
  }));

  const jupOk = jupProbe.available || quoted.some((t) => t.sellQuote?.available);
  const jupLag = quoted.find((t) => t.sellQuote)?.sellQuote?.latencyMs ?? jupProbe.latencyMs;
  const geckoOk = gecko.tokens.length > 0 && !gecko.error;
  const geckoDegraded = Boolean(gecko.error) && gecko.tokens.length > 0;
  const holderSources = holders.sources;
  const solLive = !sol.error && quoted.some((t) => t.mintAuth.value != null);
  const rpcHolders = holderSources.find((s) => s.id === "solana");

  const sources: SourceHealth[] = [
    health(
      "geckoterminal",
      gecko.tokens.length > 0 || !gecko.error,
      gecko.lagMs,
      gecko.error ?? `${gecko.tokens.length} pools`,
      false,
      geckoDegraded || (!geckoOk && Boolean(gecko.error)),
    ),
    health(
      "dexscreener",
      !dsDisc.error && dsDisc.tokens.length > 0,
      dsDisc.lagMs,
      dsDisc.error ?? `${dsDisc.tokens.length} discovered`,
    ),
    health("jupiter", jupOk, jupLag, jupOk ? "read-only quotes" : jupProbe.error ?? "no route"),
    health(
      "solana",
      solLive || Boolean(rpcHolders?.status === "live"),
      sol.lagMs ?? rpcHolders?.lagMs ?? null,
      sol.error ?? rpcHolders?.detail ?? "mint / freeze",
    ),
    ...(holderSources.filter((s) => s.id !== "solana") as SourceHealth[]),
  ];

  return {
    ingestedAt: Date.now(),
    eventTime: Date.now(),
    fetchMs: Date.now() - t0,
    solPriceUsd: solPrice,
    tokens: quoted,
    sources,
  };
}

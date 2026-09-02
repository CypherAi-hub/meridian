import { bucketOf, bucketRank } from "./buckets";
import { discoverDexScreener, enrichDexScreener, fetchSolPriceDex, lookupDexTokens } from "./providers/dexscreener";
import { fetchGeckoPools } from "./providers/gecko";
import { enrichHolders } from "./providers/holders";
import { quoteSolUsdc, quoteToken, cachedQuoteAge } from "./providers/jupiter";
import { mergeSnap } from "./providers/normalize";
import { enrichSolana } from "./providers/solana";
import type { MarketTape, SourceHealth, TokenSnapshot } from "./schema";
import { makeHolderJob } from "./holder-queue";
import { routePriority, selectRouteJobs, shouldRefreshRoute } from "./route-priority";
import { deskSettings } from "./config";
import { budgetFor } from "./rate-budget";

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
  pending?: string[];
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

export async function ingestFastPath(opts: {
  tape: MarketTape;
  mints: string[];
}): Promise<MarketTape> {
  const t0 = Date.now();
  const want = new Set(opts.mints);
  const targets = opts.tape.tokens.filter((t) => want.has(t.address)).slice(0, deskSettings().maxActiveWatches);
  if (!targets.length) return opts.tape;
  const dex = await enrichDexScreener(targets);
  const byFresh = new Map(dex.tokens.map((t) => [t.address, t]));
  const tokens = opts.tape.tokens.map((t) => byFresh.get(t.address) ?? t);
  return {
    ...opts.tape,
    tokens,
    ingestedAt: Date.now(),
    eventTime: Date.now(),
    fetchMs: Date.now() - t0,
  };
}

export async function ingestSlowEnrichment(opts: {
  tape: MarketTape;
  mints: string[];
  held?: string[];
  pending?: string[];
}): Promise<MarketTape> {
  const t0 = Date.now();
  const want = new Set(opts.mints);
  const targets = opts.tape.tokens.filter((t) => want.has(t.address)).slice(0, deskSettings().maxActiveWatches);
  if (!targets.length) return opts.tape;
  const held = new Set(opts.held ?? []);
  const pending = new Set(opts.pending ?? []);
  const jobs = targets.map((t) =>
    makeHolderJob(t.address, {
      held: held.has(t.address),
      candidate: pending.has(t.address),
      ageS: t.createdAt ? (Date.now() - t.createdAt) / 1000 : null,
    }),
  );
  const holders = await enrichHolders(targets, { jobs, priority: opts.mints });
  const quoted = await quotePriorityTargets(holders.tokens, opts.tape.solPriceUsd, {
    held,
    pending,
    focus: want,
  });
  const by = new Map(quoted.map((t) => [t.address, t]));
  return {
    ...opts.tape,
    tokens: opts.tape.tokens.map((t) => by.get(t.address) ?? t),
    ingestedAt: Date.now(),
    fetchMs: Date.now() - t0,
    sources: [...opts.tape.sources.filter((s) => s.id !== "rugcheck" && s.id !== "birdeye" && s.id !== "helius"), ...holders.sources],
  };
}

/** @deprecated slow path — prefer ingestFastPath for 3s ticks */
export async function ingestActive(opts: { tape: MarketTape; mints: string[] }): Promise<MarketTape> {
  return ingestFastPath(opts);
}

function vol(t: TokenSnapshot) {
  return t.volume1hUsd.value ?? t.volume5mUsd.value ?? 0;
}

async function quotePriorityTargets(
  tokens: TokenSnapshot[],
  solPriceUsd: number | null,
  ctx: { held: Set<string>; pending: Set<string>; focus: Set<string> },
): Promise<TokenSnapshot[]> {
  if (!solPriceUsd) return tokens;
  const settings = deskSettings();
  const limit = settings.jupiterApiKey ? 8 : 3;
  const now = Date.now();
  const jobs = tokens.map((t) => {
    const reason = ctx.held.has(t.address)
      ? ("OPEN_POSITION" as const)
      : ctx.pending.has(t.address)
        ? ("CANDIDATE" as const)
        : ctx.focus.has(t.address)
          ? ("NEAR_THRESHOLD" as const)
          : ("RESEARCH" as const);
    return { mint: t.address, priority: routePriority(reason), reason };
  });
  const selected = selectRouteJobs(
    jobs.filter((j) => shouldRefreshRoute({ lastQuotedAt: cachedQuoteAge(j.mint), now, priority: j.priority })),
    limit,
  );
  const budget = budgetFor("jupiter");
  const quoteMap = new Map<string, TokenSnapshot["buyQuote"]>();
  const sellMap = new Map<string, TokenSnapshot["sellQuote"]>();
  for (const job of selected) {
    if (!budget.take()) break;
    const t = tokens.find((x) => x.address === job.mint);
    if (!t) continue;
    try {
      const q = await quoteToken({
        mint: t.address,
        decimals: t.decimals,
        priceUsd: t.priceUsd.value,
        solPriceUsd,
        notionalUsd: 120,
      });
      quoteMap.set(t.address, q.buy);
      sellMap.set(t.address, q.sell);
    } catch {
      /* keep last quote */
    }
  }
  return tokens.map((t) => ({
    ...t,
    buyQuote: quoteMap.get(t.address) ?? t.buyQuote,
    sellQuote: sellMap.get(t.address) ?? t.sellQuote,
  }));
}

async function ingestOnce(opts?: {
  held?: string[];
  focus?: string | null;
  watch?: string[];
  pending?: string[];
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

  const jupBudget = budgetFor("jupiter");
  let jupProbe = null as Awaited<ReturnType<typeof quoteSolUsdc>> | null;
  if (jupBudget.take()) {
    jupProbe = await quoteSolUsdc();
    if (jupProbe.available && Number(jupProbe.outAmount) > 0) {
      solPrice = Number(jupProbe.outAmount) / 1e6 / 0.01;
    }
  }

  const sol = await enrichSolana(dex.tokens);
  const held = new Set(opts?.held ?? []);
  const pending = new Set(opts?.pending ?? pin);
  const jobs = sol.tokens.map((t) =>
    makeHolderJob(t.address, {
      held: held.has(t.address),
      candidate: pending.has(t.address),
      ageS: t.createdAt ? (now - t.createdAt) / 1000 : null,
    }),
  );
  const holders = await enrichHolders(sol.tokens, { jobs, priority: pin });
  const quoted = await quotePriorityTargets(holders.tokens, solPrice, {
    held,
    pending,
    focus: new Set(pin),
  });

  const jupOk = Boolean(jupProbe?.available) || quoted.some((t) => t.sellQuote?.available);
  const jupLag = quoted.find((t) => t.sellQuote)?.sellQuote?.latencyMs ?? jupProbe?.latencyMs ?? null;
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
    health("jupiter", jupOk, jupLag, jupOk ? "read-only quotes" : jupProbe?.error ?? "deferred"),
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

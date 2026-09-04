import type { SourceHealth, TokenSnapshot } from "../schema.ts";
import { field } from "./normalize.ts";
import { solanaRpc } from "./solana.ts";
import { deskSettings } from "../config.ts";
import { breakerFor } from "../circuit.ts";
import { bucketOf, type UniverseBucket } from "../buckets.ts";
import { makeHolderJob, takeHolderJobs, type HolderLookupJob } from "../holder-queue.ts";
import { budgetFor, parseRetryAfter } from "../rate-budget.ts";

export type HolderObs = {
  holders: number | null;
  top10Pct: number | null;
  top20Pct: number | null;
  largestPct: number | null;
  source: "birdeye" | "helius" | "solana" | "rugcheck";
  status: "VALID" | "UNKNOWN" | "ERROR" | "UNCONFIGURED" | "STALE";
  errors: { provider: string; error: string }[];
};

type CacheEntry = { at: number; ttl: number; value: HolderObs };
const cache = new Map<string, CacheEntry>();
const MAX_PER_TICK = 6;
export const UNKNOWN_TTL = 20_000;

export function holderTtlMs(bucket: UniverseBucket | null | undefined): number {
  switch (bucket) {
    case "new_launch":
      return 30_000;
    case "early":
      return 60_000;
    case "emerging":
      return 120_000;
    case "established":
      return 300_000;
    case "mature":
      return 600_000;
    default:
      return 90_000;
  }
}

function health(
  id: SourceHealth["id"],
  ok: boolean,
  lagMs: number | null,
  detail: string,
  unconfigured = false,
): SourceHealth {
  return {
    id,
    status: unconfigured ? "unconfigured" : ok ? "live" : "offline",
    lagMs,
    lastOkAt: ok ? Date.now() : null,
    detail,
  };
}

function asPct(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return null;
  return n > 1 ? n / 100 : n;
}

function valid(obs: HolderObs | null): obs is HolderObs {
  return Boolean(obs && (obs.top10Pct != null || obs.holders != null) && obs.status === "VALID");
}

export function peekHolderCache(mint: string): { at: number; ttl: number; value: HolderObs } | null {
  return cache.get(mint) ?? null;
}

export function applyHolderObs(
  t: TokenSnapshot,
  h: HolderObs,
  eventTime: number,
  ingestedAt: number,
): TokenSnapshot {
  const src = h.source;
  const st = h.status === "STALE" ? "STALE" : h.status === "VALID" ? "VALID" : "UNKNOWN";
  return {
    ...t,
    holders:
      h.holders != null ? field(h.holders, eventTime, ingestedAt, src === "rugcheck" ? "rugcheck" : src, st) : t.holders,
    top10Pct:
      h.top10Pct != null ? field(h.top10Pct, eventTime, ingestedAt, src === "rugcheck" ? "rugcheck" : src, st) : t.top10Pct,
    top20Pct:
      h.top20Pct != null
        ? field(h.top20Pct, eventTime, ingestedAt, src === "rugcheck" ? "rugcheck" : src, st)
        : t.top20Pct,
    largestHolderPct:
      h.largestPct != null
        ? field(h.largestPct, eventTime, ingestedAt, src === "rugcheck" ? "rugcheck" : src, st)
        : t.largestHolderPct,
  };
}

export function unknownHolderObs(errors: HolderObs["errors"] = []): HolderObs {
  return {
    holders: null,
    top10Pct: null,
    top20Pct: null,
    largestPct: null,
    source: "solana",
    status: "UNKNOWN",
    errors,
  };
}

export function parseRugcheckReport(body: {
  topHolders?: Array<{ pct?: number }>;
  totalHolders?: number;
}): HolderObs | null {
  const items = body.topHolders ?? [];
  if (!items.length) return null;
  const top10 = items.slice(0, 10).reduce((a, it) => a + (Number(it.pct) || 0), 0);
  const top20 = items.slice(0, 20).reduce((a, it) => a + (Number(it.pct) || 0), 0);
  const largest = Number(items[0]?.pct) || 0;
  return {
    holders: body.totalHolders ?? null,
    top10Pct: asPct(top10),
    top20Pct: asPct(top20),
    largestPct: asPct(largest),
    source: "rugcheck",
    status: "VALID",
    errors: [],
  };
}

async function birdeyeHolders(mint: string): Promise<HolderObs | null> {
  const key = deskSettings().birdeyeApiKey;
  if (!key) return null;
  const circuit = breakerFor("birdeye:holders");
  if (!circuit.canCall()) throw new Error("circuit open");
  const headers: Record<string, string> = {
    accept: "application/json",
    "x-chain": "solana",
    "X-API-KEY": key,
  };
  const url = `https://public-api.birdeye.so/defi/v3/token/holder?address=${encodeURIComponent(mint)}&offset=0&limit=20`;
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(7000) });
  if (!r.ok) {
    circuit.failure(`birdeye ${r.status}`);
    throw new Error(`birdeye ${r.status}`);
  }
  const body = (await r.json()) as {
    data?: { items?: { percentage?: number }[]; total?: number; holder?: number };
  };
  const items = body.data?.items ?? [];
  if (items.length) {
    const top10 = items.slice(0, 10).reduce((a, it) => a + (Number(it.percentage) || 0), 0);
    const top20 = items.slice(0, 20).reduce((a, it) => a + (Number(it.percentage) || 0), 0);
    const largest = Number(items[0]?.percentage) || 0;
    circuit.success();
    return {
      holders: body.data?.holder ?? body.data?.total ?? null,
      top10Pct: asPct(top10),
      top20Pct: asPct(top20),
      largestPct: asPct(largest),
      source: "birdeye",
      status: "VALID",
      errors: [],
    };
  }
  circuit.failure("empty");
  return null;
}

async function heliusHolders(mint: string): Promise<HolderObs | null> {
  const key = deskSettings().heliusApiKey;
  if (!key) return null;
  const circuit = breakerFor("helius:holders");
  if (!circuit.canCall()) throw new Error("circuit open");
  const rpc = deskSettings().heliusRpcUrl ?? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`;
  const r = await fetch(rpc, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTokenLargestAccounts",
      params: [mint],
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) {
    circuit.failure(`helius ${r.status}`);
    throw new Error(`helius ${r.status}`);
  }
  const body = (await r.json()) as {
    result?: { value?: { uiAmount?: number | null; amount?: string; decimals?: number }[] };
    error?: { message?: string };
  };
  if (body.error) {
    circuit.failure(body.error.message ?? "helius");
    throw new Error(body.error.message ?? "helius");
  }
  const parsed = await fromLargest(mint, body.result?.value ?? [], "helius");
  if (parsed) circuit.success();
  else circuit.failure("empty");
  return parsed;
}

function uiAmount(acc: { uiAmount?: number | null; amount?: string; decimals?: number }) {
  if (acc.uiAmount != null && Number.isFinite(acc.uiAmount)) return acc.uiAmount;
  if (acc.amount && acc.decimals != null) return Number(acc.amount) / 10 ** acc.decimals;
  return 0;
}

async function fromLargest(
  mint: string,
  accounts: { uiAmount?: number | null; amount?: string; decimals?: number }[],
  source: HolderObs["source"],
): Promise<HolderObs | null> {
  if (!accounts.length) return null;
  const top10 = accounts.slice(0, 10).reduce((a, b) => a + uiAmount(b), 0);
  const top20 = accounts.slice(0, 20).reduce((a, b) => a + uiAmount(b), 0);
  const largest = uiAmount(accounts[0] ?? {});
  let supply = 0;
  try {
    const s = await solanaRpc<{
      result?: { value?: { uiAmount?: number | null; amount?: string; decimals?: number } };
    }>({
      jsonrpc: "2.0",
      id: 2,
      method: "getTokenSupply",
      params: [mint],
    });
    const v = s.result?.value;
    supply = v?.uiAmount ?? (v?.amount && v.decimals != null ? Number(v.amount) / 10 ** v.decimals : 0);
  } catch {
    supply = accounts.reduce((a, b) => a + uiAmount(b), 0);
  }
  if (!supply) return null;
  return {
    holders: null,
    top10Pct: Math.min(1, top10 / supply),
    top20Pct: Math.min(1, top20 / supply),
    largestPct: Math.min(1, largest / supply),
    source,
    status: "VALID",
    errors: [],
  };
}

async function rpcHolders(mint: string): Promise<HolderObs | null> {
  if (!deskSettings().solanaRpcUrl && !deskSettings().heliusApiKey) {
    throw new Error("public getTokenLargestAccounts unavailable");
  }
  const circuit = breakerFor("solana:holders");
  if (!circuit.canCall()) throw new Error("circuit open");
  const largest = await solanaRpc<{
    result?: { value?: { uiAmount?: number | null; amount?: string; decimals?: number }[] };
    error?: { message?: string };
  }>({
    jsonrpc: "2.0",
    id: 1,
    method: "getTokenLargestAccounts",
    params: [mint],
  });
  if (largest.error) {
    circuit.failure(largest.error.message ?? "getTokenLargestAccounts");
    throw new Error(largest.error.message ?? "getTokenLargestAccounts");
  }
  const parsed = await fromLargest(mint, largest.result?.value ?? [], "solana");
  if (parsed) circuit.success();
  else circuit.failure("empty");
  return parsed;
}

async function rugcheckHolders(mint: string): Promise<HolderObs | null> {
  const circuit = breakerFor("rugcheck:holders");
  if (!circuit.canCall()) throw new Error("circuit open");
  const budget = budgetFor("rugcheck");
  if (!budget.take()) throw new Error("rate budget empty");
  const r = await fetch(`https://api.rugcheck.xyz/v1/tokens/${encodeURIComponent(mint)}/report`, {
    headers: { accept: "application/json", "user-agent": "meridian-research/3.3a2" },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) {
    if (r.status === 429) budget.onRateLimit(parseRetryAfter(r.headers.get("retry-after")));
    circuit.failure(`rugcheck ${r.status}`);
    throw new Error(`rugcheck ${r.status}`);
  }
  const body = (await r.json()) as { topHolders?: Array<{ pct?: number }>; totalHolders?: number };
  const parsed = parseRugcheckReport(body);
  if (parsed) {
    circuit.success();
    budget.onSuccess();
  } else circuit.failure("empty");
  return parsed;
}

export async function getHolderConcentration(
  mint: string,
  opts?: { bucket?: UniverseBucket | null },
): Promise<HolderObs> {
  const ttl = holderTtlMs(opts?.bucket);
  const hit = cache.get(mint);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (hit && age < hit.ttl) {
    return hit.value;
  }
  const staleFallback =
    hit && (hit.value.status === "VALID" || hit.value.status === "STALE")
      ? { ...hit.value, status: "STALE" as const }
      : null;
  const errors: { provider: string; error: string }[] = [];
  const settings = deskSettings();
  const providers: { name: HolderObs["source"]; run: () => Promise<HolderObs | null> }[] = [];
  if (settings.birdeyeApiKey) providers.push({ name: "birdeye", run: () => birdeyeHolders(mint) });
  else errors.push({ provider: "birdeye", error: "unconfigured" });
  if (settings.heliusApiKey) providers.push({ name: "helius", run: () => heliusHolders(mint) });
  else errors.push({ provider: "helius", error: "unconfigured" });
  providers.push({ name: "solana", run: () => rpcHolders(mint) });
  providers.push({ name: "rugcheck", run: () => rugcheckHolders(mint) });

  for (const p of providers) {
    try {
      const result = await p.run();
      if (valid(result)) {
        const value = { ...result, errors };
        cache.set(mint, { at: Date.now(), ttl, value });
        return value;
      }
      errors.push({ provider: p.name, error: "empty" });
    } catch (e) {
      errors.push({ provider: p.name, error: e instanceof Error ? e.message : "failed" });
    }
  }

  if (staleFallback) {
    cache.set(mint, { at: Date.now(), ttl: Math.min(ttl, 30_000), value: staleFallback });
    return staleFallback;
  }

  const unknown: HolderObs = unknownHolderObs(errors);
  cache.set(mint, { at: Date.now(), ttl: UNKNOWN_TTL, value: unknown });
  return unknown;
}

export async function enrichHolders(
  tokens: TokenSnapshot[],
  opts?: { priority?: string[]; jobs?: HolderLookupJob[] },
): Promise<{
  tokens: TokenSnapshot[];
  sources: SourceHealth[];
  lagMs: number;
}> {
  const t0 = Date.now();
  const settings = deskSettings();
  const jobs =
    opts?.jobs ??
    tokens.map((t) =>
      makeHolderJob(t.address, {
        ageS: t.createdAt ? (Date.now() - t.createdAt) / 1000 : null,
      }),
    );
  const pri = new Set(opts?.priority ?? []);
  const boosted = jobs.map((j) => (pri.has(j.mint) ? { ...j, priority: Math.min(j.priority, 1) } : j));
  const targets = takeHolderJobs(boosted, MAX_PER_TICK);
  const results = await Promise.all(
    targets.map(async (job) => {
      return { address: job.mint, h: await getHolderConcentration(job.mint, { bucket: job.bucket }) };
    }),
  );
  const by = new Map(results.map((r) => [r.address, r.h]));
  const eventTime = Date.now();
  const ingestedAt = eventTime;
  let birdeyeOk = false;
  let heliusOk = false;
  let rpcOk = false;
  let rugOk = false;
  let birdeyeErr = settings.birdeyeApiKey ? "empty" : "unconfigured";
  let heliusErr = settings.heliusApiKey ? "empty" : "unconfigured";
  let rpcErr = "empty";
  let rugErr = "empty";

  const next = tokens.map((t) => {
    const fetched = by.get(t.address);
    const cached = !fetched ? cache.get(t.address) : null;
    const h = fetched ?? cached?.value;
    const eventAt = fetched ? eventTime : cached?.at ?? eventTime;
    const ingestedAtTick = fetched ? ingestedAt : cached?.at ?? ingestedAt;
    if (!h) return t;
    if (h.source === "birdeye" && valid(h)) birdeyeOk = true;
    if (h.source === "helius" && valid(h)) heliusOk = true;
    if (h.source === "solana" && valid(h)) rpcOk = true;
    if (h.source === "rugcheck" && valid(h)) rugOk = true;
    for (const e of h.errors) {
      if (e.provider === "birdeye") birdeyeErr = e.error;
      if (e.provider === "helius") heliusErr = e.error;
      if (e.provider === "solana") rpcErr = e.error;
      if (e.provider === "rugcheck") rugErr = e.error;
    }
    return applyHolderObs(t, h, eventAt, ingestedAtTick);
  });

  const lagMs = Date.now() - t0;
  return {
    tokens: next,
    lagMs,
    sources: [
      health("birdeye", birdeyeOk, lagMs, birdeyeOk ? "top10" : birdeyeErr, !settings.birdeyeApiKey && !birdeyeOk),
      health("helius", heliusOk, lagMs, heliusOk ? "top10" : heliusErr, !settings.heliusApiKey && !heliusOk),
      health("solana", rpcOk, lagMs, rpcOk ? "largest accounts" : rpcErr),
      health("rugcheck", rugOk, lagMs, rugOk ? "topHolders" : rugErr),
    ],
  };
}

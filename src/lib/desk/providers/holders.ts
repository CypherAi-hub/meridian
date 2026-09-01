import type { SourceHealth, TokenSnapshot } from "../schema.ts";
import { field } from "./normalize.ts";
import { solanaRpc } from "./solana.ts";
import { deskSettings } from "../config.ts";
import { breakerFor } from "../circuit.ts";

export type HolderObs = {
  holders: number | null;
  top10Pct: number | null;
  top20Pct: number | null;
  largestPct: number | null;
  source: "birdeye" | "helius" | "solana";
  status: "VALID" | "UNKNOWN" | "ERROR" | "UNCONFIGURED";
  errors: { provider: string; error: string }[];
};

type CacheEntry = { at: number; value: HolderObs };
const cache = new Map<string, CacheEntry>();
const TTL = 90_000;
const MAX_PER_TICK = 8;

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

async function birdeyeHolders(mint: string): Promise<HolderObs | null> {
  const key = deskSettings().birdeyeApiKey;
  if (!key) return null;
  const circuit = breakerFor("birdeye");
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
      top10Pct: asPct(top10 > 1 ? top10 : top10),
      top20Pct: asPct(top20 > 1 ? top20 : top20),
      largestPct: asPct(largest > 1 ? largest : largest),
      source: "birdeye",
      status: "VALID",
      errors: [],
    };
  }
  const overview = await birdeyeOverview(mint, headers);
  if (overview) {
    circuit.success();
    return overview;
  }
  circuit.failure("empty");
  return null;
}

async function birdeyeOverview(mint: string, headers: Record<string, string>): Promise<HolderObs | null> {
  const url = `https://public-api.birdeye.so/defi/token_overview?address=${encodeURIComponent(mint)}`;
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(7000) });
  if (!r.ok) return null;
  const body = (await r.json()) as {
    data?: { holder?: number; top10HolderPercent?: number; top10UserPercent?: number };
  };
  const top = asPct(body.data?.top10HolderPercent ?? body.data?.top10UserPercent ?? null);
  if (top == null && body.data?.holder == null) return null;
  return {
    holders: body.data?.holder ?? null,
    top10Pct: top,
    top20Pct: null,
    largestPct: null,
    source: "birdeye",
    status: "VALID",
    errors: [],
  };
}

async function heliusHolders(mint: string): Promise<HolderObs | null> {
  const key = deskSettings().heliusApiKey;
  if (!key) return null;
  const circuit = breakerFor("helius");
  if (!circuit.canCall()) throw new Error("circuit open");
  const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`, {
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
    result?: { value?: { uiAmount?: number | null }[] };
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

async function fromLargest(
  mint: string,
  accounts: { uiAmount?: number | null }[],
  source: HolderObs["source"],
): Promise<HolderObs | null> {
  if (!accounts.length) return null;
  const top10 = accounts.slice(0, 10).reduce((a, b) => a + (b.uiAmount ?? 0), 0);
  const top20 = accounts.slice(0, 20).reduce((a, b) => a + (b.uiAmount ?? 0), 0);
  const largest = accounts[0]?.uiAmount ?? 0;
  let supply = 0;
  try {
    const s = await solanaRpc<{
      result?: { value?: { uiAmount?: number | null } };
      error?: { message?: string };
    }>({
      jsonrpc: "2.0",
      id: 2,
      method: "getTokenSupply",
      params: [mint],
    });
    supply = s.result?.value?.uiAmount ?? 0;
  } catch {
    supply = accounts.reduce((a, b) => a + (b.uiAmount ?? 0), 0);
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
  const circuit = breakerFor("solana_holders");
  if (!circuit.canCall()) throw new Error("circuit open");
  const largest = await solanaRpc<{
    result?: { value?: { uiAmount?: number | null }[] };
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

export async function getHolderConcentration(mint: string): Promise<HolderObs> {
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const errors: { provider: string; error: string }[] = [];
  const settings = deskSettings();

  const providers: { name: "birdeye" | "helius" | "solana"; run: () => Promise<HolderObs | null> }[] = [];
  if (settings.birdeyeApiKey) providers.push({ name: "birdeye", run: () => birdeyeHolders(mint) });
  else errors.push({ provider: "birdeye", error: "unconfigured" });
  if (settings.heliusApiKey) providers.push({ name: "helius", run: () => heliusHolders(mint) });
  else errors.push({ provider: "helius", error: "unconfigured" });
  providers.push({ name: "solana", run: () => rpcHolders(mint) });

  for (const p of providers) {
    try {
      const result = await p.run();
      if (result && (result.top10Pct != null || result.holders != null)) {
        const value = { ...result, errors };
        cache.set(mint, { at: Date.now(), value });
        return value;
      }
      errors.push({ provider: p.name, error: "empty" });
    } catch (e) {
      errors.push({ provider: p.name, error: e instanceof Error ? e.message : "failed" });
    }
  }

  const unknown: HolderObs = {
    holders: null,
    top10Pct: null,
    top20Pct: null,
    largestPct: null,
    source: "solana",
    status: "UNKNOWN",
    errors,
  };
  cache.set(mint, { at: Date.now(), value: unknown });
  return unknown;
}

export async function enrichHolders(tokens: TokenSnapshot[]): Promise<{
  tokens: TokenSnapshot[];
  sources: SourceHealth[];
  lagMs: number;
}> {
  const t0 = Date.now();
  const settings = deskSettings();
  const targets = tokens.slice(0, MAX_PER_TICK);
  const results = await Promise.all(
    targets.map(async (t) => ({ address: t.address, h: await getHolderConcentration(t.address) })),
  );
  const by = new Map(results.map((r) => [r.address, r.h]));
  const eventTime = Date.now();
  const ingestedAt = eventTime;
  let birdeyeOk = false;
  let heliusOk = false;
  let rpcOk = false;
  let birdeyeErr = settings.birdeyeApiKey ? "empty" : "unconfigured";
  let heliusErr = settings.heliusApiKey ? "empty" : "unconfigured";
  let rpcErr = "empty";

  const next = tokens.map((t) => {
    const h = by.get(t.address);
    if (!h) return t;
    if (h.source === "birdeye" && (h.top10Pct != null || h.holders != null)) birdeyeOk = true;
    if (h.source === "helius" && h.top10Pct != null) heliusOk = true;
    if (h.source === "solana" && h.top10Pct != null) rpcOk = true;
    for (const e of h.errors) {
      if (e.provider === "birdeye") birdeyeErr = e.error;
      if (e.provider === "helius") heliusErr = e.error;
      if (e.provider === "solana") rpcErr = e.error;
    }
    return {
      ...t,
      holders: h.holders != null ? field(h.holders, eventTime, ingestedAt, h.source) : t.holders,
      top10Pct: h.top10Pct != null ? field(h.top10Pct, eventTime, ingestedAt, h.source) : t.top10Pct,
      top20Pct: h.top20Pct != null ? field(h.top20Pct, eventTime, ingestedAt, h.source) : t.top20Pct,
      largestHolderPct: h.largestPct != null ? field(h.largestPct, eventTime, ingestedAt, h.source) : t.largestHolderPct,
    };
  });

  const lagMs = Date.now() - t0;
  return {
    tokens: next,
    lagMs,
    sources: [
      health("birdeye", birdeyeOk, lagMs, birdeyeOk ? "top10" : birdeyeErr, !settings.birdeyeApiKey && !birdeyeOk),
      health("helius", heliusOk, lagMs, heliusOk ? "top10" : heliusErr, !settings.heliusApiKey && !heliusOk),
      health("solana", rpcOk, lagMs, rpcOk ? "largest accounts" : rpcErr),
    ],
  };
}

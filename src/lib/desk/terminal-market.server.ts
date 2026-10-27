import { isSolanaAddress } from "./capital.ts";
import { terminalPairs, normalizeCandles, type DexPair } from "./terminal-market.ts";
const cache = new Map<string, { at: number; data: unknown }>(),
  pending = new Map<string, Promise<unknown>>();
async function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.data as T;
  const flight = pending.get(key);
  if (flight) return flight as Promise<T>;
  const task = load()
    .then((data) => {
      if (cache.size > 150) cache.delete(cache.keys().next().value!);
      cache.set(key, { at: Date.now(), data });
      return data;
    })
    .finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
}
async function json(url: string) {
  const r = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw Error(`Market-data provider returned ${r.status}`);
  return r.json();
}
export async function terminalSearch(query: string) {
  const q = query.trim();
  if (q.length < 2 || q.length > 100)
    throw Error("Enter a token symbol or full Solana contract address");
  return cached("search:" + q, 15000, async () => {
    const body = await json(
      isSolanaAddress(q)
        ? `https://api.dexscreener.com/token-pairs/v1/solana/${q}`
        : `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`,
    );
    return terminalPairs(
      (Array.isArray(body) ? body : (body.pairs ?? [])) as DexPair[],
      Date.now(),
    ).slice(0, 20);
  });
}
export async function terminalToken(mint: string) {
  if (!isSolanaAddress(mint)) throw Error("Invalid Solana token address");
  return (await terminalSearch(mint)).find((t) => t.mint === mint) ?? null;
}
export async function terminalCandles(pair: string, frame: string, mint: string) {
  if (!isSolanaAddress(mint)) throw Error("Invalid chart token address");
  if (!isSolanaAddress(pair)) throw Error("Invalid pool address");
  const frames: Record<string, [string, number]> = {
    "1m": ["minute", 1],
    "5m": ["minute", 5],
    "15m": ["minute", 15],
    "1h": ["hour", 1],
    "4h": ["hour", 4],
  };
  const spec = frames[frame];
  if (!spec) throw Error("Unsupported chart interval");
  return cached(`candles:${pair}:${mint}:${frame}`, 30000, async () => {
    const b = await json(
      `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pair}/ohlcv/${spec[0]}?aggregate=${spec[1]}&limit=100&currency=usd&token=${mint}`,
    );
    return {
      candles: normalizeCandles(b.data?.attributes?.ohlcv_list),
      source: "GeckoTerminal",
      fetchedAt: Date.now(),
      frame,
      pair,
    };
  });
}

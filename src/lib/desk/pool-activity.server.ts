import { isSolanaAddress } from "./capital.ts";
import { poolTransactions, type PoolActivity } from "./pool-activity.ts";
const cache = new Map<string, PoolActivity>(),
  pending = new Map<string, Promise<PoolActivity>>();
let lastRequest = 0;
export async function poolActivity(pair: string): Promise<PoolActivity> {
  if (!isSolanaAddress(pair)) throw Error("Select an indexed Solana pool first");
  const old = cache.get(pair);
  if (old && Date.now() - old.fetchedAt < 30000) return old;
  const running = pending.get(pair);
  if (running) return running;
  if (Date.now() - lastRequest < 3000)
    throw Error("Public transaction feed is cooling down; retry shortly");
  lastRequest = Date.now();
  const task = (async () => {
    const r = await fetch("https://api.mainnet-beta.solana.com", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getSignaturesForAddress",
        params: [pair, { limit: 20, commitment: "confirmed" }],
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw Error(`Public Solana transaction feed returned ${r.status}`);
    const b = await r.json();
    if (b.error) throw Error("Public Solana transaction feed is unavailable");
    if (!Array.isArray(b.result)) throw Error("Public transaction feed returned no valid result");
    const data: PoolActivity = {
      network: "solana-mainnet",
      readOnly: true,
      classification: "UNDECODED_ACCOUNT_ACTIVITY",
      pair,
      fetchedAt: Date.now(),
      source: "Solana public RPC · getSignaturesForAddress",
      transactions: poolTransactions(b.result),
    };
    if (cache.size >= 30) cache.delete(cache.keys().next().value!);
    cache.set(pair, data);
    return data;
  })().finally(() => pending.delete(pair));
  pending.set(pair, task);
  return task;
}

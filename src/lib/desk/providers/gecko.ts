import type { TokenSnapshot } from "../schema";
import { blankSnapshot, deriveVolume1m, field } from "./normalize";
import { getJsonRetry } from "./http";

type GeckoPool = {
  id: string;
  attributes: {
    address: string;
    name: string;
    base_token_price_usd: string | null;
    reserve_in_usd: string | null;
    fdv_usd: string | null;
    market_cap_usd: string | null;
    pool_created_at: string | null;
    volume_usd?: Record<string, string>;
    transactions?: Record<
      string,
      { buys?: number; sells?: number; buyers?: number; sellers?: number }
    >;
  };
  relationships?: {
    base_token?: { data?: { id: string } };
    quote_token?: { data?: { id: string } };
  };
};

function num(v: string | number | null | undefined) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function mintFromRel(id?: string) {
  if (!id) return "";
  return id.startsWith("solana_") ? id.slice(7) : id;
}

export async function fetchGeckoPools(): Promise<{
  tokens: TokenSnapshot[];
  solPrice: number | null;
  lagMs: number;
  error?: string;
}> {
  const t0 = Date.now();
  const ingestedAt = t0;
  try {
    const urls = [
      "https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=1",
      "https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1",
    ];
    const res = await Promise.all(urls.map((u) => getJsonRetry(u, 6000, 2)));
    const bodies = await Promise.all(
      res.map(async (r) => {
        if (!r.ok) return { data: [] as GeckoPool[], status: r.status };
        return { ...((await r.json()) as { data?: GeckoPool[] }), status: r.status };
      }),
    );
    const failed = res.filter((r) => !r.ok);
    const lagMs = Date.now() - t0;
    const eventTime = Date.now();
    const pools = bodies.flatMap((b) => b.data ?? []);
    const byMint = new Map<string, TokenSnapshot>();
    let solPrice: number | null = null;

    for (const pool of pools) {
      const quote = mintFromRel(pool.relationships?.quote_token?.data?.id);
      const base = mintFromRel(pool.relationships?.base_token?.data?.id);
      if (!base || quote !== "So11111111111111111111111111111111111111112") continue;
      const a = pool.attributes;
      const price = num(a.base_token_price_usd);
      const liq = num(a.reserve_in_usd);
      const name = (a.name ?? "").split("/")[0]?.trim() || "UNK";
      const created = a.pool_created_at ? Date.parse(a.pool_created_at) : null;
      const tx5 = a.transactions?.m5;
      const vol = a.volume_usd;
      const vol5 = field(num(vol?.m5), eventTime, ingestedAt, "geckoterminal");
      const snap: TokenSnapshot = {
        ...blankSnapshot(base, eventTime, ingestedAt),
        pairAddress: a.address,
        symbol: name.slice(0, 8).toUpperCase(),
        name,
        createdAt: Number.isFinite(created) ? created : null,
        priceUsd: field(price, eventTime, ingestedAt, "geckoterminal"),
        liquidityUsd: field(liq, eventTime, ingestedAt, "geckoterminal"),
        mcapUsd: field(num(a.market_cap_usd) ?? num(a.fdv_usd), eventTime, ingestedAt, "geckoterminal"),
        fdvUsd: field(num(a.fdv_usd), eventTime, ingestedAt, "geckoterminal"),
        volume5mUsd: vol5,
        volume1mUsd: deriveVolume1m(vol5, eventTime, ingestedAt),
        volume1hUsd: field(num(vol?.h1), eventTime, ingestedAt, "geckoterminal"),
        buys5m: field(tx5?.buys ?? null, eventTime, ingestedAt, "geckoterminal"),
        sells5m: field(tx5?.sells ?? null, eventTime, ingestedAt, "geckoterminal"),
        uniqueBuyers5m: field(tx5?.buyers ?? null, eventTime, ingestedAt, "geckoterminal"),
        uniqueSellers5m: field(tx5?.sellers ?? null, eventTime, ingestedAt, "geckoterminal"),
      };
      const prev = byMint.get(base);
      const prevLiq = prev?.liquidityUsd.value ?? 0;
      if (!prev || (liq ?? 0) > prevLiq) byMint.set(base, snap);
    }

    const solPool = pools.find(
      (p) =>
        mintFromRel(p.relationships?.base_token?.data?.id) ===
        "So11111111111111111111111111111111111111112",
    );
    solPrice = num(solPool?.attributes.base_token_price_usd) ?? null;

    return {
      tokens: [...byMint.values()],
      solPrice,
      lagMs,
      error: failed.length === res.length ? `gecko ${failed[0]?.status ?? 0}` : failed.length ? `partial ${failed[0]?.status}` : undefined,
    };
  } catch (e) {
    return {
      tokens: [],
      solPrice: null,
      lagMs: Date.now() - t0,
      error: e instanceof Error ? e.message : "gecko failed",
    };
  }
}

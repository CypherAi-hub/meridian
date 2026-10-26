export type TerminalToken = {
  mint: string;
  pair: string;
  symbol: string;
  name: string;
  quoteSymbol: string;
  dex: string;
  priceUsd: number | null;
  change5m: number | null;
  change1h: number | null;
  change24h: number | null;
  liquidityUsd: number | null;
  volume24h: number | null;
  marketCap: number | null;
  buys5m: number;
  sells5m: number;
  createdAt: number | null;
  imageUrl: string | null;
  source: "DEX Screener";
  fetchedAt: number;
};
export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};
export function normalizeCandles(rows: unknown): Candle[] {
  if (!Array.isArray(rows)) return [];
  const by = new Map<number, Candle>();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [time, open, high, low, close, volume] = row.map(Number);
    if (
      ![time, open, high, low, close, volume].every(Number.isFinite) ||
      !Number.isInteger(time) ||
      time <= 0 ||
      open <= 0 ||
      close <= 0 ||
      low <= 0 ||
      high < Math.max(open, close) ||
      low > Math.min(open, close) ||
      volume < 0
    )
      continue;
    by.set(time, { time, open, high, low, close, volume });
  }
  return [...by.values()].sort((a, b) => a.time - b.time);
}
export type DexPair = {
  chainId?: string;
  pairAddress?: string;
  dexId?: string;
  baseToken?: { address: string; symbol: string; name: string };
  quoteToken?: { symbol?: string };
  priceUsd?: string;
  priceChange?: { m5?: number; h1?: number; h24?: number };
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  marketCap?: number;
  fdv?: number;
  txns?: { m5?: { buys?: number; sells?: number } };
  pairCreatedAt?: number;
  info?: { imageUrl?: string };
};
const number = (x: unknown) => (x != null && Number.isFinite(Number(x)) ? Number(x) : null);
export function terminalPairs(pairs: DexPair[], now: number): TerminalToken[] {
  const by = new Map<string, TerminalToken>();
  for (const p of pairs) {
    if (p.chainId !== "solana" || !p.baseToken?.address || !p.pairAddress) continue;
    const t: TerminalToken = {
      mint: p.baseToken.address,
      pair: p.pairAddress,
      symbol: p.baseToken.symbol?.slice(0, 18) || "TOKEN",
      name: p.baseToken.name?.slice(0, 80) || "Unknown token",
      quoteSymbol: p.quoteToken?.symbol ?? "SOL",
      dex: p.dexId ?? "DEX",
      priceUsd: number(p.priceUsd),
      change5m: number(p.priceChange?.m5),
      change1h: number(p.priceChange?.h1),
      change24h: number(p.priceChange?.h24),
      liquidityUsd: number(p.liquidity?.usd),
      volume24h: number(p.volume?.h24),
      marketCap: number(p.marketCap),
      buys5m: p.txns?.m5?.buys ?? 0,
      sells5m: p.txns?.m5?.sells ?? 0,
      createdAt: number(p.pairCreatedAt),
      imageUrl: p.info?.imageUrl?.startsWith("https://") ? p.info.imageUrl : null,
      source: "DEX Screener",
      fetchedAt: now,
    };
    if (!by.has(t.mint) || (t.liquidityUsd ?? 0) > (by.get(t.mint)!.liquidityUsd ?? 0))
      by.set(t.mint, t);
  }
  return [...by.values()].sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));
}

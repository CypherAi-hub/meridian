import { PARTICIPANT_FEATURE_ENGINE } from "./v35-lock.ts";
import { asOfEvents } from "./v35-clock.ts";
import type { DataStatus, ParticipantEvent, ParticipantFeatureVector, WindowFeatures } from "./v35-types.ts";

const WINDOWS = { w10s: 10_000, w30s: 30_000, w60s: 60_000, w5m: 300_000 } as const;

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function hhi(shares: number[]): number | null {
  if (!shares.length) return null;
  return shares.reduce((s, x) => s + x * x, 0);
}

function emptyWindow(unknown = 1): WindowFeatures {
  return {
    uniqueBuyers: null,
    uniqueSellers: null,
    newBuyers: null,
    repeatBuyers: null,
    newBuyerRatio: null,
    repeatBuyerRatio: null,
    buyerGrowthRate: null,
    sellerGrowthRate: null,
    buyNotional: null,
    sellNotional: null,
    netNotionalFlow: null,
    medianBuySize: null,
    medianSellSize: null,
    top1BuyerShare: null,
    top5BuyerShare: null,
    top1SellerShare: null,
    flowHhiBuy: null,
    walletEntryVelocity: null,
    newWalletShare: null,
    liquidityDeltaPct: null,
    priceChange: null,
    priceChangePerNetBuy: null,
    coverage: 0,
    unknownRatio: unknown,
  };
}

function windowOf(
  events: ParticipantEvent[],
  T: number,
  ms: number,
  priorBuyers: Set<string>,
  firstSeen: Map<string, number>,
): WindowFeatures {
  const from = T - ms;
  const slice = events.filter((e) => e.eventTime > from && e.eventTime <= T);
  if (!slice.length) return emptyWindow(1);
  const buys = slice.filter((e) => e.eventType === "BUY");
  const sells = slice.filter((e) => e.eventType === "SELL");
  const buyers = [...new Set(buys.map((e) => e.walletId).filter((w) => w !== "UNKNOWN"))];
  const sellers = [...new Set(sells.map((e) => e.walletId).filter((w) => w !== "UNKNOWN"))];
  const newBuyers = buyers.filter((w) => !priorBuyers.has(w));
  const repeat = buyers.filter((w) => priorBuyers.has(w));
  const buyNotionals = buys.map((e) => e.usdNotional).filter((n): n is number => n != null);
  const sellNotionals = sells.map((e) => e.usdNotional).filter((n): n is number => n != null);
  const buySum = buyNotionals.reduce((s, n) => s + n, 0);
  const sellSum = sellNotionals.reduce((s, n) => s + n, 0);
  const byBuyer = new Map<string, number>();
  for (const e of buys) {
    if (e.walletId === "UNKNOWN" || e.usdNotional == null) continue;
    byBuyer.set(e.walletId, (byBuyer.get(e.walletId) ?? 0) + e.usdNotional);
  }
  const buyerVals = [...byBuyer.values()].sort((a, b) => b - a);
  const top1 = buySum > 0 && buyerVals[0] != null ? buyerVals[0] / buySum : null;
  const top5 = buySum > 0 ? buyerVals.slice(0, 5).reduce((s, n) => s + n, 0) / buySum : null;
  const shares = buySum > 0 ? buyerVals.map((v) => v / buySum) : [];
  const prices = slice.map((e) => e.observedPrice).filter((p): p is number => p != null && p > 0);
  const priceChange = prices.length >= 2 ? prices[prices.length - 1] / prices[0] - 1 : null;
  const liqAdds = slice.filter((e) => e.eventType === "LIQUIDITY_ADD").reduce((s, e) => s + (e.usdNotional ?? 0), 0);
  const liqRems = slice.filter((e) => e.eventType === "LIQUIDITY_REMOVE").reduce((s, e) => s + (e.usdNotional ?? 0), 0);
  const unknown = slice.filter((e) => e.dataStatus !== "OK" || e.walletId === "UNKNOWN").length / slice.length;
  const newWallet = buyers.filter((w) => {
    const seen = firstSeen.get(w);
    return seen != null && T - seen <= ms;
  }).length;
  return {
    uniqueBuyers: buyers.length,
    uniqueSellers: sellers.length,
    newBuyers: newBuyers.length,
    repeatBuyers: repeat.length,
    newBuyerRatio: buyers.length ? newBuyers.length / buyers.length : null,
    repeatBuyerRatio: buyers.length ? repeat.length / buyers.length : null,
    buyerGrowthRate: priorBuyers.size ? newBuyers.length / Math.max(1, priorBuyers.size) : newBuyers.length,
    sellerGrowthRate: sellers.length,
    buyNotional: buyNotionals.length ? buySum : null,
    sellNotional: sellNotionals.length ? sellSum : null,
    netNotionalFlow: buyNotionals.length || sellNotionals.length ? buySum - sellSum : null,
    medianBuySize: median(buyNotionals),
    medianSellSize: median(sellNotionals),
    top1BuyerShare: top1,
    top5BuyerShare: top5,
    top1SellerShare: null,
    flowHhiBuy: hhi(shares),
    walletEntryVelocity: buyers.length / (ms / 1000),
    newWalletShare: buyers.length ? newWallet / buyers.length : null,
    liquidityDeltaPct: liqAdds + liqRems ? (liqAdds - liqRems) / Math.max(1, liqAdds + liqRems) : null,
    priceChange,
    priceChangePerNetBuy: buySum - sellSum ? (priceChange ?? 0) / (buySum - sellSum) : null,
    coverage: 1 - unknown,
    unknownRatio: unknown,
  };
}

export function computeParticipantFeatures(
  events: ParticipantEvent[],
  opts: { instrumentId: string; T: number; ingestedAt?: number },
): ParticipantFeatureVector {
  const visible = asOfEvents(
    events.filter((e) => e.instrumentId === opts.instrumentId),
    opts.T,
  );
  const prior = visible.filter((e) => e.eventTime <= opts.T - 60_000 && e.eventType === "BUY");
  const priorBuyers = new Set(prior.map((e) => e.walletId).filter((w) => w !== "UNKNOWN"));
  const firstSeen = new Map<string, number>();
  for (const e of visible) {
    if (e.walletId === "UNKNOWN") continue;
    const prev = firstSeen.get(e.walletId);
    if (prev == null || e.eventTime < prev) firstSeen.set(e.walletId, e.eventTime);
  }
  const w10s = windowOf(visible, opts.T, WINDOWS.w10s, priorBuyers, firstSeen);
  const w30s = windowOf(visible, opts.T, WINDOWS.w30s, priorBuyers, firstSeen);
  const w60s = windowOf(visible, opts.T, WINDOWS.w60s, priorBuyers, firstSeen);
  const w5m = windowOf(visible, opts.T, WINDOWS.w5m, priorBuyers, firstSeen);
  const times = visible.map((e) => e.eventTime).sort((a, b) => a - b);
  let maxGap: number | null = null;
  for (let i = 1; i < times.length; i++) maxGap = Math.max(maxGap ?? 0, times[i] - times[i - 1]);
  const known = visible.filter((e) => e.walletId !== "UNKNOWN").length;
  const notion = visible.filter((e) => e.usdNotional != null).length;
  const status: DataStatus = visible.length ? "OK" : "UNKNOWN";
  return {
    instrumentId: opts.instrumentId,
    featureTime: opts.T,
    ingestedAt: opts.ingestedAt ?? opts.T,
    featureVersion: PARTICIPANT_FEATURE_ENGINE,
    w10s,
    w30s,
    w60s,
    w5m,
    priceUpFlowDown: (w60s.priceChange ?? 0) > 0.02 && (w60s.netNotionalFlow ?? 0) < 0,
    priceUpLiquidityDown: (w60s.priceChange ?? 0) > 0.02 && (w60s.liquidityDeltaPct ?? 0) < 0,
    eventCoverage: visible.length ? 1 : 0,
    walletIdentityCoverage: visible.length ? known / visible.length : 0,
    notionalCoverage: visible.length ? notion / visible.length : 0,
    freshnessMs: visible.length ? opts.T - visible[visible.length - 1].eventTime : Number.POSITIVE_INFINITY,
    maxEventGapMs: maxGap,
    dataStatus: status,
  };
}

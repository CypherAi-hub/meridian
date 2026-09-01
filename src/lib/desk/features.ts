import { bucketOf } from "./buckets";
import type { FeatureMeta, Features, Predictions, TokenLive } from "./types";

export function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function sigmoid(z: number) {
  return 1 / (1 + Math.exp(-z));
}

export function computeFeatures(t: TokenLive, now: number): { features: Features; meta: FeatureMeta } {
  const h = t.history.length ? t.history : [t.priceUsd.value ?? 0];
  const price = t.priceUsd.value ?? h[h.length - 1] ?? 0;
  const ago = h[Math.max(0, h.length - 8)] ?? price;
  const hi = Math.max(...h, price);
  const lo = Math.min(...h, price);
  const rets = h.slice(1).map((p, i) => Math.log(Math.max(p, 1e-12) / Math.max(h[i], 1e-12)));
  const mean = rets.reduce((a, b) => a + b, 0) / Math.max(rets.length, 1);
  const rv = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(rets.length, 1));
  const buys = t.buys5m.value ?? 0;
  const sells = t.sells5m.value ?? 0;
  const vol5 = t.volume5mUsd.value ?? 0;
  const liq = t.liquidityUsd.value ?? 0;
  const mcap = t.mcapUsd.value ?? t.fdvUsd.value ?? 0;
  const ageS = t.createdAt ? (now - t.createdAt) / 1000 : null;
  const cross = t.priceCrossUsd.value;
  const implied = t.sellQuote?.impliedPriceUsd ?? t.buyQuote?.impliedPriceUsd ?? null;
  const ref = implied ?? cross;
  const disagreement =
    ref != null && price > 0 ? Math.abs(ref - price) / Math.max((ref + price) / 2, 1e-12) : null;

  const features: Features = {
    tokenAgeS: ageS,
    bucket: bucketOf(ageS),
    ret1m: Math.log(Math.max(price, 1e-12) / Math.max(ago, 1e-12)),
    rv5m: rv,
    volAccel: vol5 / Math.max(t.prevVolume5m, 50),
    usdImbalance: (buys - sells) / Math.max(buys + sells, 1),
    holderGrowth5m: ((t.uniqueBuyers5m.value ?? 0) - t.prevBuyers) / Math.max(t.prevBuyers, 1),
    top10Pct: t.top10Pct.value,
    liqChange1m: (liq - t.prevLiq) / Math.max(t.prevLiq, 1),
    liqMcapRatio: liq / Math.max(mcap, 1),
    uniqueBuyerShare:
      (t.uniqueBuyers5m.value ?? 0) / Math.max((t.uniqueBuyers5m.value ?? 0) + (t.uniqueSellers5m.value ?? 0), 1),
    mintAuth: t.mintAuth.value == null ? null : t.mintAuth.value ? 1 : 0,
    freezeAuth: t.freezeAuth.value == null ? null : t.freezeAuth.value ? 1 : 0,
    sellQuoteAvailable: t.sellQuote?.available ? 1 : 0,
    maxDd5m: (hi - lo) / Math.max(hi, 1e-12),
    entryImpactPct: t.buyQuote?.priceImpactPct ?? null,
    exitImpactPct: t.sellQuote?.priceImpactPct ?? null,
    snapshotAgeMs: now - t.priceUsd.ingestedAt,
    priceDisagreement: disagreement,
  };

  const meta: FeatureMeta = {};
  const cells: [string, { source: string; eventTime: number; ingestedAt: number; lagMs: number }][] = [
    ["price", t.priceUsd],
    ["liquidity", t.liquidityUsd],
    ["mcap", t.mcapUsd],
    ["volume5m", t.volume5mUsd],
    ["buys5m", t.buys5m],
    ["uniqueBuyers", t.uniqueBuyers5m],
    ["holders", t.holders],
    ["top10", t.top10Pct],
    ["mint", t.mintAuth],
    ["freeze", t.freezeAuth],
  ];
  for (const [k, c] of cells) meta[k] = c;
  if (t.sellQuote) {
    meta.exitQuote = {
      source: t.sellQuote.source,
      eventTime: t.sellQuote.eventTime,
      ingestedAt: t.sellQuote.ingestedAt,
      lagMs: t.sellQuote.latencyMs,
    };
  }

  return { features, meta };
}

export function predict(t: TokenLive, f: Features): Predictions {
  const pCat = clamp(
    sigmoid(
      -3.1 +
        4.8 * (f.top10Pct ?? 0.35) +
        2.2 * (f.mintAuth ?? 1) +
        1.6 * (f.freezeAuth ?? 0) +
        2.4 * Math.max(0, -f.liqChange1m) -
        0.9 * f.liqMcapRatio,
    ),
    0.02,
    0.95,
  );
  const pTp = clamp(
    sigmoid(
      -0.4 +
        0.5 * Math.log(Math.max(f.volAccel, 0.2)) +
        1.2 * f.usdImbalance +
        0.8 * f.uniqueBuyerShare -
        2.0 * f.rv5m -
        0.8 * pCat,
    ),
    0.08,
    0.92,
  );
  const exec =
    12 +
    (f.exitImpactPct ?? 0.4) * 100 +
    (f.entryImpactPct ?? 0.4) * 80 +
    ((t.liquidityUsd.value ?? 0) < 40_000 ? 35 : 0);
  const ret = 0.015 * f.usdImbalance + 0.01 * (f.volAccel - 1) - 0.03 * pCat;
  const edge = ret * 10_000 - exec;
  const momentum = clamp(50 + f.ret1m * 400 + (f.volAccel - 1) * 12, 1, 99);
  const flow = clamp(50 + f.usdImbalance * 40 + f.uniqueBuyerShare * 20, 1, 99);
  const safety = clamp((1 - pCat) * 100, 1, 99);
  const edgeScore = clamp(50 + edge / 20, 1, 99);
  return {
    momentumScore: momentum,
    flowScore: flow,
    safetyScore: safety,
    edgeScore,
    pCatastrophic15m: pCat,
    pTpBeforeSl: pTp,
    returnQ50: ret,
    maeQ90: 0.06 + f.rv5m * 0.7,
    mfeQ50: Math.max(0.02, ret + 0.05),
    expectedExecCostBps: exec,
    expectedNetEdgeBps: edge,
    uncertainty: 0.15 + f.rv5m + (f.top10Pct == null ? 0.1 : 0),
  };
}

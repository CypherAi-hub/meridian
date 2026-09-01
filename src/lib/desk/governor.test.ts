import assert from "node:assert/strict";
import { test } from "node:test";
import { govern } from "./governor.ts";
import { blankSnapshot, emptyField, field } from "./providers/normalize.ts";
import type { Features, Predictions, TokenLive } from "./types.ts";

function live(partial: Partial<TokenLive> = {}): TokenLive {
  const now = Date.now();
  const base = blankSnapshot("Mint111111111111111111111111111111111111111", now, now);
  return {
    ...base,
    symbol: "TEST",
    name: "Test",
    history: [1, 1.01, 1.02],
    prevLiq: 80_000,
    prevVolume5m: 12_000,
    prevBuyers: 40,
    rugged: false,
    priceUsd: field(1.02, now, now, "dexscreener"),
    liquidityUsd: field(80_000, now, now, "dexscreener"),
    mcapUsd: field(400_000, now, now, "dexscreener"),
    mintAuth: field(false, now, now, "solana"),
    freezeAuth: field(false, now, now, "solana"),
    top10Pct: field(0.18, now, now, "solana"),
    buyQuote: {
      available: true,
      inMint: "in",
      outMint: "out",
      inAmount: "1",
      outAmount: "1",
      notionalUsd: 120,
      priceImpactPct: 0.004,
      impliedPriceUsd: 1.024,
      routeLabels: ["Raydium"],
      latencyMs: 80,
      eventTime: now,
      ingestedAt: now,
      source: "jupiter",
    },
    sellQuote: {
      available: true,
      inMint: "out",
      outMint: "in",
      inAmount: "1",
      outAmount: "1",
      notionalUsd: 120,
      priceImpactPct: 0.005,
      impliedPriceUsd: 1.015,
      routeLabels: ["Raydium"],
      latencyMs: 90,
      eventTime: now,
      ingestedAt: now,
      source: "jupiter",
    },
    ...partial,
  };
}

const features: Features = {
  tokenAgeS: 900,
  bucket: "new_launch",
  ret1m: 0.02,
  rv5m: 0.04,
  volAccel: 1.8,
  usdImbalance: 0.2,
  holderGrowth5m: 0.1,
  top10Pct: 0.18,
  liqChange1m: 0.02,
  liqMcapRatio: 0.2,
  uniqueBuyerShare: 0.6,
  mintAuth: 0,
  freezeAuth: 0,
  sellQuoteAvailable: 1,
  maxDd5m: 0.05,
  entryImpactPct: 0.004,
  exitImpactPct: 0.005,
  snapshotAgeMs: 400,
  priceDisagreement: 0.01,
};

const pred: Predictions = {
  momentumScore: 70,
  flowScore: 65,
  safetyScore: 80,
  edgeScore: 62,
  pCatastrophic15m: 0.04,
  pTpBeforeSl: 0.6,
  returnQ50: 0.04,
  maeQ90: 0.08,
  mfeQ50: 0.12,
  expectedExecCostBps: 40,
  expectedNetEdgeBps: 120,
  uncertainty: 0.2,
};

const baseOpts = {
  f: features,
  pred,
  equity: 25_000,
  riskBps: 25,
  openCount: 0,
  maxPositions: 4,
  regime: "meme_mania" as const,
  strategyId: "launch_velocity_pullback",
  now: Date.now(),
  dayDd: 0,
};

test("governor authorizes a complete, routeable name", () => {
  const g = govern({ ...baseOpts, t: live() });
  assert.equal(g.approved, true);
  assert.ok(g.layers.every((l) => l.status === "PASS"));
});

test("unknown mint authority is UNKNOWN and a veto", () => {
  const now = Date.now();
  const t = live({ mintAuth: emptyField(now, now, "solana") });
  const g = govern({ ...baseOpts, t });
  assert.equal(g.approved, false);
  const layer = g.layers.find((l) => l.name === "Contract risk");
  assert.equal(layer?.status, "UNKNOWN");
});

test("unknown holders veto new launches", () => {
  const now = Date.now();
  const t = live({ top10Pct: emptyField(now, now, "solana") });
  const g = govern({ ...baseOpts, t });
  assert.equal(g.approved, false);
  const layer = g.layers.find((l) => l.name === "Holder concentration");
  assert.equal(layer?.status, "UNKNOWN");
  assert.notEqual(layer?.status, "PASS");
});

test("FAIL governor gate vetoes the trade", () => {
  const now = Date.now();
  const t = live({ mintAuth: field(true, now, now, "solana") });
  const g = govern({ ...baseOpts, t });
  assert.equal(g.approved, false);
  assert.equal(g.layers.find((l) => l.name === "Contract risk")?.status, "FAIL");
});

test("unknown holders on emerging cut size but can pass other gates", () => {
  const now = Date.now();
  const t = live({ top10Pct: emptyField(now, now, "solana") });
  const g = govern({
    ...baseOpts,
    t,
    f: { ...features, tokenAgeS: 8 * 3600, bucket: "emerging" },
  });
  const layer = g.layers.find((l) => l.name === "Holder concentration");
  assert.equal(layer?.status, "UNKNOWN");
  assert.equal(g.approved, true);
  assert.ok(g.sizedUsd < 200);
});

test("missing sell route is a veto", () => {
  const t = live({ sellQuote: { ...live().sellQuote!, available: false, error: "no route" } });
  const g = govern({ ...baseOpts, t });
  assert.equal(g.approved, false);
  assert.equal(g.layers.find((l) => l.name === "Exit route")?.status, "FAIL");
});

test("unquoted exit is UNKNOWN, not a silent pass", () => {
  const t = live({ sellQuote: null, buyQuote: null });
  const g = govern({ ...baseOpts, t });
  assert.equal(g.approved, false);
  assert.equal(g.layers.find((l) => l.name === "Exit route")?.status, "UNKNOWN");
});

test("stressed exit above 7% is a veto", () => {
  const t = live({
    liquidityUsd: field(8_000, Date.now(), Date.now(), "dexscreener"),
    sellQuote: { ...live().sellQuote!, priceImpactPct: 0.09, notionalUsd: 120 },
  });
  const g = govern({ ...baseOpts, t });
  assert.equal(g.approved, false);
  assert.equal(g.layers.find((l) => l.name === "Price impact")?.status, "FAIL");
});

test("jupiter timeout is UNKNOWN not a fake no-route fail", () => {
  const now = Date.now();
  const t = live({
    sellQuote: {
      ...live().sellQuote!,
      available: false,
      routeState: "TIMEOUT",
      failureReason: "QUOTE_TIMEOUT",
      error: "timeout",
    },
  });
  const g = govern({ ...baseOpts, t, now });
  assert.equal(g.approved, false);
  const layer = g.layers.find((l) => l.name === "Exit route");
  assert.equal(layer?.status, "UNKNOWN");
  assert.equal(layer?.reasonCode, "QUOTE_TIMEOUT");
  assert.ok(g.reasonCodes.includes("QUOTE_TIMEOUT"));
});

test("hard fail overrides a strategy that would otherwise match", () => {
  const now = Date.now();
  const t = live({ liquidityUsd: field(8_000, now, now, "dexscreener") });
  const g = govern({ ...baseOpts, t });
  assert.equal(g.approved, false);
  assert.equal(g.layers.find((l) => l.name === "Liquidity")?.status, "FAIL");
  assert.ok(g.reasonCodes.includes("LIQUIDITY_TOO_LOW"));
});

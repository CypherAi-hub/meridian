import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceSniper,
  newSniper,
  sniperMetrics,
  sniperRejects,
  type QuoteAdapter,
  type SwapRequest,
} from "./sniper.ts";
import type { QuoteObs, TokenSnapshot } from "./schema.ts";
import { USDC } from "./schema.ts";
const base = 1_800_000_000_000;
function token(now: number, mint = "mint-1"): TokenSnapshot {
  const f = <T>(value: T) => ({
    value,
    eventTime: now,
    ingestedAt: now,
    source: "solana" as const,
    status: "VALID" as const,
    lagMs: 0,
  });
  return {
    address: mint,
    pairAddress: "pair",
    symbol: "TEST",
    name: "test",
    decimals: 6,
    mintSafety: {
      program: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      initialized: true,
      supported: true,
    },
    createdAt: base - 60_000,
    priceUsd: f(1),
    priceCrossUsd: f(1),
    liquidityUsd: f(50_000),
    mcapUsd: f(100_000),
    fdvUsd: f(100_000),
    volume1mUsd: f(2000),
    volume5mUsd: f(10000),
    volume1hUsd: f(10000),
    buys5m: f(80),
    sells5m: f(20),
    uniqueBuyers5m: f(70),
    uniqueSellers5m: f(20),
    holders: f(200),
    top10Pct: f(0.2),
    mintAuth: f(false),
    freezeAuth: f(false),
    buyQuote: null,
    sellQuote: null,
  };
}
function quote(r: SwapRequest, now: number, out = "25000000"): QuoteObs {
  return {
    available: true,
    inMint: r.inputMint,
    outMint: r.outputMint,
    inAmount: r.amount,
    outAmount: out,
    notionalUsd: r.notionalUsd,
    priceImpactPct: 0.01,
    impliedPriceUsd: 1,
    routeLabels: ["test"],
    latencyMs: 50,
    eventTime: now,
    ingestedAt: now,
    source: "jupiter",
    routeState: "QUOTE_ONLY",
  };
}
async function entered() {
  let s = await advanceSniper(newSniper(base), [token(base)], base, async () => {
    throw Error("no quote on signal");
  });
  s = await advanceSniper(s, [token(base + 2000)], base + 2000, async (r) => quote(r, base + 2000));
  return s;
}

test("signal freezes decision and cannot fill at the trigger price or before latency", async () => {
  const t = token(base);
  let calls = 0;
  const adapter: QuoteAdapter = async (r) => {
    calls++;
    return quote(r, base);
  };
  let s = await advanceSniper(newSniper(base), [t], base, adapter);
  assert.equal(calls, 0);
  assert.equal(s.trades[0].status, "pending");
  t.priceUsd.value = 99;
  assert.equal(s.trades[0].signal.priceUsd.value, 1);
  s = await advanceSniper(s, [token(base + 1000)], base + 1000, adapter);
  assert.equal(calls, 0);
});
test("entry uses exact USDC notional, adverse raw size, fees and cash accounting", async () => {
  const s = await entered();
  assert.equal(s.trades[0].entryQuote?.inMint, USDC);
  assert.equal(s.trades[0].rawQty, "24750000");
  assert.equal(s.cash, 1000 - 25 * 1.0025 - 0.02);
  assert.equal(s.trades[0].status, "open");
});
test("exit uses the full actual quantity and cannot fill from its triggering quote", async () => {
  let s = await entered();
  const cost = s.trades[0].costUsd!;
  const sell: QuoteAdapter = async (r) => {
    assert.equal(r.amount, "24750000");
    return quote(r, base + 3000, "30000000");
  };
  s = await advanceSniper(s, [token(base + 3000)], base + 3000, sell);
  assert.equal(s.trades[0].status, "open");
  assert.equal(s.trades[0].exitDueAt, base + 5000);
  s = await advanceSniper(s, [], base + 5000, async (r) => quote(r, base + 5000, "30000000"));
  assert.equal(s.trades[0].status, "closed");
  const proceeds = 30 * 0.99 * 0.9975 - 0.02;
  assert.ok(Math.abs(s.trades[0].pnlUsd! - (proceeds - cost)) < 1e-9);
  assert.ok(Math.abs(s.cash - (1000 + proceeds - cost)) < 1e-9);
});
test("missing sell route stays unresolved and conservatively marks at zero", async () => {
  let s = await entered();
  s = await advanceSniper(s, [], base + 600_000, async (r) => ({
    ...quote(r, base + 600_000),
    available: false,
    routeState: "NO_ROUTE",
    failureReason: "NO_ROUTE",
  }));
  assert.equal(s.trades[0].status, "open");
  assert.equal(s.trades[0].error, "NO_ROUTE");
  assert.equal(sniperMetrics(s).blockedExits, 1);
  assert.equal(sniperMetrics(s).equityUsd, s.cash);
  assert.equal(sniperMetrics(s).closed, 0);
});
test("quote timeout/error cannot be a successful fill", async () => {
  let s = await advanceSniper(newSniper(base), [token(base)], base, async (r) => quote(r, base));
  s = await advanceSniper(s, [token(base + 2000)], base + 2000, async () => {
    throw Error("timeout");
  });
  assert.equal(s.cash, 1000);
  assert.equal(s.trades[0].status, "pending");
  s = await advanceSniper(s, [], base + 100_000, async () => {
    throw Error("must not quote expired");
  });
  assert.equal(s.trades[0].status, "expired");
});
test("stale, future, wrong-size and wrong-token quote responses never fill", async () => {
  for (const patch of [
    { eventTime: base },
    { eventTime: base + 100_000 },
    { inAmount: "1" },
    { outMint: "attacker" },
    { outAmount: "NaN" },
  ]) {
    let s = await advanceSniper(newSniper(base), [token(base)], base, async (r) => quote(r, base));
    s = await advanceSniper(s, [token(base + 2000)], base + 2000, async (r) => ({
      ...quote(r, base + 2000),
      ...patch,
    }));
    assert.equal(s.cash, 1000);
    assert.equal(s.trades[0].status, "pending");
  }
});
test("unknown authority, holder concentration and future observations reject candidates", () => {
  const t = token(base);
  t.mintAuth.value = null;
  t.top10Pct.value = null;
  t.priceUsd.eventTime = base + 1;
  const r = sniperRejects(t, base);
  assert.ok(r.includes("CONTRACT_AUTHORITY_UNKNOWN_OR_ENABLED"));
  assert.ok(r.includes("HOLDER_CONCENTRATION"));
  assert.ok(r.includes("MISSING_OR_STALE_priceUsd"));
});
test("pending orders reserve cash/slots and duplicate discoveries cannot resignal", async () => {
  let s = await advanceSniper(
    newSniper(base),
    Array.from({ length: 10 }, (_, i) => token(base, `m${i}`)),
    base,
    async () => {
      throw Error("no quote");
    },
  );
  assert.equal(s.trades.length, 3);
  s = await advanceSniper(s, [token(base + 1, "m0")], base + 1, async () => {
    throw Error("no quote");
  });
  assert.equal(s.trades.length, 3);
  assert.equal(s.cash, 1000);
});
test("pause prevents new entries but permits delayed liquidation", async () => {
  let s = await entered();
  s.enabled = false;
  s = await advanceSniper(s, [token(base + 3000, "new")], base + 3000, async (r) =>
    quote(r, base + 3000),
  );
  assert.equal(s.trades.length, 1);
  assert.equal(s.trades[0].exitReason, "PAUSED_LIQUIDATION");
  s = await advanceSniper(s, [], base + 5000, async (r) => quote(r, base + 5000));
  assert.equal(s.trades[0].status, "closed");
});
test("closed history survives JSON restart and winning examples remain unproven", async () => {
  let s = await entered();
  s = JSON.parse(JSON.stringify(s));
  s = await advanceSniper(s, [], base + 400_000, async (r) => quote(r, base + 400_000, "50000000"));
  s = await advanceSniper(s, [], base + 402_000, async (r) => quote(r, base + 402_000, "50000000"));
  assert.equal(sniperMetrics(s).closed, 1);
  assert.ok(sniperMetrics(s).netUsd > 0);
  assert.equal(sniperMetrics(s).evidence, "UNPROVEN");
  assert.ok(sniperMetrics(s).blockers.includes("NO_UNTOUCHED_FORWARD_VALIDATION"));
});
test("stop loss includes entry and exit costs and negative PnL", async () => {
  let s = await entered();
  s = await advanceSniper(s, [], base + 3000, async (r) => quote(r, base + 3000, "20000000"));
  assert.equal(s.trades[0].exitReason, "STOP_LOSS");
  s = await advanceSniper(s, [], base + 5000, async (r) => quote(r, base + 5000, "19000000"));
  assert.ok(s.trades[0].pnlUsd! < 0);
  assert.equal(sniperMetrics(s).wins, 0);
});

test("reported marks expire using report time even when collection has stopped", async () => {
  let s = await entered();
  s = await advanceSniper(s, [], base + 3000, async (r) => quote(r, base + 3000, "30000000"));
  assert.ok(sniperMetrics(s, base + 3000).equityUsd > s.cash);
  assert.equal(sniperMetrics(s, base + 100000).equityUsd, s.cash);
  assert.equal(sniperMetrics(s, base + 100000).blockedExits, 1);
});
test("experimental liquidity arms retain the original book configuration", async () => {
  const t = token(base);
  t.liquidityUsd.value = 20000;
  const original = await advanceSniper(newSniper(base), [t], base, async (r) => quote(r, base));
  const experimental = await advanceSniper(
    newSniper(base, "paper-flow-10k-v1"),
    [t],
    base,
    async (r) => quote(r, base),
  );
  assert.equal(original.trades.length, 0);
  assert.equal(experimental.trades.length, 1);
  assert.equal(original.config.minLiquidityUsd, 35000);
  assert.equal(experimental.config.minLiquidityUsd, 10000);
});
test("confirmed flow needs an earlier observed window, not future or repeated prices", async () => {
  let s = newSniper(base, "paper-confirmed-10k-v1");
  s = await advanceSniper(s, [token(base)], base, async (r) => quote(r, base));
  assert.equal(s.trades.length, 0);
  const t = token(base + 10000);
  t.priceUsd.value = 1.05;
  s = await advanceSniper(s, [t], base + 10000, async (r) => quote(r, base + 10000));
  assert.equal(s.trades.length, 0);
  const later = token(base + 30000);
  later.priceUsd.value = 1.08;
  s = await advanceSniper(s, [later], base + 30000, async (r) => quote(r, base + 30000));
  assert.equal(s.trades.length, 1);
  assert.equal(s.trades[0].signalAt, base + 30000);
  assert.equal(s.trades[0].status, "pending");
});
test("unsupported token behavior never inherits safe legacy mint permissions", () => {
  const t = token(base);
  t.mintSafety = { program: "Token2022", initialized: true, supported: false };
  assert.ok(sniperRejects(t, base).includes("MINT_PROGRAM_NOT_VERIFIED"));
});

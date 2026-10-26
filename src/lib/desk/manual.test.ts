import test from "node:test";
import assert from "node:assert/strict";
import {
  newManualBook,
  queueManualOrder,
  advanceManual,
  manualMetrics,
  usdAtomic,
} from "./manual.ts";
import { USDC, type QuoteObs } from "./schema.ts";
import type { SwapRequest } from "./sniper.ts";
const T = 1800000000000;
const buy = (id = "request-0001", amount = "25") => ({
  requestId: id,
  side: "BUY" as const,
  mint: "TOKEN",
  symbol: "TEST",
  decimals: 6,
  amountUsdc: amount,
});
function quote(r: SwapRequest, at: number, out = "100000000"): QuoteObs {
  return {
    available: true,
    inMint: r.inputMint,
    outMint: r.outputMint,
    inAmount: r.amount,
    outAmount: out,
    notionalUsd: r.notionalUsd,
    priceImpactPct: 0.01,
    impliedPriceUsd: 1,
    routeLabels: ["fixture"],
    latencyMs: 50,
    eventTime: at,
    ingestedAt: at,
    source: "jupiter",
    routeState: "QUOTE_ONLY",
  };
}
async function entered() {
  let s = queueManualOrder(newManualBook(T), buy(), T);
  return advanceManual(s, T + 2000, async (r) =>
    quote(r, T + 2000, r.inputMint === USDC ? "100000000" : "25000000"),
  );
}
test("USDC input rejects exponent, excess precision and negative values", () => {
  assert.equal(usdAtomic("25.125"), "25125000");
  for (const v of ["-1", "1e2", "1.0000001", "NaN"]) assert.throws(() => usdAtomic(v));
});
test("pending manual buys reserve cash and request IDs are idempotent only for identical details", () => {
  const s = queueManualOrder(newManualBook(T), buy(), T);
  assert.equal(manualMetrics(s, T).availableUsdc, 974.9175);
  assert.equal(queueManualOrder(s, buy(), T + 1).orders.length, 1);
  assert.throws(() => queueManualOrder(s, buy("request-0001", "50"), T + 1), /different order/);
  assert.throws(() => queueManualOrder(s, buy("request-0002"), T + 1), /already pending/);
  const low = { ...newManualBook(T), cashAtomic: "30000000" };
  const p = queueManualOrder(low, buy(), T);
  assert.throws(
    () => queueManualOrder(p, { ...buy("request-0003"), mint: "OTHER" }, T),
    /Insufficient/,
  );
});
test("manual buys wait for latency and debit actual notional plus modeled costs", async () => {
  let calls = 0;
  let s = queueManualOrder(newManualBook(T), buy(), T);
  s = await advanceManual(s, T + 1000, async (r) => {
    calls++;
    return quote(r, T + 1000);
  });
  assert.equal(calls, 0);
  s = await entered();
  assert.equal(s.orders[0].status, "FILLED");
  assert.equal(s.positions[0].rawQty, "99000000");
  assert.equal(s.cashAtomic, "974917500");
  assert.equal(s.fills[0].costBasisAtomic, "25082500");
});
test("partial sells use exact raw quantity and proportional entry costs", async () => {
  let s = await entered();
  s = queueManualOrder(
    s,
    {
      requestId: "request-sell-01",
      side: "SELL",
      mint: "TOKEN",
      symbol: "TEST",
      decimals: 6,
      percent: 50,
    },
    T + 3000,
  );
  s = await advanceManual(s, T + 5000, async (r) => {
    assert.equal(r.amount, "49500000");
    return quote(r, T + 5000, "15000000");
  });
  const fill = s.fills.find((f) => f.side === "SELL")!;
  assert.equal(fill.costBasisAtomic, "12541250");
  assert.equal(fill.pnlAtomic, "2251625");
  assert.equal(s.positions[0].rawQty, "49500000");
  assert.equal(s.positions[0].costAtomic, "12541250");
});
test("invalid or unavailable quotes never create fills and expired orders stay expired", async () => {
  let s = queueManualOrder(newManualBook(T), buy(), T);
  s = await advanceManual(s, T + 2000, async (r) => ({ ...quote(r, T + 2000), inAmount: "1" }));
  assert.equal(s.fills.length, 0);
  assert.equal(s.cashAtomic, "1000000000");
  s = await advanceManual(s, T + 100000, async () => {
    throw Error("must not quote");
  });
  assert.equal(s.orders[0].status, "EXPIRED");
});
test("stale, pre-delay, future, and wrong-mint quotes cannot fill a manual order", async () => {
  for (const change of [
    { eventTime: T + 1000 },
    { ingestedAt: T + 1000 },
    { eventTime: T + 99999 },
    { outMint: "WRONG" },
    { available: false },
  ]) {
    const queued = queueManualOrder(newManualBook(T), buy(), T);
    const next = await advanceManual(queued, T + 5000, async (r) => ({
      ...quote(r, T + 5000),
      ...change,
    }));
    assert.equal(next.fills.length, 0);
    assert.equal(next.positions.length, 0);
    assert.equal(next.cashAtomic, "1000000000");
  }
});
test("missing exit marks are conservative and full sell removes only its position", async () => {
  let s = await entered();
  assert.equal(manualMetrics(s, T + 100000).equityUsdc, Number(s.cashAtomic) / 1e6);
  s = queueManualOrder(
    s,
    {
      requestId: "request-full-sell",
      side: "SELL",
      mint: "TOKEN",
      symbol: "TEST",
      decimals: 6,
      percent: 100,
    },
    T + 3000,
  );
  s = await advanceManual(s, T + 5000, async (r) => quote(r, T + 5000, "20000000"));
  assert.equal(s.positions.length, 0);
  assert.ok(manualMetrics(s, T + 5000).realizedUsdc < 0);
});

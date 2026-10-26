import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCandles, terminalPairs } from "./terminal-market.ts";
test("candles are ascending, de-duplicated and validated without invented intervals", () => {
  const r = normalizeCandles([
    [180, 2, 4, 1, 3, 20],
    [60, 1, 2, 0.5, 1.5, 5],
    [60, 1, 3, 0.5, 2, 10],
    [120, 3, 1, 5, 2, 9],
    [90, 1, 2, 0.5, 1, -1],
  ]);
  assert.deepEqual(
    r.map((c) => c.time),
    [60, 180],
  );
  assert.equal(r[0].close, 2);
  assert.equal(r[1].volume, 20);
});
test("market lookup keeps only Solana and the most liquid pool for each token", () => {
  const common = {
    chainId: "solana",
    pairAddress: "pool",
    baseToken: { address: "mint", symbol: "TEST", name: "Test" },
    priceUsd: "0.1",
  };
  const r = terminalPairs(
    [
      { ...common, chainId: "ethereum" },
      { ...common, liquidity: { usd: 100 } },
      { ...common, pairAddress: "better", liquidity: { usd: 200 } },
    ],
    1000,
  );
  assert.equal(r.length, 1);
  assert.equal(r[0].pair, "better");
  assert.equal(r[0].priceUsd, 0.1);
  assert.equal(r[0].fetchedAt, 1000);
  assert.equal(terminalPairs([{ ...common, fdv: 1000000 }], 1000)[0].marketCap, null);
});

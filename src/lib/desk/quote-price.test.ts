import test from "node:test";
import assert from "node:assert/strict";
import { impliedQuotePrice } from "./quote-price.ts";
import { USDC, WSOL } from "./schema.ts";

test("USDC paper quotes provide an actual indicative token price without a separate SOL price", () => {
  assert.equal(
    impliedQuotePrice({
      inMint: USDC,
      outMint: WSOL,
      inAmount: "25000000",
      outAmount: "250000000",
      inDecimals: 6,
      outDecimals: 9,
      solPriceUsd: 0,
    }),
    100,
  );
  assert.equal(
    impliedQuotePrice({
      inMint: WSOL,
      outMint: USDC,
      inAmount: "125000000",
      outAmount: "12500000",
      inDecimals: 9,
      outDecimals: 6,
      solPriceUsd: 0,
    }),
    100,
  );
  assert.equal(
    impliedQuotePrice({
      inMint: "TOKEN",
      outMint: USDC,
      inAmount: "2000000",
      outAmount: "10000000",
      inDecimals: 6,
      outDecimals: 6,
      solPriceUsd: 0,
    }),
    5,
  );
});
test("quotes without a known USD leg keep the price unknown instead of reporting zero", () => {
  const quote = {
    inMint: WSOL,
    outMint: "TOKEN",
    inAmount: "1000000000",
    outAmount: "2000000",
    inDecimals: 9,
    outDecimals: 6,
    solPriceUsd: 0,
  };
  assert.equal(impliedQuotePrice(quote), null);
  assert.equal(impliedQuotePrice({ ...quote, solPriceUsd: 100 }), 50);
  assert.equal(impliedQuotePrice({ ...quote, outAmount: "0" }), null);
  assert.equal(impliedQuotePrice({ ...quote, inAmount: "NaN" }), null);
});

import { USDC, WSOL } from "./schema.ts";

/** Indicative token price from quote quantities. This never determines a fill. */
export function impliedQuotePrice(opts: {
  inMint: string;
  outMint: string;
  inAmount: string;
  outAmount: string;
  inDecimals: number;
  outDecimals: number;
  solPriceUsd: number;
}): number | null {
  const inUi = Number(opts.inAmount) / 10 ** opts.inDecimals;
  const outUi = Number(opts.outAmount) / 10 ** opts.outDecimals;
  if (!Number.isFinite(inUi) || !Number.isFinite(outUi) || inUi <= 0 || outUi <= 0) return null;
  if (opts.inMint === USDC) return inUi / outUi;
  if (opts.outMint === USDC) return outUi / inUi;
  if (!Number.isFinite(opts.solPriceUsd) || opts.solPriceUsd <= 0) return null;
  if (opts.inMint === WSOL) return (inUi * opts.solPriceUsd) / outUi;
  if (opts.outMint === WSOL) return (outUi * opts.solPriceUsd) / inUi;
  return null;
}

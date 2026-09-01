export function relativeSpread(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a == null || b == null) return null;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const mid = (a + b) / 2;
  if (mid === 0) return null;
  return Math.abs(a - b) / mid;
}

export function flagDisagreement(opts: {
  priceA?: number | null;
  priceB?: number | null;
  liqA?: number | null;
  liqB?: number | null;
  mcapA?: number | null;
  mcapB?: number | null;
}): { disagreement: boolean; spreadPct: number | null; field: string | null } {
  const price = relativeSpread(opts.priceA, opts.priceB);
  const liq = relativeSpread(opts.liqA, opts.liqB);
  const mcap = relativeSpread(opts.mcapA, opts.mcapB);
  if (price != null && price > 0.03) return { disagreement: true, spreadPct: price, field: "price" };
  if (liq != null && liq > 0.2) return { disagreement: true, spreadPct: liq, field: "liquidity" };
  if (mcap != null && mcap > 0.2) return { disagreement: true, spreadPct: mcap, field: "mcap" };
  const spreads = [price, liq, mcap].filter((n): n is number => n != null);
  return { disagreement: false, spreadPct: spreads.length ? Math.max(...spreads) : null, field: null };
}

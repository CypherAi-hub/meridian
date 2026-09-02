export type VetoBucket =
  | "HOLDER_UNKNOWN"
  | "HOLDER_CONCENTRATION"
  | "SECURITY"
  | "ROUTE"
  | "LIQUIDITY"
  | "REGIME"
  | "FRESHNESS"
  | "OTHER";

export type VetoCounts = Record<VetoBucket, number>;

export function emptyVetoCounts(): VetoCounts {
  return {
    HOLDER_UNKNOWN: 0,
    HOLDER_CONCENTRATION: 0,
    SECURITY: 0,
    ROUTE: 0,
    LIQUIDITY: 0,
    REGIME: 0,
    FRESHNESS: 0,
    OTHER: 0,
  };
}

export function classifyVeto(code: string | null | undefined): VetoBucket {
  const c = (code ?? "").toUpperCase();
  if (c.includes("HOLDER_UNKNOWN")) return "HOLDER_UNKNOWN";
  if (c.includes("TOP10") || c.includes("HOLDER") || c.includes("CONCENTRAT")) return "HOLDER_CONCENTRATION";
  if (c.includes("CONTRACT") || c.includes("MINT_AUTHORITY") || c.includes("FREEZE") || c.includes("SECURITY"))
    return "SECURITY";
  if (c.includes("ROUTE") || c.includes("QUOTE") || c.includes("NO_SELL")) return "ROUTE";
  if (c.includes("LIQUIDITY")) return "LIQUIDITY";
  if (c.includes("REGIME") || c.includes("DRAWDOWN") || c.includes("POSITION")) return "REGIME";
  if (c.includes("STALE") || c.includes("FRESH") || c.includes("PRICE_UNKNOWN") || c.includes("DISAGREE"))
    return "FRESHNESS";
  return "OTHER";
}

export function vetoDistribution(
  rows: Array<{ governor_result?: string; veto_reason_code?: string | null }>,
): VetoCounts {
  const out = emptyVetoCounts();
  for (const r of rows) {
    if (r.governor_result && r.governor_result !== "vetoed") continue;
    out[classifyVeto(r.veto_reason_code)] += 1;
  }
  return out;
}

export type GateGroup = "PASS" | "FAIL" | "UNKNOWN";

export function gateOutcomeGrouping(
  rows: Array<{
    gate?: GateGroup | null;
    labels_complete?: boolean;
    price?: number | null;
    price_after_15m?: number | null;
    rug_detected?: boolean | null;
  }>,
) {
  const buckets: Record<GateGroup, { n: number; rets: number[]; rugs: number }> = {
    PASS: { n: 0, rets: [], rugs: 0 },
    FAIL: { n: 0, rets: [], rugs: 0 },
    UNKNOWN: { n: 0, rets: [], rugs: 0 },
  };
  for (const r of rows) {
    const g: GateGroup = r.gate === "PASS" || r.gate === "FAIL" ? r.gate : "UNKNOWN";
    buckets[g].n += 1;
    if (r.labels_complete && r.price && r.price_after_15m) {
      buckets[g].rets.push(r.price_after_15m / r.price - 1);
    }
    if (r.rug_detected) buckets[g].rugs += 1;
  }
  const summarize = (b: { n: number; rets: number[]; rugs: number }) => {
    const sorted = [...b.rets].sort((a, c) => a - c);
    const mid = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
    return { n: b.n, median15m: mid, rugRate: b.n ? b.rugs / b.n : null };
  };
  return { PASS: summarize(buckets.PASS), FAIL: summarize(buckets.FAIL), UNKNOWN: summarize(buckets.UNKNOWN) };
}

export function counterfactualVeto(
  rows: Array<{
    veto_reason_code?: string | null;
    labels_complete?: boolean;
    price?: number | null;
    price_after_15m?: number | null;
    rug_detected?: boolean | null;
  }>,
) {
  const by: Record<VetoBucket, { n: number; rets: number[]; rugs: number }> = {
    HOLDER_UNKNOWN: { n: 0, rets: [], rugs: 0 },
    HOLDER_CONCENTRATION: { n: 0, rets: [], rugs: 0 },
    SECURITY: { n: 0, rets: [], rugs: 0 },
    ROUTE: { n: 0, rets: [], rugs: 0 },
    LIQUIDITY: { n: 0, rets: [], rugs: 0 },
    REGIME: { n: 0, rets: [], rugs: 0 },
    FRESHNESS: { n: 0, rets: [], rugs: 0 },
    OTHER: { n: 0, rets: [], rugs: 0 },
  };
  for (const r of rows) {
    const k = classifyVeto(r.veto_reason_code);
    by[k].n += 1;
    if (r.labels_complete && r.price && r.price_after_15m) by[k].rets.push(r.price_after_15m / r.price - 1);
    if (r.rug_detected) by[k].rugs += 1;
  }
  const out: Record<string, { n: number; median15m: number | null; rugRate: number | null }> = {};
  for (const [k, b] of Object.entries(by)) {
    const sorted = [...b.rets].sort((a, c) => a - c);
    out[k] = {
      n: b.n,
      median15m: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
      rugRate: b.n ? b.rugs / b.n : null,
    };
  }
  return out;
}

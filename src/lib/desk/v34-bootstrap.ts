export type ClusterRow = { tokenAddress: string; value: number };

function mulberry32(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export type ClusterBootstrap = {
  nTokens: number;
  nObs: number;
  mean: number;
  ciLow: number;
  ciHigh: number;
  draws: number;
};

/** Resample tokens, not observations. 100 rows from one mint ≠ 100 independent samples. */
export function tokenClusterBootstrap(rows: ClusterRow[], opts?: { draws?: number; seed?: number; ci?: number }): ClusterBootstrap {
  const by = new Map<string, number[]>();
  for (const r of rows) {
    const list = by.get(r.tokenAddress) ?? [];
    list.push(r.value);
    by.set(r.tokenAddress, list);
  }
  const tokens = [...by.keys()];
  const nTokens = tokens.length;
  const nObs = rows.length;
  const meanOf = (toks: string[]) => {
    const vals: number[] = [];
    for (const t of toks) vals.push(...(by.get(t) ?? []));
    if (!vals.length) return 0;
    return vals.reduce((s, v) => s + v, 0) / vals.length;
  };
  const mean = meanOf(tokens);
  const draws = opts?.draws ?? 200;
  const rnd = mulberry32(opts?.seed ?? 1337);
  const dist: number[] = [];
  for (let i = 0; i < draws; i++) {
    const sample: string[] = [];
    for (let j = 0; j < nTokens; j++) sample.push(tokens[Math.floor(rnd() * nTokens)] ?? tokens[0]);
    dist.push(meanOf(sample));
  }
  dist.sort((a, b) => a - b);
  const alpha = 1 - (opts?.ci ?? 0.95);
  const lo = dist[Math.floor((alpha / 2) * dist.length)] ?? mean;
  const hi = dist[Math.min(dist.length - 1, Math.floor((1 - alpha / 2) * dist.length))] ?? mean;
  return { nTokens, nObs, mean, ciLow: lo, ciHigh: hi, draws };
}

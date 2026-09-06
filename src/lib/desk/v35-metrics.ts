import { tokenClusterBootstrap } from "./v34-bootstrap.ts";
import type { SniperOutcome, SniperSession } from "./v35-types.ts";

export type SniperCompareRow = {
  tokenAddress: string;
  hit10: boolean;
  net: number;
};

export function sniperResearchReport(
  sessions: SniperSession[],
  outcomes: SniperOutcome[],
  baseline: { hit10: number; n: number; avgNet: number },
) {
  const byId = new Map(outcomes.map((o) => [o.sessionId, o]));
  const rows: SniperCompareRow[] = [];
  let rugs = 0;
  for (const s of sessions) {
    const o = byId.get(s.id);
    if (!o || o.outcomeStatus === "PENDING" || o.outcomeStatus === "INSUFFICIENT_DATA") continue;
    const hit10 = o.upper10BeforeLower10 === "UPPER_FIRST";
    rows.push({ tokenAddress: s.instrumentId, hit10, net: o.executionAdjustedReturn ?? 0 });
    if (o.rugOutcome) rugs += 1;
  }
  const n = rows.length;
  const hit10 = n ? rows.filter((r) => r.hit10).length / n : null;
  const avgNet = n ? rows.reduce((s, r) => s + r.net, 0) / n : null;
  const boot = tokenClusterBootstrap(
    rows.map((r) => ({ tokenAddress: r.tokenAddress, value: r.hit10 ? 1 : 0 })),
    { draws: 80, seed: 1337 },
  );
  return {
    triggerCount: sessions.length,
    uniqueTokensTriggered: new Set(sessions.map((s) => s.instrumentId)).size,
    labeled: n,
    pHit10: hit10,
    meanNet: avgNet,
    rugs,
    vsBaseRate: hit10 == null || baseline.n === 0 ? null : hit10 - baseline.hit10,
    cluster: { nTokens: boot.nTokens, nObs: boot.nObs, ciLow: boot.ciLow, ciHigh: boot.ciHigh },
    note: "Not accuracy. Compare to base rate / random eligible. n tokens, not n ticks.",
  };
}

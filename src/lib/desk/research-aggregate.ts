import { emptyResearch, rebuildSummary } from "./ledger.ts";
import type { LedgerRow, ResearchSummary, Regime } from "./types.ts";
import type { UniverseBucket } from "./buckets.ts";

/** Warehouse columns the aggregate path is allowed to read. No snapshot JSON. */
export type ResearchFact = {
  governor_result: LedgerRow["governor_result"] | null;
  trade_taken: boolean;
  labels_complete: boolean;
  decision_time: number;
  regime: Regime;
  bucket: UniverseBucket;
  strategy_id: string;
  price: number | null;
  price_after_5m: number | null;
  net_execution_return: number | null;
};

export function factsFromLedger(rows: LedgerRow[]): ResearchFact[] {
  return rows.map((r) => ({
    governor_result: r.governor_result,
    trade_taken: Boolean(r.trade_taken),
    labels_complete: Boolean(r.labels_complete),
    decision_time: r.decision_time,
    regime: r.regime,
    bucket: r.bucket,
    strategy_id: r.strategy_id,
    price: r.price,
    price_after_5m: r.price_after_5m ?? null,
    net_execution_return: r.net_execution_return ?? null,
  }));
}

/** SQL-equivalent of loadResearchAggregated. Read-only. Must match rebuildSummary + error age. */
export function aggregateResearchFacts(facts: ResearchFact[], now: number): ResearchSummary {
  const summary = emptyResearch();
  summary.considerations = facts.length;
  summary.vetoed = facts.filter((f) => f.governor_result === "vetoed").length;
  summary.authorized = facts.filter((f) => f.governor_result !== "vetoed").length;
  summary.taken = facts.filter((f) => f.trade_taken).length;
  summary.labeled = facts.filter((f) => f.labels_complete).length;
  summary.incomplete = facts.filter((f) => !f.labels_complete).length;
  summary.errors = facts.filter((f) => !f.labels_complete && now - f.decision_time > 70 * 60_000).length;

  const bump = (
    target: ResearchSummary["byRegime"] | ResearchSummary["byBucket"] | ResearchSummary["byStrategy"],
    key: string,
    f: ResearchFact,
  ) => {
    if (!target[key as keyof typeof target]) {
      (target as ResearchSummary["byStrategy"])[key] = { n: 0, taken: 0, labeled: 0, sum5m: 0, n5m: 0, sumNet: 0, nNet: 0 };
    }
    const s = (target as ResearchSummary["byStrategy"])[key];
    s.n += 1;
    if (f.trade_taken) s.taken += 1;
    if (f.labels_complete) {
      s.labeled += 1;
      if (f.price && f.price_after_5m != null) {
        s.sum5m += f.price_after_5m / f.price - 1;
        s.n5m += 1;
      }
      if (f.net_execution_return != null) {
        s.sumNet += f.net_execution_return;
        s.nNet += 1;
      }
    }
  };

  for (const f of facts) {
    bump(summary.byRegime, f.regime, f);
    bump(summary.byBucket, f.bucket, f);
    bump(summary.byStrategy, f.strategy_id, f);
    if (summary.coverage[f.bucket] && summary.coverage[f.bucket][f.regime] != null) {
      summary.coverage[f.bucket][f.regime] += 1;
    }
  }
  return summary;
}

export function summaryFromLedger(rows: LedgerRow[], now: number): ResearchSummary {
  const summary = rebuildSummary(rows);
  summary.errors = rows.filter((r) => !r.labels_complete && now - r.decision_time > 70 * 60_000).length;
  return summary;
}

export const RESEARCH_AGGREGATE_IS_READONLY = true;

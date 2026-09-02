import { getSql } from "@/lib/db";
import { analyzeEdgeMonotonicity, buildBaselineReport } from "./baseline";
import { analyzeWasserstein } from "./wasserstein";
import { replayStrategy, type ReplayObservation } from "./replay";
import { STRATEGIES } from "./strategies";
import { exportRows } from "./repo.server";
import type { SourceId } from "./schema";

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function loadReplayObservations(limit = 4000): Promise<ReplayObservation[]> {
  const sql = await getSql();
  const rows = await sql.query<Record<string, unknown>>(
    `select o.mint,
            coalesce(t.symbol, o.mint) as symbol,
            t.name,
            t.pair_address,
            t.created_at_ms,
            coalesce(o.ingested_at_ms, o.observed_at_ms) as ingested_at_ms,
            coalesce(o.event_time_ms, o.observed_at_ms) as event_time_ms,
            o.price, o.liquidity, o.volume_5m, o.volume_1m, o.market_cap_usd, o.fdv_usd,
            o.buys_5m, o.sells_5m, o.unique_buyers_5m, o.unique_sellers_5m,
            o.holder_count, o.top_10_holder_pct, o.mint_authority_active, o.freeze_authority_active,
            o.jupiter_sell_route, o.jupiter_buy_route,
            o.estimated_entry_impact_bps, o.estimated_exit_impact_bps,
            o.provider
     from market_observations o
     left join tokens t on t.mint = o.mint
     order by coalesce(o.ingested_at_ms, o.observed_at_ms) desc
     limit $1`,
    [limit],
  );
  return rows
    .map((r): ReplayObservation => ({
      mint: String(r.mint),
      symbol: String(r.symbol ?? r.mint),
      name: r.name == null ? undefined : String(r.name),
      pairAddress: r.pair_address == null ? undefined : String(r.pair_address),
      createdAt: num(r.created_at_ms),
      ingestedAt: num(r.ingested_at_ms) ?? 0,
      eventTime: num(r.event_time_ms) ?? 0,
      price: num(r.price),
      liquidity: num(r.liquidity),
      volume5m: num(r.volume_5m),
      volume1m: num(r.volume_1m),
      mcap: num(r.market_cap_usd),
      fdv: num(r.fdv_usd),
      buys5m: num(r.buys_5m),
      sells5m: num(r.sells_5m),
      uniqueBuyers: num(r.unique_buyers_5m),
      uniqueSellers: num(r.unique_sellers_5m),
      holders: num(r.holder_count),
      top10Pct: num(r.top_10_holder_pct),
      mintAuth: r.mint_authority_active == null ? null : Boolean(r.mint_authority_active),
      freezeAuth: r.freeze_authority_active == null ? null : Boolean(r.freeze_authority_active),
      sellRoute: r.jupiter_sell_route == null ? null : Boolean(r.jupiter_sell_route),
      buyRoute: r.jupiter_buy_route == null ? null : Boolean(r.jupiter_buy_route),
      entryImpact: num(r.estimated_entry_impact_bps) != null ? (num(r.estimated_entry_impact_bps) as number) / 10_000 : null,
      exitImpact: num(r.estimated_exit_impact_bps) != null ? (num(r.estimated_exit_impact_bps) as number) / 10_000 : null,
      source: (String(r.provider || "dexscreener") as SourceId) || "dexscreener",
    }))
    .reverse();
}

export async function runWarehouseReplay() {
  const observations = await loadReplayObservations(2500);
  const mints = [...new Set(observations.map((o) => o.mint))].slice(0, 12);
  const from = observations[0]?.ingestedAt ?? Date.now() - 3600_000;
  const to = observations.at(-1)?.ingestedAt ?? Date.now();
  const run = replayStrategy({
    observations,
    strategy: STRATEGIES[0],
    from,
    to,
    stepMs: 20_000,
    regime: "meme_mania",
    mints,
  });
  const rows = await exportRows();
  const baseline = buildBaselineReport(rows);
  const monotonicity = analyzeEdgeMonotonicity(rows);
  const wasserstein = analyzeWasserstein(rows);
  return {
    replay: {
      from: run.from,
      to: run.to,
      observations: run.observations,
      mints: mints.length,
      considerations: run.considerations.length,
      labeled: run.labeled.filter((r) => r.labels_complete).length,
      leakageViolations: run.leakageViolations,
      note: run.note,
    },
    monotonicity: { ...monotonicity, wasserstein },
    wasserstein,
    baseline: {
      labeled: baseline.labeled,
      uniqueTokens: baseline.uniqueTokens,
      considerations: baseline.considerations,
      considerationsPerToken: baseline.considerationsPerToken,
      readyForModeling: baseline.readyForModeling,
      monotonicEdge15m: baseline.monotonicEdge15m,
      byEdge: baseline.byEdge,
      note: baseline.note,
    },
  };
}

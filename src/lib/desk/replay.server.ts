import { getSql } from "@/lib/db";
import { analyzeEdgeMonotonicity, buildBaselineReport } from "./baseline";
import { analyzeWasserstein } from "./wasserstein";
import { replayStrategy, type ReplayObservation } from "./replay";
import { runDeterministicReplayBaselines, type ReplayBaselineSlice } from "./replay-baseline";
import { V33B_HYPOTHESIS_COUNT } from "./baseline-strategy";
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

type PersistSlice = Pick<
  ReplayBaselineSlice,
  | "id"
  | "version"
  | "liveWired"
  | "published"
  | "seed"
  | "hypothesisIndex"
  | "considerations"
  | "authorized"
  | "labeled"
  | "leakageViolations"
  | "vsUniverseDelta"
  | "median15mAuthorizedToken"
> & { stats?: ReplayBaselineSlice["stats"]; result?: unknown };

async function persistReplaySlice(
  sql: Awaited<ReturnType<typeof getSql>>,
  report: { tapeFingerprint: string; from: number; to: number; stepMs: number; observations: number; uniqueTokens: number; generatedAt: number },
  s: PersistSlice,
) {
  const id = `${report.tapeFingerprint.slice(0, 16)}-${s.id}`;
  const summary = "result" in s && s.result != null ? s.result : s;
  const meanR = s.stats?.meanR ?? null;
  const expectancy = s.stats?.expectancy ?? null;
  const profitFactor =
    s.stats?.profitFactor == null || !Number.isFinite(s.stats.profitFactor) ? null : s.stats.profitFactor;
  const json = JSON.stringify(summary);

  const v33b = [
    id,
    report.tapeFingerprint,
    s.id,
    String(s.version),
    report.from,
    report.to,
    report.stepMs,
    report.observations,
    report.uniqueTokens,
    s.considerations,
    s.authorized,
    s.labeled,
    s.leakageViolations,
    json,
    s.vsUniverseDelta ?? null,
    s.liveWired,
    s.median15mAuthorizedToken ?? null,
    s.seed,
    s.hypothesisIndex,
    meanR,
    expectancy,
    profitFactor,
    report.generatedAt,
  ];
  try {
    await sql.query(
      `insert into replay_runs (
         id, tape_fingerprint, strategy_id, strategy_version, from_ms, to_ms, step_ms,
         observations, unique_tokens, considerations, authorized, labeled, leakage_violations,
         result_summary, vs_universe_delta, live_wired, median_15m_token,
         seed, hypothesis_index, mean_r, expectancy, profit_factor, created_at_ms
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19,$20,$21,$22,$23)
       on conflict (id) do nothing`,
      v33b,
    );
  } catch {
    try {
      await sql.query(
        `insert into replay_runs (
           id, tape_fingerprint, strategy_id, strategy_version, from_ms, to_ms, step_ms,
           observations, unique_tokens, considerations, authorized, labeled, leakage_violations,
           result_summary, vs_universe_delta, live_wired, median_15m_token, created_at_ms
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18)
         on conflict (id) do nothing`,
        [...v33b.slice(0, 17), report.generatedAt],
      );
    } catch {
      await sql.query(
        `insert into replay_runs (
           id, tape_fingerprint, strategy_id, strategy_version, from_ms, to_ms, step_ms,
           observations, unique_tokens, considerations, authorized, labeled, leakage_violations,
           result_summary, created_at_ms
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)
         on conflict (id) do nothing`,
        [...v33b.slice(0, 14), report.generatedAt],
      );
    }
  }

  if (!s.published) return;
  try {
    await sql.query(
      `insert into replay_experiments (
         id, name, version, seed, tape_fingerprint, hypothesis_index, hypothesis_count,
         live_wired, result_summary, created_at_ms
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
       on conflict (id) do nothing`,
      [
        id,
        s.id,
        String(s.version),
        s.seed,
        report.tapeFingerprint,
        s.hypothesisIndex ?? 0,
        V33B_HYPOTHESIS_COUNT,
        false,
        json,
        report.generatedAt,
      ],
    );
  } catch {
    /* 0009 pending */
  }
}

export async function runDeterministicBaselines() {
  const observations = await loadReplayObservations(2500);
  const to = observations.at(-1)?.ingestedAt ?? Date.now();
  const from = Math.max(observations[0]?.ingestedAt ?? 0, to - 40 * 60_000);
  const clipped = observations.filter((o) => o.ingestedAt >= from && o.ingestedAt <= to);
  const report = runDeterministicReplayBaselines(clipped, { from, to, mints: 12, stepMs: 20_000 });
  try {
    const sql = await getSql();
    const rows: PersistSlice[] = [
      ...report.strategies,
      {
        id: "universe_buy_and_hold",
        version: 1,
        liveWired: false,
        published: false,
        seed: null,
        hypothesisIndex: null,
        considerations: 0,
        authorized: 0,
        labeled: report.universe.labeled,
        leakageViolations: 0,
        vsUniverseDelta: 0,
        median15mAuthorizedToken: report.universe.median15m,
        result: report.universe,
      },
    ];
    for (const s of rows) {
      await persistReplaySlice(sql, report, s);
    }
  } catch {
    /* warehouse optional in unit tests */
  }
  return report;
}

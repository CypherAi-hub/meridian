import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dbSource, getSql, type Sql } from "@/lib/db";
import { HEARTBEAT_STALE_MS, START_EQUITY, STRATEGY_VERSION } from "./schema";
import { createDesk, emptyDesk } from "./engine";
import { computeFeatures, predict } from "./features";
import { cooldownKey } from "./leakage";
import { rebuildSummary, emptyResearch } from "./ledger";
import { noteUniverseXfer } from "./neon-xfer";
import { loadQuality } from "./quality.server";
import { FEATURE_ENGINE_VERSION, FEATURE_SCHEMA, FEATURE_SCHEMA_HASH, LABEL_DEFINITION, LABEL_DEFINITION_VERSION, EXECUTION_ASSUMPTION, EXECUTION_ASSUMPTION_VERSION } from "./versions";
import { STRATEGIES } from "./strategies";
import { requestFingerprint, observationFingerprint } from "./fingerprint";
import { ACTIVE_INTERVAL_MS, UNIVERSE_INTERVAL_MS, researchUrgency, selectActiveWatches, MAX_ACTIVE_WATCHES } from "./watch";
import { stampResearchQuality } from "./labels";
import { deskSettings } from "./config";
import { currentEpochName, officialSoakAllowed, makeSoakIncident, PRODUCTION_SOAK_CLOSURE } from "./env";
import { decideLease, PRIMARY_LEASE, LEASE_TTL_MS } from "./lease";
import { applyHolderObs, holderTtlMs } from "./providers/holders";
import { toFastPathSample, watchDeadline } from "./fast-path";
import { bucketOf } from "./buckets";
import type { TokenSnapshot } from "./schema";
import type {
  DeskSnapshot,
  Intent,
  JournalEvent,
  LedgerRow,
  Position,
  ResearchSummary,
  SourceHealth,
  TokenLive,
  WorkerHealth,
} from "./types";

const DUMP = "/workspace/data/meridian-snapshot.json";
const STARTED_AT = Date.now();
let lastDumpAt = 0;

function num(v: unknown, d = 0) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : d;
}

function json<T>(v: unknown, fallback: T): T {
  if (v == null) return fallback;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return v as T;
}

type DumpFile = {
  v: 325;
  savedAt: number;
  desk: DeskSnapshot;
  corpus: LedgerRow[];
};

export async function ensureDeskState(): Promise<Sql> {
  const sql = await getSql();
  const rows = await sql.query<{ id: number }>("select id from desk_state where id = 1");
  if (!rows.length) {
    const restored = await readDump();
    if (restored) {
      await restoreDump(sql, restored);
      return sql;
    }
    const fresh = createDesk();
    await insertFresh(sql, fresh);
    await sql.query(
      `insert into strategy_versions (version, body, created_at_ms) values ($1, $2::jsonb, $3) on conflict do nothing`,
      [STRATEGY_VERSION, JSON.stringify(STRATEGIES), Date.now()],
    );
  }
  return sql;
}

async function insertFresh(sql: Sql, s: DeskSnapshot) {
  await sql.query(
    `insert into desk_state (
      id, running, halted, cash, equity, start_equity, risk_bps, max_positions, slippage_bps,
      fills, win_count, loss_count, selected_mint, worker_started_at_ms, last_tick_at_ms,
      tape_json, journal_json, rejects_json, last_intent_json, last_considered_json,
      regime, regime_p_json, sol_price, sol_ret_5m, tick_count, last_error, pending_labels, oldest_pending_ms
    ) values (
      1, $1, $2, $3, $4, $5, $6, $7, $8,
      $9, $10, $11, $12, $13, $14,
      $15::jsonb, $16::jsonb, $17::jsonb, $18::jsonb, $19::jsonb,
      $20, $21::jsonb, $22, $23, $24, $25, $26, $27
    ) on conflict (id) do nothing`,
    [
      s.running,
      s.halted,
      s.cash,
      s.equity,
      s.startEquity,
      s.riskBps,
      s.maxPositions,
      s.slippageBps,
      s.fills,
      s.winCount,
      s.lossCount,
      s.selected,
      STARTED_AT,
      s.worker.lastTickAt ?? Date.now(),
      JSON.stringify({ tokens: s.tokens, sources: s.sources, lastTapeAt: s.lastTapeAt, feedLagMs: s.feedLagMs }),
      JSON.stringify(s.journal),
      JSON.stringify(s.rejects),
      JSON.stringify(s.lastIntent),
      JSON.stringify(s.lastConsidered),
      s.regime,
      JSON.stringify(s.regimeP),
      s.solPrice,
      s.solRet5m,
      s.worker.tickCount ?? 0,
      s.worker.lastError,
      s.pending.filter((r) => !r.labels_complete).length,
      s.pending.filter((r) => !r.labels_complete).at(-1)?.decision_time ?? null,
    ],
  );
}

async function restoreDump(sql: Sql, dump: DumpFile) {
  await insertFresh(sql, dump.desk);
  await sql.query(
    `insert into strategy_versions (version, body, created_at_ms) values ($1, $2::jsonb, $3) on conflict do nothing`,
    [STRATEGY_VERSION, JSON.stringify(STRATEGIES), Date.now()],
  );
  for (const p of dump.desk.positions ?? []) {
    await sql.query(
      `insert into paper_positions (
        mint, symbol, strategy_id, qty, entry, notional, opened_at_ms, peak, remainder, entry_impact, exit_quote_impact
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      on conflict (mint) do nothing`,
      [
        p.tokenAddress,
        p.symbol,
        p.strategyId,
        p.qty,
        p.entry,
        p.notional,
        p.openedAt,
        p.peak,
        p.remainder,
        p.entryImpactPct,
        p.exitQuoteImpactPct,
      ],
    );
  }
  for (const row of dump.corpus) {
    if (!row?.decision_id) continue;
    try {
      await sql.query(
        `insert into tokens (mint, symbol, name, decimals, pair_address, created_at_ms, last_seen_at_ms, last_considered_at_ms)
         values ($1,$2,$2,6,$3,$4,$5,$5)
         on conflict (mint) do nothing`,
        [
          row.tokenAddress,
          row.token ?? "UNK",
          row.pair_address || null,
          row.event_time ?? row.decision_time,
          row.decision_time,
        ],
      );
    } catch {
      /* tokens table from 0002 */
    }
    stampResearchQuality(row);
    const ok = await insertConsideration(sql, row, dump.desk);
    if (!ok) continue;
    await upsertLabels(sql, row);
  }
}

export async function loadDesk(): Promise<DeskSnapshot> {
  const sql = await ensureDeskState();
  const st = (await sql.query<Record<string, unknown>>("select * from desk_state where id = 1"))[0];
  const s = emptyDesk();
  if (!st) return s;
  s.now = Date.now();
  s.running = Boolean(st.running);
  s.halted = Boolean(st.halted);
  s.cash = num(st.cash, START_EQUITY);
  s.equity = num(st.equity, START_EQUITY);
  s.startEquity = num(st.start_equity, START_EQUITY);
  s.dayPnl = s.equity - s.startEquity;
  s.riskBps = num(st.risk_bps, 25);
  s.maxPositions = num(st.max_positions, 4);
  s.slippageBps = num(st.slippage_bps, 50);
  s.fills = num(st.fills);
  s.winCount = num(st.win_count);
  s.lossCount = num(st.loss_count);
  s.selected = (st.selected_mint as string) || null;
  s.regime = (st.regime as DeskSnapshot["regime"]) || "chop";
  s.regimeP = json(st.regime_p_json, s.regimeP);
  s.solPrice = num(st.sol_price);
  s.solRet5m = num(st.sol_ret_5m);
  const tape = json<{
    tokens?: TokenLive[];
    sources?: SourceHealth[];
    lastTapeAt?: number | null;
    feedLagMs?: number;
  }>(st.tape_json, {});
  s.tokens = tape.tokens ?? [];
  s.sources = tape.sources ?? [];
  s.lastTapeAt = tape.lastTapeAt ?? (st.last_market_event_at_ms ? num(st.last_market_event_at_ms) : null);
  s.feedLagMs = tape.feedLagMs ?? 0;
  s.tapeAgeMs = s.lastTapeAt ? Date.now() - s.lastTapeAt : 0;
  s.realData = s.tokens.length > 0;
  s.journal = json<JournalEvent[]>(st.journal_json, []);
  s.rejects = json<Intent[]>(st.rejects_json, []);
  s.lastIntent = json<Intent | null>(st.last_intent_json, null);
  s.lastConsidered = json<Record<string, number>>(st.last_considered_json, {});

  const pos = await sql.query<Record<string, unknown>>("select * from paper_positions");
  s.positions = pos.map(
    (p): Position => ({
      tokenAddress: String(p.mint),
      symbol: String(p.symbol),
      strategyId: p.strategy_id as Position["strategyId"],
      qty: num(p.qty),
      entry: num(p.entry),
      notional: num(p.notional),
      openedAt: num(p.opened_at_ms),
      peak: num(p.peak),
      remainder: num(p.remainder, 1),
      entryImpactPct: p.entry_impact == null ? null : num(p.entry_impact),
      exitQuoteImpactPct: p.exit_quote_impact == null ? null : num(p.exit_quote_impact),
    }),
  );

  const pendingRows = await sql.query<{ snapshot: unknown; labels: unknown }>(
    `select s.snapshot, to_jsonb(o) as labels
     from outcome_labels o
     join decision_snapshots s on s.decision_id = o.decision_id
     where o.labels_complete = false
     order by o.updated_at_ms desc
     limit 2500`,
  );
  s.pending = pendingRows.map((r) => mergeRow(json<LedgerRow>(r.snapshot, {} as LedgerRow), json(r.labels, {})));

  const recent = await sql.query<{ snapshot: unknown; labels: unknown }>(
    `select s.snapshot, to_jsonb(o) as labels
     from candidate_considerations c
     join decision_snapshots s on s.decision_id = c.decision_id
     left join outcome_labels o on o.decision_id = c.decision_id
     order by c.decision_time_ms desc
     limit 80`,
  );
  s.ledger = recent.map((r) => mergeRow(json<LedgerRow>(r.snapshot, {} as LedgerRow), json(r.labels, {})));
  s.research = await loadResearch(sql);
  s.quality = await loadQuality(sql);
  noteUniverseXfer({
    researchRows: 0,
    pendingRows: s.pending.length,
    ledgerRows: s.ledger.length,
    deskBytesEst: 8_000 + 130_000,
  });
  const providerStats = (
    await sql.query<{ errors: number; last_ok: number | null }>(
      `select coalesce(sum(error_count), 0) as errors, max(last_ok_at_ms) as last_ok from providers`,
    )
  )[0];
  s.worker = workerFromState(st, s.research.incomplete, {
    providerErrors: num(providerStats?.errors),
    lastProviderOkAt: providerStats?.last_ok == null ? null : num(providerStats.last_ok),
  });
  return s;
}

function mergeRow(snap: LedgerRow, labels: Record<string, unknown>): LedgerRow {
  const path = json<LedgerRow["path"]>(labels.path, snap.path ?? []);
  const row: LedgerRow = {
    ...snap,
    gates: snap.gates ?? [],
    feature_sources: snap.feature_sources ?? {},
    path,
    price_after_1m: labels.price_after_1m == null ? snap.price_after_1m : num(labels.price_after_1m),
    price_after_5m: labels.price_after_5m == null ? snap.price_after_5m : num(labels.price_after_5m),
    price_after_15m: labels.price_after_15m == null ? snap.price_after_15m : num(labels.price_after_15m),
    price_after_30m: labels.price_after_30m == null ? snap.price_after_30m : num(labels.price_after_30m),
    price_after_1h: labels.price_after_1h == null ? snap.price_after_1h : num(labels.price_after_1h),
    max_gain_5m: labels.max_gain_5m == null ? snap.max_gain_5m : num(labels.max_gain_5m),
    max_gain_15m: labels.max_gain_15m == null ? snap.max_gain_15m : num(labels.max_gain_15m),
    max_gain_1h: labels.max_gain_1h == null ? snap.max_gain_1h : num(labels.max_gain_1h),
    max_drawdown_5m: labels.max_drawdown_5m == null ? snap.max_drawdown_5m : num(labels.max_drawdown_5m),
    max_drawdown_15m: labels.max_drawdown_15m == null ? snap.max_drawdown_15m : num(labels.max_drawdown_15m),
    max_drawdown_1h: labels.max_drawdown_1h == null ? snap.max_drawdown_1h : num(labels.max_drawdown_1h),
    mfe_1m: labels.mfe_1m == null ? snap.mfe_1m ?? null : num(labels.mfe_1m),
    mfe_30m: labels.mfe_30m == null ? snap.mfe_30m ?? null : num(labels.mfe_30m),
    mae_1m: labels.mae_1m == null ? snap.mae_1m ?? null : num(labels.mae_1m),
    mae_30m: labels.mae_30m == null ? snap.mae_30m ?? null : num(labels.mae_30m),
    hit_plus_10_before_minus_10:
      labels.hit_plus_10_before_minus_10 == null
        ? snap.hit_plus_10_before_minus_10
        : Boolean(labels.hit_plus_10_before_minus_10),
    hit_plus_20_before_minus_10:
      labels.hit_plus_20_before_minus_10 == null
        ? snap.hit_plus_20_before_minus_10
        : Boolean(labels.hit_plus_20_before_minus_10),
    liquidity_collapse:
      labels.liquidity_collapse == null ? snap.liquidity_collapse : Boolean(labels.liquidity_collapse),
    sell_route_lost: labels.sell_route_lost == null ? snap.sell_route_lost : Boolean(labels.sell_route_lost),
    first_sell_route_loss_at:
      labels.first_sell_route_loss_at_ms == null
        ? snap.first_sell_route_loss_at ?? null
        : num(labels.first_sell_route_loss_at_ms),
    sell_route_restored_at:
      labels.sell_route_restored_at_ms == null
        ? snap.sell_route_restored_at ?? null
        : num(labels.sell_route_restored_at_ms),
    rug_detected: labels.rug_detected == null ? snap.rug_detected : Boolean(labels.rug_detected),
    simulated_entry: labels.simulated_entry == null ? snap.simulated_entry : num(labels.simulated_entry),
    simulated_exit: labels.simulated_exit == null ? snap.simulated_exit : num(labels.simulated_exit),
    theoretical_return:
      labels.theoretical_return == null ? snap.theoretical_return ?? null : num(labels.theoretical_return),
    net_execution_return:
      labels.net_execution_return == null ? snap.net_execution_return : num(labels.net_execution_return),
    execution_adjusted_return:
      labels.execution_adjusted_return == null
        ? (snap.execution_adjusted_return ?? snap.net_execution_return ?? null)
        : num(labels.execution_adjusted_return),
    labels_complete: Boolean(labels.labels_complete ?? snap.labels_complete),
    barrier_label_confidence:
      (labels.barrier_label_confidence as LedgerRow["barrier_label_confidence"]) ?? snap.barrier_label_confidence ?? null,
    barrier_10_outcome: (labels.barrier_10_outcome as LedgerRow["barrier_10_outcome"]) ?? snap.barrier_10_outcome ?? null,
    barrier_20_outcome: (labels.barrier_20_outcome as LedgerRow["barrier_20_outcome"]) ?? snap.barrier_20_outcome ?? null,
    max_path_gap_seconds:
      labels.max_path_gap_seconds == null ? snap.max_path_gap_seconds ?? null : num(labels.max_path_gap_seconds),
    avg_path_gap_seconds:
      labels.avg_path_gap_seconds == null ? snap.avg_path_gap_seconds ?? null : num(labels.avg_path_gap_seconds),
    path_sample_count: labels.path_sample_count == null ? snap.path_sample_count ?? null : num(labels.path_sample_count),
    research_quality_score:
      labels.research_quality_score == null && (snap as { research_quality_score?: number }).research_quality_score == null
        ? snap.research_quality_score ?? null
        : num(labels.research_quality_score ?? snap.research_quality_score),
    research_grade: (labels.research_grade as LedgerRow["research_grade"]) ?? snap.research_grade ?? null,
    label_definition_version:
      String(labels.label_definition_version ?? snap.label_definition_version ?? "labels_v1"),
    feature_engine_version: snap.feature_engine_version ?? "v1.3.0",
    route_status: snap.route_status ?? "UNKNOWN",
    veto_reason_code: snap.veto_reason_code ?? "",
    provider_disagreement: Boolean(snap.provider_disagreement),
  };
  if (row.research_quality_score == null || row.barrier_label_confidence == null) {
    stampResearchQuality(row);
  }
  return row;
}

function workerFromState(
  st: Record<string, unknown>,
  pending: number,
  extra?: { providerErrors: number; lastProviderOkAt: number | null },
): WorkerHealth {
  const lastTick = st.last_tick_at_ms ? num(st.last_tick_at_ms) : null;
  const lastError = (st.last_error as string) || null;
  const stale = !lastTick || Date.now() - lastTick > HEARTBEAT_STALE_MS;
  return {
    status: lastError || stale ? "offline" : "live",
    db: dbSource,
    uptimeMs: Date.now() - (st.worker_started_at_ms ? num(st.worker_started_at_ms) : STARTED_AT),
    lastTickAt: lastTick,
    lastMarketEventAt: st.last_market_event_at_ms ? num(st.last_market_event_at_ms) : null,
    lastProviderOkAt: extra?.lastProviderOkAt ?? null,
    tickCount: num(st.tick_count),
    queueDepth: pending,
    pendingLabels: pending,
    oldestPendingAt: st.oldest_pending_ms ? num(st.oldest_pending_ms) : null,
    providerErrors: extra?.providerErrors ?? 0,
    lastError,
    avgTickMs: num(st.last_tick_duration_ms),
    observationsWritten: num(st.observations_written),
    considerationsDropped: num(st.considerations_dropped),
  };
}

export async function loadResearch(sql?: Sql): Promise<ResearchSummary> {
  const db = sql ?? (await getSql());
  try {
    return await loadResearchAggregated(db);
  } catch (err) {
    console.error("[meridian] research aggregate fallback", err instanceof Error ? err.message : err);
    const rows = await db.query<{ snapshot: unknown; labels: unknown }>(
      `select s.snapshot, to_jsonb(o) as labels
       from candidate_considerations c
       join decision_snapshots s on s.decision_id = c.decision_id
       left join outcome_labels o on o.decision_id = c.decision_id
       order by c.decision_time_ms asc
       limit 50000`,
    );
    const list = rows.map((r) => mergeRow(json<LedgerRow>(r.snapshot, {} as LedgerRow), json(r.labels, {})));
    const summary = rebuildSummary(list);
    const now = Date.now();
    summary.errors = list.filter((r) => !r.labels_complete && now - r.decision_time > 70 * 60_000).length;
    return summary;
  }
}

async function loadResearchAggregated(db: Sql): Promise<ResearchSummary> {
  const now = Date.now();
  const totals = (
    await db.query<{
      considerations: number;
      vetoed: number;
      authorized: number;
      taken: number;
      labeled: number;
      incomplete: number;
      errors: number;
    }>(
      `select
         count(*)::int as considerations,
         count(*) filter (where c.governor_result = 'vetoed')::int as vetoed,
         count(*) filter (where c.governor_result is distinct from 'vetoed')::int as authorized,
         count(*) filter (where c.trade_taken)::int as taken,
         count(*) filter (where coalesce(o.labels_complete, c.labels_complete, false))::int as labeled,
         count(*) filter (where not coalesce(o.labels_complete, c.labels_complete, false))::int as incomplete,
         count(*) filter (
           where not coalesce(o.labels_complete, c.labels_complete, false)
             and $1::bigint - c.decision_time_ms > 4200000
         )::int as errors
       from candidate_considerations c
       left join outcome_labels o on o.decision_id = c.decision_id`,
      [now],
    )
  )[0];
  const summary = emptyResearch();
  if (!totals) return summary;
  summary.considerations = num(totals.considerations);
  summary.vetoed = num(totals.vetoed);
  summary.authorized = num(totals.authorized);
  summary.taken = num(totals.taken);
  summary.labeled = num(totals.labeled);
  summary.incomplete = num(totals.incomplete);
  summary.errors = num(totals.errors);

  const fill = (
    target: Record<string, { n: number; taken: number; labeled: number; sum5m: number; n5m: number; sumNet: number; nNet: number }>,
    rows: Array<{
      key: string | null;
      n: number;
      taken: number;
      labeled: number;
      sum5m: number;
      n5m: number;
      sumNet: number;
      nNet: number;
    }>,
  ) => {
    for (const r of rows) {
      if (!r.key) continue;
      const cur = target[r.key] ?? { n: 0, taken: 0, labeled: 0, sum5m: 0, n5m: 0, sumNet: 0, nNet: 0 };
      cur.n = num(r.n);
      cur.taken = num(r.taken);
      cur.labeled = num(r.labeled);
      cur.sum5m = num(r.sum5m);
      cur.n5m = num(r.n5m);
      cur.sumNet = num(r.sumNet);
      cur.nNet = num(r.nNet);
      target[r.key] = cur;
    }
  };

  const sliceSql = (dim: string) =>
    db.query<{
      key: string | null;
      n: number;
      taken: number;
      labeled: number;
      sum5m: number;
      n5m: number;
      sumNet: number;
      nNet: number;
    }>(
      `select ${dim} as key,
         count(*)::int as n,
         count(*) filter (where c.trade_taken)::int as taken,
         count(*) filter (where coalesce(o.labels_complete, false))::int as labeled,
         coalesce(sum(case
           when coalesce(o.labels_complete, false)
            and nullif(s.snapshot->>'price','')::float > 0
            and o.price_after_5m is not null
           then o.price_after_5m / nullif(s.snapshot->>'price','')::float - 1
           else 0 end), 0)::float as sum5m,
         count(*) filter (
           where coalesce(o.labels_complete, false)
             and nullif(s.snapshot->>'price','') is not null
             and o.price_after_5m is not null
         )::int as n5m,
         coalesce(sum(case when coalesce(o.labels_complete, false) then o.net_execution_return else 0 end), 0)::float as sumNet,
         count(*) filter (where coalesce(o.labels_complete, false) and o.net_execution_return is not null)::int as nNet
       from candidate_considerations c
       left join outcome_labels o on o.decision_id = c.decision_id
       left join decision_snapshots s on s.decision_id = c.decision_id
       group by ${dim}`,
    );

  fill(summary.byRegime, await sliceSql("c.regime"));
  fill(summary.byBucket, await sliceSql("c.bucket"));
  fill(summary.byStrategy, await sliceSql("c.strategy_id"));

  const cov = await db.query<{ bucket: string; regime: string; n: number }>(
    `select bucket, regime, count(*)::int as n from candidate_considerations group by bucket, regime`,
  );
  for (const r of cov) {
    if (summary.coverage[r.bucket as keyof typeof summary.coverage]?.[r.regime as "trend"] != null) {
      summary.coverage[r.bucket as keyof typeof summary.coverage][r.regime as "trend"] = num(r.n);
    }
  }
  return summary;
}

export async function hydrateHoldersOntoTape<T extends TokenSnapshot>(
  tokens: T[],
  decisionTime: number,
): Promise<T[]> {
  if (!tokens.length) return tokens;
  try {
    const sql = await getSql();
    const mints = tokens.map((t) => t.address);
    const rows = await sql.query<{
      mint: string;
      holder_count: number | null;
      top_10_holder_pct: number | null;
      holder_status: string | null;
      holder_provider: string | null;
      event_time_ms: number | null;
      ingested_at_ms: number | null;
    }>(
      `select distinct on (mint)
         mint, holder_count, top_10_holder_pct, holder_status, holder_provider,
         event_time_ms, ingested_at_ms
       from market_observations
       where mint = any($1)
         and coalesce(ingested_at_ms, observed_at_ms) <= $2
         and (top_10_holder_pct is not null or holder_count is not null)
       order by mint, coalesce(ingested_at_ms, observed_at_ms) desc`,
      [mints, decisionTime],
    );
    const by = new Map(rows.map((r) => [r.mint, r]));
    return tokens.map((t) => {
      const liveValid =
        t.top10Pct.value != null &&
        (t.top10Pct.status ?? "VALID") === "VALID" &&
        t.top10Pct.ingestedAt > 0 &&
        t.top10Pct.ingestedAt <= decisionTime;
      if (liveValid) return t;
      const row = by.get(t.address);
      if (!row) return t;
      const ingested = row.ingested_at_ms ?? 0;
      if (!ingested || ingested > decisionTime) return t;
      const age = decisionTime - ingested;
      const ttl = holderTtlMs(bucketOf(t.createdAt ? (decisionTime - t.createdAt) / 1000 : null));
      if (age > ttl) return t;
      const source = (row.holder_provider ?? "solana") as "birdeye" | "helius" | "solana" | "rugcheck";
      return applyHolderObs(
        t,
        {
          holders: row.holder_count,
          top10Pct: row.top_10_holder_pct,
          top20Pct: null,
          largestPct: null,
          source,
          status: "VALID",
          errors: [],
        },
        row.event_time_ms ?? ingested,
        ingested,
      ) as T;
    });
  } catch {
    return tokens;
  }
}

export async function persistDesk(next: DeskSnapshot, prev?: DeskSnapshot) {
  const sql = await getSql();
  const now = Date.now();
  try {
    await sql.query(
      `insert into feature_engine_versions (version, code_hash, feature_schema, created_at_ms)
       values ($1,$2,$3::jsonb,$4) on conflict do nothing`,
      [FEATURE_ENGINE_VERSION, FEATURE_SCHEMA_HASH, JSON.stringify(FEATURE_SCHEMA), now],
    );
    await sql.query(
      `insert into label_definition_versions (version, body, created_at_ms) values ($1,$2::jsonb,$3) on conflict do nothing`,
      [LABEL_DEFINITION_VERSION, JSON.stringify(LABEL_DEFINITION), now],
    );
    await sql.query(
      `insert into execution_assumption_versions (version, slippage_bps, fee_bps, extra_adverse_bps, created_at_ms)
       values ($1,$2,$3,$4,$5) on conflict do nothing`,
      [EXECUTION_ASSUMPTION_VERSION, EXECUTION_ASSUMPTION.slippage_bps, EXECUTION_ASSUMPTION.fee_bps, EXECUTION_ASSUMPTION.extra_adverse_bps, now],
    );
  } catch {
    /* 0004 */
  }
  const oldest = next.pending.filter((r) => !r.labels_complete).at(-1)?.decision_time ?? null;

  await sql.query(
    `update desk_state set
      halted = case when $1 then true else desk_state.halted end,
      cash = $2, equity = $3, start_equity = $4,
      fills = $5, win_count = $6, loss_count = $7,
      last_tick_at_ms = $8, last_market_event_at_ms = $9, last_error = $10,
      tick_count = tick_count + 1, pending_labels = $11, oldest_pending_ms = $12,
      tape_json = $13::jsonb, journal_json = $14::jsonb, rejects_json = $15::jsonb,
      last_intent_json = $16::jsonb, last_considered_json = $17::jsonb,
      regime = $18, regime_p_json = $19::jsonb, sol_price = $20, sol_ret_5m = $21,
      worker_started_at_ms = coalesce(worker_started_at_ms, $8)
     where id = 1`,
    [
      next.halted,
      next.cash,
      next.equity,
      next.startEquity,
      next.fills,
      next.winCount,
      next.lossCount,
      now,
      next.lastTapeAt,
      next.worker.lastError,
      next.pending.filter((r) => !r.labels_complete).length,
      oldest,
      JSON.stringify({
        tokens: next.tokens,
        sources: next.sources,
        lastTapeAt: next.lastTapeAt,
        feedLagMs: next.feedLagMs,
      }),
      JSON.stringify(next.journal.slice(0, 80)),
      JSON.stringify(next.rejects.slice(0, 24)),
      JSON.stringify(next.lastIntent),
      JSON.stringify(next.lastConsidered),
      next.regime,
      JSON.stringify(next.regimeP),
      next.solPrice,
      next.solRet5m,
    ],
  );

  try {
    await sql.query(
      `update desk_state set last_tick_duration_ms = $1,
        observations_written = coalesce(observations_written, 0) + $2,
        considerations_dropped = coalesce(considerations_dropped, 0) + $3
       where id = 1`,
      [next.worker.avgTickMs ?? 0, next.tokens.length, next.worker.considerationsDropped ?? 0],
    );
  } catch {
    /* 0003 */
  }
  try {
    await sql.query(
      `update desk_state set soak_started_at_ms = coalesce(soak_started_at_ms, $1), code_version = $2 where id = 1`,
      [now, STRATEGY_VERSION],
    );
    await ensureCollectionEpoch(sql, now);
    if (officialSoakAllowed()) {
      const existing = await sql.query<{ value: { ms?: number; closure?: string } }>(
        `select value from warehouse_metadata where key = 'production_soak_started_at'`,
      );
      const closure = existing[0]?.value?.closure;
      if (closure !== PRODUCTION_SOAK_CLOSURE) {
        await sql.query(`update desk_state set soak_started_at_ms = $1 where id = 1`, [now]);
        await sql.query(
          `insert into warehouse_metadata (key, value, updated_at_ms) values ('production_soak_started_at', $1::jsonb, $2)
           on conflict (key) do update set value = excluded.value, updated_at_ms = excluded.updated_at_ms`,
          [JSON.stringify({ ms: now, closure: PRODUCTION_SOAK_CLOSURE }), now],
        );
      }
    }
  } catch {
    /* 0005/0006 */
  }

  await sql.query("delete from paper_positions");
  for (const p of next.positions) {
    await sql.query(
      `insert into paper_positions (
        mint, symbol, strategy_id, qty, entry, notional, opened_at_ms, peak, remainder, entry_impact, exit_quote_impact
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        p.tokenAddress,
        p.symbol,
        p.strategyId,
        p.qty,
        p.entry,
        p.notional,
        p.openedAt,
        p.peak,
        p.remainder,
        p.entryImpactPct,
        p.exitQuoteImpactPct,
      ],
    );
  }

  for (const t of next.tokens) {
    await persistTokenObservation(sql, t, next, now);
  }
  await persistWatches(sql, next, now);

  for (const src of next.sources) {
    const fail = src.status === "offline" ? 1 : 0;
    const ok = src.status === "live" ? 1 : 0;
    await sql.query(
      `insert into providers (id, status, lag_ms, last_ok_at_ms, error_count, ok_count, detail, updated_at_ms)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (id) do update set
         status = excluded.status, lag_ms = excluded.lag_ms, last_ok_at_ms = excluded.last_ok_at_ms,
         error_count = providers.error_count + $5, ok_count = providers.ok_count + $6,
         detail = excluded.detail, updated_at_ms = excluded.updated_at_ms`,
      [src.id, src.status, src.lagMs, src.lastOkAt, fail, ok, src.detail, now],
    );
    try {
      await sql.query(
        `insert into provider_health (provider, status, last_success_at_ms, last_failure_at_ms, avg_latency_ms, failures_last_hour, updated_at_ms)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (provider) do update set
           status = excluded.status,
           last_success_at_ms = coalesce(excluded.last_success_at_ms, provider_health.last_success_at_ms),
           last_failure_at_ms = coalesce(excluded.last_failure_at_ms, provider_health.last_failure_at_ms),
           avg_latency_ms = excluded.avg_latency_ms,
           failures_last_hour = provider_health.failures_last_hour + $6,
           updated_at_ms = excluded.updated_at_ms`,
        [src.id, src.status, src.status === "live" ? src.lastOkAt : null, src.status === "offline" ? now : null, src.lagMs, fail, now],
      );
    } catch {
      /* 0003 */
    }
  }

  if (!prev || prev.regime !== next.regime) {
    await sql.query(
      `insert into regime_history (at_ms, regime, p_mania, p_trend, p_chop, p_risk_off)
       values ($1,$2,$3,$4,$5,$6)`,
      [now, next.regime, next.regimeP.meme_mania, next.regimeP.trend, next.regimeP.chop, next.regimeP.risk_off],
    );
  }

  for (const e of next.journal.slice(0, 12)) {
    await sql.query(
      `insert into system_events (id, at_ms, kind, title, detail, symbol, pnl)
       values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing`,
      [e.id, e.ts, e.kind, e.title, e.detail, e.symbol ?? null, e.pnl ?? null],
    );
  }

  const seen = new Set((prev?.pending ?? []).map((r) => r.decision_id));
  const prevLedger = new Set((prev?.ledger ?? []).map((r) => r.decision_id));
  const incoming = [...next.flushQueue, ...next.pending, ...next.ledger];
  const uniq = new Map<string, LedgerRow>();
  for (const r of incoming) uniq.set(r.decision_id, r);

  let dropped = 0;
  for (const row of uniq.values()) {
    const isNew = !seen.has(row.decision_id) && !prevLedger.has(row.decision_id);
    if (isNew) {
      const ok = await insertConsideration(sql, row, next);
      if (!ok) {
        dropped += 1;
        continue;
      }
    }
    await upsertLabels(sql, row);
    await persistPathTicks(sql, row);
  }
  next.worker.considerationsDropped = dropped;

  if (now - (prev?.now ?? 0) > 50_000) {
    await sql.query(
      `insert into portfolio_snapshots (taken_at_ms, cash, equity, day_pnl, open_positions, regime)
       values ($1,$2,$3,$4,$5,$6)`,
      [now, next.cash, next.equity, next.dayPnl, next.positions.length, next.regime],
    );
  }

  if (dbSource === "pglite" && now - lastDumpAt > 60_000) {
    lastDumpAt = now;
    await writeDump(sql, next);
  }
}

async function persistTokenObservation(sql: Sql, t: TokenLive, next: DeskSnapshot, now: number) {
  await sql.query(
    `insert into tokens (mint, symbol, name, decimals, pair_address, created_at_ms, last_seen_at_ms, last_considered_at_ms)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (mint) do update set
       symbol = excluded.symbol, name = excluded.name, pair_address = excluded.pair_address,
       last_seen_at_ms = excluded.last_seen_at_ms,
       last_considered_at_ms = coalesce(excluded.last_considered_at_ms, tokens.last_considered_at_ms)`,
    [t.address, t.symbol, t.name, t.decimals, t.pairAddress, t.createdAt, now, next.lastConsidered[t.address] ?? null],
  );
  try {
    if (t.pairAddress) {
      await sql.query(
        `insert into pools (pool_address, token_mint, dex, quote_mint, first_seen_at_ms, created_at_ms)
         values ($1,$2,$3,$4,$5,$5) on conflict (pool_address) do nothing`,
        [t.pairAddress, t.address, t.priceUsd.source, null, now],
      );
    }
  } catch {
    /* 0003 */
  }
  const eventTime = t.priceUsd.eventTime || next.lastTapeAt || now;
  const ingestedAt = t.priceUsd.ingestedAt || now;
  try {
    const inserted = await sql.query<{ id: number }>(
      `insert into market_observations (
         mint, observed_at_ms, event_time_ms, ingested_at_ms, provider, pool_address,
         price, liquidity, volume_5m, sell_route,
         market_cap_usd, fdv_usd, volume_1m, volume_1h,
         buys_5m, sells_5m, unique_buyers_5m, unique_sellers_5m,
         holder_count, top_10_holder_pct, mint_authority_active, freeze_authority_active,
         jupiter_buy_route, jupiter_sell_route,
         estimated_entry_impact_bps, estimated_exit_impact_bps, payload
       ) values (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27::jsonb
       ) on conflict (mint, observed_at_ms) do nothing returning id`,
      [
        t.address, ingestedAt, eventTime, ingestedAt, t.priceUsd.source, t.pairAddress || null,
        t.priceUsd.value, t.liquidityUsd.value, t.volume5mUsd.value, Boolean(t.sellQuote?.available),
        t.mcapUsd.value, t.fdvUsd.value, t.volume1mUsd.value, t.volume1hUsd.value,
        t.buys5m.value == null ? null : Math.round(t.buys5m.value),
        t.sells5m.value == null ? null : Math.round(t.sells5m.value),
        t.uniqueBuyers5m.value == null ? null : Math.round(t.uniqueBuyers5m.value),
        t.uniqueSellers5m.value == null ? null : Math.round(t.uniqueSellers5m.value),
        t.holders.value == null ? null : Math.round(t.holders.value),
        t.top10Pct.value,
        t.mintAuth.value,
        t.freezeAuth.value,
        Boolean(t.buyQuote?.available), Boolean(t.sellQuote?.available),
        t.buyQuote?.priceImpactPct != null ? t.buyQuote.priceImpactPct * 10_000 : null,
        t.sellQuote?.priceImpactPct != null ? t.sellQuote.priceImpactPct * 10_000 : null,
        JSON.stringify({
          price: t.priceUsd, liquidity: t.liquidityUsd, volume5m: t.volume5mUsd,
          buys: t.buys5m, sells: t.sells5m, uniqueBuyers: t.uniqueBuyers5m,
          mint: t.mintAuth, freeze: t.freezeAuth, top10: t.top10Pct, holders: t.holders,
          sell: t.sellQuote, buy: t.buyQuote,
        }),
      ],
    );
    try {
      await sql.query(
        `update market_observations set
           route_status = $3, route_failure_reason = $4, route_latency_ms = $5, route_provider = $6,
           route_input_amount = $7, route_price_impact_bps = $8,
           top_20_holder_pct = $9, largest_holder_pct = $10, holder_status = $11, holder_provider = $12,
           provider_disagreement = $13, provider_spread_pct = $14
         where mint = $1 and observed_at_ms = $2`,
        [
          t.address,
          ingestedAt,
          t.sellQuote?.routeState ?? (t.sellQuote ? (t.sellQuote.available ? "ROUTABLE" : "NO_ROUTE") : "UNKNOWN"),
          t.sellQuote?.failureReason ?? (t.sellQuote ? null : "NOT_CHECKED"),
          t.sellQuote?.latencyMs ?? null,
          t.sellQuote?.source ?? null,
          t.sellQuote?.inAmount ?? null,
          t.sellQuote?.priceImpactPct != null ? t.sellQuote.priceImpactPct * 10_000 : null,
          t.top20Pct?.value ?? null,
          t.largestHolderPct?.value ?? null,
          t.top10Pct.status ?? (t.top10Pct.value != null ? "VALID" : "UNKNOWN"),
          t.top10Pct.source,
          Boolean(t.priceUsd.value != null && t.priceCrossUsd.value != null && t.priceUsd.value && t.priceCrossUsd.value && Math.abs(t.priceUsd.value - t.priceCrossUsd.value) / ((t.priceUsd.value + t.priceCrossUsd.value) / 2) > 0.03),
          t.priceUsd.value != null && t.priceCrossUsd.value != null && t.priceUsd.value
            ? Math.abs(t.priceUsd.value - (t.priceCrossUsd.value ?? t.priceUsd.value)) / t.priceUsd.value
            : null,
        ],
      );
      await persistQuotePayload(sql, t, ingestedAt);
    } catch {
      /* 0004 */
    }
    try {
      const fp = observationFingerprint({
        mint: t.address,
        eventTime,
        price: t.priceUsd.value,
        liquidity: t.liquidityUsd.value,
        provider: String(t.priceUsd.source),
      });
      await sql.query(
        `update market_observations set holder_source = $3, observation_fingerprint = $4
         where mint = $1 and observed_at_ms = $2`,
        [t.address, ingestedAt, t.top10Pct.value != null ? t.top10Pct.source : null, fp],
      );
      await persistPathSample(sql, t, eventTime, ingestedAt, fp);
    } catch {
      /* 0005 */
    }
    try {
      await sql.query(
        `update market_observations set collection_epoch_id = coalesce(collection_epoch_id, $3) where mint = $1 and observed_at_ms = $2`,
        [t.address, ingestedAt, currentEpochName()],
      );
    } catch {
      /* 0006 */
    }
    let obsId = inserted[0]?.id ?? null;
    if (obsId == null) {
      const found = await sql.query<{ id: number }>(
        `select id from market_observations where mint = $1 and observed_at_ms = $2`,
        [t.address, ingestedAt],
      );
      obsId = found[0]?.id ?? null;
    }
    if (obsId == null) return;
    if (!inserted.length) return;
    const { features, meta } = computeFeatures(t, now);
    const pred = predict(t, features);
    await sql.query(
      `insert into feature_vectors (
         observation_id, token_mint, event_time_ms, computed_at_ms,
         return_1m, volume_accel_5m, buy_sell_imbalance, holder_growth_5m, liquidity_growth_5m,
         volatility_5m, liquidity_to_mcap, token_age_seconds,
         momentum_score, flow_score, safety_score, edge_score, regime, feature_sources
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)`,
      [
        obsId, t.address, eventTime, now, features.ret1m, features.volAccel, features.usdImbalance,
        features.holderGrowth5m, features.liqChange1m, features.rv5m, features.liqMcapRatio,
        features.tokenAgeS == null ? null : Math.round(features.tokenAgeS),
        pred.momentumScore, pred.flowScore, pred.safetyScore, pred.edgeScore, next.regime, JSON.stringify(meta),
      ],
    );
    try {
      await sql.query(
        `update feature_vectors set feature_engine_version = $2, feature_schema_hash = $3 where observation_id = $1`,
        [obsId, FEATURE_ENGINE_VERSION, FEATURE_SCHEMA_HASH],
      );
    } catch {
      /* 0004 */
    }
    try {
      await sql.query(
        `update feature_vectors set collection_epoch_id = coalesce(collection_epoch_id, $2) where observation_id = $1`,
        [obsId, currentEpochName()],
      );
    } catch {
      /* 0006 */
    }
  } catch (err) {
    console.error("[meridian] observation/feature persist", err instanceof Error ? err.message : err);
    await sql.query(
      `insert into market_observations (mint, observed_at_ms, price, liquidity, volume_5m, sell_route, payload)
       values ($1,$2,$3,$4,$5,$6,$7::jsonb) on conflict (mint, observed_at_ms) do nothing`,
      [
        t.address, ingestedAt, t.priceUsd.value, t.liquidityUsd.value, t.volume5mUsd.value,
        Boolean(t.sellQuote?.available),
        JSON.stringify({ price: t.priceUsd, liquidity: t.liquidityUsd, sell: t.sellQuote }),
      ],
    );
  }
}

async function persistPathSample(
  sql: Sql,
  t: TokenLive,
  eventTime: number,
  ingestedAt: number,
  fingerprint: string,
) {
  try {
    await sql.query(
      `insert into token_path_samples (
         token_mint, event_time_ms, ingested_at_ms, price_usd, liquidity_usd,
         sell_route_state, exit_quote_out_amount, provider_snapshot, sample_fingerprint, created_at_ms
       ) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
       on conflict (sample_fingerprint) do nothing`,
      [
        t.address,
        eventTime,
        ingestedAt,
        t.priceUsd.value,
        t.liquidityUsd.value,
        t.sellQuote?.routeState ?? (t.sellQuote?.available ? "QUOTE_ONLY" : t.sellQuote ? "NO_ROUTE" : "UNKNOWN"),
        t.sellQuote?.outAmount ?? null,
        JSON.stringify({
          price: t.priceUsd.value,
          liq: t.liquidityUsd.value,
          route: t.sellQuote?.routeState ?? null,
          source: t.priceUsd.source,
        }),
        fingerprint,
        Date.now(),
      ],
    );
    try {
      await sql.query(
        `update token_path_samples set collection_epoch_id = $2, sample_kind = 'shared' where sample_fingerprint = $1`,
        [fingerprint, currentEpochName()],
      );
    } catch {
      /* 0006 */
    }
  } catch {
    /* 0005 */
  }
}

async function persistPathTicks(sql: Sql, row: LedgerRow) {
  try {
    for (const p of row.path.slice(-12)) {
      await sql.query(
        `insert into consideration_paths (
           consideration_id, observed_at_ms, price, liquidity, jupiter_sell_route, entry_quote, exit_quote, provider_state
         ) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
         on conflict (consideration_id, observed_at_ms) do nothing`,
        [row.decision_id, p.ts, p.px, p.liq, p.sell === 1, p.entryQuote ?? null, p.exitQuote ?? null, JSON.stringify({ sell: p.sell })],
      );
    }
  } catch {
    /* 0003 */
  }
}

async function insertConsideration(sql: Sql, row: LedgerRow, desk: DeskSnapshot): Promise<boolean> {
  const cooldown = cooldownKey(row.tokenAddress, row.strategy_version, row.decision_time);
  if (row.holder_concentration == null) {
    try {
      const pit = await sql.query<{
        holder_count: number | null;
        top_10_holder_pct: number | null;
        holder_status: string | null;
        holder_provider: string | null;
        event_time_ms: number | null;
        ingested_at_ms: number | null;
      }>(
        `select holder_count, top_10_holder_pct, holder_status, holder_provider, event_time_ms, ingested_at_ms
         from market_observations
         where mint = $1
           and coalesce(ingested_at_ms, observed_at_ms) <= $2
           and (top_10_holder_pct is not null or holder_count is not null)
         order by coalesce(ingested_at_ms, observed_at_ms) desc
         limit 1`,
        [row.tokenAddress, row.decision_time],
      );
      const hit = pit[0];
      if (hit?.ingested_at_ms != null && hit.ingested_at_ms <= row.decision_time) {
        const age = row.decision_time - hit.ingested_at_ms;
        const ttl = holderTtlMs(bucketOf(row.token_age));
        if (age <= ttl) {
          row.holder_count = hit.holder_count;
          row.holder_concentration = hit.top_10_holder_pct;
          row.holder_status = "VALID";
          row.holder_source = hit.holder_provider;
          row.holder_event_time = hit.event_time_ms;
          row.holder_ingested_at = hit.ingested_at_ms;
          row.holder_age_at_decision_ms = age;
          stampResearchQuality(row);
        }
      }
    } catch {
      /* warehouse PIT optional */
    }
  }
  let obsId: number | null = null;
  let featId: number | null = null;
  try {
    const obs = await sql.query<{ id: number }>(
      `select id from market_observations where mint = $1 and coalesce(ingested_at_ms, observed_at_ms) <= $2 order by coalesce(ingested_at_ms, observed_at_ms) desc limit 1`,
      [row.tokenAddress, row.decision_time],
    );
    obsId = obs[0]?.id ?? null;
    if (obsId != null) {
      const feat = await sql.query<{ id: number }>(
        `select id from feature_vectors where observation_id = $1 order by computed_at_ms desc limit 1`,
        [obsId],
      );
      featId = feat[0]?.id ?? null;
    }
  } catch {
    /* 0003 */
  }
  const params = [
    row.decision_id, row.decision_time, row.tokenAddress, row.token, row.bucket, row.regime,
    row.strategy_id, row.strategy_version, row.governor_result, row.trade_action, row.trade_taken,
    row.veto_reason, row.proposed_size, cooldown,
  ];
  let inserted = await sql
    .query<{ decision_id: string }>(
      `insert into candidate_considerations (
        decision_id, decision_time_ms, mint, symbol, bucket, regime, strategy_id, strategy_version,
        governor_result, trade_action, trade_taken, veto_reason, proposed_size, cooldown_key, labels_complete,
        observation_id, feature_vector_id
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,false,$15,$16)
      on conflict (mint, strategy_version, cooldown_key) do nothing returning decision_id`,
      [...params, obsId, featId],
    )
    .catch(() =>
      sql.query<{ decision_id: string }>(
        `insert into candidate_considerations (
          decision_id, decision_time_ms, mint, symbol, bucket, regime, strategy_id, strategy_version,
          governor_result, trade_action, trade_taken, veto_reason, proposed_size, cooldown_key, labels_complete
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,false)
        on conflict (mint, strategy_version, cooldown_key) do nothing returning decision_id`,
        params,
      ),
    );
  if (!inserted.length) return false;
  try {
    await sql.query(
      `update candidate_considerations set
         feature_engine_version = $2, label_definition_version = $3,
         research_quality_score = $4, research_grade = $5, veto_reason_code = $6
       where decision_id = $1`,
      [
        row.decision_id,
        row.feature_engine_version,
        row.label_definition_version,
        row.research_quality_score,
        row.research_grade,
        row.veto_reason_code,
      ],
    );
  } catch {
    /* 0004 */
  }
  try {
    await sql.query(
      `update candidate_considerations set
         collection_epoch_id = $2, input_quality_score = $3, label_quality_score = $4,
         research_quality_v2 = $5, research_grade_v2 = $6, holder_age_at_decision_ms = $7,
         first_sample_delay_seconds = $8,
         holder_count = $9, holder_concentration = $10, holder_status = $11, holder_source = $12,
         holder_event_time_ms = $13, holder_ingested_at_ms = $14
       where decision_id = $1`,
      [
        row.decision_id,
        currentEpochName(),
        row.input_quality_score ?? null,
        row.label_quality_score ?? null,
        row.research_quality_v2 ?? null,
        row.research_grade_v2 ?? null,
        row.holder_age_at_decision_ms ?? null,
        row.first_sample_delay_seconds ?? null,
        row.holder_count ?? null,
        row.holder_concentration ?? null,
        row.holder_status ?? null,
        row.holder_source ?? null,
        row.holder_event_time ?? null,
        row.holder_ingested_at ?? null,
      ],
    );
  } catch {
    /* 0006 */
  }
  const frozen = { ...row, path: (row.path ?? []).slice(0, 1) };
  await sql.query(
    `insert into decision_snapshots (decision_id, snapshot, created_at_ms) values ($1, $2::jsonb, $3) on conflict do nothing`,
    [row.decision_id, JSON.stringify(frozen), row.decision_time],
  );
  for (const g of row.gates ?? []) {
    await sql.query(
      `insert into governor_gate_results (decision_id, gate_name, status, reason) values ($1,$2,$3,$4)`,
      [row.decision_id, g.name, g.status, g.reason],
    );
  }
  await sql.query(
    `insert into strategy_decisions (decision_id, matched, strategy_id, detail) values ($1,$2,$3,$4) on conflict do nothing`,
    [row.decision_id, row.governor_result === "authorized", row.strategy_id, row.veto_reason],
  );
  if (row.trade_taken && row.simulated_entry != null) {
    const oid = `ord-${row.decision_id}`;
    const fid = `fill-${row.decision_id}`;
    await sql.query(
      `insert into paper_orders (id, decision_id, side, mint, requested_notional, status, created_at_ms)
       values ($1,$2,'buy',$3,$4,'filled',$5) on conflict do nothing`,
      [oid, row.decision_id, row.tokenAddress, row.proposed_size, row.decision_time],
    );
    await sql.query(
      `insert into paper_fills (
        id, order_id, decision_id, side, mint, qty, price, notional, fees, impact, slippage_bps, provider, created_at_ms
      ) values ($1,$2,$3,'buy',$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict do nothing`,
      [
        fid, oid, row.decision_id, row.tokenAddress, row.proposed_size / row.simulated_entry,
        row.simulated_entry, row.proposed_size, row.proposed_size * 0.0025, row.entry_impact,
        desk.slippageBps, row.feature_sources?.exitQuote?.source ?? "jupiter", row.decision_time,
      ],
    );
  }
  return true;
}

async function upsertLabels(sql: Sql, row: LedgerRow) {
  const path = row.labels_complete ? row.path.slice(-40) : row.path ?? [];
  const base = [
    row.decision_id, JSON.stringify(path), row.price_after_1m, row.price_after_5m, row.price_after_15m,
    row.price_after_30m, row.price_after_1h, row.max_gain_5m, row.max_gain_15m, row.max_gain_1h,
    row.max_drawdown_5m, row.max_drawdown_15m, row.max_drawdown_1h, row.hit_plus_10_before_minus_10,
    row.hit_plus_20_before_minus_10, row.liquidity_collapse, row.sell_route_lost, row.rug_detected,
    row.simulated_entry, row.simulated_exit, row.net_execution_return, row.labels_complete, Date.now(),
  ];
  try {
    await sql.query(
      `insert into outcome_labels (
        decision_id, path, price_after_1m, price_after_5m, price_after_15m, price_after_30m, price_after_1h,
        max_gain_5m, max_gain_15m, max_gain_1h, max_drawdown_5m, max_drawdown_15m, max_drawdown_1h,
        hit_plus_10_before_minus_10, hit_plus_20_before_minus_10, liquidity_collapse, sell_route_lost, rug_detected,
        simulated_entry, simulated_exit, net_execution_return, labels_complete, updated_at_ms,
        theoretical_return, execution_adjusted_return, mfe_1m, mfe_30m, mae_1m, mae_30m,
        first_sell_route_loss_at_ms, sell_route_restored_at_ms, completed_at_ms
      ) values (
        $1,$2::jsonb,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,
        $24,$25,$26,$27,$28,$29,$30,$31,$32
      )
      on conflict (decision_id) do update set
        path = excluded.path,
        price_after_1m = coalesce(outcome_labels.price_after_1m, excluded.price_after_1m),
        price_after_5m = coalesce(outcome_labels.price_after_5m, excluded.price_after_5m),
        price_after_15m = coalesce(outcome_labels.price_after_15m, excluded.price_after_15m),
        price_after_30m = coalesce(outcome_labels.price_after_30m, excluded.price_after_30m),
        price_after_1h = coalesce(outcome_labels.price_after_1h, excluded.price_after_1h),
        max_gain_5m = coalesce(outcome_labels.max_gain_5m, excluded.max_gain_5m),
        max_gain_15m = coalesce(outcome_labels.max_gain_15m, excluded.max_gain_15m),
        max_gain_1h = coalesce(outcome_labels.max_gain_1h, excluded.max_gain_1h),
        max_drawdown_5m = coalesce(outcome_labels.max_drawdown_5m, excluded.max_drawdown_5m),
        max_drawdown_15m = coalesce(outcome_labels.max_drawdown_15m, excluded.max_drawdown_15m),
        max_drawdown_1h = coalesce(outcome_labels.max_drawdown_1h, excluded.max_drawdown_1h),
        hit_plus_10_before_minus_10 = coalesce(outcome_labels.hit_plus_10_before_minus_10, excluded.hit_plus_10_before_minus_10),
        hit_plus_20_before_minus_10 = coalesce(outcome_labels.hit_plus_20_before_minus_10, excluded.hit_plus_20_before_minus_10),
        liquidity_collapse = coalesce(outcome_labels.liquidity_collapse, excluded.liquidity_collapse),
        sell_route_lost = coalesce(outcome_labels.sell_route_lost, excluded.sell_route_lost),
        rug_detected = coalesce(outcome_labels.rug_detected, excluded.rug_detected),
        simulated_entry = coalesce(outcome_labels.simulated_entry, excluded.simulated_entry),
        simulated_exit = coalesce(outcome_labels.simulated_exit, excluded.simulated_exit),
        net_execution_return = coalesce(outcome_labels.net_execution_return, excluded.net_execution_return),
        theoretical_return = coalesce(outcome_labels.theoretical_return, excluded.theoretical_return),
        execution_adjusted_return = coalesce(outcome_labels.execution_adjusted_return, excluded.execution_adjusted_return),
        mfe_1m = coalesce(outcome_labels.mfe_1m, excluded.mfe_1m),
        mfe_30m = coalesce(outcome_labels.mfe_30m, excluded.mfe_30m),
        mae_1m = coalesce(outcome_labels.mae_1m, excluded.mae_1m),
        mae_30m = coalesce(outcome_labels.mae_30m, excluded.mae_30m),
        first_sell_route_loss_at_ms = coalesce(outcome_labels.first_sell_route_loss_at_ms, excluded.first_sell_route_loss_at_ms),
        sell_route_restored_at_ms = coalesce(outcome_labels.sell_route_restored_at_ms, excluded.sell_route_restored_at_ms),
        labels_complete = outcome_labels.labels_complete or excluded.labels_complete,
        completed_at_ms = coalesce(outcome_labels.completed_at_ms, excluded.completed_at_ms),
        updated_at_ms = excluded.updated_at_ms`,
      [
        ...base, row.theoretical_return, row.execution_adjusted_return ?? row.net_execution_return,
        row.mfe_1m, row.mfe_30m, row.mae_1m, row.mae_30m, row.first_sell_route_loss_at,
        row.sell_route_restored_at, row.labels_complete ? Date.now() : null,
      ],
    );
  } catch {
    await sql.query(
      `insert into outcome_labels (
        decision_id, path, price_after_1m, price_after_5m, price_after_15m, price_after_30m, price_after_1h,
        max_gain_5m, max_gain_15m, max_gain_1h, max_drawdown_5m, max_drawdown_15m, max_drawdown_1h,
        hit_plus_10_before_minus_10, hit_plus_20_before_minus_10, liquidity_collapse, sell_route_lost, rug_detected,
        simulated_entry, simulated_exit, net_execution_return, labels_complete, updated_at_ms
      ) values ($1,$2::jsonb,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
      on conflict (decision_id) do update set
        path = excluded.path,
        price_after_1m = coalesce(outcome_labels.price_after_1m, excluded.price_after_1m),
        price_after_5m = coalesce(outcome_labels.price_after_5m, excluded.price_after_5m),
        price_after_15m = coalesce(outcome_labels.price_after_15m, excluded.price_after_15m),
        price_after_30m = coalesce(outcome_labels.price_after_30m, excluded.price_after_30m),
        price_after_1h = coalesce(outcome_labels.price_after_1h, excluded.price_after_1h),
        max_gain_5m = coalesce(outcome_labels.max_gain_5m, excluded.max_gain_5m),
        max_gain_15m = coalesce(outcome_labels.max_gain_15m, excluded.max_gain_15m),
        max_gain_1h = coalesce(outcome_labels.max_gain_1h, excluded.max_gain_1h),
        max_drawdown_5m = coalesce(outcome_labels.max_drawdown_5m, excluded.max_drawdown_5m),
        max_drawdown_15m = coalesce(outcome_labels.max_drawdown_15m, excluded.max_drawdown_15m),
        max_drawdown_1h = coalesce(outcome_labels.max_drawdown_1h, excluded.max_drawdown_1h),
        hit_plus_10_before_minus_10 = coalesce(outcome_labels.hit_plus_10_before_minus_10, excluded.hit_plus_10_before_minus_10),
        hit_plus_20_before_minus_10 = coalesce(outcome_labels.hit_plus_20_before_minus_10, excluded.hit_plus_20_before_minus_10),
        liquidity_collapse = coalesce(outcome_labels.liquidity_collapse, excluded.liquidity_collapse),
        sell_route_lost = coalesce(outcome_labels.sell_route_lost, excluded.sell_route_lost),
        rug_detected = coalesce(outcome_labels.rug_detected, excluded.rug_detected),
        simulated_entry = coalesce(outcome_labels.simulated_entry, excluded.simulated_entry),
        simulated_exit = coalesce(outcome_labels.simulated_exit, excluded.simulated_exit),
        net_execution_return = coalesce(outcome_labels.net_execution_return, excluded.net_execution_return),
        labels_complete = outcome_labels.labels_complete or excluded.labels_complete,
        updated_at_ms = excluded.updated_at_ms`,
      base,
    );
  }
  if (row.labels_complete) {
    await sql.query(`update candidate_considerations set labels_complete = true where decision_id = $1`, [row.decision_id]);
  }
  try {
    await sql.query(
      `update outcome_labels set
         label_definition_version = $2,
         barrier_label_confidence = $3,
         barrier_10_outcome = $4,
         barrier_20_outcome = $5,
         max_path_gap_seconds = $6,
         avg_path_gap_seconds = $7,
         path_sample_count = $8
       where decision_id = $1`,
      [
        row.decision_id,
        row.label_definition_version,
        row.barrier_label_confidence,
        row.barrier_10_outcome,
        row.barrier_20_outcome,
        row.max_path_gap_seconds,
        row.avg_path_gap_seconds,
        row.path_sample_count,
      ],
    );
  } catch {
    /* 0004 */
  }
  try {
    await sql.query(
      `update outcome_labels set
         collection_epoch_id = coalesce(collection_epoch_id, $2),
         sample_count = $3,
         max_gap_seconds = $4,
         median_gap_seconds = $5,
         p95_gap_seconds = $6,
         first_sample_delay_seconds = $7
       where decision_id = $1`,
      [
        row.decision_id,
        currentEpochName(),
        row.path_sample_count ?? null,
        row.max_path_gap_seconds ?? null,
        row.avg_path_gap_seconds ?? null,
        row.max_path_gap_seconds ?? null,
        row.first_sample_delay_seconds ?? null,
      ],
    );
  } catch {
    /* 0006 */
  }
}

export async function setControl(patch: {
  running?: boolean;
  halted?: boolean;
  riskBps?: number;
  slippageBps?: number;
  selected?: string | null;
  resetBook?: boolean;
}) {
  const sql = await ensureDeskState();
  if (patch.resetBook) {
    await sql.query("delete from paper_positions");
    await sql.query(
      `update desk_state set cash = start_equity, equity = start_equity, halted = false, fills = 0, win_count = 0, loss_count = 0 where id = 1`,
    );
    return;
  }
  const sets: string[] = [];
  const vals: unknown[] = [];
  const add = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  if (patch.running != null) add("running", patch.running);
  if (patch.halted != null) add("halted", patch.halted);
  if (patch.riskBps != null) add("risk_bps", patch.riskBps);
  if (patch.slippageBps != null) add("slippage_bps", patch.slippageBps);
  if (patch.selected !== undefined) add("selected_mint", patch.selected);
  if (!sets.length) return;
  await sql.query(`update desk_state set ${sets.join(", ")} where id = 1`, vals);
}

export async function exportRows(): Promise<LedgerRow[]> {
  const sql = await getSql();
  const rows = await sql.query<{ snapshot: unknown; labels: unknown; collection_epoch_id: string | null }>(
    `select s.snapshot, to_jsonb(o) as labels, c.collection_epoch_id
     from candidate_considerations c
     join decision_snapshots s on s.decision_id = c.decision_id
     left join outcome_labels o on o.decision_id = c.decision_id
     order by c.decision_time_ms asc limit 50000`,
  );
  return rows.map((r) => {
    const merged = mergeRow(json<LedgerRow>(r.snapshot, {} as LedgerRow), json(r.labels, {})) as LedgerRow & {
      collection_epoch_id?: string | null;
    };
    merged.path = [];
    merged.collection_epoch_id = r.collection_epoch_id;
    return merged;
  });
}

export function rowsToCsv(rows: LedgerRow[]) {
  const cols = [
    "decision_id", "decision_time", "event_time", "ingested_at", "token", "tokenAddress", "pair_address",
    "token_age", "bucket", "price", "market_cap", "liquidity", "volume_1m", "volume_5m", "volume_acceleration",
    "buy_sell_imbalance", "unique_buyers", "unique_sellers", "holder_count", "holder_concentration",
    "mint_auth", "freeze_auth", "entry_impact", "exit_impact", "stressed_exit", "momentum_score",
    "flow_score", "safety_score", "edge_score", "regime", "strategy_id", "strategy_version",
    "governor_result", "veto_reason", "proposed_size", "proposed_entry", "proposed_stop", "trade_taken",
    "trade_action", "sell_quote_available", "price_after_1m", "price_after_5m", "price_after_15m",
    "price_after_30m", "price_after_1h", "max_gain_5m", "max_gain_15m", "max_gain_1h", "max_drawdown_5m",
    "max_drawdown_15m", "max_drawdown_1h", "mfe_1m", "mfe_30m", "mae_1m", "mae_30m",
    "hit_plus_10_before_minus_10", "hit_plus_20_before_minus_10", "liquidity_collapse", "sell_route_lost",
    "first_sell_route_loss_at", "rug_detected", "simulated_entry", "simulated_exit", "theoretical_return",
    "net_execution_return", "execution_adjusted_return", "labels_complete", "outcome",
    "feature_engine_version", "label_definition_version", "veto_reason_code", "route_status",
    "barrier_label_confidence", "barrier_10_outcome", "barrier_20_outcome",
    "research_quality_score", "research_grade", "provider_disagreement",
    "max_path_gap_seconds", "path_sample_count",
  ] as const;
  const extra = ["gates", "feature_sources", "features"] as const;
  const esc = (v: unknown) => {
    const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return [ [...cols, ...extra].join(","), ...rows.map((r) => [...cols.map((c) => esc(r[c])), extra.map((c) => esc(r[c]))].flat().join(",")) ].join("\n");
}

function slimRow(r: LedgerRow): LedgerRow {
  return { ...r, path: r.labels_complete ? [] : (r.path ?? []).slice(-40) };
}

async function writeDump(sql: Sql, s: DeskSnapshot) {
  try {
    await mkdir("/workspace/data", { recursive: true });
    const pending = await sql.query<{ snapshot: unknown; labels: unknown }>(
      `select s.snapshot, to_jsonb(o) as labels from outcome_labels o
       join decision_snapshots s on s.decision_id = o.decision_id
       where o.labels_complete = false order by o.updated_at_ms desc limit 2500`,
    );
    const done = await sql.query<{ snapshot: unknown; labels: unknown }>(
      `select s.snapshot, to_jsonb(o) as labels from candidate_considerations c
       join decision_snapshots s on s.decision_id = c.decision_id
       left join outcome_labels o on o.decision_id = c.decision_id
       where coalesce(o.labels_complete, false) = true order by c.decision_time_ms desc limit 8000`,
    );
    const corpus = [...pending, ...done].map((r) =>
      slimRow(mergeRow(json<LedgerRow>(r.snapshot, {} as LedgerRow), json(r.labels, {}))),
    );
    const desk: DeskSnapshot = {
      ...s,
      pending: s.pending.slice(0, 500).map(slimRow),
      ledger: s.ledger.slice(0, 80).map((r) => ({ ...r, path: [] })),
      flushQueue: [],
    };
    await writeFile(DUMP, JSON.stringify({ v: 325, savedAt: Date.now(), desk, corpus } satisfies DumpFile));
  } catch {
    /* vercel has no durable fs */
  }
}

async function readDump(): Promise<DumpFile | null> {
  try {
    const raw = await readFile(DUMP, "utf8");
    const d = JSON.parse(raw) as DumpFile | DeskSnapshot;
    if (d && typeof d === "object" && "v" in d && (d as DumpFile).v === 325) {
      const file = d as DumpFile;
      return { v: 325, savedAt: file.savedAt, desk: { ...emptyDesk(), ...file.desk }, corpus: file.corpus ?? [] };
    }
    const legacy = d as DeskSnapshot;
    if (!legacy || typeof legacy !== "object") return null;
    return {
      v: 325,
      savedAt: Date.now(),
      desk: { ...emptyDesk(), ...legacy, flushQueue: [] },
      corpus: [...(legacy.pending ?? []), ...(legacy.ledger ?? [])],
    };
  } catch {
    return null;
  }
}

export function recordError(message: string) {
  return getSql().then((sql) => sql.query(`update desk_state set last_error = $1 where id = 1`, [message]));
}

async function persistQuotePayload(sql: Sql, t: TokenLive, ingestedAt: number) {
  try {
    const q = t.sellQuote;
    const fp = requestFingerprint(
      "jupiter",
      "quote",
      { mint: t.address, inAmount: q?.inAmount ?? null, outMint: q?.outMint ?? null },
      Math.floor(ingestedAt / 4_000),
    );
    await sql.query(
      `insert into provider_payloads (
         provider, endpoint, token_mint, event_time_ms, ingested_at_ms, http_status, latency_ms,
         request_fingerprint, payload, error_code
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
       on conflict do nothing`,
      [
        "jupiter",
        "quote",
        t.address,
        q?.eventTime ?? ingestedAt,
        ingestedAt,
        q ? (q.available ? 200 : 0) : null,
        q?.latencyMs ?? null,
        fp,
        JSON.stringify(q ?? { status: "NOT_CHECKED" }),
        q?.failureReason ?? (q ? null : "NOT_CHECKED"),
      ],
    );
  } catch {
    /* 0004 */
  }
}

async function persistWatches(sql: Sql, next: DeskSnapshot, now: number) {
  try {
    const pending = new Set(next.pending.filter((r) => !r.labels_complete).map((r) => r.tokenAddress));
    const held = new Set(next.positions.map((p) => p.tokenAddress));
    const ranked = next.tokens.map((t) => {
      const considered = pending.has(t.address) || held.has(t.address);
      const edge = next.lastIntent?.tokenAddress === t.address ? next.lastIntent.predictions.edgeScore : 0;
      const ageS = t.createdAt ? (now - t.createdAt) / 1000 : null;
      const urgency = researchUrgency({
        hasOpenPaperPosition: held.has(t.address),
        hasPendingLabel: pending.has(t.address),
        wasJustConsidered: considered,
        isNewLaunch: bucketOf(ageS) === "new_launch",
        edgeScore: edge,
      });
      return { mint: t.address, urgency, considered, edge };
    });
    const { keep, demote } = selectActiveWatches(ranked, deskSettings().maxActiveWatches ?? MAX_ACTIVE_WATCHES);
    const keepSet = new Set(keep);
    for (const t of next.tokens) {
      const meta = ranked.find((r) => r.mint === t.address);
      const considered = Boolean(meta?.considered);
      const active = keepSet.has(t.address);
      const interval = active ? ACTIVE_INTERVAL_MS : UNIVERSE_INTERVAL_MS;
      const demoted = demote.includes(t.address);
      await sql.query(
        `insert into token_watch_state (
           token_mint, tier, next_due_at_ms, promoted_at_ms, expires_at_ms, reason, updated_at_ms
         ) values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (token_mint) do update set
           tier = excluded.tier,
           next_due_at_ms = excluded.next_due_at_ms,
           promoted_at_ms = coalesce(token_watch_state.promoted_at_ms, excluded.promoted_at_ms),
           expires_at_ms = excluded.expires_at_ms,
           reason = excluded.reason,
           updated_at_ms = excluded.updated_at_ms`,
        [
          t.address,
          active ? "active" : "universe",
          now + interval,
          active ? now : null,
          active ? now + 60 * 60_000 : null,
          demoted ? "capacity_demote" : considered ? "considered" : active ? "promoted" : "universe",
          now,
        ],
      );
      try {
        await sql.query(
          `update token_watch_state set phase = $2, urgency = $3, demotion_reason = $4 where token_mint = $1`,
          [t.address, active ? "ACTIVE" : demoted ? "UNIVERSE" : "UNIVERSE", meta?.urgency ?? 0, demoted ? "capacity" : null],
        );
      } catch {
        /* 0006 */
      }
    }
  } catch {
    /* 0004 */
  }
}

export async function startWorkerTick(tickId: string, startedAt: number) {
  try {
    const sql = await getSql();
    await sql.query(
      `insert into worker_ticks (tick_id, started_at_ms, status) values ($1,$2,'RUNNING') on conflict do nothing`,
      [tickId, startedAt],
    );
    try {
      await sql.query(
        `update worker_ticks set collection_epoch_id = coalesce(collection_epoch_id, $2) where tick_id = $1`,
        [tickId, currentEpochName()],
      );
    } catch {
      /* 0006 */
    }
  } catch {
    /* 0004 */
  }
}

export async function finishWorkerTick(
  tickId: string,
  status: "SUCCESS" | "FAILED",
  stats: {
    tokensSeen: number;
    observationsWritten: number;
    considerationsWritten: number;
    labelsUpdated: number;
    errorCount: number;
  },
) {
  try {
    const sql = await getSql();
    await sql.query(
      `update worker_ticks set
         completed_at_ms = $2, status = $3, tokens_seen = $4, observations_written = $5,
         considerations_written = $6, labels_updated = $7, error_count = $8
       where tick_id = $1`,
      [
        tickId,
        Date.now(),
        status,
        stats.tokensSeen,
        stats.observationsWritten,
        stats.considerationsWritten,
        stats.labelsUpdated,
        stats.errorCount,
      ],
    );
  } catch {
    /* 0004 */
  }
}

let epochEnsured = false;

async function ensureCollectionEpoch(sql: Sql, now: number) {
  const name = currentEpochName();
  try {
    await sql.query(
      `insert into collection_epochs (id, name, started_at_ms, config, code_version, notes, created_at_ms)
       values ($1,$2,$3,$4::jsonb,$5,$6,$7) on conflict (name) do nothing`,
      [name, name, now, JSON.stringify({ environment: deskSettings().environment }), STRATEGY_VERSION, "v33a2 collection", now],
    );
    await sql.query(
      `insert into warehouse_metadata (key, value, updated_at_ms) values ('collection_epoch', $1::jsonb, $2)
       on conflict (key) do update set value = excluded.value, updated_at_ms = excluded.updated_at_ms`,
      [JSON.stringify({ name, driver: deskSettings().databaseDriver }), now],
    );
    await sql.query(
      `insert into warehouse_metadata (key, value, updated_at_ms) values ('canonical_database', $1::jsonb, $2)
       on conflict (key) do update set value = excluded.value, updated_at_ms = excluded.updated_at_ms`,
      [JSON.stringify({ driver: deskSettings().databaseDriver }), now],
    );
    epochEnsured = true;
  } catch {
    epochEnsured = false;
  }
}

export async function acquirePrimaryLease(instanceId: string): Promise<"acquired" | "renewed" | "conflict"> {
  try {
    const sql = await getSql();
    const now = Date.now();
    const row = (
      await sql.query<{
        lease_name: string;
        worker_instance_id: string;
        acquired_at_ms: number;
        renewed_at_ms: number;
        expires_at_ms: number;
      }>(`select * from worker_leases where lease_name = $1`, [PRIMARY_LEASE])
    )[0];
    const existing = row
      ? {
          leaseName: row.lease_name,
          workerInstanceId: row.worker_instance_id,
          acquiredAt: Number(row.acquired_at_ms),
          renewedAt: Number(row.renewed_at_ms),
          expiresAt: Number(row.expires_at_ms),
        }
      : null;
    const { decision, next } = decideLease(existing, instanceId, now, LEASE_TTL_MS);
    if (decision === "conflict") return "conflict";
    await sql.query(
      `insert into worker_leases (lease_name, worker_instance_id, acquired_at_ms, renewed_at_ms, expires_at_ms)
       values ($1,$2,$3,$4,$5)
       on conflict (lease_name) do update set
         worker_instance_id = excluded.worker_instance_id,
         acquired_at_ms = excluded.acquired_at_ms,
         renewed_at_ms = excluded.renewed_at_ms,
         expires_at_ms = excluded.expires_at_ms`,
      [next.leaseName, next.workerInstanceId, next.acquiredAt, next.renewedAt, next.expiresAt],
    );
    return decision;
  } catch (err) {
    if (process.env.MERIDIAN_WORKER === "1") throw err;
    return "acquired";
  }
}

export async function renewPrimaryLease(instanceId: string): Promise<boolean> {
  const d = await acquirePrimaryLease(instanceId);
  return d !== "conflict";
}

export async function persistFastPath(opts: {
  tokens: TokenSnapshot[];
  mints: string[];
  scheduledAt: number;
  startedAt: number;
  providerDelayMs: number;
  deadlineMs: number;
}) {
  const sql = await getSql();
  const completedAt = Date.now();
  const db0 = Date.now();
  for (const t of opts.tokens) {
    const sample = toFastPathSample(t);
    try {
      await sql.query(
        `insert into token_path_samples (
           token_mint, event_time_ms, ingested_at_ms, price_usd, liquidity_usd,
           sell_route_state, provider_snapshot, sample_fingerprint, created_at_ms
         ) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
         on conflict (sample_fingerprint) do nothing`,
        [
          sample.mint,
          sample.eventTime,
          sample.ingestedAt,
          sample.priceUsd,
          sample.liquidityUsd,
          sample.routeState ?? "UNKNOWN",
          JSON.stringify({ source: sample.source, kind: "fast" }),
          sample.sampleFingerprint,
          completedAt,
        ],
      );
      await sql.query(
        `update token_path_samples set collection_epoch_id = $2, sample_kind = 'fast' where sample_fingerprint = $1`,
        [sample.sampleFingerprint, currentEpochName()],
      );
    } catch {
      /* 0005/0006 */
    }
  }
  const databaseDelayMs = Date.now() - db0;
  for (const mint of opts.mints) {
    const d = watchDeadline({
      scheduledAt: opts.scheduledAt,
      startedAt: opts.startedAt,
      completedAt,
      deadlineMs: opts.deadlineMs,
    });
    try {
      await sql.query(
        `insert into watch_execution_stats (
           token_mint, tier, scheduled_at_ms, started_at_ms, completed_at_ms,
           queue_delay_ms, provider_delay_ms, database_delay_ms, total_delay_ms,
           deadline_ms, deadline_missed, created_at_ms
         ) values ($1,'active',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          mint,
          opts.scheduledAt,
          opts.startedAt,
          completedAt,
          d.queueDelayMs,
          opts.providerDelayMs,
          databaseDelayMs,
          d.totalDelayMs,
          opts.deadlineMs,
          d.deadlineMissed,
          completedAt,
        ],
      );
    } catch {
      /* 0006 */
    }
  }
}

export async function recordSoakIncident(opts: {
  type: string;
  severity?: string;
  durationSeconds?: number | null;
  metadata?: Record<string, unknown>;
}) {
  try {
    const sql = await getSql();
    const row = makeSoakIncident(opts);
    await sql.query(
      `insert into soak_incidents (id, occurred_at_ms, severity, incident_type, duration_seconds, metadata, created_at_ms)
       values ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [
        row.id,
        row.occurredAtMs,
        row.severity,
        row.incidentType,
        row.durationSeconds,
        JSON.stringify(row.metadata),
        row.createdAtMs,
      ],
    );
  } catch {
    /* 0006 */
  }
}

void epochEnsured;

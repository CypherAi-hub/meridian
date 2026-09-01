import { dbSource, getSql, type Sql } from "@/lib/db";
import { workerStatusFromHeartbeat } from "./leakage";
import { emptyQuality, type DataQuality } from "./types";
import { configuredProviders } from "./config";
import { breakerFor } from "./circuit";

function num(v: unknown, d = 0) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : d;
}

async function q<T>(sql: Sql, text: string, params: unknown[] = []): Promise<T[]> {
  try {
    return await sql.query<T>(text, params);
  } catch {
    return [];
  }
}

export async function loadQuality(sql?: Sql): Promise<DataQuality> {
  const db = sql ?? (await getSql());
  const since = Date.now() - 6 * 3600_000;
  const tokens = (await q<{ n: number }>(db, `select count(*)::int as n from tokens`))[0];
  const obs = (await q<{ n: number }>(db, `select count(*)::int as n from market_observations`))[0];
  const feats = (await q<{ n: number }>(db, `select count(*)::int as n from feature_vectors`))[0];
  const featTable = (
    await q<{ n: number }>(
      db,
      `select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name = 'feature_vectors'`,
    )
  )[0];
  const migs = (
    await q<{ names: string }>(db, `select string_agg(name, ',') as names from _migrations`)
  )[0];
  const paths = (await q<{ n: number }>(db, `select count(*)::int as n from consideration_paths`))[0];
  const gaps = (
    await q<{ avg_ms: number | null; max_ms: number | null }>(
      db,
      `select avg(delta)::float as avg_ms, max(delta)::float as max_ms
       from (
         select coalesce(ingested_at_ms, observed_at_ms)
              - lag(coalesce(ingested_at_ms, observed_at_ms))
                over (partition by mint order by coalesce(ingested_at_ms, observed_at_ms)) as delta
         from market_observations
         where coalesce(ingested_at_ms, observed_at_ms) > $1
       ) s
       where delta is not null and delta > 0 and delta < 600000`,
      [since],
    )
  )[0];
  const holder = (
    await q<{ unknown_pct: number | null; cover_pct: number | null }>(
      db,
      `select
         avg(case when top_10_holder_pct is null then 1.0 else 0.0 end)::float as unknown_pct,
         avg(case when top_10_holder_pct is not null then 1.0 else 0.0 end)::float as cover_pct
       from market_observations
       where coalesce(ingested_at_ms, observed_at_ms) > $1`,
      [since],
    )
  )[0];
  const contract = (
    await q<{ unknown_pct: number | null }>(
      db,
      `select avg(case when mint_authority_active is null then 1.0 else 0.0 end)::float as unknown_pct
       from market_observations
       where coalesce(ingested_at_ms, observed_at_ms) > $1`,
      [since],
    )
  )[0];
  const jup = (
    await q<{ pct: number | null }>(
      db,
      `select avg(case when jupiter_sell_route then 1.0 else 0.0 end)::float as pct
       from market_observations
       where coalesce(ingested_at_ms, observed_at_ms) > $1`,
      [since],
    )
  )[0];
  const labels = (
    await q<{ pct: number | null }>(
      db,
      `select avg(case when labels_complete then 1.0 else 0.0 end)::float as pct from outcome_labels`,
    )
  )[0];
  const fails = (
    await q<{ n: number }>(
      db,
      `select coalesce(sum(error_count),0)::int as n from providers where updated_at_ms > $1`,
      [Date.now() - 3600_000],
    )
  )[0];
  const pathGap = (
    await q<{ avg_ms: number | null }>(
      db,
      `select avg(delta)::float as avg_ms from (
         select observed_at_ms - lag(observed_at_ms) over (partition by consideration_id order by observed_at_ms) as delta
         from consideration_paths
       ) s where delta is not null and delta > 0 and delta < 120000`,
    )
  )[0];
  const tick = (
    await q<{ ms: number | null }>(db, `select last_tick_duration_ms::float as ms from desk_state where id = 1`)
  )[0];

  const quality = emptyQuality();
  quality.tokensObserved = num(tokens?.n);
  quality.rawObservations = num(obs?.n);
  quality.featureVectors = num(feats?.n);
  if (!featTable?.n) {
    console.error("[meridian] feature_vectors missing; migrations", migs?.names);
  }
  quality.pathSamples = num(paths?.n);
  quality.avgObservationIntervalMs = gaps?.avg_ms == null ? null : num(gaps.avg_ms);
  quality.largestGapMs = gaps?.max_ms == null ? null : num(gaps.max_ms);
  quality.unknownHolderPct = holder?.unknown_pct == null ? null : num(holder.unknown_pct);
  quality.holderCoveragePct = holder?.cover_pct == null ? null : num(holder.cover_pct);
  quality.unknownContractPct = contract?.unknown_pct == null ? null : num(contract.unknown_pct);
  quality.jupiterRoutePct = jup?.pct == null ? null : num(jup.pct);
  quality.labelsCompletedPct = labels?.pct == null ? null : num(labels.pct);
  quality.providerFailuresHour = num(fails?.n);
  quality.avgPathIntervalMs = pathGap?.avg_ms == null ? null : num(pathGap.avg_ms);
  quality.avgTickMs = tick?.ms == null ? null : num(tick.ms);
  const unique = (await q<{ n: number }>(db, `select count(*)::int as n from tokens`))[0];
  quality.uniqueTokens = num(unique?.n);
  const conf = (
    await q<{ high: number | null; med: number | null; low: number | null; unk: number | null }>(
      db,
      `select
         avg(case when barrier_label_confidence = 'HIGH' then 1.0 else 0.0 end)::float as high,
         avg(case when barrier_label_confidence = 'MEDIUM' then 1.0 else 0.0 end)::float as med,
         avg(case when barrier_label_confidence = 'LOW' then 1.0 else 0.0 end)::float as low,
         avg(case when barrier_label_confidence is null or barrier_label_confidence = 'UNKNOWN' then 1.0 else 0.0 end)::float as unk
       from outcome_labels`,
    )
  )[0];
  quality.highConfidencePct = conf?.high == null ? null : num(conf.high);
  quality.mediumConfidencePct = conf?.med == null ? null : num(conf.med);
  quality.lowConfidencePct = conf?.low == null ? null : num(conf.low);
  quality.unknownConfidencePct = conf?.unk == null ? null : num(conf.unk);
  const grades = (
    await q<{ a: number; b: number; c: number; r: number }>(
      db,
      `select
         count(*) filter (where research_grade = 'TRAINING_GRADE_A')::int as a,
         count(*) filter (where research_grade = 'TRAINING_GRADE_B')::int as b,
         count(*) filter (where research_grade = 'TRAINING_GRADE_C')::int as c,
         count(*) filter (where research_grade = 'RESEARCH_ONLY')::int as r
       from candidate_considerations`,
    )
  )[0];
  quality.gradeA = num(grades?.a);
  quality.gradeB = num(grades?.b);
  quality.gradeC = num(grades?.c);
  quality.researchOnly = num(grades?.r);
  const routes = (
    await q<{
      checks: number;
      routable: number;
      noroute: number;
      timeout: number;
      rl: number;
      errors: number;
      notchecked: number;
    }>(
      db,
      `select
         count(*)::int as checks,
         count(*) filter (where route_status = 'ROUTABLE' or jupiter_sell_route)::int as routable,
         count(*) filter (where route_status = 'NO_ROUTE')::int as noroute,
         count(*) filter (where route_status = 'TIMEOUT')::int as timeout,
         count(*) filter (where route_status = 'RATE_LIMITED')::int as rl,
         count(*) filter (where route_status = 'ERROR')::int as errors,
         count(*) filter (where route_status is null or route_status = 'UNKNOWN')::int as notchecked
       from market_observations
       where coalesce(ingested_at_ms, observed_at_ms) > $1`,
      [since],
    )
  )[0];
  quality.routeCoverage = {
    checks: num(routes?.checks),
    routable: num(routes?.routable),
    noRoute: num(routes?.noroute),
    timeout: num(routes?.timeout),
    rateLimited: num(routes?.rl),
    errors: num(routes?.errors),
    notChecked: num(routes?.notchecked),
  };
  const cov = (
    await q<{ price: number | null; liq: number | null; sec: number | null }>(
      db,
      `select
         avg(case when price is not null then 1.0 else 0.0 end)::float as price,
         avg(case when liquidity is not null then 1.0 else 0.0 end)::float as liq,
         avg(case when mint_authority_active is not null then 1.0 else 0.0 end)::float as sec
       from market_observations
       where coalesce(ingested_at_ms, observed_at_ms) > $1`,
      [since],
    )
  )[0];
  quality.priceCoveragePct = cov?.price == null ? null : num(cov.price);
  quality.liquidityCoveragePct = cov?.liq == null ? null : num(cov.liq);
  quality.securityCoveragePct = cov?.sec == null ? null : num(cov.sec);
  const disagree = (
    await q<{ n: number }>(
      db,
      `select count(*)::int as n from market_observations where provider_disagreement and coalesce(ingested_at_ms, observed_at_ms) > $1`,
      [Date.now() - 3600_000],
    )
  )[0];
  quality.disagreementsHour = num(disagree?.n);
  const holderBuckets = (
    await q<{ new_launch: number | null; early: number | null; emerging: number | null }>(
      db,
      `select
         avg(case when age_s < 1800 then case when top_10_holder_pct is not null then 1.0 else 0.0 end end)::float as new_launch,
         avg(case when age_s >= 1800 and age_s < 21600 then case when top_10_holder_pct is not null then 1.0 else 0.0 end end)::float as early,
         avg(case when age_s >= 21600 and age_s < 259200 then case when top_10_holder_pct is not null then 1.0 else 0.0 end end)::float as emerging
       from (
         select o.top_10_holder_pct,
                case when t.created_at_ms is null then null
                     else (coalesce(o.ingested_at_ms, o.observed_at_ms) - t.created_at_ms) / 1000.0 end as age_s
         from market_observations o
         left join tokens t on t.mint = o.mint
         where coalesce(o.ingested_at_ms, o.observed_at_ms) > $1
       ) s`,
      [since],
    )
  )[0];
  quality.holderCoverageNewLaunchPct = holderBuckets?.new_launch == null ? null : num(holderBuckets.new_launch);
  quality.holderCoverageEarlyPct = holderBuckets?.early == null ? null : num(holderBuckets.early);
  quality.holderCoverageEmergingPct = holderBuckets?.emerging == null ? null : num(holderBuckets.emerging);
  const pathPct = (
    await q<{ med: number | null; p95: number | null }>(
      db,
      `select
         percentile_cont(0.5) within group (order by delta)::float as med,
         percentile_cont(0.95) within group (order by delta)::float as p95
       from (
         select observed_at_ms - lag(observed_at_ms) over (partition by consideration_id order by observed_at_ms) as delta
         from consideration_paths
       ) s where delta is not null and delta > 0 and delta < 120000`,
    )
  )[0];
  quality.medianPathGapMs = pathPct?.med == null ? null : num(pathPct.med);
  quality.p95PathGapMs = pathPct?.p95 == null ? null : num(pathPct.p95);
  return quality;
}

export async function loadHeartbeat(sql?: Sql): Promise<{
  lastTickMs: number | null;
  tickNumber: number;
  uptimeMs: number;
  status: string;
  durationMs: number | null;
  observationsWritten: number;
  dropped: number;
}> {
  const db = sql ?? (await getSql());
  const row = (
    await q<Record<string, unknown>>(db, `select * from worker_heartbeat where worker_name = 'market'`)
  )[0];
  if (!row) {
    return {
      lastTickMs: null,
      tickNumber: 0,
      uptimeMs: 0,
      status: "starting",
      durationMs: null,
      observationsWritten: 0,
      dropped: 0,
    };
  }
  return {
    lastTickMs: row.last_tick_ms == null ? null : num(row.last_tick_ms),
    tickNumber: num(row.tick_number),
    uptimeMs: num(row.uptime_ms),
    status: String(row.status ?? "offline"),
    durationMs: row.last_tick_duration_ms == null ? null : num(row.last_tick_duration_ms),
    observationsWritten: num(row.observations_written),
    dropped: num(row.considerations_dropped),
  };
}

export async function writeHeartbeat(opts: {
  status: string;
  durationMs: number;
  observationsWritten: number;
  considerationsWritten: number;
  dropped: number;
  error?: string | null;
  startedAt: number;
}) {
  const sql = await getSql();
  const now = Date.now();
  try {
    await sql.query(
      `insert into worker_heartbeat (
         worker_name, last_tick_ms, tick_number, uptime_ms, status,
         last_tick_duration_ms, observations_written, considerations_written, considerations_dropped, last_error
       ) values ('market', $1, 1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (worker_name) do update set
         last_tick_ms = excluded.last_tick_ms,
         tick_number = worker_heartbeat.tick_number + 1,
         uptime_ms = excluded.uptime_ms,
         status = excluded.status,
         last_tick_duration_ms = excluded.last_tick_duration_ms,
         observations_written = worker_heartbeat.observations_written + excluded.observations_written,
         considerations_written = worker_heartbeat.considerations_written + excluded.considerations_written,
         considerations_dropped = worker_heartbeat.considerations_dropped + excluded.considerations_dropped,
         last_error = excluded.last_error`,
      [
        now,
        now - opts.startedAt,
        opts.status,
        opts.durationMs,
        opts.observationsWritten,
        opts.considerationsWritten,
        opts.dropped,
        opts.error ?? null,
      ],
    );
  } catch {
    /* 0003 not applied yet */
  }
}

export { workerStatusFromHeartbeat };

export async function loadHealthPayload() {
  const sql = await getSql();
  const quality = await loadQuality(sql);
  const beat = await loadHeartbeat(sql);
  const providers = await q<Record<string, unknown>>(
    sql,
    `select id, status, lag_ms, last_ok_at_ms, error_count, ok_count, detail, updated_at_ms from providers`,
  );
  const corpus = (
    await q<Record<string, unknown>>(
      sql,
      `select
         (select count(*)::int from candidate_considerations) as considered,
         (select count(*)::int from candidate_considerations where governor_result = 'authorized') as authorized,
         (select count(*)::int from candidate_considerations where governor_result = 'vetoed') as vetoed,
         (select count(*)::int from candidate_considerations where trade_taken) as taken,
         (select count(*)::int from outcome_labels where labels_complete) as labeled,
         (select count(*)::int from outcome_labels where labels_complete = false) as pending`,
    )
  )[0];
  const status = workerStatusFromHeartbeat(beat.lastTickMs, beat.status === "offline" ? "stale" : null);
  const cfg = configuredProviders();
  const byId = new Map(providers.map((p) => [String(p.id), p]));
  const ensure = (id: string, status: string, detail: string) => {
    if (byId.has(id)) return;
    providers.push({ id, status, lag_ms: null, last_ok_at_ms: null, error_count: 0, ok_count: 0, detail, updated_at_ms: Date.now() });
  };
  ensure("birdeye", cfg.birdeye ? "offline" : "unconfigured", cfg.birdeye ? "no tick yet" : "UNCONFIGURED");
  ensure("helius", cfg.helius ? "offline" : "unconfigured", cfg.helius ? "no tick yet" : "UNCONFIGURED");
  return {
    status: status === "live" ? "ok" : "degraded",
    worker: {
      status,
      db: dbSource,
      lastTickAt: beat.lastTickMs,
      tickCount: beat.tickNumber,
      uptimeMs: beat.uptimeMs,
      avgTickMs: beat.durationMs,
      observationsWritten: beat.observationsWritten,
      considerationsDropped: beat.dropped,
    },
    providers: providers.map((p) => ({
      id: p.id,
      status: p.status,
      lagMs: p.lag_ms,
      lastOkAt: p.last_ok_at_ms,
      errors: p.error_count,
      detail: p.detail,
      circuit: breakerFor(String(p.id)).state(),
    })),
    configured: {
      birdeye: cfg.birdeye,
      helius: cfg.helius,
      solanaRpc: cfg.solanaRpc,
    },
    corpus: {
      considered: num(corpus?.considered),
      authorized: num(corpus?.authorized),
      vetoed: num(corpus?.vetoed),
      taken: num(corpus?.taken),
      labeled: num(corpus?.labeled),
      pending: num(corpus?.pending),
    },
    quality,
  };
}

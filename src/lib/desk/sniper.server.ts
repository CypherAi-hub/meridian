import { getSql, ensureDbReady } from "../db";
import {
  advanceSniper,
  newSniper,
  sniperMetrics,
  sniperRejects,
  sniperExperiment,
  SNIPER_EXPERIMENTS,
  type SniperState,
  type SwapRequest,
} from "./sniper.ts";
import { quotePaperSwap } from "./providers/jupiter";
import type { TokenSnapshot } from "./schema.ts";

const SESSION = "paper-sniper-v1";
const LOCK = 13802011;
export async function sniperReport(sessionId = SESSION) {
  const preset = sniperExperiment(sessionId);
  await ensureDbReady();
  const sql = await getSql();
  const rows = await sql.query<{ state: SniperState }>(
    "select state from paper_sniper_sessions where id=$1",
    [sessionId],
  );
  const state = rows[0]?.state ?? newSniper(Date.now(), sessionId);
  return {
    name: preset.name,
    state,
    metrics: sniperMetrics(state, Date.now()),
    initialized: rows.length > 0,
    execution: "PAPER_ONLY",
    discovery: "Public API polling; not first-block detection",
    fillEvidence: "Indicative exact-size quotes with adverse slippage; not submitted transactions",
  };
}
export async function advanceSniperSession(tokens: TokenSnapshot[], sessionId = SESSION) {
  sniperExperiment(sessionId);
  if (process.env.MERIDIAN_WORKER !== "1") return null;
  await ensureDbReady();
  const sql = await getSql();
  // The transaction lock protects one paper book across web/worker processes.
  // Try-lock skips overlapping ticks instead of queueing duplicated quote work.
  return sql.transaction(async (tx) => {
    const [lock] = await tx.query<{ acquired: boolean }>(
      "select pg_try_advisory_xact_lock($1) as acquired",
      [LOCK],
    );
    if (!lock.acquired) return null;
    const rows = await tx.query<{ state: SniperState }>(
      "select state from paper_sniper_sessions where id=$1",
      [sessionId],
    );
    const prior = rows[0]?.state ?? newSniper(Date.now(), sessionId);
    const observedAt = Date.now();
    const evidence: Array<{
      request: SwapRequest;
      response: unknown;
      error: string | null;
      requested: number;
      completed: number;
    }> = [];
    const state = await advanceSniper(
      prior,
      tokens,
      observedAt,
      async (request) => {
        const requested = Date.now();
        try {
          const response = await quotePaperSwap(request);
          evidence.push({ request, response, error: null, requested, completed: Date.now() });
          return response;
        } catch (error) {
          evidence.push({
            request,
            response: null,
            error: error instanceof Error ? error.message : String(error),
            requested,
            completed: Date.now(),
          });
          throw error;
        }
      },
      Date.now,
    );
    await tx.query(
      `insert into paper_sniper_sessions(id,state,updated_at) values($1,$2::jsonb,now())
      on conflict(id) do update set state=excluded.state,updated_at=excluded.updated_at`,
      [sessionId, JSON.stringify(state)],
    );
    if (tokens.length && sessionId === SESSION)
      await tx.query(
        `insert into paper_sniper_observations(session_id,mint,observed_at_ms,snapshot,rejects,eligible)
      select $1, x.mint, $2, x.snapshot, x.rejects, x.eligible from jsonb_to_recordset($3::jsonb)
      as x(mint text,snapshot jsonb,rejects jsonb,eligible boolean)`,
        [
          sessionId,
          observedAt,
          JSON.stringify(
            tokens.map((t) => {
              const rejects = sniperRejects(t, observedAt, state.config);
              return { mint: t.address, snapshot: t, rejects, eligible: rejects.length === 0 };
            }),
          ),
        ],
      );
    for (const e of evidence)
      await tx.query(
        `insert into paper_sniper_quotes(session_id,requested_at_ms,completed_at_ms,request,response,error) values($1,$2,$3,$4::jsonb,$5::jsonb,$6)`,
        [
          sessionId,
          e.requested,
          e.completed,
          JSON.stringify(e.request),
          JSON.stringify(e.response),
          e.error,
        ],
      );
    return state;
  });
}
export async function controlSniper(enabled: boolean, sessionId = SESSION) {
  sniperExperiment(sessionId);
  await ensureDbReady();
  const sql = await getSql();
  return sql.transaction(async (tx) => {
    await tx.query("select pg_advisory_xact_lock($1)", [LOCK]);
    const rows = await tx.query<{ state: SniperState }>(
      "select state from paper_sniper_sessions where id=$1",
      [sessionId],
    );
    const state = rows[0]?.state ?? newSniper(Date.now(), sessionId);
    state.enabled = enabled;
    await tx.query(
      `insert into paper_sniper_sessions(id,state,updated_at) values($1,$2::jsonb,now()) on conflict(id) do update set state=excluded.state,updated_at=excluded.updated_at`,
      [sessionId, JSON.stringify(state)],
    );
    return { enabled };
  });
}
export async function sniperWatchMints() {
  const reports = await Promise.all(SNIPER_EXPERIMENTS.map((p) => sniperReport(p.id)));
  return [
    ...new Set(
      reports.flatMap(({ state }) =>
        state.trades
          .filter((t) => t.status === "open" || t.status === "pending")
          .map((t) => t.mint),
      ),
    ),
  ];
}
export async function sniperSuiteReport() {
  return Promise.all(SNIPER_EXPERIMENTS.map((p) => sniperReport(p.id)));
}
export async function advanceSniperSuite(tokens: TokenSnapshot[]) {
  // Rotate equal-priority experiments to avoid permanently giving one the quote budget.
  const offset = Math.floor(Date.now() / 10000) % SNIPER_EXPERIMENTS.length;
  const order = [...SNIPER_EXPERIMENTS.slice(offset), ...SNIPER_EXPERIMENTS.slice(0, offset)];
  const openBooks = new Set(
    (await sniperSuiteReport())
      .filter((r) => r.state.trades.some((t) => t.status === "open"))
      .map((r) => r.state.experimentId ?? SESSION),
  );
  order.sort((a, b) => Number(openBooks.has(b.id)) - Number(openBooks.has(a.id)));
  const results = [];
  for (const preset of order) results.push(await advanceSniperSession(tokens, preset.id));
  return results;
}

export async function sniperCoverage() {
  await ensureDbReady();
  const sql = await getSql();
  const totals = await sql.query(
    `select count(*)::int as observations,count(distinct mint)::int as tokens,
    count(distinct mint) filter(where eligible)::int as eligible_tokens,
    min(observed_at_ms) as first_observed_at,max(observed_at_ms) as last_observed_at
    from paper_sniper_observations where session_id=$1`,
    [SESSION],
  );
  const rejects = await sql.query(
    `with latest as (
    select distinct on(mint) mint,rejects from paper_sniper_observations where session_id=$1 order by mint,observed_at_ms desc,id desc
  ) select reason,count(*)::int as tokens from latest cross join lateral jsonb_array_elements_text(rejects) as reason group by reason order by tokens desc`,
    [SESSION],
  );
  const nearMisses = await sql.query(
    `select mint,snapshot->>'symbol' as symbol,
    (snapshot->'liquidityUsd'->>'value')::double precision as liquidity_usd,
    (snapshot->'volume5mUsd'->>'value')::double precision as volume_5m_usd,rejects,observed_at_ms
    from (select distinct on(mint) * from paper_sniper_observations where session_id=$1 order by mint,observed_at_ms desc,id desc) latest
    order by jsonb_array_length(rejects),observed_at_ms desc limit 10`,
    [SESSION],
  );
  return {
    coverageStart:
      "Observation audit began with migration 0013; older rejected snapshots were not reconstructed",
    totals: totals[0],
    latestRejections: rejects,
    nearMisses,
  };
}

export async function controlSniperSuite(enabled: boolean) {
  for (const preset of SNIPER_EXPERIMENTS) await controlSniper(enabled, preset.id);
  return { enabled, scope: "all", experiments: SNIPER_EXPERIMENTS.length };
}

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dbSource, getSql, type Sql } from "@/lib/db";
import { START_EQUITY, STRATEGY_VERSION } from "./schema";
import { createDesk, emptyDesk } from "./engine";
import { rebuildSummary } from "./ledger";
import { STRATEGIES } from "./strategies";
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
    const ok = await insertConsideration(sql, row, dump.desk);
    if (!ok) continue;
    await upsertLabels(sql, row);
  }
}

export async function loadDesk(): Promise<DeskSnapshot> {
  const sql = await ensureDeskState();
  const st = (
    await sql.query<Record<string, unknown>>("select * from desk_state where id = 1")
  )[0];
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
  return {
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
    rug_detected: labels.rug_detected == null ? snap.rug_detected : Boolean(labels.rug_detected),
    simulated_entry: labels.simulated_entry == null ? snap.simulated_entry : num(labels.simulated_entry),
    simulated_exit: labels.simulated_exit == null ? snap.simulated_exit : num(labels.simulated_exit),
    net_execution_return:
      labels.net_execution_return == null ? snap.net_execution_return : num(labels.net_execution_return),
    labels_complete: Boolean(labels.labels_complete ?? snap.labels_complete),
  };
}

function workerFromState(
  st: Record<string, unknown>,
  pending: number,
  extra?: { providerErrors: number; lastProviderOkAt: number | null },
): WorkerHealth {
  const lastTick = st.last_tick_at_ms ? num(st.last_tick_at_ms) : null;
  const lastError = (st.last_error as string) || null;
  const stale = !lastTick || Date.now() - lastTick > 45_000;
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
  };
}

export async function loadResearch(sql?: Sql): Promise<ResearchSummary> {
  const db = sql ?? (await getSql());
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

export async function persistDesk(next: DeskSnapshot, prev?: DeskSnapshot) {
  const sql = await getSql();
  const now = Date.now();
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
    await sql.query(
      `insert into tokens (mint, symbol, name, decimals, pair_address, created_at_ms, last_seen_at_ms, last_considered_at_ms)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (mint) do update set
         symbol = excluded.symbol, name = excluded.name, pair_address = excluded.pair_address,
         last_seen_at_ms = excluded.last_seen_at_ms,
         last_considered_at_ms = coalesce(excluded.last_considered_at_ms, tokens.last_considered_at_ms)`,
      [
        t.address,
        t.symbol,
        t.name,
        t.decimals,
        t.pairAddress,
        t.createdAt,
        now,
        next.lastConsidered[t.address] ?? null,
      ],
    );
    await sql.query(
      `insert into market_observations (mint, observed_at_ms, price, liquidity, volume_5m, sell_route, payload)
       values ($1,$2,$3,$4,$5,$6,$7::jsonb)
       on conflict (mint, observed_at_ms) do nothing`,
      [
        t.address,
        next.lastTapeAt ?? now,
        t.priceUsd.value,
        t.liquidityUsd.value,
        t.volume5mUsd.value,
        Boolean(t.sellQuote?.available),
        JSON.stringify({
          price: t.priceUsd,
          liquidity: t.liquidityUsd,
          volume5m: t.volume5mUsd,
          buys: t.buys5m,
          sells: t.sells5m,
          uniqueBuyers: t.uniqueBuyers5m,
          mint: t.mintAuth,
          freeze: t.freezeAuth,
          top10: t.top10Pct,
          sell: t.sellQuote,
        }),
      ],
    );
  }
  await sql.query("delete from market_observations where observed_at_ms < $1", [now - 6 * 3600_000]);

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
  }

  if (!prev || prev.regime !== next.regime) {
    await sql.query(
      `insert into regime_history (at_ms, regime, p_mania, p_trend, p_chop, p_risk_off)
       values ($1,$2,$3,$4,$5,$6)`,
      [
        now,
        next.regime,
        next.regimeP.meme_mania,
        next.regimeP.trend,
        next.regimeP.chop,
        next.regimeP.risk_off,
      ],
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

  for (const row of uniq.values()) {
    const isNew = !seen.has(row.decision_id) && !prevLedger.has(row.decision_id);
    if (isNew) {
      const ok = await insertConsideration(sql, row, next);
      if (!ok) continue;
    }
    await upsertLabels(sql, row);
  }

  if (now - (prev?.now ?? 0) > 50_000) {
    await sql.query(
      `insert into portfolio_snapshots (taken_at_ms, cash, equity, day_pnl, open_positions, regime)
       values ($1,$2,$3,$4,$5,$6)`,
      [now, next.cash, next.equity, next.dayPnl, next.positions.length, next.regime],
    );
  }

  if (dbSource === "pglite") await writeDump(sql, next);
}

async function insertConsideration(sql: Sql, row: LedgerRow, desk: DeskSnapshot): Promise<boolean> {
  const cooldown = `${row.tokenAddress}:${row.strategy_version}:${Math.floor(row.decision_time / 20_000)}`;
  const inserted = await sql.query<{ decision_id: string }>(
    `insert into candidate_considerations (
      decision_id, decision_time_ms, mint, symbol, bucket, regime, strategy_id, strategy_version,
      governor_result, trade_action, trade_taken, veto_reason, proposed_size, cooldown_key, labels_complete
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,false)
    on conflict (mint, strategy_version, cooldown_key) do nothing
    returning decision_id`,
    [
      row.decision_id,
      row.decision_time,
      row.tokenAddress,
      row.token,
      row.bucket,
      row.regime,
      row.strategy_id,
      row.strategy_version,
      row.governor_result,
      row.trade_action,
      row.trade_taken,
      row.veto_reason,
      row.proposed_size,
      cooldown,
    ],
  );
  if (!inserted.length) return false;
  const frozen = { ...row, path: (row.path ?? []).slice(0, 1) };
  await sql.query(
    `insert into decision_snapshots (decision_id, snapshot, created_at_ms) values ($1, $2::jsonb, $3) on conflict do nothing`,
    [row.decision_id, JSON.stringify(frozen), row.decision_time],
  );
  const layers = row.gates ?? [];
  for (const g of layers) {
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
        fid,
        oid,
        row.decision_id,
        row.tokenAddress,
        row.proposed_size / row.simulated_entry,
        row.simulated_entry,
        row.proposed_size,
        row.proposed_size * 0.0025,
        row.entry_impact,
        desk.slippageBps,
        row.feature_sources?.exitQuote?.source ?? "jupiter",
        row.decision_time,
      ],
    );
  }
  return true;
}

async function upsertLabels(sql: Sql, row: LedgerRow) {
  const path = row.labels_complete ? [] : row.path ?? [];
  await sql.query(
    `insert into outcome_labels (
      decision_id, path, price_after_1m, price_after_5m, price_after_15m, price_after_30m, price_after_1h,
      max_gain_5m, max_gain_15m, max_gain_1h, max_drawdown_5m, max_drawdown_15m, max_drawdown_1h,
      hit_plus_10_before_minus_10, hit_plus_20_before_minus_10, liquidity_collapse, sell_route_lost, rug_detected,
      simulated_entry, simulated_exit, net_execution_return, labels_complete, updated_at_ms
    ) values (
      $1,$2::jsonb,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23
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
      labels_complete = outcome_labels.labels_complete or excluded.labels_complete,
      updated_at_ms = excluded.updated_at_ms`,
    [
      row.decision_id,
      JSON.stringify(path),
      row.price_after_1m,
      row.price_after_5m,
      row.price_after_15m,
      row.price_after_30m,
      row.price_after_1h,
      row.max_gain_5m,
      row.max_gain_15m,
      row.max_gain_1h,
      row.max_drawdown_5m,
      row.max_drawdown_15m,
      row.max_drawdown_1h,
      row.hit_plus_10_before_minus_10,
      row.hit_plus_20_before_minus_10,
      row.liquidity_collapse,
      row.sell_route_lost,
      row.rug_detected,
      row.simulated_entry,
      row.simulated_exit,
      row.net_execution_return,
      row.labels_complete,
      Date.now(),
    ],
  );
  if (row.labels_complete) {
    await sql.query(`update candidate_considerations set labels_complete = true where decision_id = $1`, [
      row.decision_id,
    ]);
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
      `update desk_state set
        cash = start_equity, equity = start_equity, halted = false, fills = 0, win_count = 0, loss_count = 0
       where id = 1`,
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
  const rows = await sql.query<{ snapshot: unknown; labels: unknown }>(
    `select s.snapshot, to_jsonb(o) as labels
     from candidate_considerations c
     join decision_snapshots s on s.decision_id = c.decision_id
     left join outcome_labels o on o.decision_id = c.decision_id
     order by c.decision_time_ms asc
     limit 50000`,
  );
  return rows.map((r) => {
    const snap = json<LedgerRow>(r.snapshot, {} as LedgerRow);
    const merged = mergeRow(snap, json(r.labels, {}));
    merged.path = [];
    return merged;
  });
}

export function rowsToCsv(rows: LedgerRow[]) {
  const cols = [
    "decision_id",
    "decision_time",
    "event_time",
    "ingested_at",
    "token",
    "tokenAddress",
    "pair_address",
    "token_age",
    "bucket",
    "price",
    "market_cap",
    "liquidity",
    "volume_1m",
    "volume_5m",
    "volume_acceleration",
    "buy_sell_imbalance",
    "unique_buyers",
    "unique_sellers",
    "holder_count",
    "holder_concentration",
    "mint_auth",
    "freeze_auth",
    "entry_impact",
    "exit_impact",
    "stressed_exit",
    "momentum_score",
    "flow_score",
    "safety_score",
    "edge_score",
    "regime",
    "strategy_id",
    "strategy_version",
    "governor_result",
    "veto_reason",
    "proposed_size",
    "proposed_entry",
    "proposed_stop",
    "trade_taken",
    "trade_action",
    "sell_quote_available",
    "price_after_1m",
    "price_after_5m",
    "price_after_15m",
    "price_after_30m",
    "price_after_1h",
    "max_gain_5m",
    "max_gain_15m",
    "max_gain_1h",
    "max_drawdown_5m",
    "max_drawdown_15m",
    "max_drawdown_1h",
    "hit_plus_10_before_minus_10",
    "hit_plus_20_before_minus_10",
    "liquidity_collapse",
    "sell_route_lost",
    "rug_detected",
    "simulated_entry",
    "simulated_exit",
    "net_execution_return",
    "labels_complete",
    "outcome",
  ] as const;
  const extra = ["gates", "feature_sources", "features"] as const;
  const esc = (v: unknown) => {
    const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const header = [...cols, ...extra].join(",");
  return [
    header,
    ...rows.map((r) =>
      [...cols.map((c) => esc(r[c])), extra.map((c) => esc(r[c]))].flat().join(","),
    ),
  ].join("\n");
}

function slimRow(r: LedgerRow): LedgerRow {
  return {
    ...r,
    path: r.labels_complete ? [] : (r.path ?? []).slice(-40),
  };
}

async function writeDump(sql: Sql, s: DeskSnapshot) {
  try {
    await mkdir("/workspace/data", { recursive: true });
    const pending = await sql.query<{ snapshot: unknown; labels: unknown }>(
      `select s.snapshot, to_jsonb(o) as labels
       from outcome_labels o
       join decision_snapshots s on s.decision_id = o.decision_id
       where o.labels_complete = false
       order by o.updated_at_ms desc
       limit 2500`,
    );
    const done = await sql.query<{ snapshot: unknown; labels: unknown }>(
      `select s.snapshot, to_jsonb(o) as labels
       from candidate_considerations c
       join decision_snapshots s on s.decision_id = c.decision_id
       left join outcome_labels o on o.decision_id = c.decision_id
       where coalesce(o.labels_complete, false) = true
       order by c.decision_time_ms desc
       limit 8000`,
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
    const dump: DumpFile = { v: 325, savedAt: Date.now(), desk, corpus };
    await writeFile(DUMP, JSON.stringify(dump));
  } catch {
    /* vercel has no durable fs; Neon is source of truth there */
  }
}

async function readDump(): Promise<DumpFile | null> {
  try {
    const raw = await readFile(DUMP, "utf8");
    const d = JSON.parse(raw) as DumpFile | DeskSnapshot;
    if (d && typeof d === "object" && "v" in d && (d as DumpFile).v === 325) {
      const file = d as DumpFile;
      return {
        v: 325,
        savedAt: file.savedAt,
        desk: { ...emptyDesk(), ...file.desk },
        corpus: file.corpus ?? [],
      };
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
  return getSql().then((sql) =>
    sql.query(`update desk_state set last_error = $1 where id = 1`, [message]),
  );
}

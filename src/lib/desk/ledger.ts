import { bucketOf, type UniverseBucket } from "./buckets.ts";
import { paperFillFromQuote } from "./governor.ts";
import { LEDGER_ARCHIVE_MAX, LEDGER_MEMORY, STRATEGY_VERSION } from "./schema.ts";
import { FEATURE_ENGINE_VERSION, LABEL_DEFINITION_VERSION } from "./versions.ts";
import { stampResearchQuality } from "./labels.ts";
import { freezeHolderAtDecision } from "./holder-at-decision.ts";
import type {
  Intent,
  LedgerRow,
  Regime,
  ResearchSummary,
  SliceStats,
  TokenLive,
} from "./types";

const DB_NAME = "meridian-research-v32";
const STORE = "obs";
const META = "meta";
const LEGACY_KEY = "meridian-ledger-v31";

function emptySlice(): SliceStats {
  return { n: 0, taken: 0, labeled: 0, sum5m: 0, n5m: 0, sumNet: 0, nNet: 0 };
}

function emptyCoverage(): ResearchSummary["coverage"] {
  const regimes: Regime[] = ["meme_mania", "trend", "chop", "risk_off"];
  const buckets: UniverseBucket[] = ["new_launch", "early", "emerging", "established", "mature", "unknown"];
  const coverage = {} as ResearchSummary["coverage"];
  for (const b of buckets) {
    coverage[b] = { meme_mania: 0, trend: 0, chop: 0, risk_off: 0 };
    for (const r of regimes) coverage[b][r] = 0;
  }
  return coverage;
}

export function emptyResearch(): ResearchSummary {
  return {
    considerations: 0,
    vetoed: 0,
    authorized: 0,
    taken: 0,
    labeled: 0,
    incomplete: 0,
    errors: 0,
    byRegime: {
      meme_mania: emptySlice(),
      trend: emptySlice(),
      chop: emptySlice(),
      risk_off: emptySlice(),
    },
    byBucket: {
      new_launch: emptySlice(),
      early: emptySlice(),
      emerging: emptySlice(),
      established: emptySlice(),
      mature: emptySlice(),
      unknown: emptySlice(),
    },
    byStrategy: {},
    coverage: emptyCoverage(),
  };
}

export function intentToLedger(intent: Intent, taken: boolean, slipBps: number): LedgerRow {
  const f = intent.features;
  const p = intent.predictions;
  const s = intent.snapshot;
  const mid = s.priceUsd.value;
  const simEntry =
    mid != null
      ? paperFillFromQuote(mid, s.buyQuote, slipBps, "buy", intent.governor.entryImpactPct)
      : null;
  const bucket = f.bucket ?? bucketOf(f.tokenAgeS);
  const frozenHolder = freezeHolderAtDecision({
    decisionTime: intent.decisionTs,
    snapshot: s,
    tokenAgeS: f.tokenAgeS,
  });
  const row: LedgerRow = {
    decision_id: intent.intentId,
    event_time: s.priceUsd.eventTime,
    ingested_at: s.priceUsd.ingestedAt,
    decision_time: intent.decisionTs,
    token: intent.symbol,
    tokenAddress: intent.tokenAddress,
    pair_address: s.pairAddress,
    token_age: f.tokenAgeS,
    bucket,
    price: mid,
    market_cap: s.mcapUsd.value,
    liquidity: s.liquidityUsd.value,
    volume_1m: s.volume1mUsd.value,
    volume_5m: s.volume5mUsd.value,
    volume_acceleration: f.volAccel,
    buy_sell_imbalance: f.usdImbalance,
    unique_buyers: s.uniqueBuyers5m.value,
    unique_sellers: s.uniqueSellers5m.value,
    holder_count: frozenHolder.holders,
    holder_concentration: frozenHolder.concentration,
    holder_status: frozenHolder.status,
    holder_source: frozenHolder.source,
    holder_event_time: frozenHolder.eventTime,
    holder_ingested_at: frozenHolder.ingestedAt,
    mint_auth: f.mintAuth,
    freeze_auth: f.freezeAuth,
    entry_impact: intent.governor.entryImpactPct,
    exit_impact: intent.governor.exitImpactPct,
    stressed_exit: intent.governor.stressedExitPct,
    momentum_score: p.momentumScore,
    flow_score: p.flowScore,
    safety_score: p.safetyScore,
    edge_score: p.edgeScore,
    regime: intent.regime,
    strategy_id: intent.strategyId,
    strategy_version: STRATEGY_VERSION,
    governor_result: intent.governor.approved ? "authorized" : "vetoed",
    veto_reason: intent.governor.approved ? "TRADE AUTHORIZED" : intent.governor.reasons[0] ?? "veto",
    proposed_size: intent.governor.sizedUsd,
    proposed_entry: mid,
    proposed_stop: mid != null ? mid * (1 - p.maeQ90) : null,
    trade_taken: taken,
    trade_action: taken ? "take" : intent.governor.approved ? "ignore" : "veto",
    sell_quote_available: Boolean(s.sellQuote?.available),
    route_status: s.sellQuote?.routeState ?? (s.sellQuote?.available ? "ROUTABLE" : s.sellQuote ? "NO_ROUTE" : "UNKNOWN"),
    feature_engine_version: FEATURE_ENGINE_VERSION,
    label_definition_version: LABEL_DEFINITION_VERSION,
    veto_reason_code: intent.governor.reasonCodes[0] ?? (intent.governor.approved ? "TRADE_AUTHORIZED" : "VETO"),
    research_quality_score: null,
    research_grade: null,
    provider_disagreement: Boolean(f.priceDisagreement != null && f.priceDisagreement > 0.03),
    barrier_10_outcome: null,
    barrier_20_outcome: null,
    barrier_label_confidence: null,
    max_path_gap_seconds: null,
    avg_path_gap_seconds: null,
    path_sample_count: null,
    feature_sources: intent.featureMeta,
    features: f,
    gates: intent.governor.layers,
    path:
      mid != null
        ? [
            {
              ts: intent.decisionTs,
              px: mid,
              liq: s.liquidityUsd.value ?? 0,
              sell: s.sellQuote?.available ? 1 : 0,
            },
          ]
        : [],
    price_after_1m: null,
    price_after_5m: null,
    price_after_15m: null,
    price_after_30m: null,
    price_after_1h: null,
    max_gain_5m: null,
    max_gain_15m: null,
    max_gain_1h: null,
    max_drawdown_5m: null,
    max_drawdown_15m: null,
    max_drawdown_1h: null,
    hit_plus_10_before_minus_10: null,
    hit_plus_20_before_minus_10: null,
    liquidity_collapse: null,
    sell_route_lost: null,
    rug_detected: null,
    simulated_entry: simEntry,
    simulated_exit: null,
    theoretical_return: null,
    net_execution_return: null,
    execution_adjusted_return: null,
    mfe_1m: null,
    mfe_30m: null,
    mae_1m: null,
    mae_30m: null,
    first_sell_route_loss_at: null,
    sell_route_restored_at: null,
    labels_complete: false,
    outcome: taken ? "open" : "not_taken",
  };
  stampResearchQuality(row);
  return row;
}

export function noteRow(summary: ResearchSummary, row: LedgerRow, prev?: LedgerRow | null) {
  const next = cloneSummary(summary);
  if (!prev) {
    next.considerations += 1;
    next.incomplete += 1;
    if (row.governor_result === "vetoed") next.vetoed += 1;
    else next.authorized += 1;
    if (row.trade_taken) next.taken += 1;
    bumpSlice(next.byRegime[row.regime], row, "new");
    bumpSlice(next.byBucket[row.bucket], row, "new");
    if (!next.byStrategy[row.strategy_id]) next.byStrategy[row.strategy_id] = emptySlice();
    bumpSlice(next.byStrategy[row.strategy_id], row, "new");
    if (next.coverage[row.bucket] && next.coverage[row.bucket][row.regime] != null) {
      next.coverage[row.bucket][row.regime] += 1;
    }
  }
  const wasDone = Boolean(prev?.labels_complete);
  if (row.labels_complete && !wasDone) {
    next.labeled += 1;
    next.incomplete = Math.max(0, next.incomplete - 1);
    bumpSlice(next.byRegime[row.regime], row, "label");
    bumpSlice(next.byBucket[row.bucket], row, "label");
    if (!next.byStrategy[row.strategy_id]) next.byStrategy[row.strategy_id] = emptySlice();
    bumpSlice(next.byStrategy[row.strategy_id], row, "label");
  }
  return next;
}

function bumpSlice(s: SliceStats, row: LedgerRow, kind: "new" | "label") {
  if (kind === "new") {
    s.n += 1;
    if (row.trade_taken) s.taken += 1;
    return;
  }
  s.labeled += 1;
  if (row.price && row.price_after_5m) {
    s.sum5m += row.price_after_5m / row.price - 1;
    s.n5m += 1;
  }
  if (row.net_execution_return != null) {
    s.sumNet += row.net_execution_return;
    s.nNet += 1;
  }
}

export function cloneSummary(s: ResearchSummary): ResearchSummary {
  const copySlice = (x: SliceStats): SliceStats => ({ ...x });
  const byRegime = {} as ResearchSummary["byRegime"];
  for (const k of Object.keys(s.byRegime) as Regime[]) byRegime[k] = copySlice(s.byRegime[k]);
  const byBucket = {} as ResearchSummary["byBucket"];
  for (const k of Object.keys(s.byBucket) as UniverseBucket[]) byBucket[k] = copySlice(s.byBucket[k]);
  const byStrategy: ResearchSummary["byStrategy"] = {};
  for (const k of Object.keys(s.byStrategy ?? {})) byStrategy[k] = copySlice(s.byStrategy[k]);
  const coverage = emptyCoverage();
  for (const b of Object.keys(s.coverage ?? {}) as UniverseBucket[]) {
    coverage[b] = { ...coverage[b], ...(s.coverage[b] ?? {}) };
  }
  return { ...s, errors: s.errors ?? 0, byRegime, byBucket, byStrategy, coverage };
}

export function meanOf(sum: number, n: number) {
  return n > 0 ? sum / n : null;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const st = db.createObjectStore(STORE, { keyPath: "decision_id" });
        st.createIndex("ts", "decision_time");
        st.createIndex("done", "labels_complete");
      }
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function persistRows(rows: LedgerRow[], summary: ResearchSummary) {
  if (typeof indexedDB === "undefined") return;
  const db = await openDb();
  const tx = db.transaction([STORE, META], "readwrite");
  const obs = tx.objectStore(STORE);
  for (const r of rows) obs.put(r);
  tx.objectStore(META).put(summary, "summary");
  await txDone(tx);
  void trimArchive(db);
}

async function trimArchive(db: IDBDatabase) {
  const tx = db.transaction(STORE, "readwrite");
  const st = tx.objectStore(STORE);
  const count = await new Promise<number>((resolve, reject) => {
    const r = st.count();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  if (count <= LEDGER_ARCHIVE_MAX) {
    await txDone(tx);
    return;
  }
  const extra = count - LEDGER_ARCHIVE_MAX;
  const idx = st.index("ts");
  let removed = 0;
  await new Promise<void>((resolve, reject) => {
    const cur = idx.openCursor();
    cur.onerror = () => reject(cur.error);
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c || removed >= extra) {
        resolve();
        return;
      }
      const row = c.value as LedgerRow;
      if (row.labels_complete) {
        c.delete();
        removed += 1;
      }
      c.continue();
    };
  });
  await txDone(tx);
}

export async function loadArchive(): Promise<{ recent: LedgerRow[]; pending: LedgerRow[]; summary: ResearchSummary }> {
  if (typeof indexedDB === "undefined") {
    return { recent: migrateLegacy(), pending: [], summary: emptyResearch() };
  }
  try {
    const db = await openDb();
    const tx = db.transaction([STORE, META], "readonly");
    const obs = tx.objectStore(STORE);
    const all = await new Promise<LedgerRow[]>((resolve, reject) => {
      const r = obs.getAll();
      r.onsuccess = () => resolve(r.result as LedgerRow[]);
      r.onerror = () => reject(r.error);
    });
    const summaryRaw = await new Promise<ResearchSummary | undefined>((resolve, reject) => {
      const r = tx.objectStore(META).get("summary");
      r.onsuccess = () => resolve(r.result as ResearchSummary | undefined);
      r.onerror = () => reject(r.error);
    });
    await txDone(tx);
    const sorted = all.sort((a, b) => b.decision_time - a.decision_time);
    const pending = sorted.filter((r) => !r.labels_complete).slice(0, 2500);
    const recent = sorted.slice(0, LEDGER_MEMORY);
    const summary = summaryRaw ?? rebuildSummary(sorted);
    if (!all.length) {
      const legacy = migrateLegacy();
      if (legacy.length) {
        const rebuilt = rebuildSummary(legacy);
        void persistRows(legacy, rebuilt);
        return {
          recent: legacy.slice(0, LEDGER_MEMORY),
          pending: legacy.filter((r) => !r.labels_complete),
          summary: rebuilt,
        };
      }
    }
    return { recent, pending, summary };
  } catch {
    return { recent: migrateLegacy(), pending: [], summary: emptyResearch() };
  }
}

export function rebuildSummary(rows: LedgerRow[]): ResearchSummary {
  let s = emptyResearch();
  for (const r of rows) {
    s = noteRow(s, { ...r, labels_complete: false });
    if (r.labels_complete) s = noteRow(s, r, { ...r, labels_complete: false });
  }
  return s;
}

export async function exportArchive(): Promise<LedgerRow[]> {
  if (typeof indexedDB === "undefined") return [];
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  const rows = await new Promise<LedgerRow[]>((resolve, reject) => {
    const r = tx.objectStore(STORE).getAll();
    r.onsuccess = () => resolve((r.result as LedgerRow[]) ?? []);
    r.onerror = () => reject(r.error);
  });
  await txDone(tx);
  return rows.sort((a, b) => a.decision_time - b.decision_time);
}

function migrateLegacy(): LedgerRow[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(LEGACY_KEY);
    if (!raw) return [];
    const old = JSON.parse(raw) as Array<Partial<LedgerRow> & { timestamp?: number }>;
    return old.map((r) => {
      const ts = r.decision_time ?? r.timestamp ?? Date.now();
      const age = r.token_age ?? null;
      return {
        ...emptyRowStub(),
        ...r,
        decision_id: r.decision_id ?? `${ts}`,
        decision_time: ts,
        event_time: r.event_time ?? ts,
        ingested_at: r.ingested_at ?? ts,
        bucket: r.bucket ?? bucketOf(age),
        strategy_id: r.strategy_id ?? r.strategy_version ?? "unknown",
        strategy_version: STRATEGY_VERSION,
        veto_reason: r.veto_reason ?? (r as { governor_reason?: string }).governor_reason ?? "",
        trade_action: r.trade_taken ? "take" : r.governor_result === "authorized" ? "ignore" : "veto",
        labels_complete: Boolean(r.price_after_1h),
        path: r.path ?? [],
      } as LedgerRow;
    });
  } catch {
    return [];
  }
}

function emptyRowStub(): Partial<LedgerRow> {
  return {
    pair_address: "",
    volume_acceleration: 0,
    buy_sell_imbalance: 0,
    unique_buyers: null,
    unique_sellers: null,
    holder_count: null,
    mint_auth: null,
    freeze_auth: null,
    entry_impact: null,
    exit_impact: null,
    stressed_exit: 0,
    sell_quote_available: false,
    route_status: "UNKNOWN",
    feature_engine_version: FEATURE_ENGINE_VERSION,
    label_definition_version: LABEL_DEFINITION_VERSION,
    veto_reason_code: "",
    research_quality_score: null,
    research_grade: null,
    provider_disagreement: false,
    barrier_10_outcome: null,
    barrier_20_outcome: null,
    barrier_label_confidence: null,
    max_path_gap_seconds: null,
    avg_path_gap_seconds: null,
    path_sample_count: null,
    feature_sources: {},
    gates: [],
    path: [],
    price_after_1m: null,
    price_after_5m: null,
    price_after_15m: null,
    price_after_30m: null,
    price_after_1h: null,
    max_gain_5m: null,
    max_gain_15m: null,
    max_gain_1h: null,
    max_drawdown_5m: null,
    max_drawdown_15m: null,
    max_drawdown_1h: null,
    hit_plus_10_before_minus_10: null,
    hit_plus_20_before_minus_10: null,
    liquidity_collapse: null,
    sell_route_lost: null,
    rug_detected: null,
    simulated_entry: null,
    simulated_exit: null,
    theoretical_return: null,
    net_execution_return: null,
    execution_adjusted_return: null,
    mfe_1m: null,
    mfe_30m: null,
    mae_1m: null,
    mae_30m: null,
    first_sell_route_loss_at: null,
    sell_route_restored_at: null,
    labels_complete: false,
  };
}

export function mergeRecent(recent: LedgerRow[], pending: LedgerRow[]): LedgerRow[] {
  const map = new Map<string, LedgerRow>();
  for (const r of recent) map.set(r.decision_id, r);
  for (const r of pending) map.set(r.decision_id, r);
  return [...map.values()].sort((a, b) => b.decision_time - a.decision_time).slice(0, LEDGER_MEMORY);
}

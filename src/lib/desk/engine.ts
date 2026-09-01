import { isResearchBucket } from "./buckets";
import { computeFeatures, predict } from "./features";
import { govern, paperFillFromQuote } from "./governor";
import { labelPending } from "./labels";
import { emptyResearch, intentToLedger, mergeRecent, noteRow } from "./ledger";
import { CONSIDER_COOLDOWN_MS, LEDGER_PENDING_MAX, START_EQUITY } from "./schema";
import { strategyForRegime, strategyMatches } from "./strategies";
import type {
  DeskSnapshot,
  Intent,
  JournalEvent,
  LedgerRow,
  MarketTape,
  Position,
  Regime,
  TokenLive,
} from "./types";

export const TICK_MS = 900;
const HISTORY = 48;

function uid() {
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function pushJournal(s: DeskSnapshot, e: Omit<JournalEvent, "id" | "ts">) {
  s.journal = [{ id: uid(), ts: s.now, ...e }, ...s.journal].slice(0, 80);
}

function detectRegime(tokens: TokenLive[], solRet: number): {
  regime: Regime;
  p: Record<Regime, number>;
} {
  const alive = tokens.filter((t) => !t.rugged);
  const up = alive.filter((t) => (t.history.at(-1) ?? 0) >= (t.history.at(-6) ?? 0)).length;
  const breadth = up / Math.max(alive.length, 1);
  const vol = alive.reduce((a, t) => a + (t.volume5mUsd.value ?? 0), 0);
  const mania = Math.min(1, 0.12 + breadth * 0.5 + (vol > 40_000 ? 0.18 : 0) + solRet * 2);
  const risk = Math.min(1, 0.08 - solRet * 2);
  const chop = Math.min(0.55, 0.22 + Math.abs(breadth - 0.5) * 0.2);
  const trend = Math.max(0.05, 1 - mania - risk - chop);
  const sum = mania + trend + chop + risk;
  const p = {
    meme_mania: mania / sum,
    trend: trend / sum,
    chop: chop / sum,
    risk_off: risk / sum,
  };
  const regime = (Object.entries(p) as [Regime, number][]).sort((a, b) => b[1] - a[1])[0][0];
  return { regime, p };
}

export function emptyDesk(): DeskSnapshot {
  return {
    now: 0,
    running: true,
    halted: false,
    equity: START_EQUITY,
    cash: START_EQUITY,
    startEquity: START_EQUITY,
    dayPnl: 0,
    regime: "chop",
    regimeP: { meme_mania: 0.2, trend: 0.25, chop: 0.45, risk_off: 0.1 },
    solPrice: 0,
    solRet5m: 0,
    feedLagMs: 0,
    tokens: [],
    selected: null,
    positions: [],
    journal: [],
    rejects: [],
    lastIntent: null,
    fills: 0,
    winCount: 0,
    lossCount: 0,
    riskBps: 25,
    maxPositions: 4,
    slippageBps: 50,
    sources: [],
    tapeAgeMs: 0,
    lastTapeAt: null,
    realData: false,
    ledger: [],
    pending: [],
    research: emptyResearch(),
    lastConsidered: {},
    flushQueue: [],
    worker: {
      status: "starting",
      db: "pglite",
      uptimeMs: 0,
      lastTickAt: null,
      lastMarketEventAt: null,
      lastProviderOkAt: null,
      tickCount: 0,
      queueDepth: 0,
      pendingLabels: 0,
      oldestPendingAt: null,
      providerErrors: 0,
      lastError: null,
    },
  };
}

export function createDesk(): DeskSnapshot {
  const now = Date.now();
  return {
    ...emptyDesk(),
    now,
    journal: [
      {
        id: uid(),
        ts: now,
        kind: "feed",
        title: "Paper desk · persistent engine",
        detail: "Worker writes the warehouse. Closing this page does not stop collection. No wallet.",
      },
    ],
  };
}

function toLive(prev: TokenLive | undefined, snap: MarketTape["tokens"][0]): TokenLive {
  const px = snap.priceUsd.value ?? prev?.history.at(-1) ?? 0;
  const history = prev ? [...prev.history.slice(-HISTORY + 1), px] : [px];
  return {
    ...snap,
    buyQuote: snap.buyQuote ?? prev?.buyQuote ?? null,
    sellQuote: snap.sellQuote ?? prev?.sellQuote ?? null,
    history,
    prevLiq: prev?.liquidityUsd.value ?? snap.liquidityUsd.value ?? 0,
    prevVolume5m: prev?.volume5mUsd.value ?? snap.volume5mUsd.value ?? 0,
    prevBuyers: prev?.uniqueBuyers5m.value ?? snap.uniqueBuyers5m.value ?? 0,
    rugged: (snap.liquidityUsd.value ?? 0) < 800,
  };
}

function cloneDesk(prev: DeskSnapshot): DeskSnapshot {
  return {
    ...prev,
    now: Date.now(),
    positions: prev.positions.map((p) => ({ ...p })),
    journal: prev.journal,
    ledger: prev.ledger,
    pending: prev.pending,
    research: prev.research,
    rejects: prev.rejects,
    lastConsidered: { ...prev.lastConsidered },
    flushQueue: [],
  };
}

export function applyTape(prev: DeskSnapshot, tape: MarketTape): DeskSnapshot {
  const s = cloneDesk(prev);
  const old = new Map(prev.tokens.map((t) => [t.address, t]));
  const incoming = tape.tokens.map((snap) => toLive(old.get(snap.address), snap));
  const firstSeen = incoming.filter((t) => !old.has(t.address)).slice(0, 3);
  s.tokens = incoming;
  s.sources = tape.sources;
  s.lastTapeAt = tape.ingestedAt;
  s.feedLagMs = tape.fetchMs;
  s.tapeAgeMs = 0;
  s.realData = tape.tokens.length > 0;
  if (tape.solPriceUsd) {
    const prevSol = prev.solPrice || tape.solPriceUsd;
    s.solRet5m = Math.log(tape.solPriceUsd / prevSol);
    s.solPrice = tape.solPriceUsd;
  }
  for (const t of firstSeen) {
    pushJournal(s, {
      kind: "listing",
      symbol: t.symbol,
      title: `${t.symbol} on tape`,
      detail: `Liq $${Math.round(t.liquidityUsd.value ?? 0).toLocaleString()} · ${t.priceUsd.source}`,
    });
  }
  if (prev.tokens.length === 0 && incoming.length) {
    s.selected = incoming[0].address;
    pushJournal(s, {
      kind: "feed",
      title: `Tape live · ${incoming.length} names`,
      detail: tape.sources
        .filter((x) => x.status === "live")
        .map((x) => x.id)
        .join(" · "),
    });
  }
  if (s.selected && !s.tokens.some((t) => t.address === s.selected)) {
    s.selected = s.tokens[0]?.address ?? null;
  }
  return decide(markToMarket(s, true));
}

export function step(prev: DeskSnapshot): DeskSnapshot {
  const s = cloneDesk(prev);
  s.tapeAgeMs = prev.lastTapeAt ? Date.now() - prev.lastTapeAt : prev.tapeAgeMs;
  return markToMarket(s, false);
}

function markToMarket(s: DeskSnapshot, label: boolean): DeskSnapshot {
  const { regime, p } = detectRegime(s.tokens, s.solRet5m);
  if (regime !== s.regime && s.tokens.length) {
    pushJournal(s, {
      kind: "regime",
      title: `Regime → ${regime.replaceAll("_", " ")}`,
      detail: `Router switched to ${strategyForRegime(regime).name}.`,
    });
  }
  s.regime = regime;
  s.regimeP = p;

  const byTok = new Map(s.tokens.map((t) => [t.address, t]));
  const kept: Position[] = [];
  for (const pos of s.positions) {
    const t = byTok.get(pos.tokenAddress);
    if (!t || t.priceUsd.value == null) {
      kept.push(pos);
      continue;
    }
    const px = t.priceUsd.value;
    pos.peak = Math.max(pos.peak, px);
    const ret = px / pos.entry - 1;
    const dd = px / pos.peak - 1;
    const age = (s.now - pos.openedAt) / 1000;
    let reason: string | null = null;
    if (t.rugged || (t.sellQuote && !t.sellQuote.available)) reason = "Catastrophic exit";
    else if (ret <= -0.1) reason = "MAE stop";
    else if (ret >= 0.18) reason = "Take profit";
    else if (dd <= -0.09) reason = "Trail";
    else if (age > 240) reason = "Time stop";
    if (reason) {
      const exitPx = paperFillFromQuote(px, t.sellQuote, s.slippageBps, "sell", pos.exitQuoteImpactPct);
      const proceeds = pos.qty * exitPx;
      const pnl = proceeds - pos.notional;
      s.cash += proceeds;
      if (pnl >= 0) s.winCount += 1;
      else s.lossCount += 1;
      s.pending = s.pending.map((row) =>
        row.tokenAddress === pos.tokenAddress && row.outcome === "open" ? { ...row, outcome: reason } : row,
      );
      s.ledger = s.ledger.map((row) =>
        row.tokenAddress === pos.tokenAddress && row.outcome === "open" ? { ...row, outcome: reason } : row,
      );
      pushJournal(s, {
        kind: "exit",
        symbol: pos.symbol,
        title: `${pos.symbol} ${reason}`,
        detail: `Paper sell @ ${exitPx.toPrecision(4)}`,
        pnl,
      });
    } else kept.push(pos);
  }
  s.positions = kept;

  if (label) {
    const before = new Map(s.pending.map((r) => [r.decision_id, r]));
    const updated = labelPending(s.pending, s.tokens, s.now);
    for (const row of updated) {
      const prev = before.get(row.decision_id);
      if (row.labels_complete && prev && !prev.labels_complete) {
        s.research = noteRow(s.research, row, prev);
      }
    }
    s.flushQueue = [...s.flushQueue, ...updated];
    s.ledger = mergeRecent(s.ledger, updated);
    s.pending = updated.filter((r) => !r.labels_complete).slice(0, LEDGER_PENDING_MAX);
  }

  s.equity =
    s.cash +
    s.positions.reduce((a, p) => {
      const t = byTok.get(p.tokenAddress);
      const px = t?.priceUsd.value ?? p.entry;
      return a + p.qty * px;
    }, 0);
  s.dayPnl = s.equity - s.startEquity;

  if ((s.startEquity - s.equity) / s.startEquity > 0.12 && !s.halted) {
    s.halted = true;
    s.running = false;
    pushJournal(s, {
      kind: "halt",
      title: "Drawdown breaker",
      detail: "Intraday loss exceeded 12%. Entries halted.",
    });
  }
  return s;
}

function decide(prev: DeskSnapshot): DeskSnapshot {
  const s = prev;
  const dayDd = Math.max(0, (s.startEquity - s.equity) / s.startEquity);
  if (!s.tokens.length || !s.running || s.halted) return s;

  const def = strategyForRegime(s.regime);
  const held = new Set(s.positions.map((p) => p.tokenAddress));
  const scored = s.tokens
    .filter((t) => !held.has(t.address) && !t.rugged)
    .map((t) => {
      const { features, meta } = computeFeatures(t, s.now);
      const pred = predict(t, features);
      return { t, features, meta, pred, score: pred.edgeScore };
    });

  const research = scored.filter((c) => isResearchBucket(c.features.bucket));
  const pool = research.length ? research : [];
  pool.sort((a, b) => b.score - a.score);

  if (s.running && !s.halted && research.length === 0 && s.tokens.length) {
    const last = s.journal[0];
    if (!last || last.title !== "No research-universe names") {
      pushJournal(s, {
        kind: "feed",
        title: "No research-universe names",
        detail: "Tape has established/mature coins only. New, early, and emerging are the collect set.",
      });
    }
  }

  let placed = false;
  const fresh: LedgerRow[] = [];
  for (const cand of pool) {
    const recently = (s.lastConsidered[cand.t.address] ?? 0) > s.now - CONSIDER_COOLDOWN_MS;
    if (recently) continue;

    const matched = strategyMatches(def, { ...cand.features, ...cand.pred });
    const gov = govern({
      t: cand.t,
      f: cand.features,
      pred: cand.pred,
      equity: s.equity,
      riskBps: s.riskBps,
      openCount: s.positions.length,
      maxPositions: s.maxPositions,
      regime: s.regime,
      strategyId: def.id,
      now: s.now,
      dayDd,
    });
    if (!matched && gov.approved) {
      gov.approved = false;
      gov.reasons = ["Strategy filters"];
      gov.layers = [...gov.layers, { name: "Regime risk", status: "FAIL", reason: "Strategy filters" }];
    }
    const intent: Intent = {
      intentId: uid(),
      tokenAddress: cand.t.address,
      symbol: cand.t.symbol,
      strategyId: def.id,
      decisionTs: s.now,
      features: cand.features,
      featureMeta: cand.meta,
      predictions: cand.pred,
      regime: s.regime,
      governor: gov,
      snapshot: cand.t,
    };
    s.lastIntent = intent;
    s.lastConsidered[cand.t.address] = s.now;

    const canTake = Boolean(s.running && !s.halted && gov.approved && !placed);
    const row = intentToLedger(intent, canTake, s.slippageBps);
    fresh.push(row);
    s.research = noteRow(s.research, row);
    s.pending = [row, ...s.pending].slice(0, LEDGER_PENDING_MAX);
    s.flushQueue = [row, ...s.flushQueue];

    if (!gov.approved) {
      s.rejects = [intent, ...s.rejects].slice(0, 24);
      continue;
    }
    if (!canTake) continue;

    const rawPx = cand.t.priceUsd.value ?? 0;
    const px = paperFillFromQuote(rawPx, cand.t.buyQuote, s.slippageBps, "buy", gov.entryImpactPct);
    const notional = gov.sizedUsd;
    const qty = notional / px;
    s.cash -= notional;
    s.positions.push({
      tokenAddress: cand.t.address,
      symbol: cand.t.symbol,
      strategyId: def.id,
      qty,
      entry: px,
      notional,
      openedAt: s.now,
      peak: px,
      remainder: 1,
      entryImpactPct: gov.entryImpactPct,
      exitQuoteImpactPct: gov.exitImpactPct,
    });
    s.fills += 1;
    placed = true;
    pushJournal(s, {
      kind: "fill",
      symbol: cand.t.symbol,
      title: `Paper buy ${cand.t.symbol}`,
      detail: `${def.name} · $${notional.toFixed(0)} @ ${px.toPrecision(4)} · ${cand.features.bucket.replaceAll("_", " ")}`,
    });
  }

  if (fresh.length) s.ledger = mergeRecent(s.ledger, fresh);

  const byTok = new Map(s.tokens.map((t) => [t.address, t]));
  s.equity =
    s.cash +
    s.positions.reduce((a, p) => {
      const t = byTok.get(p.tokenAddress);
      const px = t?.priceUsd.value ?? p.entry;
      return a + p.qty * px;
    }, 0);
  s.dayPnl = s.equity - s.startEquity;
  return s;
}

export function inspect(s: DeskSnapshot, address: string | null) {
  const t = s.tokens.find((x) => x.address === address) ?? s.tokens[0];
  if (!t) return null;
  const { features, meta } = computeFeatures(t, s.now);
  const pred = predict(t, features);
  const def = strategyForRegime(s.regime);
  const gov = govern({
    t,
    f: features,
    pred,
    equity: s.equity,
    riskBps: s.riskBps,
    openCount: s.positions.length,
    maxPositions: s.maxPositions,
    regime: s.regime,
    strategyId: def.id,
    now: s.now,
    dayDd: Math.max(0, (s.startEquity - s.equity) / s.startEquity),
  });
  const matched = strategyMatches(def, { ...features, ...pred });
  const veto = matched
    ? gov
    : {
        ...gov,
        approved: false,
        reasons: [...gov.reasons, "Strategy filters"],
        layers: gov.layers.map((l) =>
          l.name === "Regime risk" && l.status === "PASS"
            ? { ...l, status: "FAIL" as const, reason: "Strategy filters" }
            : l,
        ),
      };
  const frozen = s.lastIntent?.tokenAddress === t.address ? s.lastIntent : null;
  return { t, f: features, meta, pred, def, gov: veto, frozen };
}

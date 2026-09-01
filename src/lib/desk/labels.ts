import type { LedgerRow, PathTick, TokenLive } from "./types";

const H = {
  m1: 60_000,
  m5: 5 * 60_000,
  m15: 15 * 60_000,
  m30: 30 * 60_000,
  h1: 60 * 60_000,
};

function barrier(path: PathTick[], entry: number, up: number, down: number): boolean | null {
  for (const p of path) {
    const r = p.px / entry - 1;
    if (r <= -down) return false;
    if (r >= up) return true;
  }
  return null;
}

function priceAt(path: PathTick[], t: number): number | null {
  let last: number | null = null;
  for (const p of path) {
    if (p.ts <= t) last = p.px;
    else break;
  }
  return last ?? path.at(-1)?.px ?? null;
}

function windowRet(path: PathTick[], origin: number, horizon: number, entry: number) {
  const end = origin + horizon;
  let max = 0;
  let min = 0;
  for (const p of path) {
    if (p.ts > end) break;
    const r = p.px / entry - 1;
    if (r > max) max = r;
    if (r < min) min = r;
  }
  return { max, min };
}

export function appendOutcomeTick(row: LedgerRow, t: TokenLive, now: number): LedgerRow {
  if (row.labels_complete || row.price == null) return row;
  const px = t.priceUsd.value;
  if (px == null) return row;
  const path = row.path;
  const last = path.at(-1);
  if (last && now - last.ts < 7_000) return freezeLabels(row, now);
  const nextPath: PathTick[] = [
    ...path,
    {
      ts: now,
      px,
      liq: t.liquidityUsd.value ?? 0,
      sell: t.sellQuote?.available ? (1 as const) : (0 as const),
    },
  ].slice(-480);
  return freezeLabels({ ...row, path: nextPath }, now);
}

export function freezeLabels(row: LedgerRow, now: number): LedgerRow {
  if (row.price == null) return row;
  const age = now - row.decision_time;
  const entry = row.price;
  const path = row.path;
  const next: LedgerRow = { ...row };

  const stamp = (key: keyof LedgerRow, horizon: number) => {
    if (age >= horizon && next[key] == null) {
      const px = priceAt(path, row.decision_time + horizon);
      if (px != null) (next as unknown as Record<string, unknown>)[key] = px;
    }
  };
  stamp("price_after_1m", H.m1);
  stamp("price_after_5m", H.m5);
  stamp("price_after_15m", H.m15);
  stamp("price_after_30m", H.m30);
  stamp("price_after_1h", H.h1);

  const freezeWindow = (
    horizon: number,
    gainKey: keyof LedgerRow,
    ddKey: keyof LedgerRow,
  ) => {
    if (age < horizon || next[gainKey] != null) return;
    const w = windowRet(path, row.decision_time, horizon, entry);
    (next as unknown as Record<string, unknown>)[gainKey] = w.max;
    (next as unknown as Record<string, unknown>)[ddKey] = w.min;
  };
  freezeWindow(H.m5, "max_gain_5m", "max_drawdown_5m");
  freezeWindow(H.m15, "max_gain_15m", "max_drawdown_15m");
  freezeWindow(H.h1, "max_gain_1h", "max_drawdown_1h");

  if (next.hit_plus_10_before_minus_10 == null) {
    const hit = barrier(path, entry, 0.1, 0.1);
    if (hit != null) next.hit_plus_10_before_minus_10 = hit;
    else if (age >= H.h1) next.hit_plus_10_before_minus_10 = false;
  }
  if (next.hit_plus_20_before_minus_10 == null) {
    const hit = barrier(path, entry, 0.2, 0.1);
    if (hit != null) next.hit_plus_20_before_minus_10 = hit;
    else if (age >= H.h1) next.hit_plus_20_before_minus_10 = false;
  }

  if (next.liquidity_collapse !== true) {
    const decisionLiq = row.liquidity ?? 0;
    const collapsed = path.some(
      (p) => p.liq < 800 || (decisionLiq > 0 && p.liq < 0.3 * decisionLiq),
    );
    if (collapsed) next.liquidity_collapse = true;
    else if (age >= H.h1) next.liquidity_collapse = false;
  }

  if (row.sell_quote_available && next.sell_route_lost !== true) {
    if (path.some((p) => p.sell === 0)) next.sell_route_lost = true;
    else if (age >= H.h1) next.sell_route_lost = false;
  } else if (!row.sell_quote_available && age >= H.h1 && next.sell_route_lost == null) {
    next.sell_route_lost = null;
  }

  if (next.rug_detected !== true) {
    if (next.liquidity_collapse) next.rug_detected = true;
    else if (age >= H.h1) next.rug_detected = false;
  }

  if (age >= H.m15 && next.simulated_exit == null && next.simulated_entry != null) {
    const px = next.price_after_15m ?? path.at(-1)?.px;
    if (px != null) {
      const load = (next.exit_impact ?? 0.004) + 0.0025 + 0.005;
      next.simulated_exit = px * (1 - load);
      next.net_execution_return = next.simulated_exit / next.simulated_entry - 1;
    }
  }

  if (age >= H.h1 && next.price_after_1h != null) {
    next.labels_complete = true;
    next.path = [];
  }
  return next;
}

export function labelPending(rows: LedgerRow[], tokens: TokenLive[], now: number): LedgerRow[] {
  const by = new Map(tokens.map((t) => [t.address, t]));
  return rows.map((r) => {
    if (r.labels_complete) return r;
    const t = by.get(r.tokenAddress);
    return t ? appendOutcomeTick(r, t, now) : freezeLabels(r, now);
  });
}

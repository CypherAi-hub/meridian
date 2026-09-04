import { getSql } from "@/lib/db";
import {
  anyBudgetStorming,
  budgetFor,
  replaceBudget,
  snapshotBudgets,
  JUPITER_KEYED_BUDGET,
  type RateBudgetSnapshot,
} from "./rate-budget";
import { deskSettings } from "./config";

const g = globalThis as typeof globalThis & {
  __meridianRateBudgetRestored__?: boolean;
  __meridianRateStormAt__?: number;
};

function num(v: unknown, d = 0) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : d;
}

function rowToSnapshot(row: {
  provider: string;
  rate: number;
  tokens: number;
  min_rate: number;
  max_rate: number;
  limited_until_ms: number | null;
  last_429_at_ms: number | null;
  last_ok_at_ms: number | null;
  limited_count: number;
  taken: number;
  skipped: number;
  consecutive_ok?: number | null;
  storm_count?: number | null;
}): RateBudgetSnapshot {
  return {
    name: row.provider,
    rate: num(row.rate),
    tokens: num(row.tokens),
    minRate: num(row.min_rate),
    maxRate: num(row.max_rate),
    limitedUntil: num(row.limited_until_ms),
    last429At: row.last_429_at_ms == null ? null : num(row.last_429_at_ms),
    lastOkAt: row.last_ok_at_ms == null ? null : num(row.last_ok_at_ms),
    limitedCount: num(row.limited_count),
    taken: num(row.taken),
    skipped: num(row.skipped),
    consecutiveOk: num(row.consecutive_ok),
    storming: false,
    stormCount: num(row.storm_count),
  };
}

export async function loadPersistedBudgets(): Promise<RateBudgetSnapshot[]> {
  try {
    const sql = await getSql();
    const rows = await sql.query<{
      provider: string;
      rate: number;
      tokens: number;
      min_rate: number;
      max_rate: number;
      limited_until_ms: number | null;
      last_429_at_ms: number | null;
      last_ok_at_ms: number | null;
      limited_count: number;
      taken: number;
      skipped: number;
      consecutive_ok?: number | null;
      storm_count?: number | null;
    }>(`select * from rate_budget_snapshots`);
    return rows.map(rowToSnapshot);
  } catch {
    return [];
  }
}

export async function restoreRateBudgets(): Promise<RateBudgetSnapshot[]> {
  if (g.__meridianRateBudgetRestored__ && snapshotBudgets().length) return snapshotBudgets();
  g.__meridianRateBudgetRestored__ = true;
  try {
    const rows = await loadPersistedBudgets();
    const now = Date.now();
    for (const snap of rows) {
      let next = snap;
      if (snap.name === "jupiter" && deskSettings().jupiterApiKey && snap.rate < 1) {
        next = {
          ...snap,
          rate: JUPITER_KEYED_BUDGET.rate,
          minRate: Math.max(snap.minRate, JUPITER_KEYED_BUDGET.min),
          maxRate: Math.max(snap.maxRate, JUPITER_KEYED_BUDGET.max),
          tokens: Math.max(snap.tokens, 1),
        };
      }
      const b = budgetFor(next.name, { rate: next.rate, min: next.minRate, max: next.maxRate });
      b.applySnapshot(next, now);
      replaceBudget(b);
    }
  } catch {
    /* 0007 not applied */
  }
  return snapshotBudgets();
}

export async function persistRateBudgets(): Promise<RateBudgetSnapshot[]> {
  const snaps = snapshotBudgets();
  if (!snaps.length) return snaps;
  try {
    const sql = await getSql();
    const now = Date.now();
    for (const s of snaps) {
      try {
        await sql.query(
          `insert into rate_budget_snapshots (
             provider, rate, tokens, min_rate, max_rate, limited_until_ms,
             last_429_at_ms, last_ok_at_ms, limited_count, taken, skipped,
             consecutive_ok, storm_count, updated_at_ms
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           on conflict (provider) do update set
             rate = excluded.rate,
             tokens = excluded.tokens,
             min_rate = excluded.min_rate,
             max_rate = excluded.max_rate,
             limited_until_ms = excluded.limited_until_ms,
             last_429_at_ms = excluded.last_429_at_ms,
             last_ok_at_ms = excluded.last_ok_at_ms,
             limited_count = excluded.limited_count,
             taken = excluded.taken,
             skipped = excluded.skipped,
             consecutive_ok = excluded.consecutive_ok,
             storm_count = excluded.storm_count,
             updated_at_ms = excluded.updated_at_ms`,
          [
            s.name,
            s.rate,
            s.tokens,
            s.minRate,
            s.maxRate,
            s.limitedUntil || null,
            s.last429At,
            s.lastOkAt,
            s.limitedCount,
            s.taken,
            s.skipped,
            s.consecutiveOk,
            s.stormCount,
            now,
          ],
        );
      } catch {
        await sql.query(
          `insert into rate_budget_snapshots (
             provider, rate, tokens, min_rate, max_rate, limited_until_ms,
             last_429_at_ms, last_ok_at_ms, limited_count, taken, skipped, updated_at_ms
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           on conflict (provider) do update set
             rate = excluded.rate,
             tokens = excluded.tokens,
             min_rate = excluded.min_rate,
             max_rate = excluded.max_rate,
             limited_until_ms = excluded.limited_until_ms,
             last_429_at_ms = excluded.last_429_at_ms,
             last_ok_at_ms = excluded.last_ok_at_ms,
             limited_count = excluded.limited_count,
             taken = excluded.taken,
             skipped = excluded.skipped,
             updated_at_ms = excluded.updated_at_ms`,
          [
            s.name,
            s.rate,
            s.tokens,
            s.minRate,
            s.maxRate,
            s.limitedUntil || null,
            s.last429At,
            s.lastOkAt,
            s.limitedCount,
            s.taken,
            s.skipped,
            now,
          ],
        );
      }
    }
  } catch {
    /* 0007 */
  }
  return snaps;
}

export function rateLimitStormActive(now = Date.now()): boolean {
  if (!anyBudgetStorming()) return false;
  if (now - (g.__meridianRateStormAt__ ?? 0) < 600_000) return false;
  g.__meridianRateStormAt__ = now;
  return true;
}

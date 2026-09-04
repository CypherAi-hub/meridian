import { bucketOf } from "./buckets.ts";
import { usableAt } from "./leakage.ts";
import { holderTtlMs } from "./providers/holders.ts";
import type { DataStatus, FieldObs, TokenSnapshot } from "./schema.ts";

export type FrozenHolder = {
  holders: number | null;
  concentration: number | null;
  eventTime: number | null;
  ingestedAt: number | null;
  source: string | null;
  status: DataStatus;
  ageMs: number | null;
};

function unknown(opts: {
  eventTime: number | null;
  ingestedAt: number | null;
  source: string | null;
  ageMs: number | null;
}): FrozenHolder {
  return {
    holders: null,
    concentration: null,
    eventTime: opts.eventTime,
    ingestedAt: opts.ingestedAt,
    source: opts.source,
    status: "UNKNOWN",
    ageMs: opts.ageMs,
  };
}

export function freezeHolderAtDecision(opts: {
  decisionTime: number;
  snapshot: TokenSnapshot;
  tokenAgeS?: number | null;
  maxAgeMs?: number;
}): FrozenHolder {
  const T = opts.decisionTime;
  const top = opts.snapshot.top10Pct;
  const count = opts.snapshot.holders;
  const ttl = opts.maxAgeMs ?? holderTtlMs(bucketOf(opts.tokenAgeS ?? null));
  const concOk = usableAt(top, T);
  const countOk = usableAt(count, T);
  const ingestedAt = concOk ? top.ingestedAt : countOk ? count.ingestedAt : latestKnownIngested(top, count, T);
  const eventTime = concOk ? top.eventTime : countOk ? count.eventTime : latestKnownEvent(top, count, T);
  const source = concOk ? String(top.source) : countOk ? String(count.source) : latestKnownSource(top, count, T);
  if (ingestedAt == null || ingestedAt > T) {
    return unknown({ eventTime, ingestedAt, source, ageMs: null });
  }
  const ageMs = Math.max(0, T - ingestedAt);
  if (!concOk && !countOk) {
    return unknown({ eventTime, ingestedAt, source, ageMs });
  }
  if (ageMs > ttl) {
    return unknown({ eventTime, ingestedAt, source, ageMs });
  }
  return {
    holders: countOk ? count.value : null,
    concentration: concOk ? top.value : null,
    eventTime,
    ingestedAt,
    source,
    status: "VALID",
    ageMs,
  };
}

function latestKnownIngested(top: FieldObs<number>, count: FieldObs<number>, T: number): number | null {
  const cands = [top, count].filter((f) => f.ingestedAt > 0 && f.ingestedAt <= T);
  if (!cands.length) return null;
  return Math.max(...cands.map((f) => f.ingestedAt));
}

function latestKnownEvent(top: FieldObs<number>, count: FieldObs<number>, T: number): number | null {
  const cands = [top, count].filter((f) => f.ingestedAt > 0 && f.ingestedAt <= T);
  if (!cands.length) return null;
  return cands.sort((a, b) => b.ingestedAt - a.ingestedAt)[0]?.eventTime ?? null;
}

function latestKnownSource(top: FieldObs<number>, count: FieldObs<number>, T: number): string | null {
  const cands = [top, count].filter((f) => f.ingestedAt > 0 && f.ingestedAt <= T);
  if (!cands.length) return null;
  return String(cands.sort((a, b) => b.ingestedAt - a.ingestedAt)[0]?.source ?? null);
}

export function holderObsFromWarehouseRow(row: {
  holder_count: number | null;
  top_10_holder_pct: number | null;
  holder_status: string | null;
  holder_provider: string | null;
  event_time_ms: number | null;
  ingested_at_ms: number | null;
}): { holders: number | null; top10Pct: number | null; status: DataStatus; source: string; eventTime: number; ingestedAt: number } | null {
  const ingestedAt = row.ingested_at_ms;
  if (ingestedAt == null) return null;
  const status = (row.holder_status === "VALID" ? "VALID" : row.top_10_holder_pct != null || row.holder_count != null ? "VALID" : "UNKNOWN") as DataStatus;
  return {
    holders: row.holder_count,
    top10Pct: row.top_10_holder_pct,
    status,
    source: row.holder_provider ?? "solana",
    eventTime: row.event_time_ms ?? ingestedAt,
    ingestedAt,
  };
}

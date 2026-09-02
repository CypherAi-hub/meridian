import { applyTape } from "./engine";
import { ingestFastPath, ingestSlowEnrichment, ingestTape } from "./ingest.server";
import { persistDesk, persistFastPath, loadDesk, recordError, startWorkerTick, finishWorkerTick, acquirePrimaryLease, renewPrimaryLease, recordSoakIncident } from "./repo.server";
import { writeHeartbeat } from "./quality.server";
import { researchUrgency, selectActiveWatches, MAX_ACTIVE_WATCHES } from "./watch";
import { assertPaperMode, deskSettings } from "./config";
import { bucketOf } from "./buckets";
import type { DeskSnapshot } from "./types";
import { ACTIVE_INTERVAL_MS } from "./watch";

const TICK_MS = 12_000;
const ACTIVE_MS = ACTIVE_INTERVAL_MS;
const STARTED_AT = Date.now();
const INSTANCE_ID = crypto.randomUUID();

const g = globalThis as typeof globalThis & {
  __meridianTickTimer__?: ReturnType<typeof setInterval>;
  __meridianActiveTimer__?: ReturnType<typeof setInterval>;
  __meridianLeaseTimer__?: ReturnType<typeof setInterval>;
  __meridianTickChain__?: Promise<DeskSnapshot | null>;
  __meridianFastChain__?: Promise<DeskSnapshot | null>;
  __meridianLast__?: DeskSnapshot | null;
  __meridianLeaseHeld__?: boolean;
};

g.__meridianTickChain__ ??= Promise.resolve(null);
g.__meridianFastChain__ ??= Promise.resolve(null);

function rankActive(s: DeskSnapshot) {
  const pending = new Set(s.pending.filter((r) => !r.labels_complete).map((r) => r.tokenAddress));
  const held = new Set(s.positions.map((p) => p.tokenAddress));
  const consideredAt = s.lastConsidered ?? {};
  return s.tokens.map((t) => {
    const ageS = t.createdAt ? (s.now - t.createdAt) / 1000 : null;
    const urgency = researchUrgency({
      hasOpenPaperPosition: held.has(t.address),
      hasPendingLabel: pending.has(t.address),
      wasJustConsidered: Boolean(consideredAt[t.address] && s.now - consideredAt[t.address] < 60_000),
      isNewLaunch: bucketOf(ageS) === "new_launch",
      edgeScore: s.lastIntent?.tokenAddress === t.address ? s.lastIntent.predictions.edgeScore : 0,
    });
    return { mint: t.address, urgency };
  });
}

function activeMints(s: DeskSnapshot): string[] {
  const max = deskSettings().maxActiveWatches ?? MAX_ACTIVE_WATCHES;
  const ranked = rankActive(s);
  const pending = s.pending.filter((r) => !r.labels_complete).map((r) => r.tokenAddress);
  const held = s.positions.map((p) => p.tokenAddress);
  const forced = [...new Set([...pending, ...held])];
  const { keep } = selectActiveWatches(
    [...forced.map((mint) => ({ mint, urgency: 10_000 })), ...ranked],
    max,
  );
  return [...new Set(keep)];
}

export async function runTick(): Promise<DeskSnapshot> {
  const job = (g.__meridianTickChain__ ?? Promise.resolve(null)).then(async () => {
    const t0 = Date.now();
    const tickId = crypto.randomUUID();
    const lease = await acquirePrimaryLease(INSTANCE_ID);
    g.__meridianLeaseHeld__ = lease !== "conflict";
    if (lease === "conflict") {
      const prev = await loadDesk();
      prev.worker = { ...prev.worker, lastError: "PRIMARY_RESEARCH_WRITER_ALREADY_ACTIVE" };
      void recordSoakIncident({ type: "LEASE_LOST", severity: "error", metadata: { instance: INSTANCE_ID } });
      return prev;
    }
    await startWorkerTick(tickId, t0);
    const prev = await loadDesk();
    try {
      const watch = activeMints(prev);
      const held = prev.positions.map((p) => p.tokenAddress);
      const pending = prev.pending.filter((r) => !r.labels_complete).map((r) => r.tokenAddress);
      const tape = await ingestTape({
        held,
        focus: prev.selected,
        watch,
        pending,
      });
      const enriched = await ingestSlowEnrichment({
        tape,
        mints: watch,
        held,
        pending,
      });
      const next = applyTape(prev, enriched);
      const pendingRows = next.pending.filter((r) => !r.labels_complete);
      const lastProviderOkAt = next.sources.reduce<number | null>((acc, s) => {
        if (s.lastOkAt == null) return acc;
        return acc == null ? s.lastOkAt : Math.max(acc, s.lastOkAt);
      }, null);
      const duration = Date.now() - t0;
      next.worker = {
        ...next.worker,
        status: "live",
        lastTickAt: Date.now(),
        lastMarketEventAt: enriched.ingestedAt,
        lastProviderOkAt,
        lastError: null,
        pendingLabels: pendingRows.length,
        queueDepth: pendingRows.length,
        oldestPendingAt: pendingRows.at(-1)?.decision_time ?? null,
        providerErrors: next.sources.filter((s) => s.status === "offline").length,
        avgTickMs: duration,
        observationsWritten: (next.worker.observationsWritten ?? 0) + next.tokens.length,
      };
      await persistDesk(next, prev);
      await writeHeartbeat({
        status: "live",
        durationMs: duration,
        observationsWritten: next.tokens.length,
        considerationsWritten: next.flushQueue.filter((r) => r.decision_time >= t0).length,
        dropped: next.worker.considerationsDropped ?? 0,
        error: null,
        startedAt: STARTED_AT,
      });
      await finishWorkerTick(tickId, "SUCCESS", {
        tokensSeen: next.tokens.length,
        observationsWritten: next.tokens.length,
        considerationsWritten: next.flushQueue.filter((r) => r.decision_time >= t0).length,
        labelsUpdated: next.pending.filter((r) => r.labels_complete).length,
        errorCount: next.sources.filter((s) => s.status === "offline").length,
      });
      g.__meridianLast__ = next;
      return next;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "tick failed";
      void recordError(msg);
      const incidentType = /database|sql|neon|pglite/i.test(msg) ? "DB_DOWN" : "WORKER_DOWN";
      void recordSoakIncident({ type: incidentType, severity: "error", metadata: { message: msg } });
      await finishWorkerTick(tickId, "FAILED", {
        tokensSeen: 0,
        observationsWritten: 0,
        considerationsWritten: 0,
        labelsUpdated: 0,
        errorCount: 1,
      });
      await writeHeartbeat({
        status: "offline",
        durationMs: Date.now() - t0,
        observationsWritten: 0,
        considerationsWritten: 0,
        dropped: 0,
        error: msg,
        startedAt: STARTED_AT,
      });
      const fallback = await loadDesk().catch(() => prev);
      fallback.worker = {
        ...fallback.worker,
        status: "offline",
        lastError: msg,
        avgTickMs: Date.now() - t0,
      };
      g.__meridianLast__ = fallback;
      return fallback;
    }
  });
  g.__meridianTickChain__ = job;
  return (await job) as DeskSnapshot;
}

export async function runActiveTick(): Promise<DeskSnapshot | null> {
  const last = g.__meridianLast__;
  if (!last?.tokens.length) return null;
  const job = (g.__meridianFastChain__ ?? Promise.resolve(null)).then(async () => {
    if (g.__meridianLeaseHeld__ === false) return last;
    const scheduledAt = Date.now();
    const prev = g.__meridianLast__ ?? last;
    const mints = activeMints(prev);
    if (!mints.length) return prev;
    try {
      const startedAt = Date.now();
      const tape = await ingestFastPath({
        tape: {
          ingestedAt: prev.lastTapeAt ?? Date.now(),
          eventTime: prev.lastTapeAt ?? Date.now(),
          fetchMs: prev.feedLagMs,
          solPriceUsd: prev.solPrice || null,
          tokens: prev.tokens,
          sources: prev.sources,
        },
        mints,
      });
      const db0 = Date.now();
      await persistFastPath({
        tokens: tape.tokens.filter((t) => mints.includes(t.address)),
        mints,
        scheduledAt,
        startedAt,
        providerDelayMs: tape.fetchMs,
        deadlineMs: ACTIVE_MS,
      });
      const dbDelay = Date.now() - db0;
      void dbDelay;
      const next = applyTape(prev, tape);
      g.__meridianLast__ = next;
      return next;
    } catch (e) {
      console.error("[meridian] fast path", e instanceof Error ? e.message : e);
      return prev;
    }
  });
  g.__meridianFastChain__ = job;
  return (await job) as DeskSnapshot;
}

export function ensureWorker() {
  assertPaperMode();
  if (g.__meridianTickTimer__ == null) {
    g.__meridianTickTimer__ = setInterval(() => {
      void runTick();
    }, TICK_MS);
    void runTick();
  }
  if (g.__meridianActiveTimer__ == null) {
    g.__meridianActiveTimer__ = setInterval(() => {
      void runActiveTick();
    }, ACTIVE_MS);
  }
  if (g.__meridianLeaseTimer__ == null) {
    g.__meridianLeaseTimer__ = setInterval(() => {
      void renewPrimaryLease(INSTANCE_ID).then((ok) => {
        g.__meridianLeaseHeld__ = ok;
      });
    }, 10_000);
  }
}

export function peekLast() {
  return g.__meridianLast__ ?? null;
}

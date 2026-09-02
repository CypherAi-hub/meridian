import { applyTape } from "./engine";
import { ingestActive, ingestTape } from "./ingest.server";
import { persistDesk, loadDesk, recordError, startWorkerTick, finishWorkerTick } from "./repo.server";
import { writeHeartbeat } from "./quality.server";
import { shouldPromote } from "./watch";
import { assertPaperMode } from "./config";
import type { DeskSnapshot } from "./types";

const TICK_MS = 12_000;
const ACTIVE_MS = 3_000;
const STARTED_AT = Date.now();

const g = globalThis as typeof globalThis & {
  __meridianTickTimer__?: ReturnType<typeof setInterval>;
  __meridianActiveTimer__?: ReturnType<typeof setInterval>;
  __meridianTickChain__?: Promise<DeskSnapshot | null>;
  __meridianLast__?: DeskSnapshot | null;
};

g.__meridianTickChain__ ??= Promise.resolve(null);

function activeMints(s: DeskSnapshot): string[] {
  const pending = s.pending.filter((r) => !r.labels_complete).map((r) => r.tokenAddress);
  const promoted = s.tokens
    .filter((t) => {
      const edge = s.lastIntent?.tokenAddress === t.address ? s.lastIntent.predictions.edgeScore : 0;
      return shouldPromote({
        considered: pending.includes(t.address),
        edgeScore: edge,
      });
    })
    .map((t) => t.address);
  return [...new Set([...pending, ...promoted, ...s.positions.map((p) => p.tokenAddress)])].slice(0, 12);
}

export async function runTick(): Promise<DeskSnapshot> {
  const job = (g.__meridianTickChain__ ?? Promise.resolve(null)).then(async () => {
    const t0 = Date.now();
    const tickId = crypto.randomUUID();
    await startWorkerTick(tickId, t0);
    const prev = await loadDesk();
    try {
      const watch = activeMints(prev);
      const held = prev.positions.map((p) => p.tokenAddress);
      const tape = await ingestTape({
        held,
        focus: prev.selected,
        watch,
      });
      const next = applyTape(prev, tape);
      const pending = next.pending.filter((r) => !r.labels_complete);
      const lastProviderOkAt = next.sources.reduce<number | null>((acc, s) => {
        if (s.lastOkAt == null) return acc;
        return acc == null ? s.lastOkAt : Math.max(acc, s.lastOkAt);
      }, null);
      const duration = Date.now() - t0;
      next.worker = {
        ...next.worker,
        status: "live",
        lastTickAt: Date.now(),
        lastMarketEventAt: tape.ingestedAt,
        lastProviderOkAt,
        lastError: null,
        pendingLabels: pending.length,
        queueDepth: pending.length,
        oldestPendingAt: pending.at(-1)?.decision_time ?? null,
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
  const job = (g.__meridianTickChain__ ?? Promise.resolve(null)).then(async () => {
    const prev = g.__meridianLast__ ?? last;
    const mints = activeMints(prev);
    if (!mints.length) return prev;
    try {
      const tape = await ingestActive({
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
      const next = applyTape(prev, tape);
      await persistDesk(next, prev);
      g.__meridianLast__ = next;
      return next;
    } catch (e) {
      console.error("[meridian] active watch", e instanceof Error ? e.message : e);
      return prev;
    }
  });
  g.__meridianTickChain__ = job;
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
}

export function peekLast() {
  return g.__meridianLast__ ?? null;
}

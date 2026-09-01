import { applyTape } from "./engine";
import { ingestTape } from "./ingest.server";
import { persistDesk, loadDesk, recordError } from "./repo.server";
import type { DeskSnapshot } from "./types";

const TICK_MS = 12_000;

const g = globalThis as typeof globalThis & {
  __meridianTickTimer__?: ReturnType<typeof setInterval>;
  __meridianTickChain__?: Promise<DeskSnapshot | null>;
  __meridianLast__?: DeskSnapshot | null;
};

g.__meridianTickChain__ ??= Promise.resolve(null);

export async function runTick(): Promise<DeskSnapshot> {
  const job = (g.__meridianTickChain__ ?? Promise.resolve(null)).then(async () => {
    const prev = await loadDesk();
    try {
      const watch = [
        ...new Set(prev.pending.filter((r) => !r.labels_complete).map((r) => r.tokenAddress)),
      ].slice(0, 12);
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
      };
      await persistDesk(next, prev);
      g.__meridianLast__ = next;
      return next;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "tick failed";
      void recordError(msg);
      const fallback = await loadDesk().catch(() => prev);
      fallback.worker = {
        ...fallback.worker,
        status: "offline",
        lastError: msg,
      };
      g.__meridianLast__ = fallback;
      return fallback;
    }
  });
  g.__meridianTickChain__ = job;
  return (await job) as DeskSnapshot;
}

export function ensureWorker() {
  if (g.__meridianTickTimer__ != null) return;
  g.__meridianTickTimer__ = setInterval(() => {
    void runTick();
  }, TICK_MS);
  void runTick();
}

export function peekLast() {
  return g.__meridianLast__ ?? null;
}

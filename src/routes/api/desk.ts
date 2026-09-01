import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/desk")({
  server: {
    handlers: {
      GET: async () => {
        const { ensureWorker, peekLast, runTick } = await import("@/lib/desk/worker.server");
        const { loadDesk } = await import("@/lib/desk/repo.server");
        ensureWorker();
        const cached = peekLast();
        const fresh = await loadDesk();
        const snap =
          cached && Date.now() - (cached.worker.lastTickAt ?? 0) < 20_000
            ? {
                ...cached,
                running: fresh.running,
                halted: fresh.halted,
                riskBps: fresh.riskBps,
                slippageBps: fresh.slippageBps,
                selected: fresh.selected,
                research: fresh.research,
                worker: { ...cached.worker, ...fresh.worker, status: cached.worker.status },
              }
            : fresh;
        if (!snap.worker.lastTickAt) void runTick();
        return Response.json(snap);
      },
    },
  },
});

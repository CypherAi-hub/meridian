import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/tick")({
  server: {
    handlers: {
      GET: async () => {
        const { ensureWorker, runTick } = await import("@/lib/desk/worker.server");
        ensureWorker();
        const snap = await runTick();
        return Response.json({
          ok: snap.worker.status !== "offline",
          now: snap.now,
          obs: snap.research.considerations,
          pending: snap.research.incomplete,
          labeled: snap.research.labeled,
          running: snap.running,
          worker: snap.worker,
          tokens: snap.tokens.length,
        });
      },
      POST: async () => {
        const { ensureWorker, runTick } = await import("@/lib/desk/worker.server");
        ensureWorker();
        const snap = await runTick();
        return Response.json({ ok: true, obs: snap.research.considerations, worker: snap.worker });
      },
    },
  },
});

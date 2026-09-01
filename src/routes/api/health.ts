import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { ensureWorker } = await import("@/lib/desk/worker.server");
        const { loadHealthPayload } = await import("@/lib/desk/quality.server");
        const view = new URL(request.url).searchParams.get("view");
        if (view === "live") {
          return Response.json({ status: "LIVE" });
        }
        ensureWorker();
        const payload = await loadHealthPayload();
        if (view === "ready") {
          const providers: Record<string, string> = {};
          for (const p of payload.providers) providers[String(p.id)] = String(p.status).toUpperCase();
          return Response.json({
            worker: String(payload.worker.status).toUpperCase(),
            database: "HEALTHY",
            providers,
            holder_coverage_pct: payload.quality.holderCoveragePct,
            route_coverage_pct: payload.quality.jupiterRoutePct,
            label_completion_pct: payload.quality.labelsCompletedPct,
            configured: payload.configured,
          });
        }
        if (view === "research") {
          return Response.json({
            worker: payload.worker,
            corpus: payload.corpus,
            quality: payload.quality,
          });
        }
        return Response.json(payload);
      },
    },
  },
});

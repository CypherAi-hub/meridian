import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { ensureWorker } = await import("@/lib/desk/worker.server");
        const { liveHealth, loadHealthPayload, readyHealth, researchHealthPayload } = await import(
          "@/lib/desk/quality.server"
        );
        const view = new URL(request.url).searchParams.get("view");
        if (view === "live") {
          return Response.json(await liveHealth());
        }
        ensureWorker();
        if (view === "ready") {
          const ready = await readyHealth();
          return Response.json(ready.body, { status: ready.status });
        }
        if (view === "research") {
          return Response.json(await researchHealthPayload());
        }
        if (view === "migrations") {
          const { loadMigrationStatus } = await import("@/lib/desk/neon-migrate");
          return Response.json(await loadMigrationStatus());
        }
        return Response.json(await loadHealthPayload());
      },
    },
  },
});

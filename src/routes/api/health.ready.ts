import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/health/ready")({
  server: {
    handlers: {
      GET: async () => {
        const { ensureWorker } = await import("@/lib/desk/worker.server");
        const { readyHealth } = await import("@/lib/desk/quality.server");
        ensureWorker();
        const ready = await readyHealth();
        return Response.json(ready.body, { status: ready.status });
      },
    },
  },
});

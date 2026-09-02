import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/health/research")({
  server: {
    handlers: {
      GET: async () => {
        const { ensureWorker } = await import("@/lib/desk/worker.server");
        const { researchHealthPayload } = await import("@/lib/desk/quality.server");
        ensureWorker();
        return Response.json(await researchHealthPayload());
      },
    },
  },
});

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/health/live")({
  server: {
    handlers: {
      GET: async () => {
        const { liveHealth } = await import("@/lib/desk/quality.server");
        return Response.json(await liveHealth());
      },
    },
  },
});

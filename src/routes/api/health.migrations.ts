import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/health/migrations")({
  server: {
    handlers: {
      GET: async () => {
        const { loadMigrationStatus } = await import("@/lib/desk/neon-migrate");
        return Response.json(await loadMigrationStatus());
      },
    },
  },
});

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/tape")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const url = new URL(request.url);
          const held = url.searchParams.get("held")?.split(",").filter(Boolean) ?? [];
          const focus = url.searchParams.get("focus");
          const watch = url.searchParams.get("watch")?.split(",").filter(Boolean) ?? [];
          const { ingestTape } = await import("@/lib/desk/ingest.server");
          const tape = await ingestTape({ held, focus: focus || null, watch });
          return Response.json(tape);
        } catch (e) {
          return Response.json(
            {
              ingestedAt: Date.now(),
              eventTime: Date.now(),
              fetchMs: 0,
              solPriceUsd: null,
              tokens: [],
              sources: [
                {
                  id: "dexscreener",
                  status: "offline",
                  lagMs: null,
                  lastOkAt: null,
                  detail: e instanceof Error ? e.message : "ingest failed",
                },
              ],
              error: e instanceof Error ? e.message : "ingest failed",
            },
            { status: 200 },
          );
        }
      },
    },
  },
});

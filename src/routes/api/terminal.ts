import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/api/terminal")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const p = new URL(request.url).searchParams;
        try {
          if (p.get("view") === "search") {
            const { terminalSearch } = await import("@/lib/desk/terminal-market.server");
            return Response.json(await terminalSearch(p.get("q") ?? ""));
          }
          if (p.get("view") === "token") {
            const { terminalToken } = await import("@/lib/desk/terminal-market.server");
            return Response.json(await terminalToken(p.get("mint") ?? ""));
          }
          if (p.get("view") === "chart") {
            const { terminalCandles } = await import("@/lib/desk/terminal-market.server");
            return Response.json(
              await terminalCandles(
                p.get("pair") ?? "",
                p.get("frame") ?? "1m",
                p.get("mint") ?? "",
              ),
            );
          }
          const { manualReport } = await import("@/lib/desk/manual.server");
          return Response.json(await manualReport());
        } catch (e) {
          return Response.json(
            { error: e instanceof Error ? e.message : "Market data unavailable" },
            { status: 503 },
          );
        }
      },
      POST: async ({ request }) => {
        const origin = request.headers.get("origin");
        if (origin && origin !== new URL(request.url).origin)
          return Response.json({ error: "Origin rejected" }, { status: 403 });
        const b = await request.json().catch(() => null);
        if (!b || b.mode !== "PAPER")
          return Response.json({ error: "Only PAPER mode is available" }, { status: 409 });
        try {
          const { manualControl } = await import("@/lib/desk/manual.server");
          await manualControl(b);
          return Response.json({ ok: true, mode: "PAPER" });
        } catch (e) {
          return Response.json(
            { error: e instanceof Error ? e.message : "Paper action failed" },
            { status: 400 },
          );
        }
      },
    },
  },
});

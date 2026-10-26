import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/api/sniper")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (new URL(request.url).searchParams.get("view") === "coverage") {
          const { sniperCoverage } = await import("@/lib/desk/sniper.server");
          return Response.json(await sniperCoverage());
        }
        if (new URL(request.url).searchParams.get("view") === "experiments") {
          const { sniperSuiteReport } = await import("@/lib/desk/sniper.server");
          return Response.json(await sniperSuiteReport());
        }
        const { sniperReport } = await import("@/lib/desk/sniper.server");
        return Response.json(await sniperReport());
      },
      POST: async ({ request }) => {
        // A browser on another origin must not mutate the local experiment.
        const origin = request.headers.get("origin");
        if (origin && origin !== new URL(request.url).origin)
          return Response.json({ error: "Origin rejected" }, { status: 403 });
        const body = await request.json().catch(() => null);
        if (typeof body?.enabled !== "boolean")
          return Response.json({ error: "enabled must be a boolean" }, { status: 400 });
        if (body.scope === "all") {
          const { controlSniperSuite } = await import("@/lib/desk/sniper.server");
          return Response.json(await controlSniperSuite(body.enabled));
        }
        const { controlSniper } = await import("@/lib/desk/sniper.server");
        return Response.json(await controlSniper(body.enabled));
      },
    },
  },
});

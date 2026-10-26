import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/api/capital")({
  server: {
    handlers: {
      GET: async () => {
        const { capitalReport } = await import("@/lib/desk/capital.server");
        return Response.json(await capitalReport());
      },
      POST: async ({ request }) => {
        const origin = request.headers.get("origin");
        if (origin && origin !== new URL(request.url).origin)
          return Response.json({ error: "Origin rejected" }, { status: 403 });
        const body = await request.json().catch(() => null);
        try {
          if (body?.action === "configure") {
            const { configureCapital } = await import("@/lib/desk/capital.server");
            return Response.json(await configureCapital(body.policy));
          }
          if (body?.action === "check-addresses") {
            const { checkCapitalAddresses } = await import("@/lib/desk/capital.server");
            return Response.json(await checkCapitalAddresses());
          }
          if (
            ["deposit", "activate-live", "swap", "transfer", "withdraw", "payout"].includes(
              body?.action,
            )
          )
            return Response.json(
              {
                error: "LIVE_EXECUTION_LOCKED",
                mode: "PAPER",
                signingEnabled: false,
                transferEnabled: false,
              },
              { status: 409 },
            );
          return Response.json(
            { error: "Unsupported paper configuration action" },
            { status: 400 },
          );
        } catch (e) {
          return Response.json(
            { error: e instanceof Error ? e.message : "Invalid policy" },
            { status: 400 },
          );
        }
      },
    },
  },
});

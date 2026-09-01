import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/control")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = (await request.json().catch(() => ({}))) as {
          running?: boolean;
          riskBps?: number;
          slippageBps?: number;
          selected?: string | null;
          resetBook?: boolean;
        };
        const { setControl, loadDesk } = await import("@/lib/desk/repo.server");
        await setControl({
          running: body.running,
          riskBps: body.riskBps,
          slippageBps: body.slippageBps,
          selected: body.selected,
          resetBook: body.resetBook,
          halted: body.running === true ? false : undefined,
        });
        const snap = await loadDesk();
        return Response.json({
          running: snap.running,
          riskBps: snap.riskBps,
          slippageBps: snap.slippageBps,
          cash: snap.cash,
          positions: snap.positions.length,
        });
      },
    },
  },
});

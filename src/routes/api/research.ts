import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/research")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const format = url.searchParams.get("format") ?? "json";
        const view = url.searchParams.get("view");
        if (view === "stats") {
          const { loadHealthPayload } = await import("@/lib/desk/quality.server");
          return Response.json(await loadHealthPayload());
        }
        if (view === "baseline" || view === "edge") {
          const { exportRows } = await import("@/lib/desk/repo.server");
          const { buildBaselineReport, analyzeEdgeMonotonicity } = await import("@/lib/desk/baseline");
          const rows = await exportRows();
          if (view === "edge") return Response.json(analyzeEdgeMonotonicity(rows));
          return Response.json(buildBaselineReport(rows));
        }
        if (view === "replay") {
          const { runWarehouseReplay } = await import("@/lib/desk/replay.server");
          return Response.json(await runWarehouseReplay());
        }
        const { exportRows, rowsToCsv } = await import("@/lib/desk/repo.server");
        const rows = await exportRows();
        if (format === "csv") {
          return new Response(rowsToCsv(rows), {
            headers: {
              "content-type": "text/csv; charset=utf-8",
              "content-disposition": `attachment; filename="meridian-ledger.csv"`,
            },
          });
        }
        return Response.json(rows);
      },
    },
  },
});

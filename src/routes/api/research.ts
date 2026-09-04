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
        if (view === "baseline" || view === "edge" || view === "wasserstein") {
          const { exportRows } = await import("@/lib/desk/repo.server");
          const { buildBaselineReport, analyzeEdgeMonotonicity } = await import("@/lib/desk/baseline");
          const { analyzeWasserstein } = await import("@/lib/desk/wasserstein");
          const rows = await exportRows();
          if (view === "wasserstein") return Response.json(analyzeWasserstein(rows));
          if (view === "edge") {
            const mono = analyzeEdgeMonotonicity(rows);
            return Response.json({ ...mono, wasserstein: analyzeWasserstein(rows) });
          }
          const report = buildBaselineReport(rows);
          report.monotonicity = { ...report.monotonicity, wasserstein: analyzeWasserstein(rows) };
          return Response.json(report);
        }
        if (view === "replay") {
          const { runWarehouseReplay } = await import("@/lib/desk/replay.server");
          return Response.json(await runWarehouseReplay());
        }
        if (view === "replay-baselines" || view === "baselines") {
          const { runDeterministicBaselines } = await import("@/lib/desk/replay.server");
          return Response.json(await runDeterministicBaselines());
        }
        if (view === "migrations") {
          const { loadMigrationStatus } = await import("@/lib/desk/neon-migrate");
          return Response.json(await loadMigrationStatus());
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

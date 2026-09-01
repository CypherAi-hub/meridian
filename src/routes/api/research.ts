import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/research")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const format = url.searchParams.get("format") ?? "json";
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

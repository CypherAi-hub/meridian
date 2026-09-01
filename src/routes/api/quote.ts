import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/quote")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const mint = url.searchParams.get("mint");
        const decimals = Number(url.searchParams.get("decimals") ?? 6);
        const price = Number(url.searchParams.get("price") ?? 0);
        const sol = Number(url.searchParams.get("sol") ?? 0);
        const usd = Number(url.searchParams.get("usd") ?? 120);
        if (!mint || !sol) {
          return Response.json({ error: "mint and sol required" }, { status: 400 });
        }
        const { quoteToken } = await import("@/lib/desk/providers/jupiter");
        const q = await quoteToken({
          mint,
          decimals: Number.isFinite(decimals) ? decimals : 6,
          priceUsd: price || null,
          solPriceUsd: sol,
          notionalUsd: Number.isFinite(usd) ? usd : 120,
        });
        return Response.json(q);
      },
    },
  },
});

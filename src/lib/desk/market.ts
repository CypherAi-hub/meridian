import { createServerFn } from "@tanstack/react-start";

export const getMarketTape = createServerFn({ method: "POST" }).handler(async () => {
  const { ingestTape } = await import("./ingest.server");
  return ingestTape();
});

export const WSOL = "So11111111111111111111111111111111111111112";
export type Protocol = "pump" | "pumpswap" | "raydium-cpmm";
export type ChainEvent = {
  id: string;
  protocol: Protocol;
  kind: "launch" | "pool" | "buy" | "sell" | "migrate" | "swap";
  signature: string;
  slot: number;
  mint: string;
  quoteMint: string;
  actor: string;
  creator?: string;
  pool: string;
  instruction: string;
  instructionIndex: string;
  receivedAt: number;
  processedAt: number;
  blockTime: number | null;
  commitment: "confirmed" | "finalized";
  amountRaw: string | null;
  quoteAmountRaw: string | null;
  quantityEvidence: "actor-net-balance" | "program-event" | "unavailable";
  details: Record<string, unknown>;
};
export type Health = {
  status: string;
  source: string;
  received: number;
  decoded: number;
  rejected: number;
  errors: number;
  lastEventAt: number | null;
  latencyMs: { p50: number | null; p95: number | null };
  lastError?: string;
  backfillGaps: number;
  queueDepth: number;
};
export function json(value: unknown) {
  return JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));
}
export function solAmount(value: string): bigint {
  if (!/^\d+(\.\d{1,9})?$/.test(value))
    throw Error("SOL amount must be a nonnegative decimal with at most 9 places");
  const [whole, part = ""] = value.split(".");
  return BigInt(whole) * 1_000_000_000n + BigInt(part.padEnd(9, "0"));
}

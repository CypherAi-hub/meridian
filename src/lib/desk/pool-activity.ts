export type PoolTransaction = {
  signature: string;
  slot: number;
  blockTime: number | null;
  status: "succeeded" | "failed" | "unknown";
  confirmation: "confirmed" | "finalized" | "unknown";
  error: string | null;
};
export type PoolActivity = {
  network: "solana-mainnet";
  readOnly: true;
  classification: "UNDECODED_ACCOUNT_ACTIVITY";
  pair: string;
  fetchedAt: number;
  source: string;
  transactions: PoolTransaction[];
};
export function poolTransactions(input: unknown): PoolTransaction[] {
  if (!Array.isArray(input)) return [];
  const unique = new Map<string, PoolTransaction>();
  for (const row of input) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (
      typeof r.signature !== "string" ||
      !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(r.signature) ||
      !Number.isSafeInteger(r.slot) ||
      Number(r.slot) <= 0
    )
      continue;
    unique.set(r.signature, {
      signature: r.signature,
      slot: Number(r.slot),
      blockTime:
        Number.isSafeInteger(r.blockTime) && Number(r.blockTime) > 0 ? Number(r.blockTime) : null,
      status: r.err === null ? "succeeded" : r.err === undefined ? "unknown" : "failed",
      confirmation:
        r.confirmationStatus === "confirmed" || r.confirmationStatus === "finalized"
          ? r.confirmationStatus
          : "unknown",
      error: r.err == null ? null : JSON.stringify(r.err).slice(0, 250),
    });
  }
  return [...unique.values()].sort((a, b) => b.slot - a.slot);
}

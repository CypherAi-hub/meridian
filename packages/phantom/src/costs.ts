/** Conservative integer-bps feature for hard budget comparisons; never rounds a loss down. */
export function conservativeCostBps(amount: bigint, proceeds: bigint, networkFees: bigint): number {
  if (amount <= 0n || proceeds < 0n || networkFees < 0n) throw Error("INVALID_COST_AMOUNTS");
  const cost = amount + networkFees - proceeds;
  if (cost <= 0n) return 0;
  const roundedUp = (cost * 10_000n + amount - 1n) / amount;
  // Saturation remains conservative for any representable policy budget.
  return roundedUp > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(roundedUp);
}

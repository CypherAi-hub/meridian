/** Exact conditional arithmetic only. This module authenticates no account or program. */
export const CUSTODY_ARITHMETIC_KIND = "RAYDIUM_CPMM_LP_BURN_ARITHMETIC_V1";
export const CUSTODY_AMOUNT_FIELDS = [
  "baseSupplyRaw",
  "baseVaultRaw",
  "baseProtocolFeesRaw",
  "baseFundFeesRaw",
  "baseCreatorFeesRaw",
  "quoteVaultRaw",
  "quoteProtocolFeesRaw",
  "quoteFundFeesRaw",
  "quoteCreatorFeesRaw",
  "internalLpSupplyRaw",
  "actualLpSupplyRaw",
] as const;
export type CustodyAmounts = Record<(typeof CUSTODY_AMOUNT_FIELDS)[number], string>;
export type CustodyArithmeticInput = {
  kind: typeof CUSTODY_ARITHMETIC_KIND;
  amounts: CustodyAmounts;
};
const U64 = (1n << 64n) - 1n;
export function custodyRaw(value: unknown): bigint {
  if (typeof value !== "string" || value.length > 20 || !/^(0|[1-9][0-9]*)$/.test(value))
    throw Error("CUSTODY_AMOUNT_NOT_CANONICAL_U64");
  const n = BigInt(value);
  if (n > U64) throw Error("CUSTODY_AMOUNT_NOT_CANONICAL_U64");
  return n;
}
function fields(value: unknown, expected: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== expected.length ||
    !expected.every((name) => Object.hasOwn(value, name))
  )
    throw Error("CUSTODY_INPUT_FIELDS_INVALID");
  return value as Record<string, unknown>;
}

/**
 * All actual LP, all fee buckets, and all supply outside excluded principal are
 * assigned to the creator. LP sent to an address or locked remains actual LP.
 * The denominator is the pool's internal supply, never the actual mint supply.
 * This is a current unpaid-redemption bound, conditional on reviewed semantics;
 * it is not a permanent lock or a statement about hidden wallet independence.
 */
export function evaluateCustodyArithmetic(value: unknown) {
  const input = fields(value, ["kind", "amounts"]);
  if (input.kind !== CUSTODY_ARITHMETIC_KIND) throw Error("CUSTODY_INPUT_KIND_INVALID");
  const a = fields(input.amounts, CUSTODY_AMOUNT_FIELDS);
  const amounts = Object.fromEntries(
    CUSTODY_AMOUNT_FIELDS.map((name) => [name, custodyRaw(a[name])]),
  ) as Record<(typeof CUSTODY_AMOUNT_FIELDS)[number], bigint>;
  const S = amounts.baseSupplyRaw,
    B = amounts.baseVaultRaw,
    D = amounts.internalLpSupplyRaw,
    M = amounts.actualLpSupplyRaw,
    baseFees = amounts.baseProtocolFeesRaw + amounts.baseFundFeesRaw + amounts.baseCreatorFeesRaw,
    quoteFees =
      amounts.quoteProtocolFeesRaw + amounts.quoteFundFeesRaw + amounts.quoteCreatorFeesRaw;
  if (S === 0n || D === 0n) throw Error("CUSTODY_SUPPLY_OR_DENOMINATOR_ZERO");
  if (B > S || M > D || baseFees > B || quoteFees > amounts.quoteVaultRaw)
    throw Error("CUSTODY_AMOUNTS_INCONSISTENT");
  const netBase = B - baseFees,
    netQuote = amounts.quoteVaultRaw - quoteFees,
    redeemable = (netBase * M) / D,
    excluded = netBase - redeemable,
    upper = S - excluded,
    upperBps = (upper * 10_000n + S - 1n) / S,
    creatorCapSatisfied = upper * 10_000n <= 1_000n * S,
    liquidityFloorSatisfied = netQuote >= 20_000_000_000n;
  return {
    kind: "CONDITIONAL_ARITHMETIC_NOT_A_CUSTODY_CERTIFICATE" as const,
    amounts: {
      netBaseReserveRaw: netBase.toString(),
      netQuoteReserveLamports: netQuote.toString(),
      unmintedOrBurnedLpRaw: (D - M).toString(),
      redeemablePrincipalUpperRaw: redeemable.toString(),
      excludedPrincipalLowerRaw: excluded.toString(),
      creatorSupplyUpperRaw: upper.toString(),
      creatorSupplyUpperBps: upperBps.toString(),
    },
    creatorCapSatisfied,
    liquidityFloorSatisfied,
    arithmeticCandidate: creatorCapSatisfied && liquidityFloorSatisfied,
    liveApproved: false as const,
  };
}

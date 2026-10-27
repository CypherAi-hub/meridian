import type { ManualBook, ManualPosition } from "./manual.ts";
import { WSOL } from "./schema.ts";

export function recentTimestamp(at: number | null | undefined, now: number, maximumAgeMs: number) {
  return (
    typeof at === "number" &&
    Number.isSafeInteger(at) &&
    at >= 0 &&
    at <= now &&
    now - at <= maximumAgeMs
  );
}

export function watchlistForView(
  saved: string[] | undefined,
  local: string[] | null,
  readOnly: boolean,
) {
  return [...new Set(readOnly && local !== null ? local : (saved ?? [WSOL]))];
}

export function toggleWatchlist(current: string[], mint: string) {
  return current.includes(mint) ? current.filter((value) => value !== mint) : [...current, mint];
}

export function freshManualMark(
  position: Pick<ManualPosition, "markAtomic" | "markedAt">,
  now: number,
): bigint | null {
  const value = position.markAtomic;
  if (
    !recentTimestamp(position.markedAt, now, 45000) ||
    typeof value !== "string" ||
    value.length > 21 ||
    !/^(?:0|-?[1-9]\d*)$/.test(value)
  )
    return null;
  const mark = BigInt(value),
    limit = (1n << 64n) - 1n;
  return mark > limit || mark < -limit ? null : mark;
}

/** Unknown positions remain inventory, never a fabricated zero in total equity. */
export function manualValuation(book: Pick<ManualBook, "cashAtomic" | "positions">, now: number) {
  let marked = 0n,
    unvaluedPositions = 0;
  for (const position of book.positions) {
    const value = freshManualMark(position, now);
    if (value === null) unvaluedPositions++;
    else marked += value > 0n ? value : 0n;
  }
  return {
    equityUsdc: unvaluedPositions ? null : Number(BigInt(book.cashAtomic) + marked) / 1e6,
    unvaluedPositions,
  };
}

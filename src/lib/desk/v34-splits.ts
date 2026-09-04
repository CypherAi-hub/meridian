import { groupByToken, tokenLeakage } from "./dataset.ts";

export type SplitName = "train" | "validation" | "test";

export type SplitAssignment<T> = {
  train: T[];
  validation: T[];
  test: T[];
  leakedTokens: string[];
};

const HOUR = 60 * 60_000;

/**
 * Purged walk-forward with embargo.
 * Train labels must finish (decision + horizon) plus embargo before trainEnd.
 * Validation/test start after the previous bound plus embargo.
 * Token-grouped: a mint is assigned by its first decision_time and never split across folds.
 */
export function purgedEmbargoTokenSplit<T extends { decision_time: number; tokenAddress: string }>(
  rows: T[],
  opts: { trainEnd: number; validationEnd: number; horizonMs?: number; embargoMs?: number },
): SplitAssignment<T> {
  const horizonMs = opts.horizonMs ?? HOUR;
  const embargoMs = opts.embargoMs ?? HOUR;
  const grouped = groupByToken(rows);
  const train: T[] = [];
  const validation: T[] = [];
  const test: T[] = [];
  for (const [, group] of grouped) {
    const first = Math.min(...group.map((r) => r.decision_time));
    const lastLabelEnd = Math.max(...group.map((r) => r.decision_time + horizonMs));
    let dest: SplitName;
    if (lastLabelEnd + embargoMs < opts.trainEnd) dest = "train";
    else if (first >= opts.trainEnd + embargoMs && lastLabelEnd + embargoMs < opts.validationEnd) dest = "validation";
    else if (first >= opts.validationEnd + embargoMs) dest = "test";
    else continue; // purged / embargo gap — do not assign
    if (dest === "train") train.push(...group);
    else if (dest === "validation") validation.push(...group);
    else test.push(...group);
  }
  return {
    train,
    validation,
    test,
    leakedTokens: [
      ...tokenLeakage(train, validation),
      ...tokenLeakage(train, test),
      ...tokenLeakage(validation, test),
    ],
  };
}

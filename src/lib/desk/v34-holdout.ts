export type HoldoutVault = {
  from: number;
  to: number;
  locked: boolean;
  unlockedAt: number | null;
  unlockCount: number;
  log: Array<{ at: number; event: "created" | "unlock" | "reject_peek" }>;
};

export function createHoldoutVault(from: number, to: number): HoldoutVault {
  return { from, to, locked: true, unlockedAt: null, unlockCount: 0, log: [{ at: Date.now(), event: "created" }] };
}

export function inHoldout<T extends { decision_time: number }>(rows: T[], vault: HoldoutVault): T[] {
  return rows.filter((r) => r.decision_time >= vault.from && r.decision_time <= vault.to);
}

export function hideHoldout<T extends { decision_time: number }>(rows: T[], vault: HoldoutVault): T[] {
  if (!vault.locked) return rows;
  return rows.filter((r) => r.decision_time < vault.from || r.decision_time > vault.to);
}

export function peekHoldout<T extends { decision_time: number }>(rows: T[], vault: HoldoutVault): T[] {
  if (vault.locked) {
    vault.log.push({ at: Date.now(), event: "reject_peek" });
    throw new Error("HOLDOUT_LOCKED: final test period is inaccessible during model selection");
  }
  return inHoldout(rows, vault);
}

/** One deliberate unlock. Further calls throw. Permanently logged. */
export function unlockHoldout(vault: HoldoutVault): HoldoutVault {
  if (vault.unlockCount > 0 || !vault.locked) {
    throw new Error("HOLDOUT_ALREADY_UNLOCKED: one unlock event only");
  }
  return {
    ...vault,
    locked: false,
    unlockedAt: Date.now(),
    unlockCount: 1,
    log: [...vault.log, { at: Date.now(), event: "unlock" }],
  };
}

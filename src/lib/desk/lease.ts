export const PRIMARY_LEASE = "meridian_primary_research_writer";
export const LEASE_TTL_MS = 30_000;

export type WorkerLease = {
  leaseName: string;
  workerInstanceId: string;
  acquiredAt: number;
  renewedAt: number;
  expiresAt: number;
};

export type LeaseDecision = "acquired" | "renewed" | "conflict";

export function decideLease(
  existing: WorkerLease | null,
  instanceId: string,
  now: number,
  ttlMs = LEASE_TTL_MS,
): { decision: LeaseDecision; next: WorkerLease } {
  if (
    existing &&
    existing.expiresAt > now &&
    existing.workerInstanceId !== instanceId
  ) {
    return { decision: "conflict", next: existing };
  }
  const acquired = existing && existing.workerInstanceId === instanceId ? existing.acquiredAt : now;
  return {
    decision: existing && existing.workerInstanceId === instanceId ? "renewed" : "acquired",
    next: {
      leaseName: PRIMARY_LEASE,
      workerInstanceId: instanceId,
      acquiredAt: acquired,
      renewedAt: now,
      expiresAt: now + ttlMs,
    },
  };
}

import { PRIMARY_LEASE, LEASE_TTL_MS, type LeaseDecision, type WorkerLease } from "./lease.ts";

/** Separate from production. Never acquire meridian_primary_research_writer. */
export const SHADOW_LEASE = "meridian_v35_shadow_collector";

export function assertNotPrimaryLease(name: string) {
  if (name === PRIMARY_LEASE || name === "meridian_primary_research_writer") {
    throw new Error("V35_SHADOW: refused primary production writer lease");
  }
}

export function shadowDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const dedicated = (env.PARTICIPANT_DATABASE_URL ?? env.DATABASE_URL_DEV ?? "").trim();
  return dedicated || null;
}

export function assertShadowWarehouse(env: NodeJS.ProcessEnv = process.env) {
  if (env.MERIDIAN_WORKER === "1") {
    throw new Error("V35_SHADOW: cannot run inside the production worker process");
  }
  const dedicated = shadowDatabaseUrl(env);
  const prod = (env.DATABASE_URL ?? "").trim();
  if (!dedicated) {
    throw new Error("V35_SHADOW: PARTICIPANT_DATABASE_URL (or DATABASE_URL_DEV) is required. Will not use production DATABASE_URL.");
  }
  if (prod && dedicated === prod) {
    throw new Error("V35_SHADOW: participant DB must not be the production DATABASE_URL");
  }
  return dedicated;
}

export function decideShadowLease(
  existing: WorkerLease | null,
  instanceId: string,
  now: number,
  ttlMs = LEASE_TTL_MS,
): { decision: LeaseDecision; next: WorkerLease } {
  assertNotPrimaryLease(SHADOW_LEASE);
  if (existing) assertNotPrimaryLease(existing.leaseName);
  if (existing && existing.expiresAt > now && existing.workerInstanceId !== instanceId) {
    return { decision: "conflict", next: existing };
  }
  const acquired = existing && existing.workerInstanceId === instanceId ? existing.acquiredAt : now;
  return {
    decision: existing && existing.workerInstanceId === instanceId ? "renewed" : "acquired",
    next: {
      leaseName: SHADOW_LEASE,
      workerInstanceId: instanceId,
      acquiredAt: acquired,
      renewedAt: now,
      expiresAt: now + ttlMs,
    },
  };
}

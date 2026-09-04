export type AlertSeverity = "info" | "warn" | "error";

export type ProductionAlert = {
  code: string;
  severity: AlertSeverity;
  message: string;
};

export type AlertSnapshot = {
  now?: number;
  leaseExpiresAtMs?: number | null;
  lastTickAtMs?: number | null;
  workerStatus?: string | null;
  observationsStalled?: boolean;
  holderAtDecisionPct?: number | null;
  routeCheckPct?: number | null;
  activeMedianGapMs?: number | null;
  soakIncidentOpen?: boolean;
};

const TICK_STALE_MS = 90_000;
const LEASE_SOON_MS = 15_000;
const PATH_GAP_MS = 12_000;

export function evaluateProductionAlerts(s: AlertSnapshot): ProductionAlert[] {
  const now = s.now ?? Date.now();
  const alerts: ProductionAlert[] = [];
  if (s.workerStatus && s.workerStatus !== "live") {
    alerts.push({ code: "WORKER_DOWN", severity: "error", message: `worker status ${s.workerStatus}` });
  }
  if (s.leaseExpiresAtMs == null) {
    alerts.push({ code: "LEASE_MISSING", severity: "error", message: "primary writer lease missing" });
  } else if (s.leaseExpiresAtMs <= now) {
    alerts.push({ code: "LEASE_EXPIRED", severity: "error", message: "primary writer lease expired" });
  } else if (s.leaseExpiresAtMs - now < LEASE_SOON_MS) {
    alerts.push({ code: "LEASE_EXPIRING", severity: "warn", message: "primary writer lease expiring" });
  }
  if (s.lastTickAtMs == null || now - s.lastTickAtMs > TICK_STALE_MS) {
    alerts.push({ code: "TICK_STALE", severity: "error", message: "worker tick is stale" });
  }
  if (s.observationsStalled) {
    alerts.push({ code: "NEON_STALL", severity: "error", message: "Neon observations stalled" });
  }
  if (s.holderAtDecisionPct != null && s.holderAtDecisionPct < 0.05) {
    alerts.push({
      code: "HOLDER_COVERAGE_COLLAPSE",
      severity: "warn",
      message: `holder-at-decision ${(s.holderAtDecisionPct * 100).toFixed(1)}%`,
    });
  }
  if (s.routeCheckPct != null && s.routeCheckPct < 0.05) {
    alerts.push({
      code: "ROUTE_COVERAGE_COLLAPSE",
      severity: "warn",
      message: `route-check ${(s.routeCheckPct * 100).toFixed(1)}%`,
    });
  }
  if (s.activeMedianGapMs != null && s.activeMedianGapMs > PATH_GAP_MS) {
    alerts.push({
      code: "PATH_GAP_BLOWOUT",
      severity: "warn",
      message: `active median gap ${(s.activeMedianGapMs / 1000).toFixed(1)}s`,
    });
  }
  if (s.soakIncidentOpen) {
    alerts.push({ code: "SOAK_INCIDENT", severity: "error", message: "open soak incident" });
  }
  return alerts;
}

export type MeridianEnvironment = "development" | "preview" | "production";
export type ExecutionMode = "PAPER";

export type ProductionConfig = {
  databaseUrl: string | null;
  databaseDriver: "pglite" | "neon";
  executionMode: ExecutionMode;
};

export function canonicalDriver(): "pglite" | "neon" {
  const raw = typeof process !== "undefined" ? process.env.DATABASE_URL : undefined;
  return raw && raw.trim() ? "neon" : "pglite";
}

export function meridianEnvironment(): MeridianEnvironment {
  const raw = (process.env.MERIDIAN_ENV ?? "").trim().toLowerCase();
  if (raw === "production" || raw === "prod") return "production";
  if (raw === "development" || raw === "dev") return "development";
  if (raw === "preview") return "preview";
  if (process.env.NODE_ENV === "production" && canonicalDriver() === "neon") return "production";
  if (process.env.NODE_ENV === "development") return "development";
  return "preview";
}

export function validateProductionConfig(config: ProductionConfig) {
  if (meridianEnvironment() !== "production") return;
  const errors: string[] = [];
  if (!config.databaseUrl) errors.push("DATABASE_URL_REQUIRED");
  if (config.databaseDriver === "pglite") errors.push("PGLITE_NOT_ALLOWED_AS_PRODUCTION_CANONICAL_DB");
  if (config.executionMode !== "PAPER") errors.push("ONLY_PAPER_MODE_ALLOWED");
  if (errors.length) throw new Error(`Invalid production config: ${errors.join(",")}`);
}

export function currentEpochName(env: MeridianEnvironment = meridianEnvironment()): string {
  if (env === "production" && canonicalDriver() === "neon") return "v33b_production";
  if (env === "production") return "v33b_production_blocked";
  return "v33b_preview";
}

export function officialSoakAllowed(env: MeridianEnvironment = meridianEnvironment()) {
  return env === "production" && canonicalDriver() === "neon";
}

/** Official soak clock marker. Previous preview minutes do not count. */
export const PRODUCTION_SOAK_CLOSURE = "v33b_worker";

export const SOAK_INCIDENT_TYPES = [
  "WORKER_DOWN",
  "DB_DOWN",
  "PROVIDER_OUTAGE",
  "ACTIVE_PATH_DEGRADED",
  "QUEUE_BACKLOG",
  "DATA_GAP",
  "LEASE_LOST",
  "RATE_LIMIT_STORM",
] as const;

export type SoakIncidentType = (typeof SOAK_INCIDENT_TYPES)[number];

export function makeSoakIncident(opts: {
  type: SoakIncidentType | string;
  severity?: string;
  durationSeconds?: number | null;
  metadata?: Record<string, unknown>;
  now?: number;
}) {
  const now = opts.now ?? Date.now();
  return {
    id: crypto.randomUUID(),
    occurredAtMs: now,
    severity: opts.severity ?? "warn",
    incidentType: opts.type,
    durationSeconds: opts.durationSeconds ?? null,
    metadata: opts.metadata ?? {},
    createdAtMs: now,
  };
}

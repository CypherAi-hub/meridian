/** Ordered Meridian warehouse migrations. Auth schema is intentionally excluded. */
export const MERIDIAN_MIGRATIONS = [
  "0002_meridian.sql",
  "0003_durable.sql",
  "0004_v33a.sql",
  "0005_v33a1.sql",
  "0006_v33a2.sql",
  "0007_v33a3.sql",
  "0008_v33a3_budget.sql",
  "0009_v33b.sql",
  "0010_v33b_closure.sql",
] as const;

export const SCHEMA_VERSION = "v33b";

export const REQUIRED_TABLES = [
  "market_observations",
  "feature_vectors",
  "candidate_considerations",
  "outcome_labels",
  "token_path_samples",
  "token_watch_state",
  "worker_heartbeat",
  "collection_epochs",
  "warehouse_metadata",
  "rate_budget_snapshots",
  "replay_runs",
  "replay_experiments",
] as const;

export type NeonStepStatus = "done" | "current" | "pending" | "blocked";

export type NeonMigrationStep = {
  id: number;
  name: string;
  action: string;
  status: NeonStepStatus;
};

const STEP_COPY: Array<{ id: number; name: string; action: string }> = [
  {
    id: 1,
    name: "provision",
    action: "Platform injects DATABASE_URL on deploy. Never write a .env. Preview stays on PGLite until then.",
  },
  {
    id: 2,
    name: "apply",
    action: `Apply ${MERIDIAN_MIGRATIONS.join(" → ")} in order via npm run db:migrate / db:neon (Neon) or automatic PGLite bootstrap.`,
  },
  {
    id: 3,
    name: "verify",
    action: `Confirm _migrations contains every Meridian file and required tables exist: ${REQUIRED_TABLES.join(", ")}.`,
  },
  {
    id: 4,
    name: "stamp",
    action: `Write warehouse_metadata.schema_version = ${SCHEMA_VERSION}. Do not copy preview PGLite rows into Neon.`,
  },
  {
    id: 5,
    name: "isolate",
    action: "Preview PGLite is a throwaway warehouse. Never dump, copy, or restore preview rows into Neon.",
  },
  {
    id: 6,
    name: "epoch",
    action: "Start v33b_production collection epoch only after Neon is canonical. Preview soak is not counted. Do not mix v33a2_preview rows into the production epoch.",
  },
];

export function neonMigrationSteps(): NeonMigrationStep[] {
  return STEP_COPY.map((s) => ({ ...s, status: "pending" as const }));
}

export function pendingMeridianMigrations(applied: string[]): string[] {
  const done = new Set(applied);
  return MERIDIAN_MIGRATIONS.filter((n) => !done.has(n));
}

export type NeonStepContext = {
  canonical: "pglite" | "neon";
  applied: string[];
  tables: Record<string, boolean>;
  schemaVersion: string | null;
  soakAllowed: boolean;
  soakStarted: boolean;
};

export function evaluateNeonMigrationSteps(ctx: NeonStepContext): {
  steps: NeonMigrationStep[];
  current: string;
} {
  const pending = pendingMeridianMigrations(ctx.applied);
  const tablesReady = REQUIRED_TABLES.every((t) => ctx.tables[t]);
  const stamped = ctx.schemaVersion === SCHEMA_VERSION;
  const provisioned = ctx.canonical === "neon";

  const statuses: NeonStepStatus[] = [];

  statuses[0] = provisioned ? "done" : "current";
  if (pending.length === 0) statuses[1] = "done";
  else if (provisioned) statuses[1] = "current";
  else statuses[1] = "pending";
  if (tablesReady) statuses[2] = "done";
  else if (pending.length === 0) statuses[2] = "current";
  else statuses[2] = "pending";
  if (stamped) statuses[3] = "done";
  else if (tablesReady) statuses[3] = "current";
  else statuses[3] = "pending";
  statuses[4] = provisioned ? "done" : "current";
  if (ctx.soakStarted && ctx.soakAllowed) statuses[5] = "done";
  else if (ctx.soakAllowed) statuses[5] = "current";
  else statuses[5] = "blocked";

  let seenCurrent = false;
  for (let i = 0; i < statuses.length; i++) {
    if (statuses[i] === "done" || statuses[i] === "blocked") continue;
    if (!seenCurrent) {
      statuses[i] = statuses[i] === "pending" && i > 0 && statuses[i - 1] !== "done" ? "pending" : "current";
      seenCurrent = true;
    } else if (statuses[i] === "current") {
      statuses[i] = "pending";
    }
  }

  const steps = STEP_COPY.map((s, i) => ({ ...s, status: statuses[i] ?? "pending" }));
  const current = steps.find((s) => s.status === "current" || s.status === "blocked")?.name ?? "done";
  return { steps, current };
}

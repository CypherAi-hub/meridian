import { dbSource, getSql } from "@/lib/db";
import { canonicalDriver, officialSoakAllowed } from "./env.ts";
import {
  MERIDIAN_MIGRATIONS,
  REQUIRED_TABLES,
  SCHEMA_VERSION,
  evaluateNeonMigrationSteps,
  neonMigrationSteps,
  pendingMeridianMigrations,
  type NeonMigrationStep,
} from "./neon-steps.ts";

export {
  MERIDIAN_MIGRATIONS,
  REQUIRED_TABLES,
  SCHEMA_VERSION,
  neonMigrationSteps,
  pendingMeridianMigrations,
  evaluateNeonMigrationSteps,
};
export type { NeonMigrationStep };

export type MigrationStatus = {
  driver: "pglite" | "neon";
  canonical: "pglite" | "neon";
  expected: string[];
  applied: string[];
  pending: string[];
  tables: Record<string, boolean>;
  schemaVersion: string | null;
  ready: boolean;
  currentStep: string;
  steps: NeonMigrationStep[];
  note: string;
};

export async function loadMigrationStatus(): Promise<MigrationStatus> {
  const sql = await getSql();
  let applied: string[] = [];
  try {
    const rows = await sql.query<{ name: string }>("select name from _migrations order by name");
    applied = rows.map((r) => r.name);
  } catch {
    applied = [];
  }
  const pending = pendingMeridianMigrations(applied);
  const tables: Record<string, boolean> = {};
  for (const table of REQUIRED_TABLES) {
    try {
      const row = (
        await sql.query<{ n: number }>(
          `select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name = $1`,
          [table],
        )
      )[0];
      tables[table] = Number(row?.n ?? 0) > 0;
    } catch {
      tables[table] = false;
    }
  }
  let schemaVersion: string | null = null;
  let soakStarted = false;
  try {
    const row = (await sql.query<{ value: unknown }>(`select value from warehouse_metadata where key = 'schema_version'`))[0];
    const v = row?.value;
    if (v && typeof v === "object" && v !== null && "version" in (v as object)) {
      schemaVersion = String((v as { version: string }).version);
    } else if (typeof v === "string") schemaVersion = v;
  } catch {
    schemaVersion = null;
  }
  try {
    const soak = (await sql.query<{ value: unknown }>(`select value from warehouse_metadata where key = 'production_soak_started_at'`))[0];
    if (soak?.value && typeof soak.value === "object" && soak.value && "ms" in (soak.value as object)) {
      soakStarted = Number((soak.value as { ms: number }).ms) > 0;
    }
  } catch {
    soakStarted = false;
  }
  const tablesReady = REQUIRED_TABLES.every((t) => tables[t]);
  const ready = pending.length === 0 && tablesReady;
  const driver = dbSource;
  const canonical = canonicalDriver();
  const soakAllowed = officialSoakAllowed();
  const evaluated = evaluateNeonMigrationSteps({
    canonical,
    applied,
    tables,
    schemaVersion,
    soakAllowed,
    soakStarted,
  });
  return {
    driver,
    canonical,
    expected: [...MERIDIAN_MIGRATIONS],
    applied: MERIDIAN_MIGRATIONS.filter((n) => applied.includes(n)),
    pending: [...pending],
    tables,
    schemaVersion,
    ready,
    currentStep: evaluated.current,
    steps: evaluated.steps,
    note:
      canonical === "neon"
        ? ready
          ? "Neon warehouse schema is current."
          : `Neon pending: ${pending.join(", ") || evaluated.current}.`
        : "Preview is on PGLite. Neon steps run on deploy when DATABASE_URL is injected. Do not copy preview rows into Neon.",
  };
}

export async function stampSchemaVersion(version = SCHEMA_VERSION) {
  const sql = await getSql();
  const now = Date.now();
  await sql.query(
    `insert into warehouse_metadata (key, value, updated_at_ms)
     values ('schema_version', $1::jsonb, $2)
     on conflict (key) do update set value = excluded.value, updated_at_ms = excluded.updated_at_ms`,
    [JSON.stringify({ version, migrations: MERIDIAN_MIGRATIONS, stampedAt: now }), now],
  );
}

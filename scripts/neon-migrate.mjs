#!/usr/bin/env node
/**
 * Neon warehouse cutover helper.
 *
 * Preview: no DATABASE_URL → prints the ordered steps and exits 0 (PGLite
 * already applies the same files). Never writes a .env.
 *
 * Deploy: DATABASE_URL present → apply pending migrations then verify required
 * tables. Stamping schema_version happens from the app once the tables exist.
 */
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import pg from "pg";
import { pendingMigrations } from "./migration-plan.mjs";

const MERIDIAN = [
  "0002_meridian.sql",
  "0003_durable.sql",
  "0004_v33a.sql",
  "0005_v33a1.sql",
  "0006_v33a2.sql",
  "0007_v33a3.sql",
  "0008_v33a3_budget.sql",
  "0009_v33b.sql",
  "0010_v33b_closure.sql",
];

const REQUIRED = [
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
];

const STEPS = [
  "1. provision — platform injects DATABASE_URL on deploy; never write a .env",
  `2. apply — ${MERIDIAN.join(" → ")}`,
  "3. verify — _migrations + required tables",
  "4. stamp — warehouse_metadata.schema_version = v33b; do not copy PGLite rows",
  "5. isolate — never dump/copy/restore preview PGLite rows into Neon",
  "6. epoch — v33b_production soak only after Neon is canonical. Do not mix preview rows.",
];

function runMigrate() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "migrate.mjs")], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`migrate.mjs exited ${code}`));
    });
  });
}

async function verifyNeon(databaseUrl) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const applied = (await pool.query("select name from _migrations order by name")).rows.map((r) => r.name);
    const pending = MERIDIAN.filter((n) => !applied.includes(n));
    const missing = [];
    for (const table of REQUIRED) {
      const row = await pool.query(
        `select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name = $1`,
        [table],
      );
      if (!row.rows[0]?.n) missing.push(table);
    }
    console.log("[neon-migrate] applied:", applied.filter((n) => MERIDIAN.includes(n)).join(", ") || "(none)");
    console.log("[neon-migrate] pending:", pending.join(", ") || "(none)");
    if (missing.length) {
      console.log("[neon-migrate] missing tables:", missing.join(", "));
      throw new Error(`verify failed: missing ${missing.join(", ")}`);
    }
    console.log("[neon-migrate] verify ok — required tables present. Stamp schema_version from the app; do not copy PGLite rows.");
  } finally {
    await pool.end();
  }
}

async function main() {
  console.log("[neon-migrate] Meridian warehouse steps:");
  for (const s of STEPS) console.log(`  ${s}`);

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
    const entries = await readdir(dir).catch(() => []);
    const pending = pendingMigrations(entries, [])
      .map((m) => m.name)
      .filter((n) => MERIDIAN.includes(n));
    console.log("[neon-migrate] DATABASE_URL unset — preview PGLite path. Files present:", pending.join(", ") || "(none)");
    console.log("[neon-migrate] current step: provision. Neon apply is deferred until deploy injects DATABASE_URL.");
    return;
  }

  await runMigrate();
  await verifyNeon(databaseUrl);
}

main().catch((err) => {
  console.error("[neon-migrate] failed:", err?.message || err);
  process.exit(1);
});

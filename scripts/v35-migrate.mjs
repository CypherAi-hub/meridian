#!/usr/bin/env node
/** Apply ONLY 0012_v35_participant.sql to PARTICIPANT_DATABASE_URL. Never production DATABASE_URL. */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const dedicated = (process.env.PARTICIPANT_DATABASE_URL ?? process.env.DATABASE_URL_DEV ?? "").trim();
const prod = (process.env.DATABASE_URL ?? "").trim();
if (!dedicated) {
  console.error("[v35-migrate] PARTICIPANT_DATABASE_URL required");
  process.exit(1);
}
if (prod && dedicated === prod) {
  console.error("[v35-migrate] refused: participant DB equals production DATABASE_URL");
  process.exit(1);
}

const file = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations", "0012_v35_participant.sql");
const pool = new pg.Pool({ connectionString: dedicated, max: 1, ssl: { rejectUnauthorized: false } });
const client = await pool.connect();
try {
  await client.query(
    "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  );
  const applied = (await client.query("SELECT name FROM _migrations WHERE name = $1", ["0012_v35_participant.sql"])).rows;
  if (applied.length) {
    console.log("[v35-migrate] 0012 already applied");
  } else {
    const text = await readFile(file, "utf8");
    await client.query("BEGIN");
    await client.query(text);
    await client.query("INSERT INTO _migrations (name) VALUES ($1)", ["0012_v35_participant.sql"]);
    await client.query("COMMIT");
    console.log("[v35-migrate] applied 0012_v35_participant.sql");
  }
} catch (e) {
  try {
    await client.query("ROLLBACK");
  } catch {
    /* ignore */
  }
  throw e;
} finally {
  client.release();
  await pool.end();
}

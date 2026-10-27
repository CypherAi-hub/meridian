/** Real PostgreSQL integration, with an isolated database created by this suite.
 * Only a loopback PHANTOM_TEST_DATABASE_URL is accepted. No chain/provider requests.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { Engine } from "../src/engine.ts";
import { decodeTransaction } from "../src/decoder.ts";

const connection = process.env.PHANTOM_TEST_DATABASE_URL;
describe.skipIf(!connection)("real PostgreSQL persistence and worker fencing", () => {
  const database = `phantom_test_${randomUUID().replaceAll("-", "")}`;
  let admin: Client,
    databaseUrl: string,
    created = false;
  beforeAll(async () => {
    const url = new URL(connection!);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      throw Error("POSTGRES_TESTS_REQUIRE_LOOPBACK_SERVER");
    admin = new Client({ connectionString: connection });
    await admin.connect();
    // This identifier contains only a fixed test prefix and a freshly generated UUID.
    await admin.query(`CREATE DATABASE "${database}"`);
    created = true;
    url.pathname = `/${database}`;
    databaseUrl = url.toString();
  });
  afterAll(async () => {
    try {
      if (created && /^phantom_test_[a-f0-9]{32}$/.test(database))
        await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
    } finally {
      await admin?.end();
    }
  });
  it("applies migrations, preserves exact JSON amounts and deduplicates actual recorded evidence", async () => {
    const store = await new Store().open(databaseUrl, undefined, true);
    try {
      const tx = JSON.parse(
        readFileSync(new URL("./fixtures/real-pump-buy.json", import.meta.url), "utf8"),
      );
      const event = decodeTransaction(tx, Date.now())[0];
      expect(event).toBeDefined();
      expect(await store.event(event)).toBe(true);
      expect(await store.event(event)).toBe(false);
      await store.save("pg-exact-state", { cashLamports: 18_446_744_073_709_551_615n });
      expect((await store.get("pg-exact-state")).cashLamports).toBe("18446744073709551615");
      const contender = new Store();
      await expect(contender.open(databaseUrl, undefined, true)).rejects.toThrow(
        "PHANTOM_WORKER_ALREADY_RUNNING_FOR_DATABASE",
      );
      await contender.close();
      const sessions = await admin.query(
        "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1",
        [database],
      );
      expect(sessions.rows[0].count).toBe(1);
    } finally {
      await store.close();
    }
    const restarted = await new Store().open(databaseUrl, undefined, true);
    try {
      expect((await restarted.get("pg-exact-state")).cashLamports).toBe("18446744073709551615");
    } finally {
      await restarted.close();
    }
  });
  it("fences an old worker after its actual advisory-lock backend is terminated", async () => {
    const first = await new Store().open(databaseUrl, undefined, true);
    let second: Store | undefined;
    try {
      await first.save("pg-fence-state", { owner: "first" });
      const [{ pid }] = await first.query("SELECT pg_backend_pid() AS pid");
      expect(
        (await admin.query("SELECT pg_terminate_backend($1) AS killed", [pid])).rows[0].killed,
      ).toBe(true);
      await vi.waitFor(() => expect(first.workerLeaseHealthy).toBe(false));
      second = await new Store().open(databaseUrl, undefined, true);
      await second.save("pg-fence-state", { owner: "second" });
      await expect(first.save("pg-fence-state", { owner: "stale" })).rejects.toThrow(
        "PHANTOM_WORKER_LEASE_LOST",
      );
      await expect(
        first.query("UPDATE phantom_state SET payload='{}'::jsonb WHERE id='pg-fence-state'"),
      ).rejects.toThrow("PHANTOM_WORKER_LEASE_LOST");
      expect(await second.get("pg-fence-state")).toEqual({ owner: "second" });
    } finally {
      await first.close();
      await second?.close();
    }
  });
  it("atomically creates and version-fences research books on the actual leased PostgreSQL session", async () => {
    const store = await new Store().open(databaseUrl, undefined, true);
    const id = "research-paper:postgres-cas", manifestHash = "a".repeat(64);
    try {
      const first = { ledgerVersion: 1, manifest: { manifestHash }, cashLamports: "1000000000" };
      expect(await store.saveResearchPaperBook(id, first, null, manifestHash)).toBe(true);
      expect(await store.saveResearchPaperBook(id, first, null, manifestHash)).toBe(false);
      const updates = await Promise.all(["989990000", "989980000"].map((cashLamports) =>
        store.saveResearchPaperBook(id, { ...first, ledgerVersion: 2, cashLamports }, 1, manifestHash)));
      expect(updates.filter(Boolean)).toHaveLength(1);
      expect((await store.get(id)).ledgerVersion).toBe(2);
      expect(await store.saveResearchPaperBook(id, { ...first, ledgerVersion: 3 }, 1, manifestHash)).toBe(false);
      expect(await store.saveResearchPaperBook(id, { ...first, ledgerVersion: 3 }, 2, "b".repeat(64))).toBe(false);
    } finally { await store.close(); }
    const restored = await new Store().open(databaseUrl, undefined, true);
    try {
      const current = await restored.get(id);
      expect(current.ledgerVersion).toBe(2);
      expect(await restored.saveResearchPaperBook(id, { ...current, ledgerVersion: 3 }, 2, manifestHash)).toBe(true);
    } finally { await restored.close(); }
  });
  it("does not move an in-flight write to another pooled session after lease loss", async () => {
    const first = await new Store().open(databaseUrl, undefined, true);
    let second: Store | undefined;
    try {
      const [{ pid }] = await first.query("SELECT pg_backend_pid() AS pid");
      const pending = first.exec(
        "WITH pause AS (SELECT pg_sleep(5)) INSERT INTO phantom_state(id,payload,updated_at) SELECT 'interrupted-worker-write','{}'::jsonb,0 FROM pause",
      );
      const rejected = expect(pending).rejects.toBeDefined();
      await admin.query("SELECT pg_terminate_backend($1)", [pid]);
      await rejected;
      await vi.waitFor(() => expect(first.workerLeaseHealthy).toBe(false));
      second = await new Store().open(databaseUrl, undefined, true);
      expect(await second.get("interrupted-worker-write")).toBe(null);
      await expect(
        first.exec(
          "INSERT INTO phantom_state(id,payload,updated_at) VALUES('stale-worker-write','{}',0)",
        ),
      ).rejects.toThrow("PHANTOM_WORKER_LEASE_LOST");
      expect(await second.get("stale-worker-write")).toBe(null);
    } finally {
      await first.close();
      await second?.close();
    }
  });
  it("suspends the paper engine on actual lease loss and still closes its HTTP server", async () => {
    const previous = { ...process.env },
      directory = mkdtempSync(join(tmpdir(), "phantom-pg-engine-"));
    let engine: Engine | undefined;
    try {
      process.env.PHANTOM_DATABASE_URL = databaseUrl;
      process.env.PHANTOM_KILL_FILE = join(directory, "KILL");
      process.env.PHANTOM_WALLET_HISTORY = "false";
      process.env.PHANTOM_QUOTE_RESEARCH = "false";
      process.env.PHANTOM_MODE = "PAPER";
      process.env.NODE_ENV = "production";
      engine = await new Engine().start({ stream: false, port: 0 });
      const url = engine.url;
      const [{ pid }] = await engine.store.query("SELECT pg_backend_pid() AS pid");
      await admin.query("SELECT pg_terminate_backend($1)", [pid]);
      await vi.waitFor(() => expect(engine!.store.workerLeaseHealthy).toBe(false));
      await engine.tick();
      expect(JSON.parse(readFileSync(join(directory, "KILL"), "utf8")).reason).toBe(
        "DATABASE_WORKER_LEASE_LOST_ALL_SETTLEMENT_SUSPENDED",
      );
      expect(engine.state().positions).toEqual([]);
      await engine.stop();
      engine = undefined;
      await expect(fetch(url + "/state")).rejects.toBeDefined();
    } finally {
      await engine?.stop();
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

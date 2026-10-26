import { readFileSync, mkdirSync, openSync, writeFileSync, closeSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { PGlite } from "@electric-sql/pglite";
import { json, type ChainEvent } from "./types.ts";
export class Store {
  private pool: Pool | null = null;
  private local: PGlite | null = null;
  private lockClient: PoolClient | null = null;
  private leaseFile: string | null = null;
  private leaseNonce: string | null = null;
  private dir: string | null = null;
  async open(url?: string, dir = "./data/warehouse", workerLease = false) {
    if (url) {
      this.pool = new Pool({ connectionString: url, max: 4 });
      if (workerLease) await this.acquireWorkerLease();
    } else {
      this.dir = resolve(dir);
      mkdirSync(this.dir, { recursive: true });
      if (workerLease) await this.acquireWorkerLease();
      this.local = new PGlite(this.dir);
      await this.local.waitReady;
    }
    await this.exec(
      readFileSync(new URL("../migrations/0001_phantom.sql", import.meta.url), "utf8"),
    );
    return this;
  }
  async acquireWorkerLease() {
    if (this.pool) {
      const client = await this.pool.connect();
      const result = await client.query("SELECT pg_try_advisory_lock(7342921,1) AS acquired");
      if (!result.rows[0]?.acquired) {
        client.release();
        throw Error("PHANTOM_WORKER_ALREADY_RUNNING_FOR_DATABASE");
      }
      this.lockClient = client;
      return;
    }
    if (!this.dir) throw Error("STORE_NOT_OPEN");
    const file = join(this.dir, ".phantom-worker.lock");
    const nonce = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(file, "wx", 0o600);
        writeFileSync(
          fd,
          JSON.stringify({ schema: "phantom-worker-lease-v1", pid: process.pid, nonce }),
        );
        closeSync(fd);
        this.leaseFile = file;
        this.leaseNonce = nonce;
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        let previous;
        try {
          previous = JSON.parse(readFileSync(file, "utf8"));
        } catch {
          throw Error("UNRECOGNIZED_WORKER_LEASE_REQUIRES_REVIEW");
        }
        if (
          previous.schema !== "phantom-worker-lease-v1" ||
          !Number.isSafeInteger(previous.pid) ||
          previous.pid < 1 ||
          typeof previous.nonce !== "string"
        )
          throw Error("UNRECOGNIZED_WORKER_LEASE_REQUIRES_REVIEW");
        let live = true;
        try {
          process.kill(previous.pid, 0);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ESRCH") live = false;
        }
        if (live) throw Error("PHANTOM_WORKER_ALREADY_RUNNING_FOR_DATABASE");
        unlinkSync(file);
      }
    }
    throw Error("WORKER_LEASE_RACE_RETRY_STARTUP");
  }
  async exec(sql: string, args: unknown[] = []): Promise<{ rows: any[] }> {
    if (this.pool) return this.pool.query(sql, args);
    if (!this.local) throw Error("Store not open");
    if (!args.length) {
      await this.local.exec(sql);
      return { rows: [] };
    }
    return this.local.query(sql, args);
  }
  async query(sql: string, args: unknown[] = []): Promise<any[]> {
    if (this.pool) return (await this.pool.query(sql, args)).rows;
    if (!this.local) throw Error("Store not open");
    return (await this.local.query(sql, args)).rows;
  }
  async event(event: ChainEvent) {
    const r = await this.exec(
      "INSERT INTO phantom_events(id,signature,slot,protocol,kind,mint,received_at,processed_at,commitment,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT(id) DO NOTHING RETURNING id",
      [
        event.id,
        event.signature,
        event.slot,
        event.protocol,
        event.kind,
        event.mint,
        event.receivedAt,
        event.processedAt,
        event.commitment,
        json(event),
      ],
    );
    return r.rows.length > 0;
  }
  async transaction(signature: string, slot: number, tx: unknown) {
    await this.exec(
      "INSERT INTO phantom_transactions(signature,slot,payload) VALUES($1,$2,$3::jsonb) ON CONFLICT(signature) DO NOTHING",
      [signature, slot, json(tx)],
    );
  }
  async decision(value: unknown, at: number) {
    await this.exec("INSERT INTO phantom_decisions(at,payload) VALUES($1,$2::jsonb)", [
      at,
      json(value),
    ]);
  }
  async save(id: string, value: unknown) {
    await this.exec(
      "INSERT INTO phantom_state(id,payload,updated_at) VALUES($1,$2::jsonb,$3) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at",
      [id, json(value), Date.now()],
    );
  }
  async get(id: string) {
    return (
      (await this.query("SELECT payload FROM phantom_state WHERE id=$1", [id]))[0]?.payload ?? null
    );
  }
  async recentEvents(limit = 200) {
    return (
      await this.query(
        "SELECT payload FROM phantom_events WHERE orphaned=false ORDER BY received_at DESC LIMIT $1",
        [limit],
      )
    ).map((x) => x.payload) as ChainEvent[];
  }
  async recentDecisions(limit = 200) {
    return (
      await this.query("SELECT payload FROM phantom_decisions ORDER BY id DESC LIMIT $1", [limit])
    ).map((x) => x.payload);
  }
  async unevaluated(limit = 1000) {
    return (
      await this.query(
        "SELECT payload FROM phantom_events WHERE evaluated=false AND orphaned=false ORDER BY slot, id LIMIT $1",
        [limit],
      )
    ).map((x) => x.payload) as ChainEvent[];
  }
  async evaluated(id: string) {
    await this.exec("UPDATE phantom_events SET evaluated=true WHERE id=$1", [id]);
  }
  async cursor(program: string, signature?: string) {
    if (signature)
      await this.exec(
        "INSERT INTO phantom_cursor(program,signature,updated_at) VALUES($1,$2,$3) ON CONFLICT(program) DO UPDATE SET signature=excluded.signature,updated_at=excluded.updated_at",
        [program, signature, Date.now()],
      );
    return (await this.query("SELECT signature FROM phantom_cursor WHERE program=$1", [program]))[0]
      ?.signature as string | undefined;
  }
  async close() {
    if (this.lockClient) {
      await this.lockClient.query("SELECT pg_advisory_unlock(7342921,1)");
      this.lockClient.release();
      this.lockClient = null;
    }
    await this.pool?.end();
    await this.local?.close();
    if (this.leaseFile) {
      try {
        const lease = JSON.parse(readFileSync(this.leaseFile, "utf8"));
        if (lease.nonce === this.leaseNonce) unlinkSync(this.leaseFile);
      } catch {}
      this.leaseFile = null;
    }
  }
}

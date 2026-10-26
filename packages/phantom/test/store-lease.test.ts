/** Synthetic PostgreSQL protocol failures; no network, credentials or market data. */
import { beforeEach, describe, expect, it, vi } from "vitest";
const control = vi.hoisted(() => ({
  pools: [] as any[],
  acquired: true,
  acquisitionFailure: false,
  migrationFailure: false,
}));
vi.mock("pg", async () => {
  const { EventEmitter } = await import("node:events");
  class Client extends EventEmitter {
    query = vi.fn(async (sql: string, _args?: unknown[]) => {
      if (sql.includes("pg_try_advisory_lock")) {
        if (control.acquisitionFailure) throw Error("SYNTHETIC_ACQUISITION_QUERY_FAILURE");
        return { rows: [{ acquired: control.acquired }] };
      }
      if (sql.includes("CREATE TABLE") && control.migrationFailure)
        throw Error("SYNTHETIC_MIGRATION_FAILURE");
      return { rows: [] };
    });
    release = vi.fn();
  }
  class Pool extends EventEmitter {
    client = new Client();
    connect = vi.fn(async () => this.client);
    query = vi.fn(async () => ({ rows: [] }));
    end = vi.fn(async () => undefined);
    constructor(_options: unknown) {
      super();
      control.pools.push(this);
    }
  }
  return { Pool };
});
import { Store } from "../src/store.ts";

beforeEach(() => {
  control.pools = [];
  control.acquired = true;
  control.acquisitionFailure = false;
  control.migrationFailure = false;
});
const pool = () => control.pools.at(-1)!;
const open = () => new Store().open("postgresql://synthetic.invalid/lease-tests", undefined, true);

describe("worker PostgreSQL lease session fencing", () => {
  it("routes migrations, writes and arbitrary SQL query through the exact leased session", async () => {
    const store = await open(),
      pg = pool();
    expect(store.workerLeaseHealthy).toBe(true);
    expect(() => store.assertWorkerLease()).not.toThrow();
    await store.save("synthetic-state", { counter: 1 });
    await store.query("UPDATE phantom_state SET updated_at=1");
    await store.exec("SELECT 1");
    expect(pg.query).not.toHaveBeenCalled();
    expect(pg.client.query.mock.calls[0][0]).toContain("pg_try_advisory_lock");
    expect(pg.client.query.mock.calls[1][0]).toContain("CREATE TABLE");
    expect(pg.client.query.mock.calls.some(([sql]: [string]) => sql.startsWith("UPDATE"))).toBe(
      true,
    );
    await store.close();
  });
  it.each(["error", "end"])(
    "permanently rejects new operations after lease %s without unhandled events or pool fallback",
    async (event) => {
      const store = await open(),
        pg = pool();
      expect(() => pg.client.emit(event, Error("SYNTHETIC_LEASE_DISCONNECT"))).not.toThrow();
      expect(store.workerLeaseHealthy).toBe(false);
      expect(() => store.assertWorkerLease()).toThrow("PHANTOM_WORKER_LEASE_LOST");
      const before = pg.client.query.mock.calls.length;
      await expect(store.save("synthetic", {})).rejects.toThrow("PHANTOM_WORKER_LEASE_LOST");
      await expect(store.query("UPDATE phantom_state SET updated_at=2")).rejects.toThrow(
        "PHANTOM_WORKER_LEASE_LOST",
      );
      await expect(store.acquireWorkerLease()).rejects.toThrow("PHANTOM_WORKER_LEASE_LOST");
      expect(pg.client.query).toHaveBeenCalledTimes(before);
      expect(pg.query).not.toHaveBeenCalled();
      await store.close();
      await store.close();
      expect(pg.client.release).toHaveBeenCalledExactlyOnceWith(true);
      expect(pg.end).toHaveBeenCalledOnce();
    },
  );
  it("rejects an in-flight failed write as lease loss and never retries it through a different session", async () => {
    const store = await open(),
      pg = pool();
    let rejectWrite!: (error: Error) => void;
    pg.client.query.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectWrite = reject;
        }),
    );
    const writing = store.save("synthetic", {});
    pg.client.emit("error", Error("SYNTHETIC_BACKEND_TERMINATED"));
    rejectWrite(Error("SYNTHETIC_CONNECTION_CLOSED"));
    await expect(writing).rejects.toThrow("PHANTOM_WORKER_LEASE_LOST");
    await expect(store.exec("INSERT INTO phantom_state VALUES ('synthetic')")).rejects.toThrow(
      "PHANTOM_WORKER_LEASE_LOST",
    );
    expect(pg.query).not.toHaveBeenCalled();
    expect(pg.connect).toHaveBeenCalledOnce();
    await store.close();
  });
  it("preserves the lease after an ordinary SQL rejection on a healthy session", async () => {
    const store = await open(),
      pg = pool();
    pg.client.query.mockRejectedValueOnce(Error("SYNTHETIC_SQL_CONSTRAINT_FAILURE"));
    await expect(store.exec("SYNTHETIC INVALID SQL")).rejects.toThrow(
      "SYNTHETIC_SQL_CONSTRAINT_FAILURE",
    );
    expect(store.workerLeaseHealthy).toBe(true);
    await store.save("synthetic", {});
    await store.close();
  });
  it("handles pool idle errors without transferring worker queries to another client", async () => {
    const store = await open(),
      pg = pool();
    expect(() => pg.emit("error", Error("SYNTHETIC_IDLE_ERROR"), {})).not.toThrow();
    expect(store.workerLeaseHealthy).toBe(true);
    await store.save("synthetic", {});
    expect(pg.query).not.toHaveBeenCalled();
    await store.close();
  });
});

describe("store startup and shutdown cleanup", () => {
  it.each(["contended", "acquisition-query", "migration"])(
    "releases startup resources exactly once after %s failure",
    async (failure) => {
      if (failure === "contended") control.acquired = false;
      if (failure === "acquisition-query") control.acquisitionFailure = true;
      if (failure === "migration") control.migrationFailure = true;
      const store = new Store();
      await expect(
        store.open("postgresql://synthetic.invalid/lease-tests", undefined, true),
      ).rejects.toThrow(
        failure === "contended"
          ? "PHANTOM_WORKER_ALREADY_RUNNING_FOR_DATABASE"
          : failure === "acquisition-query"
            ? "SYNTHETIC_ACQUISITION_QUERY_FAILURE"
            : "SYNTHETIC_MIGRATION_FAILURE",
      );
      const pg = pool();
      expect(pg.client.release).toHaveBeenCalledExactlyOnceWith(true);
      expect(pg.end).toHaveBeenCalledOnce();
      expect(store.workerLeaseHealthy).toBe(false);
      await store.close();
      expect(pg.end).toHaveBeenCalledOnce();
    },
  );
  it("destroys the leased session and ends its pool even when advisory unlock fails", async () => {
    const store = await open(),
      pg = pool();
    pg.client.query.mockRejectedValueOnce(Error("SYNTHETIC_UNLOCK_FAILURE"));
    await expect(store.close()).resolves.toBeUndefined();
    expect(pg.client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(pg.end).toHaveBeenCalledOnce();
    await store.close();
    expect(pg.end).toHaveBeenCalledOnce();
  });
  it("rejects new worker dispatch synchronously once shutdown starts", async () => {
    const store = await open(),
      pg = pool();
    let releaseUnlock!: () => void;
    pg.client.query.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseUnlock = () => resolve({ rows: [] });
        }),
    );
    const closing = store.close(),
      queries = pg.client.query.mock.calls.length;
    expect(store.workerLeaseHealthy).toBe(false);
    await expect(store.save("synthetic", {})).rejects.toThrow("PHANTOM_WORKER_LEASE_LOST");
    expect(pg.client.query).toHaveBeenCalledTimes(queries);
    releaseUnlock();
    await closing;
    expect(pg.client.release).toHaveBeenCalledOnce();
  });
  it("does not retain a lease acquired after concurrent startup shutdown", async () => {
    const store = new Store();
    const opening = store.open("postgresql://synthetic.invalid/lease-tests", undefined, true);
    const pg = pool();
    let acquired!: () => void;
    pg.client.query.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          acquired = () => resolve({ rows: [{ acquired: true }] });
        }),
    );
    await vi.waitFor(() => expect(acquired).toBeTypeOf("function"));
    await store.close();
    acquired();
    await expect(opening).rejects.toThrow("STORE_NOT_OPEN");
    expect(pg.client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(pg.end).toHaveBeenCalledOnce();
    expect(store.workerLeaseHealthy).toBe(false);
    expect((store as any).lockClient).toBeNull();
  });
  it("does not mark an intentional shutdown as unexpected lease loss", async () => {
    const store = await open(),
      pg = pool();
    pg.client.release.mockImplementation(() => pg.client.emit("end"));
    await store.close();
    expect((store as any).leaseLost).toBe(false);
  });
  it("retains normal pooling and a no-op lease assertion for non-worker stores", async () => {
    const store = await new Store().open("postgresql://synthetic.invalid/reader");
    const pg = pool();
    expect(() => store.assertWorkerLease()).not.toThrow();
    await store.query("SELECT 1");
    expect(pg.query).toHaveBeenCalledTimes(2);
    expect(pg.connect).not.toHaveBeenCalled();
    expect(() => pg.emit("error", Error("SYNTHETIC_IDLE_ERROR"), {})).not.toThrow();
    await store.close();
    expect(pg.end).toHaveBeenCalledOnce();
  });
});

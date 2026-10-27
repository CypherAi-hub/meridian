/** Recorded public fixture; synthetic callback ordering and an entirely in-memory Store. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Engine } from "../src/engine.ts";
import type { RpcTransaction } from "../src/decoder.ts";
import type { ChainEvent } from "../src/types.ts";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function setup() {
  vi.stubEnv("PHANTOM_QUOTE_RESEARCH", "false");
  const fetch = vi.fn(() => { throw Error("UNEXPECTED_NETWORK_IN_OFFLINE_TEST"); });
  vi.stubGlobal("fetch", fetch);
  const tx = JSON.parse(readFileSync(new URL("./fixtures/real-pump-buy.json", import.meta.url), "utf8")) as RpcTransaction;
  const engine = new Engine(), rows = new Map<string, ChainEvent>();
  const store = {
    transaction: vi.fn(async () => {}),
    event: vi.fn(async (event: ChainEvent) => {
      if (rows.has(event.id)) return false;
      rows.set(event.id, structuredClone(event)); return true;
    }),
    exec: vi.fn(async (_sql: string, args: unknown[]) => ({ rows: args.filter((_, i) => i % 5 === 0).map((id) => ({ id })) })),
  };
  (engine as any).store = store;
  const schedule = vi.fn(); (engine as any).schedule = schedule;
  return { engine, store, rows, schedule, tx, fetch };
}

describe("Engine finalized admission boundary", () => {
  it("rejects confirmed transactions before persistence so the later finalized callback is not poisoned", async () => {
    const f = setup();
    await expect(f.engine.receive(f.tx, 1000, "confirmed")).rejects.toThrow("NON_FINALIZED_TRANSACTION_REJECTED");
    expect(f.store.transaction).not.toHaveBeenCalled();
    expect(f.store.event).not.toHaveBeenCalled();
    expect((f.engine as any).trades).toEqual([]);
    expect(f.schedule).not.toHaveBeenCalled();
    await f.engine.receive(f.tx, 2000, "finalized");
    expect(f.rows.size).toBeGreaterThan(0);
    expect((f.engine as any).trades).toHaveLength(1);
    expect(f.schedule).toHaveBeenCalled();
    for (const event of f.rows.values()) expect(event.commitment).toBe("finalized");
    const calls = f.schedule.mock.calls.length;
    await f.engine.receive(f.tx, 3000, "finalized");
    expect(f.schedule).toHaveBeenCalledTimes(calls);
    expect((f.engine as any).trades).toHaveLength(1);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("rejects a runtime non-finalized log envelope before decoder-generated finality can mask it", async () => {
    const f = setup(), envelope = {
      signature: f.tx.transaction.signatures[0], slot: f.tx.slot,
      logs: f.tx.meta!.logMessages!, receivedAt: 1000, commitment: "confirmed",
    };
    await expect(f.engine.recordLogs(envelope as any)).rejects.toThrow("NON_FINALIZED_LOGS_REJECTED");
    expect(f.store.exec).not.toHaveBeenCalled();
    expect((f.engine as any).trades).toEqual([]);
    await f.engine.recordLogs({ ...envelope, commitment: "finalized" });
    expect(f.store.exec).toHaveBeenCalledTimes(1);
    expect((f.engine as any).trades).toHaveLength(1);
    expect(f.fetch).not.toHaveBeenCalled();
  });
});

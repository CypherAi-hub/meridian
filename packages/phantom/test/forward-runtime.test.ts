import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Store } from "../src/store.ts";
import { ForwardSqlJournal } from "../src/forward-cohort-store.ts";
import {
  FORWARD_SCOPE,
  FORWARD_WSOL,
  freezeForwardProtocol,
  forwardHash,
  type ForwardProbe,
  type ForwardRecord,
} from "../src/forward-cohort.ts";
import {
  FORWARD_ACTIVE_STATE_KEY,
  ForwardRuntime,
  forwardRetirementStateKey,
  type ForwardRuntimeStore,
} from "../src/forward-runtime.ts";

// Synthetic contract fixtures only. These quotes/timestamps are not market evidence.
const SOURCE_A = "a".repeat(64),
  SOURCE_B = "b".repeat(64),
  COMMIT = "c".repeat(40);
const mint = "A".repeat(32);
function probe(): ForwardProbe {
  return {
    id: "synthetic-runtime-probe",
    mint,
    signature: "c".repeat(88),
    slot: 1,
    protocol: "pump",
    kind: "buy",
    eventObservedAt: 3000,
    startedAt: 4000,
    completedAt: 4600,
    amountLamports: "10000000",
    buy: {
      inputMint: FORWARD_WSOL,
      outputMint: mint,
      inAmount: "10000000",
      outAmount: "1000000",
      minOutAmount: "990000",
      observedAt: 4100,
    },
    sell: {
      inputMint: mint,
      outputMint: FORWARD_WSOL,
      inAmount: "990000",
      outAmount: "9969000",
      minOutAmount: "9880000",
      observedAt: 4500,
    },
  };
}

/** Implements the exact immutable SQL operations, and rejects unexpected statements. */
class MemoryStore implements ForwardRuntimeStore {
  protocols = new Map<string, unknown>();
  records = new Map<string, ForwardRecord>();
  state = new Map<string, unknown>();
  healthy = true;
  loseProtocolAck = false;
  losePointerWrite = false;
  loseRetirementAck = false;
  loseRetirementRecoveryRead = false;
  failProtocolBeforeWrite = false;
  writes = 0;
  assertWorkerLease() {
    if (!this.healthy) throw Error("PHANTOM_WORKER_LEASE_LOST");
  }
  async exec(sql: string, args: unknown[] = []) {
    this.assertWorkerLease();
    if (sql.includes("CREATE TABLE IF NOT EXISTS phantom_forward_protocols")) return;
    if (sql.startsWith("INSERT INTO phantom_forward_protocols")) {
      if (this.failProtocolBeforeWrite) {
        this.failProtocolBeforeWrite = false;
        throw Error("SYNTHETIC_PROTOCOL_NOT_WRITTEN");
      }
      this.writes++;
      if (!this.protocols.has(String(args[0])))
        this.protocols.set(String(args[0]), JSON.parse(String(args[1])));
      if (this.loseProtocolAck) {
        this.loseProtocolAck = false;
        throw Error("SYNTHETIC_ACK_LOST");
      }
      return;
    }
    if (sql.startsWith("INSERT INTO phantom_forward_records")) {
      this.writes++;
      const row = JSON.parse(String(args[5])) as ForwardRecord;
      const duplicatePhase = [...this.records.values()].some(
        (r) => r.experimentId === row.experimentId && r.mint === row.mint && r.phase === row.phase,
      );
      if (!this.protocols.has(row.experimentId)) throw Error("SYNTHETIC_FOREIGN_KEY");
      if (!this.records.has(row.id) && !duplicatePhase) this.records.set(row.id, row);
      return;
    }
    if (
      sql ===
      "INSERT INTO phantom_state(id,payload,updated_at) VALUES($1,$2::jsonb,$3) ON CONFLICT(id) DO NOTHING"
    ) {
      this.writes++;
      if (!this.state.has(String(args[0])))
        this.state.set(String(args[0]), JSON.parse(String(args[1])));
      if (this.loseRetirementAck) {
        this.loseRetirementAck = false;
        throw Error("SYNTHETIC_RETIREMENT_ACK_LOST");
      }
      return;
    }
    throw Error(`Unexpected fixture SQL: ${sql}`);
  }
  async query(sql: string, args: unknown[] = []): Promise<Array<{ payload: unknown }>> {
    this.assertWorkerLease();
    let rows: unknown[];
    if (sql === "SELECT payload FROM phantom_forward_protocols WHERE experiment_id=$1")
      rows = this.protocols.has(String(args[0])) ? [this.protocols.get(String(args[0]))] : [];
    else if (sql === "SELECT payload FROM phantom_forward_protocols")
      rows = [...this.protocols.values()];
    else if (sql === "SELECT payload FROM phantom_forward_records WHERE id=$1")
      rows = this.records.has(String(args[0])) ? [this.records.get(String(args[0]))] : [];
    else if (
      sql === "SELECT payload FROM phantom_forward_records WHERE experiment_id=$1 ORDER BY at,id"
    )
      rows = [...this.records.values()]
        .filter((r) => r.experimentId === args[0])
        .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    else throw Error(`Unexpected fixture SQL: ${sql}`);
    return rows.map((payload) => ({ payload: structuredClone(payload) }));
  }
  async get(id: string) {
    this.assertWorkerLease();
    if (
      this.loseRetirementRecoveryRead &&
      id.startsWith("forward-runtime-retirement-v1:") &&
      this.state.has(id)
    ) {
      this.loseRetirementRecoveryRead = false;
      throw Error("SYNTHETIC_RETIREMENT_READ_ACK_LOST");
    }
    return structuredClone(this.state.get(id) ?? null);
  }
  async save(id: string, value: unknown) {
    this.assertWorkerLease();
    if (id === FORWARD_ACTIVE_STATE_KEY && this.losePointerWrite) {
      this.losePointerWrite = false;
      throw Error("SYNTHETIC_CRASH_BEFORE_POINTER");
    }
    this.writes++;
    this.state.set(id, structuredClone(value));
  }
}
const create = (
  store: ForwardRuntimeStore,
  clock: { now: number },
  source = SOURCE_A,
  commit = COMMIT,
  retireInterruptedEpoch = false,
) =>
  new ForwardRuntime(store, {
    runtimeSourceVersion: source,
    sourceCommit: commit,
    now: () => clock.now,
    retireInterruptedEpoch,
  });

async function enrollmentAndIntent(
  store: ForwardRuntimeStore,
  runtime: ForwardRuntime,
  clock: { now: number },
) {
  clock.now = 5000;
  expect((await runtime.collector.considerProbe(probe())).status).toBe(
    "ENROLLED_FRESH_ENTRY_REQUIRED",
  );
  const p = runtime.protocol;
  clock.now = 37000;
  await new ForwardSqlJournal(store).append({
    id: `${p.experimentId}:${mint}:ENTRY_REQUEST`,
    experimentId: p.experimentId,
    configurationHash: p.configurationHash,
    scope: FORWARD_SCOPE,
    mint,
    phase: "ENTRY_REQUEST",
    at: clock.now,
    data: {
      requestIntentAt: clock.now,
      dueAt: 37000,
      deadlineAt: 42000,
      inputMint: FORWARD_WSOL,
      outputMint: mint,
      amountRaw: p.amountLamports,
    },
  });
}

describe("durable forward runtime (synthetic contract fixtures)", () => {
  it("refuses changed sources by default before target manifests, retirement or provider recovery", async () => {
    const store = new MemoryStore(),
      clock = { now: 1000 };
    const first = await create(store, clock).initialize();
    await enrollmentAndIntent(store, first, clock);
    const original = await first.export(),
      pointer = await store.get(FORWARD_ACTIVE_STATE_KEY);
    clock.now = 38000;
    await expect(create(store, clock, SOURCE_B).initialize()).rejects.toThrow(
      "SOURCE_CHANGE_REQUIRES_RETIREMENT",
    );
    expect(store.protocols.size).toBe(1);
    expect(await store.get(FORWARD_ACTIVE_STATE_KEY)).toEqual(pointer);
    expect(await store.get(forwardRetirementStateKey(first.protocol.experimentId))).toBeNull();
    expect((await first.export()).records).toEqual(original.records);
    expect(store.records.size).toBe(2); // No interrupted-request result is invented for the old epoch.
  });

  it("durably labels the old epoch incomplete, binds its original journal/bounds, and refuses rollback", async () => {
    const store = new MemoryStore(),
      clock = { now: 1000 };
    const first = await create(store, clock).initialize();
    await enrollmentAndIntent(store, first, clock);
    const before = await first.export();
    clock.now = 38000;
    const next = await create(store, clock, SOURCE_B, COMMIT, true).initialize();
    const old = await next.export(first.protocol.experimentId),
      retirement = old.retirement!;
    expect(retirement).toMatchObject({
      schemaVersion: 1,
      status: "INCOMPLETE",
      reason: "SOURCE_CHANGED",
      cutoffAt: 38000,
      oldExperimentId: first.protocol.experimentId,
      oldRuntimeSourceVersion: SOURCE_A,
      oldConfigurationHash: first.protocol.configurationHash,
      originalEnrollmentStart: first.protocol.enrollmentStart,
      originalEnrollmentEnd: first.protocol.enrollmentEnd,
      newExperimentId: next.protocol.experimentId,
      newRuntimeSourceVersion: SOURCE_B,
      journalRecordCount: 2,
      journalCanonicalSha256: forwardHash(before.records),
      targetProtocol: next.protocol,
    });
    expect(Object.isFrozen(retirement)).toBe(true);
    expect(old.protocol).toEqual(before.protocol);
    expect(old.records).toEqual(before.records);
    const history = await next.history();
    expect(history[0]).toMatchObject({ active: false, retirement });
    expect(history[1]).toMatchObject({ active: true });
    const writes = store.writes;
    await expect(create(store, clock, SOURCE_A, COMMIT, true).initialize()).rejects.toThrow(
      "EPOCH_RETIRED",
    );
    expect(store.writes).toBe(writes);
    expect(store.records.size).toBe(2);
    expect(await store.get(forwardRetirementStateKey(first.protocol.experimentId))).toEqual(
      retirement,
    );
  });

  it("reuses original retirement and target protocol after a crash before pointer replacement", async () => {
    const store = new MemoryStore(),
      clock = { now: 1000 };
    const first = await create(store, clock).initialize();
    await enrollmentAndIntent(store, first, clock);
    clock.now = 38000;
    store.losePointerWrite = true;
    await expect(create(store, clock, SOURCE_B, COMMIT, true).initialize()).rejects.toThrow(
      "CRASH_BEFORE_POINTER",
    );
    const retirement = (await store.get(
      forwardRetirementStateKey(first.protocol.experimentId),
    )) as any;
    expect(retirement.cutoffAt).toBe(38000);
    expect(((await store.get(FORWARD_ACTIVE_STATE_KEY)) as any).runtimeSourceVersion).toBe(
      SOURCE_A,
    );
    // Retirement alone forbids old-source recovery, even while its pointer remains.
    await expect(create(store, clock).initialize()).rejects.toThrow("EPOCH_RETIRED");
    await expect(create(store, clock, "d".repeat(64), COMMIT, true).initialize()).rejects.toThrow(
      "RETIREMENT_TARGET_MISMATCH",
    );
    clock.now += 80 * 3_600_000;
    await expect(create(store, clock, SOURCE_B).initialize()).rejects.toThrow(
      "SOURCE_CHANGE_REQUIRES_RETIREMENT",
    );
    const recovered = await create(store, clock, SOURCE_B, "e".repeat(40), true).initialize();
    expect(recovered.protocol).toEqual(retirement.targetProtocol);
    expect(recovered.protocol.frozenAt).toBe(38000);
    expect(recovered.protocol.sourceCommit).toBe(COMMIT);
    expect(await store.get(forwardRetirementStateKey(first.protocol.experimentId))).toEqual(
      retirement,
    );
    expect(
      (await recovered.export(first.protocol.experimentId)).records.map((r) => r.phase),
    ).toEqual(["ENROLLMENT", "ENTRY_REQUEST"]);
  });

  it("does not open a new enrollment window when retirement committed before a failed target manifest write", async () => {
    const store = new MemoryStore(),
      clock = { now: 1000 };
    const first = await create(store, clock).initialize();
    clock.now = 6000;
    store.failProtocolBeforeWrite = true;
    await expect(create(store, clock, SOURCE_B, COMMIT, true).initialize()).rejects.toThrow(
      "PROTOCOL_NOT_WRITTEN",
    );
    const retirement = (await store.get(
      forwardRetirementStateKey(first.protocol.experimentId),
    )) as any;
    expect(store.protocols.size).toBe(1);
    expect(retirement.targetProtocol.frozenAt).toBe(6000);
    clock.now = 9000;
    const next = await create(store, clock, SOURCE_B, "d".repeat(40), true).initialize();
    expect(next.protocol).toEqual(retirement.targetProtocol);
    expect(next.protocol.enrollmentStart).toBe(7000);
    expect(await store.get(forwardRetirementStateKey(first.protocol.experimentId))).toEqual(
      retirement,
    );
  });

  it("reconciles lost retirement and target-manifest acknowledgements without replacing original clocks", async () => {
    const store = new MemoryStore(),
      clock = { now: 1000 };
    const first = await create(store, clock).initialize();
    clock.now = 6000;
    store.loseRetirementAck = true;
    store.loseProtocolAck = true;
    const next = await create(store, clock, SOURCE_B, COMMIT, true).initialize();
    expect(next.protocol.frozenAt).toBe(6000);
    expect((await next.export(first.protocol.experimentId)).retirement?.cutoffAt).toBe(6000);
    expect(
      [...store.state.keys()].filter((key) => key.startsWith("forward-runtime-retirement-v1:")),
    ).toHaveLength(1);
    clock.now = 8000;
    const restarted = await create(store, clock, SOURCE_B).initialize();
    expect(restarted.protocol).toEqual(next.protocol);
    expect((await restarted.export(first.protocol.experimentId)).retirement?.cutoffAt).toBe(6000);
  });

  it("recovers an ambiguously acknowledged retirement on a later restart without resetting its target window", async () => {
    const store = new MemoryStore(),
      clock = { now: 1000 };
    const first = await create(store, clock).initialize();
    clock.now = 6000;
    store.loseRetirementAck = true;
    store.loseRetirementRecoveryRead = true;
    await expect(create(store, clock, SOURCE_B, COMMIT, true).initialize()).rejects.toThrow(
      "RETIREMENT_READ_ACK_LOST",
    );
    const original = (await store.get(
      forwardRetirementStateKey(first.protocol.experimentId),
    )) as any;
    expect(store.protocols.size).toBe(1);
    clock.now = 9000;
    const next = await create(store, clock, SOURCE_B, "d".repeat(40), true).initialize();
    expect(next.protocol).toEqual(original.targetProtocol);
    expect(next.protocol.frozenAt).toBe(6000);
    expect(await store.get(forwardRetirementStateKey(first.protocol.experimentId))).toEqual(
      original,
    );
  });

  it("does not use a malformed source-bearing pointer to bypass retirement authorization", async () => {
    const store = new MemoryStore(),
      clock = { now: 1000 };
    const first = await create(store, clock).initialize();
    await store.save(FORWARD_ACTIVE_STATE_KEY, {
      version: 1,
      experimentId: first.protocol.experimentId,
      runtimeSourceVersion: SOURCE_A,
    });
    await expect(create(store, clock, SOURCE_B).initialize()).rejects.toThrow(
      "ACTIVE_POINTER_INVALID",
    );
    expect(store.protocols.size).toBe(1);
    expect(await store.get(forwardRetirementStateKey(first.protocol.experimentId))).toBeNull();
  });

  it("fails closed when an external writer changes journal bytes behind a retirement fingerprint", async () => {
    const store = new MemoryStore(),
      clock = { now: 1000 };
    const first = await create(store, clock).initialize();
    clock.now = 5000;
    await first.collector.considerProbe(probe());
    clock.now = 6000;
    const next = await create(store, clock, SOURCE_B, COMMIT, true).initialize();
    const row = [...store.records.values()][0];
    store.records.set(row.id, { ...row, data: { ...row.data, externalMutation: true } });
    await expect(next.export(first.protocol.experimentId)).rejects.toThrow(
      "RETIRED_JOURNAL_CHANGED",
    );
    await expect(next.history()).rejects.toThrow("RETIRED_JOURNAL_CHANGED");
  });

  it("reuses the original manifest, commit and closed enrollment on same-source restart", async () => {
    const store = new MemoryStore(),
      clock = { now: 1000 };
    const first = await create(store, clock).initialize(),
      original = first.protocol;
    clock.now = original.enrollmentEnd + 1000;
    const restarted = await create(store, clock, SOURCE_A, "d".repeat(40)).initialize();
    expect(restarted.protocol).toEqual(original);
    expect(restarted.protocol.sourceCommit).toBe(COMMIT);
    expect((await restarted.collector.considerProbe(probe())).status).toBe(
      "OUTSIDE_ENROLLMENT_WINDOW",
    );
    expect(store.protocols.size).toBe(1);
    expect(Object.isFrozen(restarted.protocol)).toBe(true);
  });

  it("finds orphan manifests before freeze when a crash prevents the active pointer", async () => {
    const store = new MemoryStore(),
      clock = { now: 1000 };
    store.losePointerWrite = true;
    await expect(create(store, clock).initialize()).rejects.toThrow("CRASH_BEFORE_POINTER");
    expect(store.state.has(FORWARD_ACTIVE_STATE_KEY)).toBe(false);
    clock.now += 80 * 3_600_000;
    const recovered = await create(store, clock).initialize();
    expect(recovered.protocol.frozenAt).toBe(1000);
    expect(recovered.protocol.enrollmentEnd).toBe(1000 + 72 * 3_600_000);
    expect(store.protocols.size).toBe(1);
  });

  it("reconciles a lost protocol INSERT acknowledgement without a second manifest", async () => {
    const store = new MemoryStore(),
      clock = { now: 1000 };
    store.loseProtocolAck = true;
    const runtime = await create(store, clock).initialize();
    expect(runtime.protocol.frozenAt).toBe(1000);
    expect(store.protocols.size).toBe(1);
    await runtime.initialize();
    expect(store.protocols.size).toBe(1);
  });

  it("serializes concurrent same-source starts and ignores a stale advisory pointer", async () => {
    const store = new MemoryStore(),
      clock = { now: 1000 };
    await store.save(FORWARD_ACTIVE_STATE_KEY, { version: 1, experimentId: "nonexistent" });
    const [a, b] = await Promise.all([
      create(store, clock).initialize(),
      create(store, clock).initialize(),
    ]);
    expect(a.protocol).toEqual(b.protocol);
    expect(store.protocols.size).toBe(1);
    expect((await a.history()).map((p) => p.active)).toEqual([true]);
    await expect(a.collector.nextQuoteWindow()).rejects.toThrow("SUPERSEDED");
    expect(await b.collector.nextQuoteWindow()).toBeNull();
  });

  it("preserves old rows on source changes, invalidates old collectors and leaves paper state untouched", async () => {
    const store = new MemoryStore(),
      clock = { now: 1000 };
    const paper = { cashLamports: "1234567", positions: [{ id: "synthetic-paper-sentinel" }] };
    await store.save("ledger", paper);
    const a = await create(store, clock).initialize(),
      oldCollector = a.collector;
    clock.now = 5000;
    await a.collector.considerProbe(probe());
    const oldExport = await a.export();
    clock.now = 6000;
    const b = await create(store, clock, SOURCE_B, COMMIT, true).initialize();
    expect(b.protocol.experimentId).not.toBe(a.protocol.experimentId);
    expect((await b.history()).map((p) => p.active)).toEqual([false, true]);
    expect((await b.export(a.protocol.experimentId)).records).toEqual(oldExport.records);
    expect((await b.export(a.protocol.experimentId)).protocol).toEqual(a.protocol);
    let calls = 0;
    await expect(
      oldCollector.tick({
        quote: async () => {
          calls++;
          throw Error("must not call");
        },
      }),
    ).rejects.toThrow("SUPERSEDED");
    await expect(a.initialize()).rejects.toThrow("SUPERSEDED");
    expect(calls).toBe(0);
    expect(await store.get("ledger")).toEqual(paper);
    expect(store.protocols.size).toBe(2);
  });

  it("reconciles interrupted current requests exactly once without reissuing quotes", async () => {
    const store = new MemoryStore(),
      clock = { now: 1000 };
    const first = await create(store, clock).initialize();
    await enrollmentAndIntent(store, first, clock);
    clock.now = 38000;
    const recovered = await create(store, clock).initialize();
    const rows = (await recovered.export()).records;
    expect(rows).toHaveLength(3);
    expect(rows[2].data.status).toBe("INTERRUPTED_UNKNOWN_NO_RETRY");
    await create(store, clock).initialize();
    expect(store.records.size).toBe(3);
    await expect(recovered.collector.nextQuoteWindow()).rejects.toThrow("SUPERSEDED");
  });

  it("exports historical interrupted requests read-only without initializing an old-source collector", async () => {
    const store = new MemoryStore(),
      clock = { now: 1000 };
    const first = await create(store, clock).initialize();
    await enrollmentAndIntent(store, first, clock);
    clock.now = 38000;
    const current = await create(store, clock, SOURCE_B, COMMIT, true).initialize();
    const writes = store.writes;
    const result = await current.export(first.protocol.experimentId);
    expect(result.records.map((r) => r.phase)).toEqual(["ENROLLMENT", "ENTRY_REQUEST"]);
    expect(result.protocol).toEqual(first.protocol);
    expect(result.exportedAt).toBe(clock.now);
    expect(result.costAudit.breakEvenExitProceedsLamports).toBe("10020000");
    await current.history();
    expect(store.writes).toBe(writes);
    expect(store.records.size).toBe(2);
  });

  it("rejects absent, invalid or unknown exports honestly without creating data", async () => {
    const store = new MemoryStore(),
      clock = { now: 1000 },
      runtime = create(store, clock);
    expect(() => runtime.export()).toThrow("NOT_INITIALIZED");
    expect(() => runtime.protocol).toThrow("NOT_INITIALIZED");
    expect(store.protocols.size).toBe(0);
    await runtime.initialize();
    const writes = store.writes;
    await expect(runtime.export("../other")).rejects.toThrow("ID_INVALID");
    await expect(runtime.export("x".repeat(129))).rejects.toThrow("ID_INVALID");
    await expect(runtime.export("unknown-valid-id")).rejects.toThrow("NOT_FOUND");
    expect(store.writes).toBe(writes);
  });

  it("fails closed for invalid source, commit, time, corrupt manifest and lost lease", async () => {
    const store = new MemoryStore(),
      clock = { now: 1000 };
    expect(() => create(store, clock, "A".repeat(64))).toThrow("SOURCE_INVALID");
    expect(() => create(store, clock, SOURCE_A, "short")).toThrow("COMMIT_INVALID");
    await expect(create(store, { now: Number.NaN }).initialize()).rejects.toThrow("CLOCK_INVALID");
    const runtime = await create(store, clock).initialize();
    store.protocols.set(runtime.protocol.experimentId, {
      ...runtime.protocol,
      runtimeSourceVersion: SOURCE_B,
    });
    await expect(create(store, clock).initialize()).rejects.toThrow("PROTOCOL_INVALID_OR_CHANGED");
    store.healthy = false;
    await expect(runtime.collector.nextQuoteWindow()).rejects.toThrow("LEASE_LOST");
    await expect(runtime.export()).rejects.toThrow("LEASE_LOST");
  });

  it("rejects a valid but source-mismatched manifest and disables the previous source on failed replacement", async () => {
    const store = new MemoryStore(),
      clock = { now: 1000 };
    const first = await create(store, clock).initialize();
    const id = `post-probe-60s-v1-${SOURCE_B}`;
    store.protocols.set(
      id,
      freezeForwardProtocol({
        now: 1000,
        runtimeSourceVersion: SOURCE_A,
        sourceCommit: COMMIT,
        experimentId: id,
      }),
    );
    await expect(create(store, clock, SOURCE_B, COMMIT, true).initialize()).rejects.toThrow(
      "SOURCE_MISMATCH",
    );
    await expect(first.collector.nextQuoteWindow()).rejects.toThrow("SUPERSEDED");
    expect(store.protocols.size).toBe(2);
  });

  it("waits for old in-flight provider work before switching and rejects its next request", async () => {
    const store = new MemoryStore(),
      clock = { now: 1000 };
    const a = await create(store, clock).initialize();
    clock.now = 5000;
    await a.collector.considerProbe(probe());
    clock.now = 37000;
    let release!: () => void, signal!: () => void;
    const entered = new Promise<void>((r) => {
      signal = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const tick = a.collector.tick({
      quote: async (request) => {
        signal();
        await gate;
        return {
          inputMint: request.inputMint,
          outputMint: request.outputMint,
          inAmount: request.amount.toString(),
          outAmount: "808000",
          minOutAmount: "800000",
          observedAt: clock.now,
        };
      },
    });
    await entered;
    let switched = false;
    const initializing = create(store, clock, SOURCE_B, COMMIT, true)
      .initialize()
      .then((b) => {
        switched = true;
        return b;
      });
    await Promise.resolve();
    expect(switched).toBe(false);
    expect(await store.get(forwardRetirementStateKey(a.protocol.experimentId))).toBeNull();
    clock.now = 38000;
    release();
    await tick;
    const b = await initializing;
    expect(b.protocol.runtimeSourceVersion).toBe(SOURCE_B);
    await expect(a.collector.nextQuoteWindow()).rejects.toThrow("SUPERSEDED");
    expect((await b.export(a.protocol.experimentId)).records).toHaveLength(3);
    expect((await b.export(a.protocol.experimentId)).retirement).toMatchObject({
      cutoffAt: 38000,
      journalRecordCount: 3,
      journalCanonicalSha256: forwardHash((await b.export(a.protocol.experimentId)).records),
    });
  });

  it("uses real fenced temporary PGlite SQL and preserves manifests/history across close and reopen", async () => {
    const parent = resolve(tmpdir()),
      dir = await mkdtemp(join(parent, "phantom-forward-runtime-test-"));
    let store: Store | undefined;
    const clock = { now: 1000 };
    try {
      store = await new Store().open(undefined, dir, true);
      const first = await create(store, clock).initialize(),
        protocol = first.protocol;
      clock.now = 5000;
      await first.collector.considerProbe(probe());
      await store.save("ledger", { cashLamports: "17", syntheticSentinel: true });
      await first.idle();
      await store.close();
      store = undefined;
      clock.now = protocol.enrollmentEnd + 1000;
      store = await new Store().open(undefined, dir, true);
      const restarted = await create(store, clock).initialize();
      expect(restarted.protocol).toEqual(protocol);
      expect((await restarted.export()).records).toHaveLength(1);
      const changed = await create(store, clock, SOURCE_B, COMMIT, true).initialize();
      expect(await changed.history()).toHaveLength(2);
      expect((await changed.export(protocol.experimentId)).records).toHaveLength(1);
      expect(await store.get("ledger")).toEqual({ cashLamports: "17", syntheticSentinel: true });
      const retirement = (await changed.export(protocol.experimentId)).retirement;
      const target = changed.protocol;
      await store.close();
      store = undefined;
      clock.now += 1000;
      store = await new Store().open(undefined, dir, true);
      const resumed = await create(store, clock, SOURCE_B).initialize();
      expect(resumed.protocol).toEqual(target);
      expect((await resumed.export(protocol.experimentId)).retirement).toEqual(retirement);
      await expect(create(store, clock, SOURCE_A, COMMIT, true).initialize()).rejects.toThrow(
        "EPOCH_RETIRED",
      );
    } finally {
      await store?.close();
      // Delete only the exact dedicated mkdtemp child created by this test.
      if (
        dirname(resolve(dir)) !== parent ||
        !basename(dir).startsWith("phantom-forward-runtime-test-")
      )
        throw Error("UNSAFE_TEST_TEMP_PATH");
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);
});

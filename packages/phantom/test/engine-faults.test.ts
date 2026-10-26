/** Fault injection uses synthetic quotes, safety and balances only. No RPC or transaction submission. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine.ts";
import { PaperLedger } from "../src/paper.ts";
import {
  DEFAULT_RISK_LIMITS,
  RiskGovernor,
  checkTokenSafety,
  type TokenSafetyEvidence,
} from "../src/risk.ts";
import { WSOL, json, type ChainEvent } from "../src/types.ts";
import type { Quote } from "../src/execution.ts";
import type { RpcTransaction } from "../src/decoder.ts";

const oldEnvironment = { ...process.env };
const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const name of Object.keys(process.env))
    if (!(name in oldEnvironment)) delete process.env[name];
  Object.assign(process.env, oldEnvironment);
  // Every directory was created directly beneath the OS test temporary directory above.
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function environment() {
  const directory = mkdtempSync(join(tmpdir(), "phantom-engine-faults-"));
  directories.push(directory);
  process.env.PHANTOM_DATA_DIR = join(directory, "db");
  process.env.PHANTOM_KILL_FILE = join(directory, "KILL");
  process.env.PHANTOM_WALLET_HISTORY = "false";
  process.env.PHANTOM_QUOTE_RESEARCH = "false";
  process.env.PHANTOM_MODE = "PAPER";
  process.env.PHANTOM_KILL_SWITCH = "false";
  delete process.env.PHANTOM_DATABASE_URL;
  delete process.env.NODE_ENV;
  return directory;
}
function quote(inputMint: string, outputMint: string, amount: bigint, output: bigint): Quote {
  return {
    inputMint,
    outputMint,
    inAmount: String(amount),
    outAmount: String(output),
    minOutAmount: String(output),
    impactBps: 50,
    observedAt: Date.now(),
    contextSlot: 1,
    route: ["SYNTHETIC FAULT TEST"],
  };
}
function safety(mint: string): TokenSafetyEvidence {
  return {
    mint,
    observedAt: Date.now(),
    mintAuthority: null,
    freezeAuthority: null,
    tokenProgram: "spl-token",
    extensionsVerified: true,
    extensions: [],
    transferFeeBps: 0,
    permanentDelegate: null,
    transferRestricted: false,
    creatorConcentrationBps: 100,
    creatorAssociationsVerified: true,
    creatorAssociatedConcentrationBps: 100,
    topHolderConcentrationBps: 1000,
    knownMalicious: false,
    sellRouteAvailable: true,
    sellRouteObservedAt: Date.now(),
    liquidityAccessible: true,
    abnormalCreatorActivity: false,
  };
}
function event(): ChainEvent {
  return {
    id: "SYNTHETIC-EVENT",
    protocol: "pump",
    kind: "buy",
    signature: "SYNTHETIC-SIGNATURE",
    slot: 1,
    mint: "SYNTHETIC-MINT",
    quoteMint: WSOL,
    actor: "SYNTHETIC-ACTOR",
    pool: "SYNTHETIC-POOL",
    creator: "SYNTHETIC-CREATOR",
    instruction: "buy",
    instructionIndex: "0",
    receivedAt: Date.now(),
    processedAt: Date.now(),
    blockTime: null,
    commitment: "finalized",
    amountRaw: "1000",
    quoteAmountRaw: "10000000",
    quantityEvidence: "program-event",
    details: {},
  };
}
function fixture() {
  const directory = environment(),
    engine = new Engine(),
    internal = engine as any;
  const rows = new Map<string, any>();
  vi.spyOn(engine.store, "save").mockImplementation(async (id, value) => {
    rows.set(id, JSON.parse(json(value)));
  });
  vi.spyOn(engine.store, "get").mockImplementation(async (id) => rows.get(id) ?? null);
  vi.spyOn(engine.store, "decision").mockResolvedValue(undefined);
  internal.ledger = new PaperLedger(1_000_000_000n, new RiskGovernor({ ...DEFAULT_RISK_LIMITS }));
  const e = event();
  internal.events = [e];
  internal.launches.set(e.mint, e);
  vi.spyOn(internal, "feature").mockImplementation(() => ({
    observations: 8,
    organic: { independentBuyerUnits: 8, score: 80 },
    liquidityLamports: 100_000_000_000n,
    executionCostBps: 20,
    creatorSelling: false,
    creatorPriorAdverseOutcomes: 0,
    verifiedLaunchAgeMs: 1000,
    imbalance: 0.8,
    netInflowLamports: 100_000_000n,
    uniqueBuyerAcceleration: 5,
  }));
  vi.spyOn(engine.security, "inspect").mockImplementation(
    async () =>
      ({
        evidence: safety(e.mint),
        observedAt: Date.now(),
        liquidityLamports: 100_000_000_000n,
        curveProgressBps: 1000,
        warnings: [],
      }) as any,
  );
  engine.setQuoteProvider({
    quote: vi.fn(async (input) =>
      input.inputMint === WSOL
        ? quote(WSOL, input.outputMint, input.amount, 1000n)
        : quote(input.inputMint, WSOL, input.amount, 10_000_000n),
    ),
  });
  vi.spyOn(internal, "capture").mockResolvedValue(undefined);
  return { directory, engine, internal, rows, e, ledger: internal.ledger as PaperLedger };
}
function queue(f: ReturnType<typeof fixture>) {
  f.ledger.queue(
    {
      id: "SYNTHETIC-ENTRY",
      mint: f.e.mint,
      strategy: "launch_sniper",
      amountLamports: 10_000_000n,
      eventId: f.e.id,
    },
    Date.now() - 3000,
    2000,
  );
}
function enter(ledger: PaperLedger, mint: string, id: string) {
  const at = Date.now();
  ledger.queue(
    { id, mint, strategy: "launch_sniper", amountLamports: 10_000_000n, eventId: "SYNTHETIC" },
    at - 3000,
    2000,
  );
  const order = ledger.state.pending.find((x) => x.id === id)!;
  expect(
    ledger.fill(
      order,
      quote(WSOL, mint, order.amountLamports, 1000n),
      checkTokenSafety(safety(mint)),
      100_000_000_000n,
      10_000n,
      Date.now(),
    ).allowed,
  ).toBe(true);
  return ledger.state.positions.at(-1)!;
}

describe("engine economic and audit fault boundaries", () => {
  it("persists a filled position before audit capture and preserves it when capture fails", async () => {
    const f = fixture();
    queue(f);
    let captureSawDurableFill = false;
    vi.mocked(f.internal.capture).mockImplementation(async () => {
      captureSawDurableFill =
        f.rows.get("ledger")?.positions.length === 1 && f.rows.get("ledger")?.pending.length === 0;
      throw Error("SYNTHETIC_AUDIT_FAILURE");
    });
    await f.engine.tick();
    expect(captureSawDurableFill).toBe(true);
    expect(f.ledger.state.positions).toHaveLength(1);
    expect(f.ledger.state.cashLamports).toBe(989_990_000n);
    expect(f.rows.get("ledger").positions).toHaveLength(1);
    expect(f.rows.get("suspension").reason).toBe(
      "PAPER_FILL_AUDIT_OR_DURABILITY_FAILED_POSITION_PRESERVED",
    );
    expect(JSON.parse(readFileSync(join(f.directory, "KILL"), "utf8")).schema).toBe(
      "phantom-suspension-v1",
    );
    expect(f.engine.state().decisions.flatMap((d) => d.reasons)).not.toContain(
      "PAPER_ENTRY_FAILED_NO_FILL",
    );
  });
  it("does not reinterpret a settled fill as no-fill when the first ledger checkpoint fails", async () => {
    const f = fixture();
    queue(f);
    const save = vi.mocked(f.engine.store.save),
      normalSave = save.getMockImplementation()!;
    let failed = false;
    save.mockImplementation(async (id, value) => {
      if (id === "ledger" && !failed) {
        failed = true;
        throw Error("SYNTHETIC_DISK_FAILURE");
      }
      return normalSave(id, value);
    });
    await f.engine.tick();
    expect(failed).toBe(true);
    expect(f.ledger.state.positions).toHaveLength(1);
    expect(f.ledger.state.pending).toEqual([]);
    expect(f.ledger.state.killSwitch).toBe(true);
    expect(f.internal.capture).not.toHaveBeenCalled();
    expect(f.rows.get("ledger").positions).toHaveLength(1);
    expect(f.rows.get("suspension")).toBeDefined();
    expect(f.engine.state().decisions.flatMap((d) => d.reasons)).not.toContain(
      "PAPER_ENTRY_FAILED_NO_FILL",
    );
  });
  it("serializes ledger checkpoints and reads the current state when each queued write begins", async () => {
    const f = fixture();
    let release!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observed: number[] = [];
    vi.mocked(f.engine.store.save).mockImplementation(async (id, value: any) => {
      if (id !== "ledger") return;
      observed.push(value.failures);
      if (observed.length === 1) await firstWrite;
    });
    f.ledger.state.failures = 1;
    const first = f.internal.persistLedger();
    await Promise.resolve();
    await Promise.resolve();
    f.ledger.state.failures = 2;
    const second = f.internal.persistLedger();
    await Promise.resolve();
    expect(observed).toEqual([1]);
    release();
    await Promise.all([first, second]);
    expect(observed).toEqual([1, 2]);
  });
  it("checkpoints the first position mark before awaiting the next provider request", async () => {
    const f = fixture(),
      first = enter(f.ledger, f.e.mint, "SYNTHETIC-FIRST"),
      second = enter(f.ledger, "SYNTHETIC-SECOND-MINT", "SYNTHETIC-SECOND");
    f.engine.setQuoteProvider({
      quote: vi.fn(async (input) => {
        if (input.inputMint === second.mint) {
          expect(
            f.rows.get("ledger").positions.find((p: any) => p.id === first.id).markLamports,
          ).toBe("9990000");
        }
        return quote(input.inputMint, WSOL, input.amount, 10_000_000n);
      }),
    });
    await f.engine.tick();
    expect(first.markLamports).toBe(9_990_000n);
    expect(second.markLamports).toBe(9_990_000n);
  });
  it("checkpoints a completed pending exit before requesting the next position quote", async () => {
    const f = fixture(),
      first = enter(f.ledger, f.e.mint, "SYNTHETIC-FIRST"),
      second = enter(f.ledger, "SYNTHETIC-SECOND-MINT", "SYNTHETIC-SECOND");
    f.ledger.queueExit(first, first.quantityRaw, "SYNTHETIC-EXIT", Date.now() - 3000, 2000);
    let nextProviderSawDurableExit = false;
    f.engine.setQuoteProvider({
      quote: vi.fn(async (input) => {
        if (input.inputMint === second.mint) {
          const saved = f.rows.get("ledger");
          nextProviderSawDurableExit =
            saved?.positions.length === 1 &&
            saved?.pendingExits.length === 0 &&
            saved?.trades.length === 1 &&
            saved?.trades[0].isFinalExit === true;
          throw Error("SYNTHETIC_NEXT_PROVIDER_FAILURE");
        }
        return quote(input.inputMint, WSOL, input.amount, 10_000_000n);
      }),
    });
    await f.engine.tick();
    expect(nextProviderSawDurableExit).toBe(true);
    expect(f.ledger.state.trades).toHaveLength(1);
    expect(f.ledger.state.positions).toHaveLength(1);
    expect(f.rows.get("ledger").trades[0].positionId).toBe(first.id);
  });
});

describe("engine callback and restart boundaries", () => {
  it("retains exactly one full trade after repeated full callbacks and restores that same feature history", async () => {
    environment();
    let engine: Engine | undefined;
    try {
      // Recorded read-only chain fixture; the callback repetition is injected synthetically.
      const tx = JSON.parse(
        readFileSync(new URL("./fixtures/real-pump-buy.json", import.meta.url), "utf8"),
      ) as RpcTransaction;
      engine = await new Engine().start({ stream: false, port: 0 });
      await engine.recordLogs({
        logs: tx.meta!.logMessages!,
        signature: tx.transaction.signatures[0],
        slot: tx.slot,
        receivedAt: Date.now(),
        commitment: "finalized",
      });
      expect((engine as any).trades).toHaveLength(1);
      await engine.receive(tx, Date.now(), "finalized");
      await engine.idle();
      expect((engine as any).trades).toHaveLength(1);
      expect((engine as any).trades[0].instructionIndex.startsWith("log:")).toBe(false);
      await engine.receive(tx, Date.now(), "finalized");
      expect((engine as any).trades).toHaveLength(1);
      await engine.stop();
      engine = undefined;
      engine = await new Engine().start({ stream: false, port: 0 });
      expect((engine as any).trades).toHaveLength(1);
    } finally {
      await engine?.stop();
    }
  }, 30000);
  it("keeps typed fast trade evidence when a full callback has no supported decodable instruction", async () => {
    environment();
    let engine: Engine | undefined;
    try {
      const tx = JSON.parse(
        readFileSync(new URL("./fixtures/real-pump-buy.json", import.meta.url), "utf8"),
      ) as RpcTransaction;
      engine = await new Engine().start({ stream: false, port: 0 });
      await engine.recordLogs({
        logs: tx.meta!.logMessages!,
        signature: tx.transaction.signatures[0],
        slot: tx.slot,
        receivedAt: Date.now(),
        commitment: "finalized",
      });
      const before = structuredClone((engine as any).trades);
      const syntheticUnsupported = structuredClone(tx);
      syntheticUnsupported.transaction.message.instructions = [];
      syntheticUnsupported.meta!.innerInstructions = [];
      await engine.receive(syntheticUnsupported, Date.now(), "finalized");
      expect((engine as any).trades).toEqual(before);
      expect(engine.state().events[0].verification).toBe("TYPED_PROGRAM_EVENT");
    } finally {
      await engine?.stop();
    }
  }, 30000);
  it("restores a durable suspension even when the temporary marker is absent and env switch is false", async () => {
    const directory = environment();
    let engine: Engine | undefined;
    try {
      engine = await new Engine().start({ stream: false, port: 0 });
      await (engine as any).latchSuspension("SYNTHETIC_DURABILITY_FAULT");
      await engine.stop();
      engine = undefined;
      rmSync(join(directory, "KILL")); // Remove this test's marker to independently prove the DB latch.
      expect(existsSync(join(directory, "KILL"))).toBe(false);
      engine = await new Engine().start({ stream: false, port: 0 });
      expect((engine as any).ledger.state.killSwitch).toBe(true);
      expect((engine as any).killed()).toBe(true);
      expect((await engine.store.get("suspension")).reason).toBe("SYNTHETIC_DURABILITY_FAULT");
    } finally {
      await engine?.stop();
    }
  }, 30000);
  it("keeps position ticks single-flight while analysis is blocked, without accumulating timer callbacks", async () => {
    environment();
    let engine: Engine | undefined;
    let releaseAnalysis!: () => void, releaseTick!: () => void;
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      engine = await new Engine().start({ stream: false, port: 0 });
      const internal = engine as any;
      internal.work = new Promise<void>((resolve) => {
        releaseAnalysis = resolve;
      });
      const slowTick = new Promise<void>((resolve) => {
        releaseTick = resolve;
      });
      const tick = vi
        .spyOn(engine, "tick")
        .mockImplementationOnce(() => slowTick)
        .mockResolvedValue(undefined);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(tick).toHaveBeenCalledTimes(1);
      releaseTick();
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(3000);
      expect(tick).toHaveBeenCalledTimes(2);
      releaseAnalysis();
      await engine.idle();
    } finally {
      releaseTick?.();
      releaseAnalysis?.();
      await engine?.stop();
    }
  }, 30000);
});

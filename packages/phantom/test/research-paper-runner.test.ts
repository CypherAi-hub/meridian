/** Actual runner + temporary on-disk Store; every market/quote is a SYNTHETIC fixture, never profit evidence. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { MintLayout, TOKEN_2022_PROGRAM_ID, ExtensionType } from "@solana/spl-token";
import { Store } from "../src/store.ts";
import { freezeResearchPaperPolicyV2 } from "../src/research-paper-policy.ts";
import {
  freezeResearchPaperRun,
  ResearchPaperRunner,
  reconcileResearchPaper,
  type ResearchPaperDecision,
  type ResearchBookEnvelope,
  type ResearchRunnerControls,
} from "../src/research-paper-runner.ts";
import { PaperLedger, type QuoteProvider } from "../src/paper.ts";
import { RiskGovernor, RESEARCH_PAPER_RISK_LIMITS, type SafetyVerdict } from "../src/risk.ts";
import { WSOL, json } from "../src/types.ts";
import type { Quote } from "../src/execution.ts";

const MINT = new PublicKey(new Uint8Array(32).fill(7)).toBase58();
const SOURCE = "a".repeat(64);
const policy = () => freezeResearchPaperPolicyV2({ sourceHash: SOURCE, frozenAt: 90000 });
const manifest = () =>
  freezeResearchPaperRun({
    bookId: "synthetic-runner",
    policy: policy(),
    enrollmentStart: 94000,
    enrollmentEnd: 180000,
  });
function decision(captureId = "synthetic:runner:1"): ResearchPaperDecision {
  const data = Buffer.alloc(234);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
      supply: 1000000000000n,
      decimals: 6,
      isInitialized: true,
    },
    data,
  );
  data[165] = 1;
  data.writeUInt16LE(ExtensionType.MetadataPointer, 166);
  data.writeUInt16LE(64, 168);
  new PublicKey(MINT).toBuffer().copy(data, 202);
  return {
    captureId,
    sourceObservedAt: 95000,
    decisionAt: 97000,
    features: {
      asOf: 97000,
      mint: MINT,
      observations: 8,
      verifiedLaunchAgeMs: null,
      imbalance: 0.4,
      uniqueBuyers: 8,
      uniqueBuyerAcceleration: 3,
      priceVelocityBps: 125,
      priceAccelerationBps: null,
      drawdownFromPeakBps: null,
      netInflowLamports: 100000000n,
      sellerConcentrationBps: 1000,
      organic: {
        score: 80,
        confidence: "low",
        independentBuyerUnits: 8,
        uniqueBuyers: 8,
        clusteredBuyers: 0,
        creatorAssociatedBuyers: 0,
        effectiveBuyVolume: 100000000n,
        evidence: ["SYNTHETIC_UNKNOWN_ASSOCIATION_FIXTURE"],
      },
      smartBuyers: 0,
      creatorSelling: false,
      creatorPriorLaunches: 0,
      creatorPriorAdverseOutcomes: 0,
      liquidityLamports: 20000000000n,
      liquidityGrowing: true,
      curveProgressBps: null,
      executionCostBps: 149,
    },
    security: {
      mint: MINT,
      observedAt: 96500,
      mintAuthority: null,
      freezeAuthority: null,
      tokenProgram: "token-2022",
      extensionsVerified: true,
      extensions: ["MetadataPointer"],
      transferFeeBps: 0,
      permanentDelegate: null,
      transferRestricted: false,
      creatorConcentrationBps: 1000,
      creatorAssociationsVerified: false,
      creatorAssociatedConcentrationBps: null,
      topHolderConcentrationBps: 3500,
      knownMalicious: false,
      sellRouteAvailable: null,
      sellRouteObservedAt: null,
      liquidityAccessible: true,
      abnormalCreatorActivity: false,
    },
    mintAccountCapture: {
      address: MINT,
      owner: TOKEN_2022_PROGRAM_ID.toBase58(),
      dataBase64: data.toString("base64"),
      slot: 123456,
      requestedAt: 95500,
      observedAt: 96000,
      publishedAt: 96500,
    },
  };
}
const stores: Store[] = [],
  dirs: string[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function open(dir?: string) {
  dir ??= await mkdtemp(join(tmpdir(), "omni-research-runner-"));
  if (!dirs.includes(dir)) dirs.push(dir);
  const store = await new Store().open(undefined, dir, true);
  stores.push(store);
  return { store, dir };
}
async function fixture(controls: ResearchRunnerControls = {}) {
  const f = await open();
  let at = 94000;
  const calls: { input: Parameters<QuoteProvider["quote"]>[0]; at: number }[] = [];
  const script: ((input: Parameters<QuoteProvider["quote"]>[0]) => Quote | Promise<Quote>)[] = [];
  function quote(input: Parameters<QuoteProvider["quote"]>[0], proceeds?: bigint): Quote {
    const buy = input.inputMint === WSOL;
    return {
      inputMint: input.inputMint,
      outputMint: input.outputMint,
      inAmount: input.amount.toString(),
      outAmount: (buy ? 1000000n : (proceeds ?? 9894737n)).toString(),
      minOutAmount: (buy ? 997500n : (proceeds ?? 9870000n)).toString(),
      impactBps: 20,
      requestedAt: at,
      observedAt: at,
      contextSlot: 123456,
      route: ["SYNTHETIC_TEST_ONLY"],
      source: "JUPITER",
      router: "metis",
    };
  }
  const provider: QuoteProvider = {
    async quote(input) {
      calls.push({ input, at });
      return script.shift()?.(input) ?? quote(input);
    },
  };
  const runner = await ResearchPaperRunner.create(
    f.store,
    provider,
    manifest(),
    () => at,
    controls,
  );
  return {
    ...f,
    runner,
    provider,
    calls,
    script,
    quote,
    now: () => at,
    time: (value: number) => {
      at = value;
    },
  };
}
async function enter(f: Awaited<ReturnType<typeof fixture>>) {
  f.time(97000);
  expect(await f.runner.enroll(decision())).toBe(true);
  f.time(99000);
  await f.runner.step();
  expect(f.runner.snapshot().entries[0].status).toBe("FILLED");
}
const saved = (value: unknown) => JSON.parse(json(value));

describe("separate durable prospective research PAPER runner", () => {
  it("persists time-based exit intent in a provider-free pass and later executes the same ready order without renewing its delay", async () => {
    const f = await fixture();
    await enter(f);
    const before = f.calls.length;
    const offline = { allowEntryQuotes: false, allowPassiveMarks: false, allowExitQuotes: false };
    f.time(399000);
    await f.runner.step(offline);
    const original = f.runner.snapshot().ledger.pendingExits[0];
    expect(original.reason).toBe("MAX_HOLD");
    expect(original.createdAt).toBe(399000);
    expect(original.readyAt).toBe(401000);
    expect((await f.store.get(f.runner.key)).ledger.pendingExits[0].id).toBe(original.id);
    f.time(401000);
    await f.runner.step(offline);
    expect(f.calls).toHaveLength(before);
    expect(f.runner.snapshot().ledger.pendingExits[0]).toEqual(original);
    f.time(402000);
    f.script.push((input) => f.quote(input, 12000000n));
    await f.runner.step();
    const s = f.runner.snapshot();
    expect(s.ledger.trades).toHaveLength(1);
    expect(s.ledger.trades[0].exitOrderId).toBe(original.id);
    expect(s.ledger.positions).toEqual([]);
    expect(reconcileResearchPaper(s).cashLamports).toBe(1001980000n);
  });
  it.each(["passive", "partial"])(
    "observes callback-only stop during %s quote and replaces the old quote with full emergency intent",
    async (kind) => {
      let stopped = false;
      const f = await fixture({ stopRequested: () => stopped });
      await enter(f);
      if (kind === "partial") {
        f.time(100000);
        f.script.push((i) => f.quote(i, 16000000n));
        await f.runner.step();
        expect(f.runner.snapshot().ledger.pendingExits[0].quantityRaw).toBe(498750n);
      }
      f.time(kind === "partial" ? 102000 : 100000);
      f.script.push((i) => {
        stopped = true;
        return f.quote(i, kind === "partial" ? 8000000n : 16000000n);
      });
      await f.runner.step();
      const s = f.runner.snapshot();
      expect(s.ledger.killSwitch).toBe(true);
      expect(s.ledger.trades).toEqual([]);
      expect(s.ledger.positions[0].quantityRaw).toBe(997500n);
      expect(s.ledger.pendingExits[0].reason).toBe("EMERGENCY_SHUTDOWN");
      expect(s.ledger.pendingExits[0].quantityRaw).toBe(997500n);
      expect(s.ledger.pendingExits[0].readyAt).toBe((kind === "partial" ? 102000 : 100000) + 2000);
      expect(reconcileResearchPaper(s).openPositions).toBe(1);
    },
  );
  it("closes entry authority when a stop arrives during the buy await and retains the latch after restart", async () => {
    let stopped = false;
    const f = await fixture({ stopRequested: () => stopped });
    f.time(97000);
    await f.runner.enroll(decision());
    let release!: () => void;
    f.script.push(
      (input) =>
        new Promise<Quote>((resolve) => {
          release = () => resolve(f.quote(input));
        }),
    );
    f.time(99000);
    const stepping = f.runner.step();
    stopped = true;
    release();
    await stepping;
    let s = f.runner.snapshot();
    expect(f.calls).toHaveLength(1);
    expect(s.ledger.cashLamports).toBe(1000000000n);
    expect(s.ledger.positions).toEqual([]);
    expect(s.ledger.pending).toEqual([]);
    expect(s.ledger.killSwitch).toBe(true);
    expect(s.entries[0].status).toBe("REJECTED");
    expect(s.journal.filter((j) => j.kind === "EMERGENCY_STOP")).toHaveLength(1);
    stopped = false;
    const restored = await ResearchPaperRunner.restore(f.store, f.provider, manifest(), f.now, {
      stopRequested: () => stopped,
    });
    expect(restored.accountState().emergencyStopLatched).toBe(true);
    expect(await restored.enroll(decision("after-file-clear"))).toBe(false);
    s = restored.snapshot();
    expect(reconcileResearchPaper(s).settledEntries).toBe(0);
  });
  it("checks the stop again after the paired sell before any entry settlement", async () => {
    let stopped = false;
    const f = await fixture({ stopRequested: () => stopped });
    f.time(97000);
    await f.runner.enroll(decision());
    f.script.push(
      (i) => f.quote(i),
      (i) => {
        stopped = true;
        return f.quote(i);
      },
    );
    f.time(99000);
    await f.runner.step();
    expect(f.calls).toHaveLength(2);
    expect(f.runner.snapshot().ledger.positions).toEqual([]);
    expect(f.runner.snapshot().ledger.cashLamports).toBe(1000000000n);
  });
  it("latches emergency intent synchronously during a mark await, discards the old quote and still permits full exit", async () => {
    const f = await fixture();
    await enter(f);
    f.time(100000);
    let release!: () => void;
    f.script.push(
      (input) =>
        new Promise<Quote>((resolve) => {
          release = () => resolve(f.quote(input, 16000000n));
        }),
    );
    const stepping = f.runner.step();
    const stopping = f.runner.latchEmergencyStop("USER_STOP");
    const stoppingAgain = f.runner.latchEmergencyStop("USER_STOP");
    let s = f.runner.snapshot();
    expect(s.ledger.killSwitch).toBe(true);
    expect(s.ledger.pendingExits[0].reason).toBe("EMERGENCY_SHUTDOWN");
    expect(s.ledger.pendingExits[0].quantityRaw).toBe(997500n);
    release();
    await Promise.all([stepping, stopping, stoppingAgain]);
    s = f.runner.snapshot();
    expect(s.ledger.positions[0].markLamports).toBeNull();
    expect(s.journal.filter((j) => j.kind === "EMERGENCY_STOP")).toHaveLength(1);
    expect(s.ledger.trades).toEqual([]);
    expect(reconcileResearchPaper(s).openPositions).toBe(1);
    f.time(102000);
    f.script.push((input) => f.quote(input, 8000000n));
    await f.runner.step({ allowEntryQuotes: false, allowPassiveMarks: false });
    s = f.runner.snapshot();
    expect(s.ledger.positions).toEqual([]);
    expect(s.ledger.trades).toHaveLength(1);
    expect(s.ledger.trades[0].reason).toBe("EMERGENCY_SHUTDOWN");
    expect(s.ledger.cashLamports).toBe(997980000n);
  });
  it("retains earlier profit intent history when emergency supersedes it with a full delayed exit", async () => {
    const f = await fixture();
    await enter(f);
    f.time(100000);
    f.script.push((input) => f.quote(input, 16000000n));
    await f.runner.step();
    expect(f.runner.snapshot().ledger.pendingExits[0].quantityRaw).toBe(498750n);
    f.time(100500);
    await f.runner.latchEmergencyStop("USER_STOP");
    const s = f.runner.snapshot();
    expect(s.journal.filter((j) => j.kind === "EXIT_INTENT")).toHaveLength(2);
    expect(s.ledger.pendingExits[0].quantityRaw).toBe(997500n);
    expect(s.ledger.pendingExits[0].readyAt).toBe(102500);
    expect(reconcileResearchPaper(s).openPositions).toBe(1);
    const restored = await ResearchPaperRunner.restore(f.store, f.provider, manifest(), f.now);
    expect(restored.accountState().emergencyStopLatched).toBe(true);
  });
  it("respects shared-lane entry/mark turns while expiring intents and serving ready exits without those allowances", async () => {
    const f = await fixture();
    f.time(97000);
    await f.runner.enroll(decision());
    f.time(99000);
    await f.runner.step({ allowEntryQuotes: false, allowPassiveMarks: false });
    expect(f.calls).toHaveLength(0);
    expect(f.runner.snapshot().ledger.pending).toHaveLength(1);
    f.time(127001);
    await f.runner.step({ allowEntryQuotes: false, allowPassiveMarks: false });
    expect(f.calls).toHaveLength(0);
    expect(f.runner.snapshot().entries[0].status).toBe("EXPIRED");
    const second = await fixture();
    await enter(second);
    const before = second.calls.length;
    second.time(100000);
    await second.runner.step({ allowEntryQuotes: false, allowPassiveMarks: false });
    expect(second.calls).toHaveLength(before);
    second.time(399000);
    await second.runner.step({ allowEntryQuotes: false, allowPassiveMarks: false });
    expect(second.calls).toHaveLength(before);
    expect(second.runner.snapshot().ledger.pendingExits).toHaveLength(1);
    second.time(401000);
    second.script.push((input) => second.quote(input, 8000000n));
    await second.runner.step({ allowEntryQuotes: false, allowPassiveMarks: false });
    expect(second.calls).toHaveLength(before + 1);
    expect(second.calls.at(-1)?.input.priority).toBe("protective_exit");
    expect(reconcileResearchPaper(second.runner.snapshot()).realizedLegs).toBe(1);
  });
  it("cannot mutate the enrollment barrier through the caller manifest while creation awaits the store", async () => {
    const f = await open();
    const caller = structuredClone(manifest()) as any;
    const get = f.store.get.bind(f.store);
    let quoteCalls = 0;
    f.store.get = async (id) => {
      caller.enrollmentStart = 100000;
      return get(id);
    };
    const provider: QuoteProvider = {
      async quote() {
        quoteCalls++;
        throw Error("UNEXPECTED_PROVIDER");
      },
    };
    await expect(
      ResearchPaperRunner.create(f.store, provider, caller, () => 97000),
    ).rejects.toThrow("BEFORE_ENROLLMENT");
    expect(await get("research-paper:synthetic-runner")).toBeNull();
    expect(quoteCalls).toBe(0);
  });
  it("reads each run-constructor field once before validation and freezing", () => {
    let endReads = 0;
    const input = {
      bookId: "getter-run",
      policy: policy(),
      enrollmentStart: 94000,
      get enrollmentEnd() {
        return ++endReads === 1 ? 180000 : 93000;
      },
    };
    const run = freezeResearchPaperRun(input);
    expect(endReads).toBe(1);
    expect(run.enrollmentEnd).toBe(180000);
  });
  it("uses one economic settlement clock even when every Date.now-style read advances", async () => {
    const f = await open();
    let at = 94000;
    const now = () => at++;
    let exitProceeds: bigint | null = null;
    const provider: QuoteProvider = {
      async quote(input) {
        const requestedAt = now(),
          observedAt = now(),
          buy = input.inputMint === WSOL;
        return {
          inputMint: input.inputMint,
          outputMint: input.outputMint,
          inAmount: input.amount.toString(),
          outAmount: (buy ? 1000000n : (exitProceeds ?? 9894737n)).toString(),
          minOutAmount: (buy ? 997500n : (exitProceeds ?? 9870000n)).toString(),
          requestedAt,
          observedAt,
          impactBps: 20,
          contextSlot: 123456,
          route: ["SYNTHETIC_ADVANCING_CLOCK"],
          source: "JUPITER",
          router: "metis",
        };
      },
    };
    const runner = await ResearchPaperRunner.create(f.store, provider, manifest(), now);
    at = 97000;
    await runner.enroll(decision());
    at = 99001;
    await runner.step();
    let s = runner.snapshot();
    expect(s.entries[0].status).toBe("FILLED");
    expect(s.entries[0].fill?.at).toBe(s.ledger.positions[0].openedAt);
    expect(s.journal.find((j) => j.kind === "ENTRY_SETTLED")?.at).toBe(s.entries[0].fill?.at);
    at = 400000;
    await runner.step();
    at = 402010;
    exitProceeds = 12000000n;
    await runner.step();
    s = runner.snapshot();
    expect(s.ledger.trades).toHaveLength(1);
    expect(s.journal.find((j) => j.kind === "EXIT_SETTLED")?.at).toBe(s.ledger.trades[0].closedAt);
    expect(runner.suspended).toBe(false);
    expect(reconcileResearchPaper(s).cashLamports).toBe(1001980000n);
    expect((await f.store.get(runner.key)).ledger.cashLamports).toBe("1001980000");
  });
  it("detaches provider accessors and exposed snapshots from the authoritative ledger", async () => {
    const f = await fixture();
    f.time(97000);
    await f.runner.enroll(decision());
    // Provider is an untrusted boundary. A malicious accessor cannot change a durable fill's identity.
    let mintReads = 0;
    f.script.push((input) => {
      const q = f.quote(input);
      Object.defineProperty(q, "outputMint", {
        enumerable: true,
        get: () => (++mintReads > 1 ? "tampered" : MINT),
      });
      return q;
    });
    f.time(99000);
    await f.runner.step();
    expect(mintReads).toBe(1);
    expect(f.runner.snapshot().ledger.positions).toHaveLength(1);
    // Independently corrupt the exposed snapshot; it cannot mutate the runner or its persisted audit.
    const exposed = f.runner.snapshot();
    exposed.entries[0].fill!.quote.minOutAmount = "997499";
    expect(() => reconcileResearchPaper(exposed)).toThrow("FILL_QUOTE_MISMATCH");
    expect(reconcileResearchPaper(f.runner.snapshot()).cashLamports).toBe(989990000n);
  });
  it("keeps a profit-exit decision causal when the next clock read crosses max hold", async () => {
    const f = await open();
    let at = 94000,
      boundary = false,
      reads = 0;
    const now = () => (boundary ? (++reads <= 7 ? 398999 : 399000) : at);
    let proceeds: bigint | null = null;
    const provider: QuoteProvider = {
      async quote(input) {
        const buy = input.inputMint === WSOL,
          requestedAt = now(),
          observedAt = now();
        return {
          inputMint: input.inputMint,
          outputMint: input.outputMint,
          inAmount: input.amount.toString(),
          outAmount: (buy ? 1000000n : (proceeds ?? 9894737n)).toString(),
          minOutAmount: (buy ? 997500n : (proceeds ?? 9870000n)).toString(),
          requestedAt,
          observedAt,
          impactBps: 20,
          contextSlot: 123456,
          route: ["SYNTHETIC_BOUNDARY"],
          source: "JUPITER",
          router: "metis",
        };
      },
    };
    const runner = await ResearchPaperRunner.create(f.store, provider, manifest(), now);
    at = 97000;
    await runner.enroll(decision());
    at = 99000;
    await runner.step();
    proceeds = 16000000n;
    boundary = true;
    await runner.step();
    let s = runner.snapshot();
    expect(s.ledger.pendingExits[0].reason).toBe("PARTIAL_PROFIT");
    expect(s.ledger.pendingExits[0].createdAt).toBe(398999);
    expect(runner.suspended).toBe(false);
    boundary = false;
    at = 399000;
    await runner.step();
    s = runner.snapshot();
    expect(s.ledger.pendingExits[0].reason).toBe("MAX_HOLD");
    expect(s.ledger.pendingExits[0].quantityRaw).toBe(997500n);
    expect(s.ledger.pendingExits[0].readyAt).toBe(401000);
    expect(reconcileResearchPaper(s).openPositions).toBe(1);
  });
  it("freezes every effective risk/exit/fee scope and rejects unleased, duplicate or late creation", async () => {
    const f = await fixture(),
      m = manifest();
    expect(Object.isFrozen(m.policy)).toBe(true);
    expect(m.liveApproved).toBe(false);
    expect(m.strictPolicyEligible).toBe(false);
    expect(m.rentScope).toContain("EXCLUDED");
    expect(m.feeScope).toContain("NOT_MEASURED");
    expect(m.economicProfileHash).toHaveLength(64);
    expect(m.exitProfileHash).toHaveLength(64);
    await expect(ResearchPaperRunner.create(f.store, f.provider, m, f.now)).rejects.toThrow(
      "ALREADY_EXISTS",
    );
    await expect(
      ResearchPaperRunner.create(
        { ...f.store, workerLeaseEnforced: false } as any,
        f.provider,
        m,
        f.now,
      ),
    ).rejects.toThrow("LEASE");
    await expect(
      ResearchPaperRunner.restore(
        f.store,
        f.provider,
        { ...m, exitProfileHash: "b".repeat(64) },
        f.now,
      ),
    ).rejects.toThrow("MANIFEST_MISMATCH");
    await expect(
      ResearchPaperRunner.create(
        f.store,
        f.provider,
        freezeResearchPaperRun({
          bookId: "late-book",
          policy: policy(),
          enrollmentStart: 94000,
          enrollmentEnd: 180000,
        }),
        () => 94001,
      ),
    ).rejects.toThrow("BEFORE_ENROLLMENT");
  });
  it("persists a new decision and capacity before I/O; delayed exact entry settles once without changing original features", async () => {
    const f = await fixture();
    f.time(97000);
    const original = decision();
    expect(await f.runner.enroll(original)).toBe(true);
    original.features.executionCostBps = 0;
    expect(await f.runner.enroll(decision())).toBe(false);
    expect(await f.runner.enroll(decision("another-candidate"))).toBe(false);
    expect((await f.store.get(f.runner.key)).ledger.pending).toHaveLength(1);
    expect(f.runner.accountState().reservedLamports).toBe(10010000n);
    expect(f.runner.accountState().availableCashLamports).toBe(989990000n);
    f.time(98999);
    await f.runner.step();
    expect(f.calls).toHaveLength(0);
    f.time(99000);
    await f.runner.step();
    const s = f.runner.snapshot();
    expect(f.calls).toHaveLength(2);
    expect(f.calls.every((c) => c.at >= 99000)).toBe(true);
    expect(f.calls[1].input.amount).toBe(997500n);
    expect(s.ledger.cashLamports).toBe(989990000n);
    expect(s.ledger.positions[0].quantityRaw).toBe(997500n);
    expect(s.ledger.positions[0].entryFeeLamports).toBe(10000n);
    expect(s.ledger.pending).toEqual([]);
    expect(s.entries[0].fill?.evidence.features.executionCostBps).toBe(149);
    expect(s.entries[0].fill?.evidence.security.creatorAssociationsVerified).toBe(false);
    expect(s.entries[0].fill?.evidence.mintAccountCapture?.observedAt).toBe(96000);
    expect(reconcileResearchPaper(s)).toEqual({
      cashLamports: 989990000n,
      openPositions: 1,
      realizedLegs: 0,
      settledEntries: 1,
    });
    const before = s.ledger.completedOrderIds.slice();
    f.time(99001);
    await f.runner.step();
    expect(f.runner.snapshot().ledger.completedOrderIds).toEqual(before);
  });
  it("survives real store restart, unavailable protective exit, later sale, and another restart with independent reconciliation", async () => {
    const f = await fixture();
    await enter(f);
    await f.store.close();
    const second = await open(f.dir);
    let runner = await ResearchPaperRunner.restore(second.store, f.provider, manifest(), f.now);
    expect(runner.snapshot().ledger.cashLamports).toBe(989990000n);
    expect(runner.snapshot().ledger.positions[0].quantityRaw).toBe(997500n);
    expect(runner.snapshot().ledger.positions[0].markLamports).toBeNull();
    const before = f.calls.length;
    f.time(399000);
    await runner.step();
    expect(f.calls).toHaveLength(before); // Full protective intent is durable before requesting an exit.
    expect((await second.store.get(runner.key)).ledger.pendingExits[0].quantityRaw).toBe("997500");
    f.time(401000);
    f.script.push(() => {
      throw Error("SYNTHETIC_MISSING_EXIT");
    });
    await runner.step();
    let s = runner.snapshot();
    expect(s.ledger.positions).toHaveLength(1);
    expect(s.ledger.pendingExits).toHaveLength(1);
    expect(s.ledger.cashLamports).toBe(989990000n);
    expect(s.ledger.trades).toEqual([]);
    expect(s.ledger.equity.at(-1)?.equityLamports).toBeNull();
    expect(s.journal.at(-1)?.kind).toBe("EXIT_UNAVAILABLE");
    await second.store.close();
    const third = await open(f.dir);
    runner = await ResearchPaperRunner.restore(third.store, f.provider, manifest(), f.now);
    f.time(402000);
    f.script.push((input) => f.quote(input, 12000000n));
    await runner.step();
    s = runner.snapshot();
    expect(s.ledger.positions).toEqual([]);
    expect(s.ledger.pendingExits).toEqual([]);
    expect(s.ledger.cashLamports).toBe(1001980000n);
    expect(s.ledger.trades).toHaveLength(1);
    expect(s.ledger.trades[0].feesLamports).toBe(20000n);
    expect(s.ledger.trades[0].pnlLamports).toBe(1980000n);
    expect(reconcileResearchPaper(s).settledEntries).toBe(1);
    await third.store.close();
    const fourth = await open(f.dir);
    const restored = await ResearchPaperRunner.restore(fourth.store, f.provider, manifest(), f.now);
    await restored.step();
    expect(restored.snapshot().ledger.cashLamports).toBe(1001980000n);
    expect(restored.snapshot().ledger.trades).toHaveLength(1);
  }, 30000);
  it("retains an actual negative synthetic outcome rather than replacing it with a profitable model", async () => {
    const f = await fixture();
    await enter(f);
    f.time(399000);
    await f.runner.step();
    f.time(401000);
    f.script.push((input) => f.quote(input, 8000000n));
    await f.runner.step();
    const s = f.runner.snapshot();
    expect(s.ledger.trades[0].pnlLamports).toBe(-2020000n);
    expect(s.ledger.cashLamports).toBe(997980000n);
    expect(reconcileResearchPaper(s).realizedLegs).toBe(1);
  });
  it("preserves proportional basis and fee accounting through a partial exit and full max-hold exit", async () => {
    const f = await fixture();
    await enter(f);
    f.time(100000);
    f.script.push((input) => f.quote(input, 16000000n));
    await f.runner.step();
    expect(f.runner.snapshot().ledger.pendingExits[0].quantityRaw).toBe(498750n);
    f.time(102000);
    f.script.push((input) => f.quote(input, 8000000n));
    await f.runner.step();
    let s = f.runner.snapshot();
    expect(s.ledger.positions[0].quantityRaw).toBe(498750n);
    expect(s.ledger.positions[0].costLamports).toBe(5000000n);
    expect(s.ledger.positions[0].entryFeeLamports).toBe(5000n);
    expect(s.ledger.trades[0].isFinalExit).toBe(false);
    expect(reconcileResearchPaper(s).realizedLegs).toBe(1);
    f.time(399000);
    await f.runner.step();
    f.time(401000);
    f.script.push((input) => f.quote(input, 4000000n));
    await f.runner.step();
    s = f.runner.snapshot();
    expect(s.ledger.trades[1].isFinalExit).toBe(true);
    expect(s.ledger.positions).toEqual([]);
    expect(s.ledger.cashLamports).toBe(1001970000n);
    expect(s.ledger.trades.reduce((n, t) => n + t.feesLamports, 0n)).toBe(30000n);
    expect(reconcileResearchPaper(s).realizedLegs).toBe(2);
  });
  it("makes an ambiguous acknowledged fill suspend until durable reload, never submitting a duplicate entry", async () => {
    const f = await fixture();
    f.time(97000);
    await f.runner.enroll(decision());
    const originalSave = f.store.saveResearchPaperBook.bind(f.store);
    let injected = false;
    f.store.saveResearchPaperBook = async (key, value, version, manifestHash) => {
      const changed = await originalSave(key, value, version, manifestHash);
      if (!injected && (value as ResearchBookEnvelope).ledger.positions.length === 1) {
        injected = true;
        throw Error("SYNTHETIC_ACK_LOST_AFTER_COMMIT");
      }
      return changed;
    };
    f.time(99000);
    await expect(f.runner.step()).rejects.toThrow("ACK_AMBIGUOUS");
    expect(f.runner.suspended).toBe(true);
    await expect(f.runner.step()).rejects.toThrow("SUSPENDED");
    f.store.saveResearchPaperBook = originalSave;
    const runner = await ResearchPaperRunner.restore(f.store, f.provider, manifest(), f.now);
    expect(runner.snapshot().ledger.positions).toHaveLength(1);
    expect(f.calls.filter((c) => c.input.inputMint === WSOL)).toHaveLength(1);
    expect(reconcileResearchPaper(runner.snapshot()).cashLamports).toBe(989990000n);
  });
  it("checks the owning lease again after provider awaits and leaves the durable entry intent untouched on lease loss", async () => {
    const f = await fixture();
    f.time(97000);
    await f.runner.enroll(decision());
    const originalAssert = f.store.assertWorkerLease.bind(f.store);
    let lost = false;
    f.store.assertWorkerLease = () => {
      if (lost) throw Error("SYNTHETIC_LEASE_LOST");
      originalAssert();
    };
    f.script.push((input) => {
      lost = true;
      return f.quote(input);
    });
    f.time(99000);
    await expect(f.runner.step()).rejects.toThrow("LEASE_LOST");
    expect(f.runner.suspended).toBe(true);
    expect(f.runner.snapshot().ledger.positions).toEqual([]);
    f.store.assertWorkerLease = originalAssert;
    const s = await f.store.get(f.runner.key);
    expect(s.ledger.pending).toHaveLength(1);
    expect(s.ledger.cashLamports).toBe("1000000000");
  });
  it("cancels expired decisions and provider failures without fabricated inventory or fees", async () => {
    const f = await fixture();
    f.time(97000);
    await f.runner.enroll(decision());
    f.time(127001);
    await f.runner.step();
    expect(f.calls).toHaveLength(0);
    expect(f.runner.snapshot().entries[0].status).toBe("EXPIRED");
    const d = decision("failure:2");
    d.decisionAt = d.features.asOf = 128000;
    d.sourceObservedAt = 127000;
    f.time(128000);
    await f.runner.enroll(d);
    f.time(130000);
    f.script.push(() => {
      throw Error("SYNTHETIC_PROVIDER_FAIL");
    });
    await f.runner.step();
    const s = f.runner.snapshot();
    expect(s.entries[1].status).toBe("ENTRY_QUOTE_FAILED");
    expect(s.ledger.cashLamports).toBe(1000000000n);
    expect(s.ledger.positions).toEqual([]);
    expect(s.ledger.pending).toEqual([]);
  });
  it.each(["high_cost", "RFQ", "old_request", "changed_raw_mint"])(
    "rejects final %s evidence with no settlement",
    async (failure) => {
      const f = await fixture();
      f.time(97000);
      const d = decision();
      if (failure === "changed_raw_mint") d.security.mintAuthority = MINT;
      await f.runner.enroll(d);
      f.time(99000);
      if (failure === "high_cost")
        f.script.push(
          (i) => f.quote(i),
          (i) => f.quote(i, 9000000n),
        );
      if (failure === "RFQ")
        f.script.push((i) => ({ ...f.quote(i), quoteId: "SYNTHETIC_RFQ" }) as Quote);
      if (failure === "old_request") f.script.push((i) => ({ ...f.quote(i), requestedAt: 98999 }));
      await f.runner.step();
      const s = f.runner.snapshot();
      expect(s.ledger.positions).toEqual([]);
      expect(s.ledger.cashLamports).toBe(1000000000n);
      expect(s.entries[0].status).not.toBe("FILLED");
    },
  );
  it("stops mismatched/corrupt restore instead of creating another 1 SOL book", async () => {
    const f = await fixture();
    await enter(f);
    const m = manifest();
    const changed = freezeResearchPaperRun({
      bookId: m.bookId,
      policy: freezeResearchPaperPolicyV2({ sourceHash: "b".repeat(64), frozenAt: 90000 }),
      enrollmentStart: m.enrollmentStart,
      enrollmentEnd: m.enrollmentEnd,
    });
    await expect(ResearchPaperRunner.restore(f.store, f.provider, changed, f.now)).rejects.toThrow(
      "IDENTITY_MISMATCH",
    );
    const s = saved(f.runner.snapshot());
    s.entries[0].fill.quote.minOutAmount = "997499";
    await f.store.save(f.runner.key, s);
    await expect(ResearchPaperRunner.restore(f.store, f.provider, m, f.now)).rejects.toThrow(
      "FILL_QUOTE_MISMATCH",
    );
    await f.store.exec("DELETE FROM phantom_state WHERE id=$1", [f.runner.key]);
    await expect(ResearchPaperRunner.restore(f.store, f.provider, m, f.now)).rejects.toThrow(
      "MISSING_NO_CAPITAL_RESET",
    );
  });
  it("rejects lost or changed protective intents and contradictory historical quotes", async () => {
    const f = await fixture();
    await enter(f);
    f.time(100000);
    f.script.push((input) => f.quote(input, 8000000n));
    await f.runner.step();
    const pending = saved(f.runner.snapshot());
    expect(pending.ledger.pendingExits[0].reason).toBe("STOP_LOSS");
    const missing = structuredClone(pending);
    missing.ledger.pendingExits = [];
    expect(() => reconcileResearchPaper(missing)).toThrow("EXIT_INTENT_RECONCILIATION");
    const changed = structuredClone(pending);
    changed.ledger.pendingExits[0].readyAt++;
    expect(() => reconcileResearchPaper(changed)).toThrow("PENDING_EXIT_RECONCILIATION");
    f.time(102000);
    f.script.push((input) => f.quote(input, 8000000n));
    await f.runner.step();
    const base = saved(f.runner.snapshot());
    for (const patch of [
      { outAmount: "1" },
      { requestedAt: 0 },
      { observedAt: 999999999 },
      { router: "jupiterz" },
      { quoteId: "SYNTHETIC_RFQ" },
      { impactBps: null },
      { impactBps: 201 },
    ]) {
      const s = structuredClone(base),
        exit = s.journal.find((j: any) => j.kind === "EXIT_SETTLED");
      Object.assign(exit.exit.quote, patch);
      expect(() => reconcileResearchPaper(s)).toThrow();
    }
    for (const patch of [{ outAmount: "1" }, { router: "jupiterz" }, { requestedAt: 0 }]) {
      const s = structuredClone(base);
      Object.assign(s.entries[0].fill.quote, patch);
      expect(() => reconcileResearchPaper(s)).toThrow("FILL_QUOTE_MISMATCH");
    }
    const noIntent = structuredClone(base);
    noIntent.journal = noIntent.journal
      .filter((j: any) => j.kind !== "EXIT_INTENT")
      .map((j: any, i: number) => ({ ...j, sequence: i + 1 }));
    expect(() => reconcileResearchPaper(noIntent)).toThrow("UNOWNED_EXIT");
    const corrupt = structuredClone(base);
    corrupt.journal.find((j: any) => j.kind === "EXIT_SETTLED").exit.quote.requestedAt = 0;
    await f.store.save(f.runner.key, corrupt);
    await expect(
      ResearchPaperRunner.restore(f.store, f.provider, manifest(), f.now),
    ).rejects.toThrow("RESEARCH_QUOTE");
  });
  it("rejects changed enrollment, original mint/security evidence and invalid journal transitions", async () => {
    const f = await fixture();
    await enter(f);
    const base = saved(f.runner.snapshot());
    const patches = [
      (s: any) => {
        s.entries[0].decision.sourceObservedAt++;
      },
      (s: any) => {
        s.entries[0].decision.security.observedAt++;
      },
      (s: any) => {
        s.entries[0].decision.mintAccountCapture.slot++;
      },
      (s: any) => {
        s.entries[0].decision.decisionAt = s.entries[0].decision.features.asOf = 93000;
      },
      (s: any) => {
        s.entries[0].status = "UNKNOWN";
      },
      (s: any) => {
        s.journal[0].kind = "UNKNOWN";
      },
      (s: any) => {
        s.journal[1].at = s.journal[0].at - 1;
      },
    ];
    for (const patch of patches) {
      const s = structuredClone(base);
      patch(s);
      expect(() => reconcileResearchPaper(s)).toThrow();
    }
  });
  it("fences two instances of one book under the same healthy worker lease", async () => {
    const f = await fixture();
    const current = await ResearchPaperRunner.restore(f.store, f.provider, manifest(), f.now);
    f.time(97000);
    await expect(f.runner.enroll(decision())).rejects.toThrow("RESTORE_REQUIRED");
    expect(f.runner.suspended).toBe(true);
    expect((await f.store.get(f.runner.key)).ledger.pending).toEqual([]);
    expect(await current.enroll(decision())).toBe(true);
    f.time(99000);
    await current.step();
    expect(current.snapshot().ledger.positions).toHaveLength(1);
    expect(reconcileResearchPaper(current.snapshot()).settledEntries).toBe(1);
  });
  it("rejects strict/research cross-mode fills and fabricated single-use authorizations at runtime", async () => {
    const strict = new PaperLedger(1000000000n, new RiskGovernor());
    expect(() => strict.fillResearch({} as any, {} as any, {} as any, 99000)).toThrow(
      "REQUIRES_RESEARCH_BOOK",
    );
    const governor = new RiskGovernor(
      { ...RESEARCH_PAPER_RISK_LIMITS },
      { bookId: "guard-test", policy: policy() },
    );
    const research = new PaperLedger(1000000000n, governor);
    expect(() =>
      research.fill({} as any, {} as any, { allowed: true } as SafetyVerdict, null, 10000n, 99000),
    ).toThrow("REQUIRES_STRICT_BOOK");
    expect(() =>
      governor.consumeAuthorization({ orderId: "fake" } as any, {} as any, 99000),
    ).toThrow("NOT_ISSUED");
    expect(
      () =>
        new RiskGovernor(
          { ...RESEARCH_PAPER_RISK_LIMITS, maxPositions: 2 },
          { bookId: "guard-test", policy: policy() },
        ),
    ).toThrow("PROFILE_MISMATCH");
  });
});

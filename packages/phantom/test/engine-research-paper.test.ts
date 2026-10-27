/** Synthetic strategy/security/quotes, real advancing clocks, isolated Store and loopback HTTP. No market-performance evidence. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, basename, join, resolve } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { BorshCoder, type Idl } from "@coral-xyz/anchor";
import bs58 from "bs58";
import { MintLayout, TOKEN_2022_PROGRAM_ID, ExtensionType } from "@solana/spl-token";
import { Engine } from "../src/engine.ts";
import { Store } from "../src/store.ts";
import { decodeTransaction, type RpcTransaction } from "../src/decoder.ts";
import type { QuoteProvider } from "../src/paper.ts";
import type { SecuritySnapshot } from "../src/security.ts";
import { JupiterQuoteClient } from "../src/execution.ts";
import { WSOL } from "../src/types.ts";
import { parsePhantomState } from "../../../src/lib/desk/phantom.ts";

const prior = { ...process.env },
  directories: string[] = [],
  engines: Engine[] = [];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  vi.restoreAllMocks();
  for (const name of Object.keys(process.env)) if (!(name in prior)) delete process.env[name];
  Object.assign(process.env, prior);
  for (const dir of directories.splice(0)) {
    if (
      dirname(resolve(dir)) !== resolve(tmpdir()) ||
      !basename(dir).startsWith("phantom-engine-experimental-")
    )
      throw Error("UNSAFE_TEST_PATH");
    await rm(dir, { recursive: true, force: true });
  }
});
async function setup(options: { defaultResearch?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "phantom-engine-experimental-"));
  directories.push(dir);
  process.env.PHANTOM_DATA_DIR = join(dir, "db");
  process.env.PHANTOM_KILL_FILE = join(dir, "KILL");
  process.env.PHANTOM_MODE = "PAPER";
  process.env.PHANTOM_KILL_SWITCH = "false";
  process.env.PHANTOM_QUOTE_RESEARCH = "false";
  process.env.PHANTOM_FORWARD_RESEARCH = "false";
  if (options.defaultResearch) {
    delete process.env.PHANTOM_QUOTE_RESEARCH;
    delete process.env.PHANTOM_FORWARD_RESEARCH;
  }
  process.env.PHANTOM_WALLET_HISTORY = "false";
  process.env.PHANTOM_RESEARCH_PAPER_ENABLED = "true";
  process.env.PHANTOM_TRADE_SOL = "0.02"; // Strict configuration must never change the frozen research notional.
  delete process.env.PHANTOM_DATABASE_URL;
  delete process.env.NODE_ENV;
  const realNow = Date.now.bind(Date),
    origin = realNow(),
    started = performance.now();
  let offset = 0;
  vi.spyOn(Date, "now").mockImplementation(
    () => origin + Math.floor(performance.now() - started) + offset,
  );
  const tx = JSON.parse(
    readFileSync(new URL("./fixtures/real-pump-buy.json", import.meta.url), "utf8"),
  ) as RpcTransaction;
  // Create an explicitly synthetic ABI-consistent callback from the transport seed.
  // The recorded deployed label mismatch remains vetoed in its existing fixture tests.
  const instruction = decodeTransaction(tx, Date.now())[0].instruction;
  const idl = JSON.parse(
    readFileSync(new URL("../vendor/pump.json", import.meta.url), "utf8"),
  ) as Idl;
  const coder = new BorshCoder(idl);
  tx.transaction.signatures[0] = bs58.encode(new Uint8Array(64).fill(42));
  tx.meta!.logMessages = tx.meta!.logMessages!.map((line) => {
    if (!line.startsWith("Program data: ")) return line;
    const decoded = coder.events.decode(line.slice("Program data: ".length));
    if (!decoded || decoded.name !== "TradeEvent") return line;
    decoded.data.ix_name = instruction;
    const entry = idl.events!.find((e) => e.name === decoded.name)!;
    return (
      "Program data: " +
      Buffer.concat([
        Buffer.from(entry.discriminator),
        coder.types.encode(decoded.name, decoded.data),
      ]).toString("base64")
    );
  });
  const mint = decodeTransaction(tx, Date.now())[0].mint;
  const calls: {
    input: Parameters<QuoteProvider["quote"]>[0];
    requestedAt: number;
    observedAt: number;
  }[] = [];
  let stopDuringBuy = false;
  // Exercise the production serialized Jupiter lane and response validator with an offline fetch.
  const client = new JupiterQuoteClient({
    apiKey: "SYNTHETIC_TEST_KEY_ONLY",
    minimumIntervalMs: 1000,
    fetch: async (input) => {
      const url = new URL(String(input));
      if (url.origin !== "https://api.jup.ag" || url.pathname !== "/swap/v2/order")
        throw Error("UNEXPECTED_TEST_URL");
      await sleep(12);
      const buy = url.searchParams.get("inputMint") === WSOL;
      if (stopDuringBuy && buy) await writeFile(join(dir, "KILL"), "synthetic kill during quote");
      return Response.json({
        inputMint: url.searchParams.get("inputMint"),
        outputMint: url.searchParams.get("outputMint"),
        inAmount: url.searchParams.get("amount"),
        outAmount: buy ? "1000000" : "9904762",
        otherAmountThreshold: buy ? "997500" : "9880000",
        priceImpact: 0.2,
        router: "metis",
        routePlan: [{ swapInfo: { label: "SYNTHETIC_ENGINE_TEST_ONLY" } }],
      });
    },
  });
  const provider: QuoteProvider = {
    async quote(input) {
      const q = await client.quote(input);
      calls.push({
        input: structuredClone(input),
        requestedAt: q.requestedAt!,
        observedAt: q.observedAt,
      });
      return q;
    },
  };
  const engine = new Engine();
  engine.setQuoteProvider(provider);
  await engine.start({ stream: false, port: 0 });
  engines.push(engine);
  const initial = engine.state().researchPaper!;
  offset += Math.max(0, initial.manifest.enrollmentStart - Date.now() + 10);
  vi.spyOn(engine.security, "inspect").mockImplementation(async () => {
    const requestedAt = Date.now();
    await sleep(12);
    const observedAt = Date.now();
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
    new PublicKey(mint).toBuffer().copy(data, 202);
    return {
      observedAt,
      liquidityLamports: 20000000000n,
      curveProgressBps: null,
      warnings: [],
      evidence: {
        mint,
        observedAt,
        evidenceRequestedAt: requestedAt,
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
        creatorAddress: null,
        directCreatorConcentrationBps: 1000,
        creatorConcentrationScope: "DIRECT_OWNER_AND_DELEGATE_ONLY",
        mintSlot: tx.slot,
        holderSnapshotSlot: tx.slot,
        liquiditySlot: tx.slot,
      },
      mintAccountCapture: {
        address: mint,
        owner: TOKEN_2022_PROGRAM_ID.toBase58(),
        dataBase64: data.toString("base64"),
        slot: tx.slot,
        requestedAt,
        observedAt,
        publishedAt: observedAt,
      },
    } satisfies SecuritySnapshot;
  });
  vi.spyOn(engine as any, "feature").mockImplementation((_event, _snapshot, cost = null) => ({
    asOf: Date.now(),
    mint,
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
      evidence: ["SYNTHETIC_ENGINE_SIGNAL_ONLY"],
    },
    smartBuyers: 0,
    creatorSelling: false,
    creatorPriorLaunches: 0,
    creatorPriorAdverseOutcomes: 0,
    liquidityLamports: 20000000000n,
    liquidityGrowing: true,
    curveProgressBps: null,
    executionCostBps: cost,
  }));
  return {
    dir,
    engine,
    tx,
    calls,
    provider,
    setStopDuringBuy(value = true) {
      stopDuringBuy = value;
    },
    advance(ms: number) {
      offset += ms;
    },
  };
}

describe("experimental book Engine integration", () => {
  it.each(["security", "buy", "sell"] as const)(
    "latches an observed stop when initial %s rejects",
    async (stage) => {
      const f = await setup();
      clearInterval((f.engine as any).timer);
      (f.engine as any).timer = null;
      clearInterval((f.engine as any).researchTimer);
      (f.engine as any).researchTimer = null;
      const inspect = vi.mocked(f.engine.security.inspect).getMockImplementation()!;
      const originalQuote = f.provider.quote.bind(f.provider);
      vi.mocked(f.engine.security.inspect).mockImplementation(async (...args) => {
        if (stage === "security") {
          await writeFile(join(f.dir, "KILL"), "synthetic rejected inspection stop");
          throw Error("SYNTHETIC_INSPECTION_REJECTED");
        }
        return inspect(...args);
      });
      const quote = vi.spyOn(f.provider, "quote").mockImplementation(async (input) => {
        if (
          (stage === "buy" && input.inputMint === WSOL) ||
          (stage === "sell" && input.outputMint === WSOL)
        ) {
          await writeFile(join(f.dir, "KILL"), "synthetic rejected quote stop");
          throw Error("SYNTHETIC_QUOTE_REJECTED");
        }
        return originalQuote(input);
      });
      await f.engine.receive(f.tx, Date.now(), "finalized");
      await f.engine.idle();
      expect(f.engine.state().researchPaper!.account.emergencyStopLatched).toBe(true);
      expect(f.engine.state().researchPaper!.pending).toEqual([]);
      const count = f.calls.length;
      await rm(join(f.dir, "KILL"));
      quote.mockRestore();
      vi.mocked(f.engine.security.inspect).mockImplementation(inspect);
      f.advance(31_000);
      const later = structuredClone(f.tx);
      later.transaction.signatures[0] = bs58.encode(new Uint8Array(64).fill(50));
      await f.engine.receive(later, Date.now(), "finalized");
      await f.engine.idle();
      expect(f.calls).toHaveLength(count);
      expect(f.engine.state().researchPaper!.positions).toEqual([]);
    },
    15000,
  );

  it.each(["ENGINE_INITIAL_ANALYSIS_STOP", "ENGINE_CAPTURE_STOP"])(
    "latches an adjacent control transition after %s",
    async (stage) => {
      const f = await setup();
      clearInterval((f.engine as any).timer);
      (f.engine as any).timer = null;
      clearInterval((f.engine as any).researchTimer);
      (f.engine as any).researchTimer = null;
      let armed = false,
        flipped = false;
      const killed = vi.spyOn(f.engine as any, "killed").mockImplementation(() => armed);
      const original = (f.engine as any).researchEntryBarred.bind(f.engine);
      const check = vi
        .spyOn(f.engine as any, "researchEntryBarred")
        .mockImplementation(async (...args: unknown[]) => {
          const result = await original(...args);
          if (args[0] === stage && !flipped) {
            flipped = true;
            armed = true;
          }
          return result;
        });
      await f.engine.receive(f.tx, Date.now(), "finalized");
      await f.engine.idle();
      expect(flipped).toBe(true);
      expect(f.engine.state().researchPaper!.account.emergencyStopLatched).toBe(true);
      const count = f.calls.length;
      armed = false;
      killed.mockRestore();
      check.mockRestore();
      f.advance(31_000);
      const later = structuredClone(f.tx);
      later.transaction.signatures[0] = bs58.encode(new Uint8Array(64).fill(51));
      await f.engine.receive(later, Date.now(), "finalized");
      await f.engine.idle();
      expect(f.calls).toHaveLength(count);
      expect(f.engine.state().researchPaper!.positions).toEqual([]);
    },
    15000,
  );

  it("offers a bounded baseline turn after its captured analysis even while newer work remains queued", async () => {
    const f = await setup();
    clearInterval((f.engine as any).timer);
    (f.engine as any).timer = null;
    clearInterval((f.engine as any).researchTimer);
    (f.engine as any).researchTimer = null;
    let releaseFirst!: () => void, releaseLater!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const later = new Promise<void>((resolve) => {
      releaseLater = resolve;
    });
    const sample = vi.spyOn((f.engine as any).quoteResearch, "sample").mockResolvedValue(undefined);
    (f.engine as any).work = first;
    (f.engine as any).deferBaselineUntilAnalysis(decodeTransaction(f.tx, Date.now())[0]);
    (f.engine as any).work = later;
    try {
      releaseFirst();
      await vi.waitFor(() => expect(sample).toHaveBeenCalledOnce(), { timeout: 300 });
    } finally {
      releaseLater();
      await (f.engine as any).baselineWork;
      (f.engine as any).work = Promise.resolve();
    }
    expect(f.calls).toHaveLength(0);
  }, 15000);

  it("arbitrates fast and full callbacks ahead of baseline sampling with both research defaults enabled", async () => {
    const f = await setup({ defaultResearch: true });
    // Drive timer work explicitly so injected clock jumps do not race periodic callbacks.
    clearInterval((f.engine as any).timer);
    (f.engine as any).timer = null;
    clearInterval((f.engine as any).researchTimer);
    (f.engine as any).researchTimer = null;
    const collector = (f.engine as any).quoteResearch;
    const samples = vi.spyOn(collector, "sample");
    expect(process.env.PHANTOM_QUOTE_RESEARCH).toBeUndefined();
    expect(process.env.PHANTOM_FORWARD_RESEARCH).toBeUndefined();
    expect(f.engine.state().forwardResearch).not.toBeNull();
    await f.engine.recordLogs({
      signature: f.tx.transaction.signatures[0],
      slot: f.tx.slot,
      receivedAt: Date.now(),
      logs: f.tx.meta!.logMessages!,
      commitment: "finalized",
    });
    expect(samples).not.toHaveBeenCalled();
    expect(f.calls).toHaveLength(0);
    await f.engine.receive(f.tx, Date.now(), "finalized");
    await f.engine.idle();
    expect(f.calls).toHaveLength(4);
    expect(f.calls.every((c) => c.input.slippageBps === 25)).toBe(true);
    expect(f.engine.state().researchPaper!.positions).toHaveLength(1);
    // Baseline remains enabled and gets a later full-event turn when the book is occupied.
    f.advance(31_000);
    const later = structuredClone(f.tx);
    later.transaction.signatures[0] = bs58.encode(new Uint8Array(64).fill(43));
    await f.engine.receive(later, Date.now(), "finalized");
    await f.engine.idle();
    expect(samples).toHaveBeenCalledTimes(2);
    expect(f.calls).toHaveLength(6);
    const baselines = await f.engine.store.query(
      "SELECT payload FROM phantom_quote_research WHERE payload->>'phase'='BASELINE'",
    );
    expect(baselines).toHaveLength(1);
    expect(baselines[0].payload.forwardExperimentId).toBe(
      f.engine.state().forwardResearch!.experimentId,
    );
    const window = await (f.engine as any).forwardRuntime.collector.nextQuoteWindow();
    f.advance(Math.max(0, window.dueAt - Date.now()));
    await collector.tick(f.provider);
    expect(f.calls).toHaveLength(7); // Four modeled-entry quotes, two baseline quotes, one fresh forward entry.
    const records = await f.engine.store.query(
      "SELECT payload FROM phantom_forward_records WHERE phase='ENTRY_RESULT'",
    );
    expect(records).toHaveLength(1);
    await collector.tick(f.provider);
    expect(f.calls).toHaveLength(7); // A due legacy horizon cannot bypass the spent shared budget.
    expect(f.engine.state().researchPaper!.positions).toHaveLength(1);
  }, 30000);

  it("keeps a genuine due forward turn ahead of an otherwise valid experimental candidate", async () => {
    const f = await setup({ defaultResearch: true });
    clearInterval((f.engine as any).timer);
    (f.engine as any).timer = null;
    clearInterval((f.engine as any).researchTimer);
    (f.engine as any).researchTimer = null;
    const signal = vi.mocked((f.engine as any).feature).getMockImplementation()!;
    vi.mocked((f.engine as any).feature).mockImplementation((...args: unknown[]) => ({
      ...signal(...args),
      observations: 1,
    }));
    await f.engine.receive(f.tx, Date.now(), "finalized");
    await f.engine.idle();
    expect(f.calls).toHaveLength(2); // With no valid signal, the enabled baseline owns this turn.
    vi.mocked((f.engine as any).feature).mockImplementation(signal);
    const collector = (f.engine as any).quoteResearch;
    const window = await (f.engine as any).forwardRuntime.collector.nextQuoteWindow();
    f.advance(Math.max(0, window.dueAt - Date.now()));
    const later = structuredClone(f.tx);
    later.transaction.signatures[0] = bs58.encode(new Uint8Array(64).fill(47));
    await f.engine.receive(later, Date.now(), "finalized");
    await f.engine.idle();
    expect(f.calls).toHaveLength(2);
    expect(f.engine.state().researchPaper!.positions).toEqual([]);
    await collector.tick(f.provider);
    expect(f.calls).toHaveLength(3);
    expect(
      await f.engine.store.query(
        "SELECT payload FROM phantom_forward_records WHERE phase='ENTRY_RESULT'",
      ),
    ).toHaveLength(1);
  }, 30000);

  it("keeps an observed initial-quote kill latched after the file is cleared", async () => {
    const f = await setup();
    f.setStopDuringBuy();
    await f.engine.receive(f.tx, Date.now(), "finalized");
    await f.engine.idle();
    expect(f.engine.state().researchPaper!.account.emergencyStopLatched).toBe(true);
    await rm(join(f.dir, "KILL"));
    f.setStopDuringBuy(false);
    f.advance(31_000);
    const later = structuredClone(f.tx);
    later.transaction.signatures[0] = bs58.encode(new Uint8Array(64).fill(44));
    await f.engine.receive(later, Date.now(), "finalized");
    await f.engine.idle();
    expect(f.calls).toHaveLength(1);
    expect(f.engine.state().researchPaper!.positions).toEqual([]);
  }, 15000);

  it("latches a stop observed before analysis even when the file clears before a tick", async () => {
    const f = await setup();
    clearInterval((f.engine as any).timer);
    (f.engine as any).timer = null;
    clearInterval((f.engine as any).researchTimer);
    (f.engine as any).researchTimer = null;
    await writeFile(join(f.dir, "KILL"), "synthetic stop before analysis");
    await f.engine.receive(f.tx, Date.now(), "finalized");
    await f.engine.idle();
    expect(f.engine.state().researchPaper!.account.emergencyStopLatched).toBe(true);
    await rm(join(f.dir, "KILL"));
    f.advance(31_000);
    const later = structuredClone(f.tx);
    later.transaction.signatures[0] = bs58.encode(new Uint8Array(64).fill(48));
    await f.engine.receive(later, Date.now(), "finalized");
    await f.engine.idle();
    expect(f.calls).toHaveLength(0);
    expect(f.engine.state().researchPaper!.positions).toEqual([]);
  }, 15000);

  it("latches a stop observed during the real entry delay without a periodic tick", async () => {
    const f = await setup();
    clearInterval((f.engine as any).timer);
    (f.engine as any).timer = null;
    clearInterval((f.engine as any).researchTimer);
    (f.engine as any).researchTimer = null;
    await f.engine.receive(f.tx, Date.now(), "finalized");
    await vi.waitFor(() => expect(f.engine.state().researchPaper!.pending).toHaveLength(1), {
      timeout: 4000,
      interval: 20,
    });
    await writeFile(join(f.dir, "KILL"), "synthetic stop during delay");
    await f.engine.idle();
    expect(f.engine.state().researchPaper!.account.emergencyStopLatched).toBe(true);
    expect(f.engine.state().researchPaper!.pending).toEqual([]);
    await rm(join(f.dir, "KILL"));
    f.advance(31_000);
    const later = structuredClone(f.tx);
    later.transaction.signatures[0] = bs58.encode(new Uint8Array(64).fill(49));
    await f.engine.receive(later, Date.now(), "finalized");
    await f.engine.idle();
    expect(f.calls).toHaveLength(2);
    expect(f.engine.state().researchPaper!.positions).toEqual([]);
  }, 15000);

  it("does not reserve an experimental turn after restoring a durably stopped book", async () => {
    const f = await setup();
    await f.engine.stop();
    const restored = new Engine();
    restored.setQuoteProvider(f.provider);
    await restored.start({ stream: false, port: 0 });
    engines.push(restored);
    vi.spyOn(restored as any, "feature").mockImplementation(
      vi.mocked((f.engine as any).feature).getMockImplementation()!,
    );
    const inspect = vi
      .spyOn(restored.security, "inspect")
      .mockRejectedValue(Error("UNEXPECTED_SECURITY_AFTER_STOP"));
    const reserve = vi.spyOn((restored as any).quoteResearch, "externalTurn");
    f.advance(31_000);
    const later = structuredClone(f.tx);
    later.transaction.signatures[0] = bs58.encode(new Uint8Array(64).fill(45));
    await restored.receive(later, Date.now(), "finalized");
    await restored.idle();
    expect(reserve).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    expect(f.calls).toHaveLength(0);
  }, 15000);

  it("expires an ordinary turn without latching a stop and allows a later fresh candidate", async () => {
    const f = await setup(),
      inspect = vi.mocked(f.engine.security.inspect).getMockImplementation()!;
    vi.mocked(f.engine.security.inspect).mockImplementation(async (...args) => {
      const snapshot = await inspect(...args);
      f.advance(31_000);
      return snapshot;
    });
    await f.engine.receive(f.tx, Date.now(), "finalized");
    await f.engine.idle();
    expect(f.calls).toHaveLength(0);
    expect(f.engine.state().researchPaper!.account.emergencyStopLatched).toBe(false);
    vi.mocked(f.engine.security.inspect).mockImplementation(inspect);
    const later = structuredClone(f.tx);
    later.transaction.signatures[0] = bs58.encode(new Uint8Array(64).fill(46));
    await f.engine.receive(later, Date.now(), "finalized");
    await f.engine.idle();
    expect(f.calls).toHaveLength(4);
    expect(f.engine.state().researchPaper!.positions).toHaveLength(1);
  }, 30000);
  it("observes a 25bps original pair, waits real delay, settles separately and exposes the book through the Omni contract", async () => {
    const f = await setup();
    await f.engine.receive(f.tx, Date.now(), "finalized");
    await f.engine.idle();
    const state = f.engine.state(),
      book = state.researchPaper!;
    expect(
      f.calls,
      JSON.stringify({
        reasons: state.decisions.map((d) => d.reasons),
        journal: book.journal.map((j) => j.kind),
        health: state.health.lastError,
      }),
    ).toHaveLength(4);
    expect(f.calls.every((c) => c.input.slippageBps === 25)).toBe(true);
    for (let i = 1; i < f.calls.length; i++)
      expect(f.calls[i].requestedAt - f.calls[i - 1].requestedAt).toBeGreaterThanOrEqual(1000);
    expect(f.calls[3].observedAt - f.calls[0].requestedAt).toBeLessThan(30_000);
    expect(
      f.calls.filter((c) => c.input.inputMint === WSOL).every((c) => c.input.amount === 10000000n),
    ).toBe(true);
    expect(
      f.calls.filter((c) => c.input.outputMint === WSOL).every((c) => c.input.amount === 997500n),
    ).toBe(true);
    const intent = book.journal.find((j) => j.kind === "ENTRY_INTENT")!;
    expect(f.calls[2].requestedAt - intent.at).toBeGreaterThanOrEqual(2000);
    expect(book.positions).toHaveLength(1);
    expect(book.account.cashLamports).toBe(989990000n);
    expect(state.cashLamports).toBe(1000000000n);
    expect(state.positions).toEqual([]);
    const captures = await f.engine.store.query(
      "SELECT payload FROM phantom_state WHERE id LIKE 'research-decision:%'",
    );
    expect(captures).toHaveLength(1);
    expect(captures[0].payload.initialQuoteEvidence.slippageBps).toBe(25);
    expect(captures[0].payload.features.executionCostBps).toBe(140);
    expect(captures[0].payload.costObservedAt).toBe(f.calls[1].observedAt);
    expect(captures[0].payload.initialQuoteEvidence.buy.requestedAt).toBeGreaterThanOrEqual(
      captures[0].payload.mintAccountCapture.publishedAt,
    );
    const report = parsePhantomState(
      await (await fetch(f.engine.url + "/state")).json(),
      Date.now(),
    );
    expect(report.state?.researchPaperStatus).toBe("available");
    expect(report.state?.researchPaper?.account.liveApproved).toBe(false);
    let strictEntered!: () => void, releaseStrict!: () => void;
    const strictStarted = new Promise<void>((resolve) => {
      strictEntered = resolve;
    });
    const strictGate = new Promise<void>((resolve) => {
      releaseStrict = resolve;
    });
    const manage = vi.spyOn(f.engine as any, "managePositions").mockImplementation(async () => {
      strictEntered();
      await strictGate;
    });
    await writeFile(join(f.dir, "KILL"), "synthetic emergency");
    const protection = f.engine.tick();
    await strictStarted;
    // The research intent and delay clock must already exist while the strict provider phase waits.
    expect(f.engine.state().researchPaper!.pendingExits).toHaveLength(1);
    expect(f.calls).toHaveLength(4);
    releaseStrict();
    await protection;
    manage.mockRestore();
    expect(f.engine.state().researchPaper!.pendingExits).toHaveLength(1);
    await sleep(2050);
    await f.engine.tick();
    const closed = f.engine.state().researchPaper!;
    expect(closed.positions).toEqual([]);
    expect(closed.trades).toHaveLength(1);
    expect(closed.status).toBe("ENTRY_STOPPED");
    expect(closed.account.realizedPnlLamports).toBe(-140000n);
    expect(f.engine.state().cashLamports).toBe(1000000000n);
    await f.engine.stop();
    const restarted = new Engine();
    restarted.setQuoteProvider(f.provider);
    await restarted.start({ stream: false, port: 0 });
    engines.push(restarted);
    expect(restarted.state().researchPaper!.account.cashLamports).toBe(closed.account.cashLamports);
    expect(restarted.state().researchPaper!.status).toBe("ENTRY_STOPPED");
  }, 30000);

  it("vetoes a kill arriving during original quote I/O without reserving inventory", async () => {
    const f = await setup();
    f.setStopDuringBuy();
    await f.engine.receive(f.tx, Date.now(), "finalized");
    await f.engine.idle();
    expect(f.engine.state().researchPaper!.positions).toEqual([]);
    expect(f.engine.state().researchPaper!.pending).toEqual([]);
    expect(f.engine.state().researchPaper!.account.cashLamports).toBe(1000000000n);
    expect(f.calls).toHaveLength(1);
  }, 15000);

  it("refuses missing durable book state instead of recreating the initial capital", async () => {
    const f = await setup(),
      key = `research-paper:${f.engine.state().researchPaper!.account.bookId}`;
    await f.engine.stop();
    const store = await new Store().open(undefined, join(f.dir, "db"), true);
    await store.exec("DELETE FROM phantom_state WHERE id=$1", [key]);
    await store.close();
    const restarted = new Engine();
    restarted.setQuoteProvider(f.provider);
    await expect(restarted.start({ stream: false, port: 0 })).rejects.toThrow(
      "RESEARCH_BOOK_MISSING_NO_CAPITAL_RESET",
    );
    expect(f.calls).toHaveLength(0);
  }, 15000);

  it("closes the entry barrier during the actual execution delay on worker stop", async () => {
    const f = await setup();
    await f.engine.receive(f.tx, Date.now(), "finalized");
    await vi.waitFor(() => expect(f.engine.state().researchPaper!.pending).toHaveLength(1), {
      timeout: 3000,
      interval: 20,
    });
    await f.engine.stop();
    expect(f.calls).toHaveLength(2);
    expect(f.engine.state().researchPaper!.positions).toEqual([]);
    expect(f.engine.state().researchPaper!.pending).toEqual([]);
    expect(f.engine.state().researchPaper!.account.cashLamports).toBe(1000000000n);
    expect(f.engine.state().researchPaper!.status).toBe("ENTRY_STOPPED");
  }, 15000);

  it("suspends before enrollment if original decision capture is not durably acknowledged", async () => {
    const f = await setup(),
      exec = f.engine.store.exec.bind(f.engine.store);
    vi.spyOn(f.engine.store, "exec").mockImplementation(async (sql, args) => {
      if (typeof args?.[0] === "string" && args[0].startsWith("research-decision:"))
        throw Error("SYNTHETIC_CAPTURE_ACK_FAILURE");
      return exec(sql, args);
    });
    await f.engine.receive(f.tx, Date.now(), "finalized");
    await f.engine.idle();
    const book = f.engine.state().researchPaper!;
    expect(f.calls).toHaveLength(2);
    expect(book.positions).toEqual([]);
    expect(book.pending).toEqual([]);
    expect(book.account.cashLamports).toBe(1000000000n);
    expect(book.status).toBe("ENTRY_STOPPED");
    expect((await f.engine.store.get("suspension")).reason).toBe(
      "RESEARCH_ORIGINAL_DECISION_DURABILITY_UNCERTAIN",
    );
  }, 15000);

  it("does not issue initial quote I/O after losing the worker lease during security inspection", async () => {
    const f = await setup(),
      inspect = vi.mocked(f.engine.security.inspect).getMockImplementation()!;
    vi.mocked(f.engine.security.inspect).mockImplementation(async (...args) => {
      const snapshot = await inspect(...args);
      vi.spyOn(f.engine.store, "workerLeaseHealthy", "get").mockReturnValue(false);
      return snapshot;
    });
    await f.engine.receive(f.tx, Date.now(), "finalized");
    await f.engine.idle();
    expect(f.calls).toHaveLength(0);
    expect(f.engine.state().researchPaper!.positions).toEqual([]);
    expect(f.engine.state().researchPaper!.account.cashLamports).toBe(1000000000n);
  }, 15000);
  it("refuses a restored book whose original raw quote capture is missing", async () => {
    const f = await setup();
    await f.engine.receive(f.tx, Date.now(), "finalized");
    await vi.waitFor(() => expect(f.engine.state().researchPaper!.pending).toHaveLength(1), {
      timeout: 4000,
      interval: 20,
    });
    await f.engine.stop();
    const store = await new Store().open(undefined, join(f.dir, "db"), true);
    await store.exec("DELETE FROM phantom_state WHERE id LIKE 'research-decision:%'");
    await store.close();
    const restarted = new Engine();
    restarted.setQuoteProvider(f.provider);
    await expect(restarted.start({ stream: false, port: 0 })).rejects.toThrow(
      "RESEARCH_ORIGINAL_CAPTURE_MISSING_OR_CONTRADICTORY",
    );
    expect(f.calls).toHaveLength(2);
  }, 15000);
  it("does not dispatch delayed entry quotes when queued book work outlives its reserved turn", async () => {
    const f = await setup();
    await f.engine.receive(f.tx, Date.now(), "finalized");
    await vi.waitFor(() => expect(f.engine.state().researchPaper!.pending).toHaveLength(1), {
      timeout: 4000,
      interval: 20,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    (f.engine as any).researchBookWork = gate;
    try {
      await sleep(2100);
      f.advance(40_000);
    } finally {
      release();
    }
    await f.engine.idle();
    expect(f.calls).toHaveLength(2);
    expect(f.engine.state().researchPaper!.positions).toEqual([]);
    expect(f.engine.state().researchPaper!.account.cashLamports).toBe(1000000000n);
  }, 15000);
});

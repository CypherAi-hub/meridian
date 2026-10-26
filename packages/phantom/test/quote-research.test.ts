import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuoteResearchCollector, RESEARCH_WATCH_STATE_KEY } from "../src/quote-research.ts";
import { decodeTransaction, type RpcTransaction } from "../src/decoder.ts";
import type { QuoteProvider } from "../src/paper.ts";
import { readFileSync } from "node:fs";
import { WSOL } from "../src/types.ts";
// Synthetic clocks and quote responses; captured transaction is public provenance only.
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/real-pump-buy.json", import.meta.url), "utf8"),
) as RpcTransaction;
const event = () => decodeTransaction(fixture, Date.now())[0];
function memoryStore() {
  const rows = new Map<string, any>(),
    state = new Map<string, any>();
  return {
    rows,
    state,
    exec: async (_sql: string, args: unknown[]) => {
      const id = String(args[0]);
      if (!rows.has(id)) rows.set(id, JSON.parse(args[2] as string));
      return { rows: [] };
    },
    query: async (_sql: string, args: unknown[]) =>
      rows.has(String(args[0])) ? [{ payload: structuredClone(rows.get(String(args[0]))) }] : [],
    get: async (key: string) => (state.has(key) ? structuredClone(state.get(key)) : null),
    save: async (key: string, value: unknown) => {
      state.set(key, structuredClone(value));
    },
  };
}
const provider = () => ({
  quote: vi.fn<QuoteProvider["quote"]>(async (input) => ({
    inputMint: input.inputMint,
    outputMint: input.outputMint,
    inAmount: input.amount.toString(),
    outAmount: input.inputMint === WSOL ? "10000" : "9800000",
    minOutAmount: input.inputMint === WSOL ? "9900" : "9700000",
    impactBps: 10,
    observedAt: Date.now(),
    contextSlot: null,
    route: ["SYNTHETIC_TEST_ROUTE"],
  })),
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => vi.useRealTimers());
describe("bounded quote-only research and horizon observations", () => {
  it("keeps exact baseline sizes and models network costs once without creating fills", async () => {
    const store = memoryStore(),
      p = provider(),
      e = event(),
      collector = new QuoteResearchCollector(store as any);
    await collector.sample(e, p, 10_000_000n);
    const rows = [...store.rows.values()];
    expect(p.quote.mock.calls[1][0].amount).toBe(9900n);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "QUOTED",
      phase: "BASELINE",
      conservativeRoundTripNetLamports: "-320000",
      scope: "RESEARCH_QUOTE_ONLY_NO_TRADE",
      signature: e.signature,
    });
    expect(store.state.get(RESEARCH_WATCH_STATE_KEY).episodes[0].quantityRaw).toBe("9900");
  });
  it("preserves unavailable samples without zero costs or invented quotes", async () => {
    const store = memoryStore(),
      collector = new QuoteResearchCollector(store as any);
    await collector.sample(event(), {
      quote: async () => {
        throw Error("JUPITER_QUOTE_UNAVAILABLE");
      },
    });
    const row = [...store.rows.values()][0];
    expect(row.status).toBe("UNAVAILABLE");
    expect(row.conservativeRoundTripNetLamports).toBeUndefined();
    expect(row.buy).toBeUndefined();
    expect(store.state.get(RESEARCH_WATCH_STATE_KEY).episodes).toHaveLength(0);
  });
  it("samples 30/60/180s horizons at original hypothetical token quantity", async () => {
    const store = memoryStore(),
      collector = new QuoteResearchCollector(store as any),
      p = provider();
    await collector.sample(event(), p);
    await collector.tick(p);
    expect(p.quote).toHaveBeenCalledTimes(2);
    for (const horizon of [30_000, 60_000, 180_000]) {
      vi.setSystemTime(1_000_000 + horizon);
      await collector.tick(p);
    }
    const horizons = [...store.rows.values()].filter((r) => r.phase === "HORIZON");
    expect(horizons).toHaveLength(3);
    expect(p.quote.mock.calls.slice(2).every(([input]) => input.amount === 9900n)).toBe(true);
    expect(horizons.map((r) => r.horizonMs)).toEqual([30_000, 60_000, 180_000]);
    expect(
      horizons.every(
        (r) =>
          r.status === "QUOTED" && r.observedAt >= r.targetAt && r.quoteFreshness.sell === "FRESH",
      ),
    ).toBe(true);
    expect(horizons[0]).toMatchObject({
      hypotheticalTokenQuantityRaw: "9900",
      hypotheticalHorizonNetLamports: "-320000",
      hypotheticalHorizonReturnBps: -320,
    });
    expect(horizons[0].conservativeRoundTripCostBps).toBeUndefined();
    expect(store.state.get(RESEARCH_WATCH_STATE_KEY).episodes).toHaveLength(0);
  });
  it("shares a persisted 30s budget and processes at most one due horizon per tick", async () => {
    const store = memoryStore(),
      p = provider(),
      collector = new QuoteResearchCollector(store as any);
    await collector.sample(event(), p);
    vi.setSystemTime(1_180_000);
    await collector.tick(p);
    await collector.tick(p);
    expect(p.quote).toHaveBeenCalledTimes(3);
    expect([...store.rows.values()].filter((r) => r.phase === "HORIZON")).toHaveLength(1);
    const restarted = new QuoteResearchCollector(store as any);
    await restarted.initialize();
    await restarted.tick(p);
    expect(p.quote).toHaveBeenCalledTimes(3);
    vi.setSystemTime(1_210_000);
    await restarted.tick(p);
    expect(p.quote).toHaveBeenCalledTimes(4);
  });
  it("deduplicates an already persisted horizon after interrupted state checkpoint", async () => {
    const store = memoryStore(),
      p = provider(),
      collector = new QuoteResearchCollector(store as any);
    await collector.sample(event(), p);
    const checkpoint = structuredClone(store.state.get(RESEARCH_WATCH_STATE_KEY));
    vi.setSystemTime(1_030_000);
    await collector.tick(p);
    store.state.set(RESEARCH_WATCH_STATE_KEY, checkpoint);
    const restarted = new QuoteResearchCollector(store as any);
    await restarted.initialize();
    await restarted.tick(p);
    expect(p.quote).toHaveBeenCalledTimes(3);
    expect([...store.rows.values()].filter((r) => r.phase === "HORIZON")).toHaveLength(1);
  });
  it("records expired missing horizons without calling a provider or backdating values", async () => {
    const store = memoryStore(),
      p = provider(),
      collector = new QuoteResearchCollector(store as any);
    await collector.sample(event(), p);
    vi.setSystemTime(1_601_000);
    await collector.tick(p);
    const row = [...store.rows.values()].find((r) => r.phase === "HORIZON");
    expect(row).toMatchObject({
      status: "UNAVAILABLE",
      error: "HORIZON_EXPIRED_NO_OBSERVATION",
      observedAt: 1_601_000,
      targetAt: 1_030_000,
    });
    expect(row.hypotheticalHorizonNetLamports).toBeUndefined();
    expect(p.quote).toHaveBeenCalledTimes(2);
  });
  it("rejects stale, future, and pre-target horizon quotes instead of filling gaps", async () => {
    for (const shift of [-6000, 1, -1]) {
      vi.setSystemTime(1_000_000);
      const store = memoryStore(),
        p = provider(),
        collector = new QuoteResearchCollector(store as any);
      await collector.sample(event(), p);
      vi.setSystemTime(1_030_000);
      p.quote.mockImplementationOnce(async (input) => ({
        inputMint: input.inputMint,
        outputMint: input.outputMint,
        inAmount: String(input.amount),
        outAmount: "10000000",
        minOutAmount: "9900000",
        impactBps: 0,
        observedAt: Date.now() + shift,
        contextSlot: null,
        route: ["SYNTHETIC_TEST_ROUTE"],
      }));
      await collector.tick(p);
      const row = [...store.rows.values()].find((r) => r.phase === "HORIZON");
      expect(row.status).toBe("UNAVAILABLE");
      expect(row.hypotheticalHorizonReturnBps).toBeUndefined();
    }
  });
  it("does not persist an unverified baseline quantity as a usable episode", async () => {
    const store = memoryStore(),
      p = provider(),
      collector = new QuoteResearchCollector(store as any);
    p.quote.mockImplementationOnce(async (input) => ({
      inputMint: input.inputMint,
      outputMint: input.outputMint,
      inAmount: String(input.amount + 1n),
      outAmount: "10000",
      minOutAmount: "9900",
      impactBps: 0,
      observedAt: Date.now(),
      contextSlot: null,
      route: ["SYNTHETIC_TEST_ROUTE"],
    }));
    await collector.sample(event(), p);
    expect([...store.rows.values()][0].status).toBe("UNAVAILABLE");
    expect(store.state.get(RESEARCH_WATCH_STATE_KEY).episodes).toHaveLength(0);
  });
  it("prioritizes due watches rather than allowing baseline traffic to starve horizons", async () => {
    const store = memoryStore(),
      p = provider(),
      collector = new QuoteResearchCollector(store as any);
    await collector.sample(event(), p);
    vi.setSystemTime(1_030_000);
    await collector.sample({ ...event(), mint: "SYNTHETIC_OTHER_MINT" }, p);
    expect(p.quote).toHaveBeenCalledTimes(2);
    await collector.tick(p);
    expect(p.quote).toHaveBeenCalledTimes(3);
  });
  it("keeps due horizon priority under continuous new-token baseline pressure", async () => {
    const store = memoryStore(),
      p = provider(),
      collector = new QuoteResearchCollector(store as any);
    await collector.sample(event(), p);
    for (const [index, at] of [1_180_000, 1_210_000, 1_240_000].entries()) {
      vi.setSystemTime(at);
      for (let i = 0; i < 1000; i++)
        await collector.sample({ ...event(), mint: `SYNTHETIC_PRESSURE_${index}_${i}` }, p);
      expect(p.quote).toHaveBeenCalledTimes(2 + index);
      await collector.tick(p);
      expect(p.quote).toHaveBeenCalledTimes(3 + index);
    }
    expect([...store.rows.values()].filter((r) => r.phase === "HORIZON")).toHaveLength(3);
  });
  it("spaces new baseline attempts by at least90s independently of the shared30s budget", async () => {
    const store = memoryStore(),
      p = provider(),
      collector = new QuoteResearchCollector(store as any);
    p.quote.mockRejectedValueOnce(Error("SYNTHETIC_PROVIDER_UNAVAILABLE"));
    await collector.sample(event(), p);
    vi.setSystemTime(1_030_000);
    await collector.sample({ ...event(), mint: "SYNTHETIC_NEW_MINT" }, p);
    expect(p.quote).toHaveBeenCalledTimes(1);
    vi.setSystemTime(1_090_000);
    await collector.sample({ ...event(), mint: "SYNTHETIC_NEW_MINT" }, p);
    expect(p.quote).toHaveBeenCalledTimes(3);
  });
  it("caps persisted watches and refuses over-budget configuration", async () => {
    const store = memoryStore(),
      p = provider(),
      collector = new QuoteResearchCollector(store as any);
    await collector.sample(event(), p);
    const saved = store.state.get(RESEARCH_WATCH_STATE_KEY),
      episode = saved.episodes[0];
    saved.episodes = Array.from({ length: 10 }, (_, i) => ({
      ...structuredClone(episode),
      id: `fixture-${i}`,
      mint: `fixture-${i}`,
      buy: { ...episode.buy, outputMint: `fixture-${i}` },
    }));
    store.state.set(RESEARCH_WATCH_STATE_KEY, saved);
    const full = new QuoteResearchCollector(store as any);
    await full.initialize();
    await full.sample({ ...event(), mint: "SYNTHETIC_EXTRA_MINT" }, p);
    expect(p.quote).toHaveBeenCalledTimes(2);
    saved.episodes.push({ ...structuredClone(saved.episodes[0]), id: "fixture-over-limit" });
    store.state.set(RESEARCH_WATCH_STATE_KEY, saved);
    await expect(new QuoteResearchCollector(store as any).initialize()).rejects.toThrow(
      "STATE_INVALID",
    );
    expect(() => new QuoteResearchCollector(store as any, 29_999)).toThrow("RATE_TOO_HIGH");
  });
  it("never exposes arbitrary provider errors in research payloads", async () => {
    const store = memoryStore(),
      collector = new QuoteResearchCollector(store as any);
    await collector.sample(event(), {
      quote: async () => {
        throw Error("Provider URL has ?key=SYNTHETIC_SECRET");
      },
    });
    expect([...store.rows.values()][0].error).toBe("RESEARCH_QUOTE_PROVIDER_UNAVAILABLE");
  });
});

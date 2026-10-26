/** Synthetic quote clocks with an actual isolated PGlite journal. No network or orders. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Store } from "../src/store.ts";
import { QuoteResearchCollector } from "../src/quote-research.ts";
import { ForwardCohortCollector, freezeForwardProtocol } from "../src/forward-cohort.ts";
import { ForwardSqlJournal } from "../src/forward-cohort-store.ts";
import { decodeTransaction } from "../src/decoder.ts";
import { WSOL } from "../src/types.ts";
import type { QuoteProvider } from "../src/paper.ts";
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/real-pump-buy.json", import.meta.url), "utf8"),
);
const opened: Array<{ store: Store; directory: string }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const { store, directory } of opened.splice(0)) {
    await store.close();
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep))
      throw Error("UNEXPECTED_TEST_DIRECTORY");
    rmSync(directory, { recursive: true, force: true });
  }
});
async function setup() {
  const directory = mkdtempSync(join(tmpdir(), "phantom-forward-budget-"));
  const store = await new Store().open(undefined, join(directory, "db"), true);
  opened.push({ store, directory });
  await store.save("ledger", { cashLamports: "1000000000", positions: [], trades: [] });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_000_000);
  const protocol = freezeForwardProtocol({
    now: Date.now(),
    runtimeSourceVersion: "a".repeat(64),
    sourceCommit: "b".repeat(40),
  });
  const journal = new ForwardSqlJournal(store);
  const collector = new ForwardCohortCollector(protocol, journal, protocol.runtimeSourceVersion);
  await collector.initialize();
  const provider: QuoteProvider = {
    quote: vi.fn(async (input) => ({
      inputMint: input.inputMint,
      outputMint: input.outputMint,
      inAmount: String(input.amount),
      outAmount: input.inputMint === WSOL ? "10000" : "10000000",
      minOutAmount: input.inputMint === WSOL ? "9900" : "9900000",
      observedAt: Date.now(),
      impactBps: 10,
      contextSlot: null,
      route: ["SYNTHETIC_TEST_ONLY"],
    })),
  };
  const event = () => decodeTransaction(fixture, Date.now())[0];
  return { store, protocol, journal, forward: collector, provider, event };
}
describe("shared forward and legacy research budget", () => {
  it("reserves the32s entry before a30s legacy horizon and preserves exact exit quantity", async () => {
    const f = await setup(),
      research = new QuoteResearchCollector(f.store, 30_000, f.forward);
    vi.setSystemTime(1_001_000);
    await research.sample(f.event(), f.provider);
    expect(f.provider.quote).toHaveBeenCalledTimes(2);
    vi.setSystemTime(1_031_000);
    await research.tick(f.provider);
    expect(f.provider.quote).toHaveBeenCalledTimes(2);
    expect(research.status().forwardReservationDeferrals).toBe(1);
    vi.setSystemTime(1_034_000);
    await research.tick(f.provider);
    expect(f.provider.quote).toHaveBeenCalledTimes(3);
    vi.setSystemTime(1_064_000);
    await research.tick(f.provider);
    expect(f.provider.quote).toHaveBeenCalledTimes(4);
    vi.setSystemTime(1_094_000);
    await research.tick(f.provider);
    expect(f.provider.quote).toHaveBeenCalledTimes(5);
    const rows = (await f.forward.export()).records;
    expect(rows.map((r) => r.phase)).toEqual([
      "ENROLLMENT",
      "ENTRY_REQUEST",
      "ENTRY_RESULT",
      "EXIT_REQUEST",
      "EXIT_RESULT",
    ]);
    expect(rows.at(-1)!.data).toMatchObject({ status: "QUOTED", originalQuantityRaw: "9900" });
    const request = vi.mocked(f.provider.quote).mock.calls.at(-1)![0];
    expect(request.amount).toBe(9900n);
    expect(
      vi.mocked(f.provider.quote).mock.calls.every(([input]) => input.priority === "research"),
    ).toBe(true);
    expect(await f.store.get("ledger")).toEqual({
      cashLamports: "1000000000",
      positions: [],
      trades: [],
    });
    const legacy = (await f.store.query("SELECT payload FROM phantom_quote_research")).map(
      (r) => r.payload,
    );
    expect(legacy.find((r) => r.phase === "HORIZON")).toMatchObject({ delayPastTargetMs: 33_000 });
  });
  it("records a missed forward entry when protective work holds the turn without spending budget", async () => {
    const f = await setup();
    let permit = true;
    const research = new QuoteResearchCollector(f.store, 30_000, f.forward, () => permit);
    vi.setSystemTime(1_001_000);
    await research.sample(f.event(), f.provider);
    const reserved = research.status().lastProviderSampleAt;
    permit = false;
    vi.setSystemTime(1_034_000);
    await research.tick(f.provider);
    expect(research.status().lastProviderSampleAt).toBe(reserved);
    vi.setSystemTime(1_039_000);
    await research.tick(f.provider);
    expect(f.provider.quote).toHaveBeenCalledTimes(2);
    expect((await f.forward.export()).records.at(-1)!.data.status).toBe("MISSED_DEADLINE_NO_QUOTE");
  });
  it("recovers only tagged durable first probes after a lost hook, without a new quote", async () => {
    const f = await setup(),
      research = new QuoteResearchCollector(f.store, 30_000, f.forward);
    await f.store.exec(
      "INSERT INTO phantom_quote_research(id,at,payload) VALUES($1,$2,$3::jsonb)",
      [
        "SYNTHETIC_UNTAGGED_OLD_PROBE",
        1_000_000,
        JSON.stringify({ phase: "BASELINE", mint: f.event().mint }),
      ],
    );
    const callback = vi
      .spyOn(f.forward, "considerProbe")
      .mockRejectedValueOnce(Error("SYNTHETIC_HOOK_LOST"));
    vi.setSystemTime(1_001_000);
    await expect(research.sample(f.event(), f.provider)).rejects.toThrow("SYNTHETIC_HOOK_LOST");
    expect(f.provider.quote).toHaveBeenCalledTimes(2);
    callback.mockRestore();
    const restarted = new QuoteResearchCollector(f.store, 30_000, f.forward);
    vi.setSystemTime(1_001_010);
    await restarted.tick(f.provider);
    expect(f.provider.quote).toHaveBeenCalledTimes(2);
    expect((await f.forward.export()).records).toHaveLength(1);
    expect(restarted.status().recoveredForwardProbes).toBe(1);
    expect((await f.forward.export()).records[0].data.probeCompletedAt).toBe(1_001_000);
  });
  it("records a stale recovered first probe as rejected instead of retrospectively entering", async () => {
    const f = await setup(),
      research = new QuoteResearchCollector(f.store, 30_000, f.forward);
    const callback = vi
      .spyOn(f.forward, "considerProbe")
      .mockRejectedValueOnce(Error("SYNTHETIC_HOOK_LOST"));
    vi.setSystemTime(1_001_000);
    await expect(research.sample(f.event(), f.provider)).rejects.toThrow("SYNTHETIC_HOOK_LOST");
    callback.mockRestore();
    vi.setSystemTime(1_008_000);
    await new QuoteResearchCollector(f.store, 30_000, f.forward).tick(f.provider);
    const enrollment = (await f.forward.export()).records[0];
    expect(enrollment.data).toMatchObject({
      admitted: false,
      reasons: expect.arrayContaining(["PROBE_OUTSIDE_PROSPECTIVE_TIME_OR_SIZE"]),
    });
    expect(await f.forward.nextQuoteWindow()).toBeNull();
    expect(f.provider.quote).toHaveBeenCalledTimes(2);
  });
  it("keeps pre-enrollment source backlog out of the mint's first prospective slot", async () => {
    const f = await setup(),
      research = new QuoteResearchCollector(f.store, 30_000, f.forward);
    vi.setSystemTime(1_001_000);
    await research.sample({ ...f.event(), receivedAt: 1_000_000 }, f.provider);
    expect((await f.forward.export()).records).toEqual([]);
    for (const offset of [30_000, 60_000, 180_000]) {
      vi.setSystemTime(1_001_000 + offset);
      await research.tick(f.provider);
    }
    vi.setSystemTime(1_211_000);
    await research.sample(f.event(), f.provider);
    const enrollment = (await f.forward.export()).records[0];
    expect(enrollment.phase).toBe("ENROLLMENT");
    expect(enrollment.data).toMatchObject({ eventObservedAt: 1_211_000, admitted: true });
    const baselines = (
      await f.store.query("SELECT payload FROM phantom_quote_research ORDER BY at,id")
    )
      .map((r) => r.payload)
      .filter((r) => r.phase === "BASELINE");
    expect(baselines[0].forwardExperimentId).toBeUndefined();
    expect(baselines[1].forwardExperimentId).toBe(f.protocol.experimentId);
  });
});

/** Real local HTTP and isolated PGlite; all quote/probe fixtures remain synthetic. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Engine } from "../src/engine.ts";
import { Store } from "../src/store.ts";
import { ForwardRuntime } from "../src/forward-runtime.ts";
import { ForwardSqlJournal } from "../src/forward-cohort-store.ts";
import { freezeForwardProtocol } from "../src/forward-cohort.ts";
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const original = { ...process.env };
const directories: string[] = [];
const engines: Engine[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep))
      throw Error("UNEXPECTED_TEST_DIRECTORY");
    rmSync(directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});
function environment() {
  const directory = mkdtempSync(join(tmpdir(), "phantom-forward-api-"));
  directories.push(directory);
  process.env.PHANTOM_DATA_DIR = join(directory, "db");
  process.env.PHANTOM_KILL_FILE = join(directory, "KILL");
  process.env.PHANTOM_MODE = "PAPER";
  process.env.PHANTOM_KILL_SWITCH = "false";
  process.env.PHANTOM_QUOTE_RESEARCH = "true";
  process.env.PHANTOM_FORWARD_RESEARCH = "true";
  process.env.PHANTOM_WALLET_HISTORY = "false";
  delete process.env.PHANTOM_DATABASE_URL;
  delete process.env.NODE_ENV;
}
async function start() {
  const engine = await new Engine().start({ stream: false, port: 0, sourceCommit: "b".repeat(40) });
  engines.push(engine);
  return engine;
}
describe("read-only forward cohort API", () => {
  it("exports its frozen source manifest, validates fixed queries and preserves the paper book", async () => {
    environment();
    const engine = await start();
    const before = engine.state(),
      url = engine.url!;
    const exported = await fetch(url + "/forward-cohort").then((r) => r.json());
    expect(exported.protocol.runtimeSourceVersion).toBe(engine.sourceVersion);
    expect(exported.protocol.sourceCommit).toBe("b".repeat(40));
    expect(exported.protocol.minimumEntryDelayMs).toBe(32_000);
    expect(exported.records).toEqual([]);
    expect(exported.probeDeliveryAudit).toMatchObject({
      status: "COMPLETE",
      distinctTaggedMints: 0,
      missingEnrollmentMints: 0,
    });
    const history = await fetch(url + "/forward-cohorts").then((r) => r.json());
    expect(history.experiments).toHaveLength(1);
    expect(history.activeExperimentId).toBe(exported.protocol.experimentId);
    expect((await fetch(url + "/forward-cohort", { method: "POST" })).status).toBe(405);
    expect((await fetch(url + "/forward-cohort?source=https://example.invalid")).status).toBe(400);
    expect((await fetch(url + "/forward-cohort?experiment=a&experiment=b")).status).toBe(400);
    expect((await fetch(url + "/forward-cohort?experiment=missing")).status).toBe(404);
    expect((await fetch(url + "/forward-cohort?experiment=%2e%2e%2fsecret")).status).toBe(404);
    const after = engine.state();
    expect({ cash: after.cashLamports, positions: after.positions, trades: after.trades }).toEqual({
      cash: before.cashLamports,
      positions: before.positions,
      trades: before.trades,
    });
    expect(after.forwardResearch).toMatchObject({
      scope: "FORWARD_QUOTE_COHORT_NOT_TRADES",
      security: "UNASSESSED_NOT_TRADABLE",
    });
  });
  it("reuses the original enrollment on engine close/reopen instead of restarting the experiment", async () => {
    environment();
    const first = await start();
    const originalExport = await fetch(first.url! + "/forward-cohort").then((r) => r.json());
    await first.stop();
    engines.splice(engines.indexOf(first), 1);
    const second = await start();
    const restarted = await fetch(second.url! + "/forward-cohort").then((r) => r.json());
    expect(restarted.protocol).toEqual(originalExport.protocol);
    expect(
      (await fetch(second.url! + "/forward-cohorts").then((r) => r.json())).experiments,
    ).toHaveLength(1);
  });
  it("reports disabled research rather than substituting an empty successful cohort", async () => {
    environment();
    process.env.PHANTOM_FORWARD_RESEARCH = "false";
    const engine = await start();
    expect((await fetch(engine.url! + "/forward-cohort")).status).toBe(503);
    expect((await fetch(engine.url! + "/forward-cohorts")).status).toBe(503);
    expect(engine.state().forwardResearch).toBeNull();
  });
  it("exposes lost delivery for a retired closed cohort without relabeling or enrolling it", async () => {
    environment();
    const engine = await start();
    const old = freezeForwardProtocol({
      now: Date.now() - 73 * 3_600_000,
      runtimeSourceVersion: "c".repeat(64),
      sourceCommit: "d".repeat(40),
    });
    const journal = new ForwardSqlJournal(engine.store);
    await journal.ensureProtocol(old);
    await engine.store.exec(
      "INSERT INTO phantom_quote_research(id,at,payload) VALUES($1,$2,$3::jsonb)",
      [
        "SYNTHETIC_LOST_RETIRED",
        old.enrollmentStart + 2000,
        JSON.stringify({
          phase: "BASELINE",
          mint: MINT,
          forwardExperimentId: old.experimentId,
          forwardProbe: { id: "lost-first-probe" },
        }),
      ],
    );
    const exported = await fetch(
      engine.url! + "/forward-cohort?experiment=" + old.experimentId,
    ).then((r) => r.json());
    expect(exported.protocol).toEqual(old);
    expect(exported.records).toEqual([]);
    expect(exported.probeDeliveryAudit).toMatchObject({
      status: "INCOMPLETE",
      distinctTaggedMints: 1,
      missingEnrollmentMints: 1,
    });
    expect(await journal.records(old.experimentId)).toEqual([]);
  });
  it("keeps a closed same-source window and its lost-delivery evidence across native-style restart", async () => {
    environment();
    const engine = new Engine(),
      store = await new Store().open(undefined, process.env.PHANTOM_DATA_DIR, true);
    let protocol;
    try {
      const prior = await new ForwardRuntime(store, {
        runtimeSourceVersion: engine.sourceVersion,
        sourceCommit: "b".repeat(40),
        now: () => Date.now() - 73 * 3_600_000,
      }).initialize();
      protocol = prior.protocol;
      await store.exec(
        "INSERT INTO phantom_quote_research(id,at,payload) VALUES($1,$2,$3::jsonb)",
        [
          "SYNTHETIC_LOST_CLOSED",
          protocol.enrollmentStart + 2000,
          JSON.stringify({
            phase: "BASELINE",
            mint: MINT,
            forwardExperimentId: protocol.experimentId,
            forwardProbe: { id: "lost-closed-probe" },
          }),
        ],
      );
    } finally {
      await store.close();
    }
    await engine.start({ stream: false, port: 0, sourceCommit: "b".repeat(40) });
    engines.push(engine);
    const exported = await fetch(engine.url! + "/forward-cohort").then((r) => r.json());
    expect(exported.protocol).toEqual(protocol);
    expect(exported.protocol.enrollmentEnd).toBeLessThan(Date.now());
    expect(exported.records).toEqual([]);
    expect(exported.probeDeliveryAudit).toMatchObject({
      status: "INCOMPLETE",
      missingEnrollmentMints: 1,
    });
  });
});

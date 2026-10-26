import { test, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine.ts";
import { decodeTransaction, type RpcTransaction } from "../src/decoder.ts";
import { DEFAULT_STRATEGY_RULES } from "../src/intelligence.ts";

test("recorded finalized transaction survives decode -> SQL dedup -> read-only API -> restart, with unsupported-schema entry veto", async () => {
  const dir = mkdtempSync(join(tmpdir(), "phantom-integration-"));
  const old = { ...process.env };
  process.env.PHANTOM_DATA_DIR = join(dir, "db");
  process.env.PHANTOM_KILL_FILE = join(dir, "KILL");
  process.env.PHANTOM_WALLET_HISTORY = "false";
  process.env.PHANTOM_QUOTE_RESEARCH = "false";
  delete process.env.PHANTOM_DATABASE_URL;
  delete process.env.NODE_ENV;
  process.env.PHANTOM_MODE = "PAPER";
  let engine: Engine | undefined;
  try {
    const tx = JSON.parse(
      readFileSync(new URL("./fixtures/real-pump-buy.json", import.meta.url), "utf8"),
    ) as RpcTransaction;
    expect(decodeTransaction(tx, Date.now())).toHaveLength(1);
    engine = await new Engine().start({ stream: false, port: 0 });
    await expect(new Engine().start({ stream: false, port: 0 })).rejects.toThrow(
      "PHANTOM_WORKER_ALREADY_RUNNING_FOR_DATABASE",
    );
    await engine.recordLogs({
      logs: tx.meta!.logMessages!,
      signature: tx.transaction.signatures[0],
      slot: tx.slot,
      receivedAt: Date.now(),
      commitment: "finalized",
    });
    const fast = engine.state();
    expect(fast.events).toHaveLength(1);
    expect(fast.events[0].verification).toBe("TYPED_PROGRAM_EVENT");
    expect(fast.events[0].details.executionSupported).toBe(false);
    await engine.receive(tx, Date.now(), "finalized");
    await engine.receive(tx, Date.now(), "finalized");
    await engine.idle();
    const response = await fetch(engine.url + "/state");
    expect(response.status).toBe(200);
    const state = await response.json();
    expect(state.strategyRules.maximumCostBps).toBe(DEFAULT_STRATEGY_RULES.maximumCostBps);
    expect(state.strategyRules.minimumLiquidityLamports).toBe(
      String(DEFAULT_STRATEGY_RULES.minimumLiquidityLamports),
    );
    expect(state.events).toHaveLength(1);
    expect(state.events[0].signature).toBe(tx.transaction.signatures[0]);
    expect(state.events[0].slot).toBe(tx.slot);
    expect(state.events[0].quantityEvidence).toBe("program-event");
    expect(state.events[0].verification).toBe("FULL_TRANSACTION");
    expect(state.positions).toEqual([]);
    expect(
      state.decisions.some((d: any) =>
        d.reasons.includes("EVENT_SCHEMA_PARTIALLY_VERIFIED_EXECUTION_UNSUPPORTED"),
      ),
    ).toBe(true);
    expect((await engine.store.query("SELECT count(*) AS n FROM phantom_transactions"))[0].n).toBe(
      1,
    );
    expect((await fetch(engine.url + "/state", { method: "POST" })).status).toBe(405);
    const exported = await fetch(engine.url + "/replay").then((r) => r.json());
    expect(exported.options.fixtureKind).toBe("recorded-chain");
    expect(exported.observations).toEqual([]);
    writeFileSync(join(dir, "KILL"), "Synthetic test shutdown flag");
    await engine.tick();
    expect((await engine.store.get("ledger")).killSwitch).toBe(true);
    await engine.stop();
    engine = undefined;
    engine = await new Engine().start({ stream: false, port: 0 });
    expect(engine.state().events).toHaveLength(1);
    expect(engine.state().cashLamports).toBe(1_000_000_000n);
    await engine.receive(tx, Date.now(), "finalized");
    expect(engine.state().events).toHaveLength(1);
  } finally {
    await engine?.stop();
    for (const k of Object.keys(process.env)) if (!(k in old)) delete process.env[k];
    Object.assign(process.env, old);
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

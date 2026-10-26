/** Synthetic SQL persistence tests in an isolated temporary PGlite database. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import {
  freezeForwardProtocol,
  ForwardCohortCollector,
  FORWARD_WSOL,
  forwardHash,
  type ForwardProbe,
} from "../src/forward-cohort.ts";
import { ForwardSqlJournal } from "../src/forward-cohort-store.ts";

test(
  "actual SQL keeps immutable protocol/records and preserves a restarted entry",
  { timeout: 30000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "omni-forward-test-"));
    let store: Store | undefined;
    try {
      const version = "a".repeat(64),
        mint = "A".repeat(32);
      let now = 5000;
      const protocol = freezeForwardProtocol({
        now: 1000,
        runtimeSourceVersion: version,
        sourceCommit: "b".repeat(40),
      });
      store = await new Store().open(undefined, dir);
      const journal = new ForwardSqlJournal(store),
        collector = new ForwardCohortCollector(protocol, journal, version, () => now);
      const probe: ForwardProbe = {
        id: "synthetic-sql-probe",
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
      await collector.considerProbe(probe);
      now = 37000;
      await collector.tick({
        quote: async (r) => ({
          inputMint: r.inputMint,
          outputMint: r.outputMint,
          inAmount: r.amount.toString(),
          outAmount: "808000",
          minOutAmount: "800000",
          observedAt: now,
        }),
      });
      const exported = await collector.export();
      assert.equal(exported.records.length, 3);
      await journal.append(exported.records[0]);
      await assert.rejects(journal.append({ ...exported.records[0], at: 5001 }), /APPEND_ONLY/);
      const { configurationHash: _, ...base } = protocol,
        changed = { ...base, maximumProbeCostBps: 500 };
      await assert.rejects(
        journal.ensureProtocol({ ...changed, configurationHash: forwardHash(changed) }),
        /PROTOCOL_CONFLICT/,
      );
      assert.equal(await store.get("ledger"), null);
      await store.close();
      store = await new Store().open(undefined, dir);
      const restarted = new ForwardCohortCollector(
        protocol,
        new ForwardSqlJournal(store),
        version,
        () => now,
      );
      now = 97000;
      let quantity: bigint | undefined;
      await restarted.tick({
        quote: async (r) => {
          quantity = r.amount;
          return {
            inputMint: r.inputMint,
            outputMint: r.outputMint,
            inAmount: r.amount.toString(),
            outAmount: "11100000",
            minOutAmount: "11000000",
            observedAt: now,
          };
        },
      });
      assert.equal(quantity, 800000n);
      const result = await restarted.export();
      assert.equal(result.records.length, 5);
      assert.equal(result.records.find((x) => x.phase === "EXIT_RESULT")?.data.status, "QUOTED");
      assert.equal(await store.get("ledger"), null);
    } finally {
      await store?.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

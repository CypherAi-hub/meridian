/** Synthetic regression fixtures. Never served as collected market data or profitability. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  canonical,
  forwardHash,
  freezeForwardProtocol,
  forwardCostAudit,
  ForwardCohortCollector,
  FORWARD_WSOL,
  type ForwardProtocol,
  type ForwardJournal,
  type ForwardRecord,
  type ForwardProbe,
  type ForwardQuote,
  type TimedForwardQuote,
} from "../src/forward-cohort.ts";
import { ForwardSqlJournal } from "../src/forward-cohort-store.ts";
import { JupiterQuoteLane } from "../src/jupiter-quote-lane.ts";

const MINT = "A".repeat(32),
  OTHER = "B".repeat(32),
  VERSION = "a".repeat(64);
class Journal implements ForwardJournal {
  protocol: ForwardProtocol | null = null;
  rows: ForwardRecord[] = [];
  async ensureProtocol(p: ForwardProtocol) {
    if (this.protocol && canonical(p) !== canonical(this.protocol))
      throw Error("FORWARD_FROZEN_PROTOCOL_CONFLICT");
    this.protocol ??= structuredClone(p);
  }
  async records() {
    return structuredClone(this.rows);
  }
  async append(r: ForwardRecord) {
    const old = this.rows.find((x) => x.id === r.id);
    if (old && canonical(old) !== canonical(r)) throw Error("FORWARD_APPEND_ONLY_RECORD_CONFLICT");
    if (!old) this.rows.push(structuredClone(r));
  }
}
function fixture() {
  let now = 5000;
  const protocol = freezeForwardProtocol({
    now: 1000,
    runtimeSourceVersion: VERSION,
    sourceCommit: "b".repeat(40),
  });
  const journal = new Journal(),
    collector = new ForwardCohortCollector(protocol, journal, VERSION, () => now);
  const probe: ForwardProbe = {
    id: "synthetic-probe",
    mint: MINT,
    signature: "c".repeat(88),
    slot: 123,
    protocol: "pump",
    kind: "buy",
    eventObservedAt: 3000,
    startedAt: 4000,
    completedAt: 4600,
    amountLamports: "10000000",
    buy: {
      inputMint: FORWARD_WSOL,
      outputMint: MINT,
      inAmount: "10000000",
      outAmount: "1000000",
      minOutAmount: "990000",
      observedAt: 4100,
    },
    sell: {
      inputMint: MINT,
      outputMint: FORWARD_WSOL,
      inAmount: "990000",
      outAmount: "9969000",
      minOutAmount: "9880000",
      observedAt: 4500,
    },
  };
  const provider = {
    calls: [] as Array<{ amount: bigint; inputMint: string; outputMint: string }>,
    async quote(r: {
      amount: bigint;
      inputMint: string;
      outputMint: string;
    }): Promise<ForwardQuote> {
      this.calls.push(r);
      return {
        inputMint: r.inputMint,
        outputMint: r.outputMint,
        inAmount: r.amount.toString(),
        outAmount: r.inputMint === FORWARD_WSOL ? "808000" : "11100000",
        minOutAmount: r.inputMint === FORWARD_WSOL ? "800000" : "11000000",
        observedAt: now,
      };
    },
  };
  return {
    protocol,
    journal,
    collector,
    probe,
    provider,
    clock: (n: number) => {
      now = n;
    },
    now: () => now,
  };
}
test("static stress floor and strict fractional cost boundary are exact", async () => {
  const f = fixture();
  assert.equal(forwardCostAudit(f.protocol).idealStaticLinearStressCostBpsCeiling, "219");
  assert.equal(forwardCostAudit(f.protocol).configuredCapBelowStaticStressFloor, true);
  f.probe.sell!.minOutAmount = "9869999"; // 150.001bps must fail150.
  await f.collector.considerProbe(f.probe);
  assert.equal(f.journal.rows[0].data.costQualified, false);
  assert.equal(f.journal.rows[0].data.sequentialStressCostBpsCeiling, "151");
  const g = fixture();
  g.probe.sell!.minOutAmount = "9870000";
  await g.collector.considerProbe(g.probe);
  assert.equal(g.journal.rows[0].data.admitted, true);
});
test("eligibility follows probe completion and requires a new delayed entry", async () => {
  const f = fixture();
  await f.collector.considerProbe(f.probe);
  assert.equal(f.journal.rows.length, 1);
  assert.equal(f.journal.rows[0].data.decisionAt, 5000);
  assert.equal(f.journal.rows[0].data.entryDueAt, 37000);
  assert.deepEqual(await f.collector.nextQuoteWindow(), {
    mint: MINT,
    phase: "ENTRY",
    dueAt: 37000,
    deadlineAt: 42000,
  });
  f.clock(36999);
  await f.collector.tick(f.provider);
  assert.equal(f.provider.calls.length, 0);
  f.clock(37000);
  await f.collector.tick(f.provider);
  assert.equal(f.provider.calls.length, 1);
  const entry = f.journal.rows.find((x) => x.phase === "ENTRY_RESULT")!;
  assert.equal(entry.data.status, "QUOTED");
  const timed = entry.data.timedQuote as TimedForwardQuote;
  assert.equal(timed.requestedAt, undefined);
  assert.equal(timed.providerInvocationAt, 37000);
  assert.equal(timed.timingEvidence, "PROVIDER_INVOCATION_ONLY");
  assert.equal(timed.quote.minOutAmount, "800000");
  assert.deepEqual(await f.collector.nextQuoteWindow(), {
    mint: MINT,
    phase: "EXIT",
    dueAt: 97000,
    deadlineAt: 102000,
  });
  f.clock(96999);
  await f.collector.tick(f.provider);
  assert.equal(f.provider.calls.length, 1);
  f.clock(97000);
  await f.collector.tick(f.provider);
  assert.equal(f.provider.calls[1].amount, 800000n); // Never probe990000.
  assert.equal(f.journal.rows.at(-1)?.phase, "EXIT_RESULT");
  assert.equal(f.journal.rows.at(-1)?.data.status, "QUOTED");
});
test("a cached predecision quote attached to a later request cannot enter", async () => {
  const f = fixture();
  await f.collector.considerProbe(f.probe);
  f.clock(37000);
  await f.collector.tick({ quote: async () => f.probe.buy! });
  assert.equal(f.journal.rows.at(-1)?.data.status, "UNAVAILABLE_OR_LATE");
  f.clock(90000);
  await f.collector.tick(f.provider);
  assert.equal(f.provider.calls.length, 0);
});
test("late entry responses produce no hypothetical inventory", async () => {
  const f = fixture();
  await f.collector.considerProbe(f.probe);
  f.clock(37000);
  await f.collector.tick({
    quote: async (r) => {
      f.clock(43001);
      return f.provider.quote(r);
    },
  });
  assert.equal(f.journal.rows.at(-1)?.data.status, "UNAVAILABLE_OR_LATE");
  assert.equal(f.journal.rows.at(-1)?.data.error, "FORWARD_RESPONSE_AFTER_DEADLINE");
  f.clock(90000);
  await f.collector.tick(f.provider);
  assert.equal(f.provider.calls.length, 1);
});
test("budget denial never calls providers and missed deadlines remain explicit", async () => {
  const f = fixture();
  await f.collector.considerProbe(f.probe);
  f.clock(37000);
  await f.collector.tick(f.provider, false);
  assert.equal(f.provider.calls.length, 0);
  f.clock(42001);
  await f.collector.tick(f.provider, false);
  assert.equal(f.journal.rows.at(-1)?.data.status, "MISSED_DEADLINE_NO_QUOTE");
});
test("first probe per mint cannot be replaced by a later cheap probe", async () => {
  const f = fixture();
  const p = structuredClone(f.probe);
  p.sell!.minOutAmount = "9000000";
  await f.collector.considerProbe(p);
  const result = await f.collector.considerProbe(f.probe);
  assert.equal(result.status, "FIRST_PROBE_ALREADY_RECORDED");
  assert.equal(f.journal.rows.length, 1);
  assert.equal(f.journal.rows[0].data.admitted, false);
});
test("capacity exclusions are journaled without creating another entry", async () => {
  const f = fixture();
  await f.collector.considerProbe(f.probe);
  const p = structuredClone(f.probe);
  p.mint = OTHER;
  p.id = "other";
  p.buy!.outputMint = OTHER;
  p.sell!.inputMint = OTHER;
  await f.collector.considerProbe(p);
  assert.equal(f.journal.rows[1].data.costQualified, true);
  assert.equal(f.journal.rows[1].data.admitted, false);
  assert.deepEqual(f.journal.rows[1].data.reasons, ["FORWARD_CAPACITY_UNAVAILABLE"]);
});
test("historical source receipt is not prospectively enrolled as new", async () => {
  const f = fixture();
  f.probe.eventObservedAt = 1500;
  await f.collector.considerProbe(f.probe);
  assert.equal(f.journal.rows[0].data.admitted, false);
  assert.ok(
    (f.journal.rows[0].data.reasons as string[]).includes("PROBE_OUTSIDE_PROSPECTIVE_TIME_OR_SIZE"),
  );
});
test("missing and wrong-size quotes are rejected and provider errors are redacted", async () => {
  const f = fixture();
  await f.collector.considerProbe(f.probe);
  f.clock(37000);
  await f.collector.tick({
    quote: async () => {
      throw Error("https://provider/?api-key=PRIVATE");
    },
  });
  assert.equal(f.journal.rows.at(-1)?.data.error, "FORWARD_QUOTE_PROVIDER_UNAVAILABLE");
  assert.ok(!JSON.stringify(f.journal.rows).includes("PRIVATE"));
  const g = fixture();
  await g.collector.considerProbe(g.probe);
  g.clock(37000);
  await g.collector.tick({
    quote: async (r) => ({ ...(await g.provider.quote(r)), inAmount: "1" }),
  });
  assert.equal(g.journal.rows.at(-1)?.data.status, "UNAVAILABLE_OR_LATE");
});
test("missed exits are preserved, not backdated or retried", async () => {
  const f = fixture();
  await f.collector.considerProbe(f.probe);
  f.clock(37000);
  await f.collector.tick(f.provider);
  f.clock(130000);
  await f.collector.tick(f.provider);
  assert.equal(f.provider.calls.length, 1);
  assert.equal(f.journal.rows.at(-1)?.phase, "EXIT_RESULT");
  assert.equal(f.journal.rows.at(-1)?.data.status, "MISSED_DEADLINE_NO_QUOTE");
});
test("restart preserves original entry and exact exit quantity", async () => {
  const f = fixture();
  await f.collector.considerProbe(f.probe);
  f.clock(37000);
  await f.collector.tick(f.provider);
  const restart = new ForwardCohortCollector(f.protocol, f.journal, VERSION, f.now);
  f.clock(97000);
  await restart.tick(f.provider);
  assert.equal(f.provider.calls[1].amount, 800000n);
  assert.equal(f.journal.rows.filter((x) => x.phase === "ENROLLMENT").length, 1);
});
test("interrupted requests are explicit unknowns on restart with no retry", async () => {
  const f = fixture();
  await f.collector.considerProbe(f.probe);
  f.clock(37000);
  await f.collector.tick(f.provider);
  f.journal.rows = f.journal.rows.filter((x) => x.phase !== "ENTRY_RESULT");
  const restart = new ForwardCohortCollector(f.protocol, f.journal, VERSION, f.now);
  await restart.initialize();
  assert.equal(f.journal.rows.at(-1)?.data.status, "INTERRUPTED_UNKNOWN_NO_RETRY");
  await restart.tick(f.provider);
  assert.equal(f.provider.calls.length, 1);
});
test("runtime, frozen-protocol and conflicting journal changes fail closed", async () => {
  const f = fixture();
  assert.throws(
    () => new ForwardCohortCollector(f.protocol, f.journal, "c".repeat(64)),
    /RUNTIME_SOURCE/,
  );
  assert.throws(
    () =>
      new ForwardCohortCollector({ ...f.protocol, maximumProbeCostBps: 500 }, f.journal, VERSION),
    /PROTOCOL/,
  );
  await f.collector.considerProbe(f.probe);
  const { configurationHash: _, ...body } = f.protocol;
  const changed = { ...body, maximumProbeCostBps: 500 };
  await assert.rejects(
    new ForwardCohortCollector(
      { ...changed, configurationHash: forwardHash(changed) },
      f.journal,
      VERSION,
      f.now,
    ).initialize(),
    /PROTOCOL_CONFLICT/,
  );
  f.journal.rows.push({ ...structuredClone(f.journal.rows[0]), at: 5001 });
  f.clock(6000);
  await assert.rejects(
    new ForwardCohortCollector(f.protocol, f.journal, VERSION, f.now).initialize(),
    /CONFLICTING_DUPLICATE/,
  );
});
test("append-only SQL adapter refuses changed payload and checks worker lease", async () => {
  const f = fixture();
  await f.collector.considerProbe(f.probe);
  let lease = true;
  const values = new Map<string, unknown>();
  const db = {
    assertWorkerLease() {
      if (!lease) throw Error("LEASE_LOST");
    },
    async exec(sql: string, args: unknown[] = []) {
      this.assertWorkerLease();
      if (sql.startsWith("INSERT") && !values.has(String(args[0])))
        values.set(String(args[0]), JSON.parse(String(args.at(-1))));
    },
    async query(_sql: string, args: unknown[] = []) {
      this.assertWorkerLease();
      return values.has(String(args[0])) ? [{ payload: values.get(String(args[0])) }] : [];
    },
  };
  // Protocol INSERT has payload last, record INSERT also has payload last.
  const journal = new ForwardSqlJournal(db);
  await journal.ensureProtocol(f.protocol);
  await journal.append(f.journal.rows[0]);
  await journal.append(f.journal.rows[0]);
  await assert.rejects(journal.append({ ...f.journal.rows[0], at: 5001 }), /APPEND_ONLY/);
  lease = false;
  await assert.rejects(journal.append(f.journal.rows[0]), /LEASE_LOST/);
});
test("frozen slippage limits apply to newly received and restored quotes", async () => {
  const f = fixture();
  await f.collector.considerProbe(f.probe);
  f.clock(37000);
  await f.collector.tick({
    quote: async (r) => ({ ...(await f.provider.quote(r)), minOutAmount: "1" }),
  });
  assert.equal(f.journal.rows.at(-1)?.data.status, "UNAVAILABLE_OR_LATE");
  const g = fixture();
  await g.collector.considerProbe(g.probe);
  g.clock(37000);
  await g.collector.tick(g.provider);
  const result = g.journal.rows.find((x) => x.phase === "ENTRY_RESULT")!;
  (result.data.timedQuote as { quote: ForwardQuote }).quote.minOutAmount = "999999999999999";
  await assert.rejects(
    new ForwardCohortCollector(g.protocol, g.journal, VERSION, g.now).initialize(),
    /QUOTE/,
  );
  assert.equal(g.provider.calls.length, 1);
});
test("restored successful results require their canonical preceding request", async () => {
  const f = fixture();
  await f.collector.considerProbe(f.probe);
  f.clock(37000);
  await f.collector.tick(f.provider);
  f.journal.rows = f.journal.rows.filter((x) => x.phase !== "ENTRY_REQUEST");
  f.clock(97000);
  const restart = new ForwardCohortCollector(f.protocol, f.journal, VERSION, f.now);
  await assert.rejects(restart.tick(f.provider), /CAUSAL/);
  assert.equal(f.provider.calls.length, 1);
});
test("lost result acknowledgement reloads durable entry instead of requesting twice", async () => {
  const f = fixture(),
    append = f.journal.append.bind(f.journal);
  let lost = false;
  f.journal.append = async (r) => {
    await append(r);
    if (r.phase === "ENTRY_RESULT" && !lost) {
      lost = true;
      throw Error("LOST_ACK");
    }
  };
  await f.collector.considerProbe(f.probe);
  f.clock(37000);
  await assert.rejects(f.collector.tick(f.provider), /LOST_ACK/);
  await f.collector.tick(f.provider);
  assert.equal(f.provider.calls.length, 1);
  f.clock(97000);
  await f.collector.tick(f.provider);
  assert.equal(f.provider.calls.length, 2);
  assert.equal(f.journal.rows.filter((x) => x.phase === "ENTRY_REQUEST").length, 1);
});
test("lost request acknowledgement does not make an unjournaled provider call", async () => {
  const f = fixture(),
    append = f.journal.append.bind(f.journal);
  let lost = false;
  f.journal.append = async (r) => {
    await append(r);
    if (r.phase === "ENTRY_REQUEST" && !lost) {
      lost = true;
      throw Error("LOST_ACK");
    }
  };
  await f.collector.considerProbe(f.probe);
  f.clock(37000);
  await assert.rejects(f.collector.tick(f.provider), /LOST_ACK/);
  await f.collector.tick(f.provider);
  assert.equal(f.provider.calls.length, 0);
  assert.equal(f.journal.rows.at(-1)?.data.status, "INTERRUPTED_UNKNOWN_NO_RETRY");
});
test("a transient schema initialization error can recover in the same journal", async () => {
  const f = fixture();
  let ddlCalls = 0;
  const values = new Map<string, unknown>();
  const db = {
    assertWorkerLease() {},
    async exec(sql: string, args: unknown[] = []) {
      if (sql.includes("CREATE TABLE") && ++ddlCalls === 1) throw Error("TEMP_DB_DOWN");
      if (sql.startsWith("INSERT") && !values.has(String(args[0])))
        values.set(String(args[0]), JSON.parse(String(args.at(-1))));
    },
    async query(_sql: string, args: unknown[] = []) {
      return values.has(String(args[0])) ? [{ payload: values.get(String(args[0])) }] : [];
    },
  };
  const journal = new ForwardSqlJournal(db);
  await assert.rejects(journal.ensureProtocol(f.protocol), /TEMP_DB/);
  await journal.ensureProtocol(f.protocol);
  assert.equal(ddlCalls, 2);
});
test("provider invocation follows durable intent and slow intent writes cannot spend an expired budget", async () => {
  const f = fixture(),
    append = f.journal.append.bind(f.journal);
  f.journal.append = async (r) => {
    await append(r);
    if (r.phase === "ENTRY_REQUEST") f.clock(40000);
  };
  await f.collector.considerProbe(f.probe);
  f.clock(37000);
  await f.collector.tick(f.provider);
  const result = f.journal.rows.at(-1)!;
  assert.equal((result.data.timedQuote as TimedForwardQuote).providerInvocationAt, 40000);
  assert.equal((result.data.timedQuote as TimedForwardQuote).requestedAt, undefined);
  assert.equal(
    f.journal.rows.find((r) => r.phase === "ENTRY_REQUEST")?.data.requestIntentAt,
    37000,
  );
  await new ForwardCohortCollector(f.protocol, f.journal, VERSION, f.now).initialize();
  const g = fixture(),
    original = g.journal.append.bind(g.journal);
  g.journal.append = async (r) => {
    await original(r);
    if (r.phase === "ENTRY_REQUEST") g.clock(43000);
  };
  await g.collector.considerProbe(g.probe);
  g.clock(37000);
  await g.collector.tick(g.provider);
  assert.equal(g.provider.calls.length, 0);
  assert.equal(g.journal.rows.at(-1)?.data.error, "FORWARD_INTENT_PERSISTENCE_DELAY");
  assert.equal(g.journal.rows.at(-1)?.data.timingEvidence, "NO_PROVIDER_CALL");
  assert.equal(g.journal.rows.at(-1)?.data.requestedAt, undefined);
  await new ForwardCohortCollector(g.protocol, g.journal, VERSION, g.now).initialize();
});

test("the actual queued provider start is retained separately from invocation and durable intent", async (context) => {
  const f = fixture(),
    lane = new JupiterQuoteLane({ now: f.now });
  context.mock.timers.enable({ apis: ["setTimeout"] });
  await f.collector.considerProbe(f.probe);
  f.clock(36500);
  await lane.schedule("analysis", 6000, async () => undefined); // Synthetic earlier caller occupies the local rate slot.
  f.clock(37000);
  const provider = {
    quote: (request: Parameters<typeof f.provider.quote>[0]) =>
      lane.schedule("research", 6000, async () => {
        const requestedAt = f.now();
        f.clock(requestedAt + 100);
        return { ...(await f.provider.quote(request)), requestedAt };
      }),
  };
  const collecting = f.collector.tick(provider);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.provider.calls.length, 0);
  f.clock(37500);
  context.mock.timers.tick(500);
  await collecting;
  const entry = f.journal.rows.at(-1)!,
    timed = entry.data.timedQuote as TimedForwardQuote;
  assert.equal(timed.timingEvidence, "PROVIDER_REPORTED_REQUEST_START");
  assert.equal(timed.providerInvocationAt, 37000);
  assert.equal(timed.requestedAt, 37500);
  assert.equal(timed.quote.requestedAt, 37500);
  assert.equal(timed.quote.observedAt, 37600);
  assert.equal(timed.receivedAt, 37600);
  assert.equal(
    f.journal.rows.find((r) => r.phase === "ENTRY_REQUEST")!.data.requestIntentAt,
    37000,
  );
  const restart = new ForwardCohortCollector(f.protocol, f.journal, VERSION, f.now);
  assert.equal((await restart.nextQuoteWindow())!.dueAt, 97600);
  f.clock(97600);
  await restart.tick(provider);
  assert.equal(f.provider.calls[1].amount, 800000n);
  assert.equal((f.journal.rows.at(-1)!.data.timedQuote as TimedForwardQuote).requestedAt, 97600);
  await new ForwardCohortCollector(f.protocol, f.journal, VERSION, f.now).initialize();
});

test("malformed, future and pre-invocation provider request metadata fail closed without a retry", async () => {
  for (const requestedAt of [NaN, Infinity, 37000.5, 36999, 38001, "37000"] as const) {
    const f = fixture();
    await f.collector.considerProbe(f.probe);
    f.clock(37000);
    await f.collector.tick({
      quote: async (request) => {
        f.clock(38000);
        return { ...(await f.provider.quote(request)), requestedAt } as ForwardQuote;
      },
    });
    const record = f.journal.rows.at(-1)!;
    assert.equal(record.data.status, "UNAVAILABLE_OR_LATE");
    assert.equal(record.data.error, "FORWARD_PROVIDER_REQUEST_TIMING_INVALID");
    assert.equal(record.data.requestedAt, undefined);
    assert.equal(record.data.providerInvocationAt, 37000);
    assert.equal(record.data.timingEvidence, "PROVIDER_INVOCATION_ONLY");
    assert.ok(!("timedQuote" in record.data));
    await f.collector.tick(f.provider);
    await new ForwardCohortCollector(f.protocol, f.journal, VERSION, f.now).initialize();
    assert.equal(f.provider.calls.length, 1);
  }
});

test("provider request time cannot follow its own observed quote even when received later", async () => {
  const f = fixture();
  await f.collector.considerProbe(f.probe);
  f.clock(37000);
  await f.collector.tick({
    quote: async (request) => {
      const q = await f.provider.quote(request);
      f.clock(38000);
      return { ...q, requestedAt: 37500 };
    },
  });
  assert.equal(f.journal.rows.at(-1)!.data.error, "FORWARD_PROVIDER_REQUEST_TIMING_INVALID");
  assert.equal(f.provider.calls.length, 1);
});

test("a genuine queued start after the frozen grace window is unavailable and remains restart-valid", async () => {
  const f = fixture();
  await f.collector.considerProbe(f.probe);
  f.clock(37000);
  await f.collector.tick({
    quote: async (request) => {
      f.clock(43000);
      return { ...(await f.provider.quote(request)), requestedAt: 42900 };
    },
  });
  const last = f.journal.rows.at(-1)!;
  assert.equal(last.data.status, "UNAVAILABLE_OR_LATE");
  assert.equal(last.data.error, "FORWARD_REQUEST_START_AFTER_DEADLINE");
  assert.equal(last.data.providerInvocationAt, 37000);
  assert.equal(last.data.requestedAt, 42900);
  await new ForwardCohortCollector(f.protocol, f.journal, VERSION, f.now).initialize();
  await f.collector.tick(f.provider);
  assert.equal(f.provider.calls.length, 1);
});

test("restore rejects relabelled invocation proof and inconsistent provider-reported start metadata", async () => {
  for (const corrupt of [
    "invocation-claims-request",
    "reported-before-invocation",
    "reported-missing-quote-copy",
    "unknown-kind",
  ] as const) {
    const f = fixture();
    await f.collector.considerProbe(f.probe);
    f.clock(37000);
    await f.collector.tick(f.provider);
    const timed = f.journal.rows.at(-1)!.data.timedQuote as TimedForwardQuote;
    if (corrupt === "invocation-claims-request") timed.requestedAt = 37000;
    if (corrupt === "reported-before-invocation") {
      timed.timingEvidence = "PROVIDER_REPORTED_REQUEST_START";
      timed.requestedAt = timed.quote.requestedAt = 36999;
    }
    if (corrupt === "reported-missing-quote-copy") {
      timed.timingEvidence = "PROVIDER_REPORTED_REQUEST_START";
      timed.requestedAt = 37000;
    }
    if (corrupt === "unknown-kind") (timed as any).timingEvidence = "TRUSTED_NETWORK";
    await assert.rejects(
      new ForwardCohortCollector(f.protocol, f.journal, VERSION, f.now).initialize(),
      /CAUSAL/,
    );
    assert.equal(f.provider.calls.length, 1);
  }
});

test("unmarked legacy invocation times remain readable without acquiring invented provider proof", async () => {
  const f = fixture();
  await f.collector.considerProbe(f.probe);
  f.clock(37000);
  await f.collector.tick(f.provider);
  const timed = f.journal.rows.at(-1)!.data.timedQuote as TimedForwardQuote;
  timed.requestedAt = timed.providerInvocationAt;
  delete timed.providerInvocationAt;
  delete timed.timingEvidence;
  const before = canonical(f.journal.rows);
  const exportValue = await new ForwardCohortCollector(
    f.protocol,
    f.journal,
    VERSION,
    f.now,
  ).export();
  assert.equal(canonical(exportValue.records), before);
});

test("provider error text cannot escape redaction merely by using a FORWARD prefix", async () => {
  const f = fixture();
  await f.collector.considerProbe(f.probe);
  f.clock(37000);
  await f.collector.tick({
    quote: async () => {
      throw Error("FORWARD_PRIVATE_TOKEN_SHOULD_NOT_BE_SAVED");
    },
  });
  assert.equal(f.journal.rows.at(-1)!.data.error, "FORWARD_QUOTE_PROVIDER_UNAVAILABLE");
  assert.ok(!canonical(f.journal.rows).includes("PRIVATE_TOKEN"));
});

test("only whitelisted quote fields and validated timing metadata enter the journal", async () => {
  const f = fixture();
  await f.collector.considerProbe(f.probe);
  f.clock(37000);
  await f.collector.tick({
    quote: async (request) => ({
      ...(await f.provider.quote(request)),
      requestedAt: 37000,
      route: "SYNTHETIC_PRIVATE_URL",
      providerText: "SYNTHETIC_PRIVATE_KEY",
    }),
  });
  assert.equal(f.journal.rows.at(-1)!.data.status, "QUOTED");
  assert.ok(!canonical(f.journal.rows).includes("PRIVATE"));
  const timed = f.journal.rows.at(-1)!.data.timedQuote as TimedForwardQuote;
  assert.equal(timed.quote.requestedAt, 37000);
});

test("reported probe sell requests must follow the known buy quantity without changing frozen limits", async () => {
  const good = fixture();
  good.probe.buy!.requestedAt = 4000;
  good.probe.sell!.requestedAt = 4100;
  await good.collector.considerProbe(good.probe);
  assert.equal(good.journal.rows[0].data.admitted, true);
  await new ForwardCohortCollector(good.protocol, good.journal, VERSION, good.now).initialize();
  const bad = fixture();
  bad.probe.buy!.requestedAt = 4000;
  bad.probe.sell!.requestedAt = 4099;
  await bad.collector.considerProbe(bad.probe);
  assert.equal(bad.journal.rows[0].data.admitted, false);
  assert.equal(bad.protocol.minimumEntryDelayMs, 32000);
  assert.equal(bad.protocol.entryToleranceMs, 5000);
  assert.equal(bad.protocol.researchMinimumTurnSpacingMs, 30000);
  assert.equal(bad.protocol.primaryHorizonMs, 60000);
  assert.equal(bad.protocol.maximumProbeCostBps, 150);
});

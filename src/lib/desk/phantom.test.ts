import test from "node:test";
import assert from "node:assert/strict";
import { parsePhantomState, phantomSol } from "./phantom.ts";
import { fetchPhantomBridge, phantomOrigin } from "./phantom-bridge.server.ts";
import { WSOL, USDC } from "./schema.ts";
const T = 1800000000000;
const mint = "wCKY2jxSWo1yBYoKfm89h2uv9iBkTQiRsLhk29Hpump";
const sig =
  "5c5WuEVBjn9vEhWQ9CJHc5VB25QiN2BWRJ8LGzBbCSYEB5Cr8CMFUNYoyLYRb9DHvjJ1doFCA84UgSPDzpYCCw2k";
/** Synthetic contract fixture using a previously observed public signature, never served as live data. */
function sample() {
  return {
    application: "PHANTOM",
    mode: "PAPER",
    now: T,
    startedAt: T - 60000,
    sourceVersion: "a".repeat(64),
    health: {
      status: "DEGRADED",
      source: "rpc",
      received: 200,
      decoded: 2,
      rejected: 5,
      errors: 3,
      lastEventAt: T - 100,
      latencyMs: { p50: 91040, p95: 195766 },
      backfillGaps: 2,
      queueDepth: 200,
      typedObserved: 100,
      typedLogs: {
        received: 200,
        processed: 200,
        dropped: 0,
        errors: 0,
        queueDepth: 0,
        latencyMs: { p50: 0, p95: 1 },
      },
    },
    events: [
      {
        id: sig + ":log:83",
        protocol: "pump",
        kind: "buy",
        signature: sig,
        slot: 461793746,
        mint,
        quoteMint: WSOL,
        receivedAt: T - 100,
        processedAt: T - 99,
        commitment: "finalized",
        amountRaw: "967052638572",
        quoteAmountRaw: "107255323",
        verification: "TYPED_PROGRAM_EVENT",
        details: { fullTransactionVerified: false },
      },
    ],
    decisions: [
      {
        at: T - 100,
        mint,
        strategy: "all",
        accepted: false,
        reasons: ["INSUFFICIENT_VERIFIED_TRADE_OBSERVATIONS"],
      },
    ],
    positions: [],
    pending: [],
    completedPositions: [],
    equity: [{ at: T - 1000, equityLamports: "1000000000" }],
    cashLamports: "1000000000",
    limitations: ["Synthetic contract fixture"],
  };
}
/** Entirely synthetic experimental monitoring contract, not a market or execution fixture. */
function experimental() {
  return {
    status: "ACTIVE",
    account: {
      bookId: "synthetic-experiment",
      mode: "RESEARCH_PAPER",
      strictPolicyEligible: false,
      liveApproved: false,
      associationScope: "UNKNOWN_ASSOCIATIONS_ACCEPTED_FOR_PAPER",
      cashLamports: "1000000000",
      reservedLamports: "0",
      availableCashLamports: "1000000000",
      equityLamports: "1000000000",
      realizedPnlLamports: "0",
      modeledSettledFeesLamports: "0",
      openPositions: 0,
      pendingEntries: 0,
      pendingExits: 0,
      sourceHash: "a".repeat(64),
      policyHash: "b".repeat(64),
      runHash: "c".repeat(64),
      ledgerVersion: 1,
      suspended: false,
    },
    manifest: {
      kind: "RESEARCH_PAPER_RUN_V1",
      mode: "RESEARCH_PAPER",
      strictPolicyEligible: false,
      liveApproved: false,
      bookId: "synthetic-experiment",
      enrollmentStart: T - 120000,
      enrollmentEnd: T + 3600000,
      manifestHash: "c".repeat(64),
      economicProfileHash: "d".repeat(64),
      exitProfileHash: "e".repeat(64),
      settlementScope: "QUOTE_MINIMUM_MODEL_NOT_ATTAINABLE_FILL_CERTIFICATION",
      feeScope: "10000_LAMPORTS_PER_SETTLED_LEG_MODEL_NOT_MEASURED",
      priorityFeeScope: "INCLUDED_IN_FIXED_NETWORK_FEE_MODEL_NOT_MEASURED",
      rentScope: "NO_TOKEN_ACCOUNT_CREATED_RENT_EXCLUDED_FROM_PAPER_MODEL",
      failedAttemptScope: "NO_TRANSACTION_SUBMITTED_NO_ONCHAIN_FAILURE_FEE_MODELED",
      policy: {
        kind: "RESEARCH_PAPER_POLICY_V1",
        version: 1,
        strategy: "momentum_breakout",
        associationScope: "UNKNOWN_ASSOCIATIONS_ACCEPTED_FOR_PAPER",
        strictPolicyEligible: false,
        liveApproved: false,
        sourceHash: "a".repeat(64),
        manifestHash: "b".repeat(64),
        frozenAt: T - 180000,
        entryLamports: "10000000",
        initialCapitalLamports: "1000000000",
        maximumPositions: 1,
        networkFeePerLegLamports: "10000",
        maximumQuoteAgeMs: 5000,
        minimumEntryDelayMs: 2000,
        maximumExecutionCostBps: 150,
        slippageBps: 25,
        sourceUniverse: "LEGACY_SPL_SOL_PAIRS_JUPITER_AGGREGATOR_QUOTES",
      },
    },
    positions: [],
    pending: [],
    pendingExits: [],
    journal: [],
    trades: [],
    completedPositions: [],
    limitations: ["Synthetic monitoring fixture only"],
  };
}
function researchState(book: unknown = experimental()) {
  return { ...sample(), researchPaper: book };
}
function positionBook(): Record<string, any> {
  const r: Record<string, any> = experimental();
  r.account.cashLamports = "989990000";
  r.account.availableCashLamports = "989990000";
  r.account.openPositions = 1;
  r.account.equityLamports = "998990000";
  r.account.modeledSettledFeesLamports = "10000";
  r.positions = [
    {
      id: "research:synthetic-experiment:capture:0",
      mint,
      strategy: "momentum_breakout",
      quantityRaw: "1000",
      costLamports: "10000000",
      openedAt: T - 10000,
      markLamports: "9000000",
      markAt: T - 100,
      entryFeeLamports: "10000",
    },
  ];
  return r;
}

test("experimental paper is optional and legacy/null absence never becomes a zero-valued account", () => {
  for (const value of [sample(), researchState(null)]) {
    const r = parsePhantomState(value, T);
    assert.equal(r.connection, "connected");
    assert.equal(r.state!.researchPaperStatus, "absent");
    assert.equal(r.state!.researchPaper, null);
    assert.equal(r.state!.cashLamports, "1000000000");
  }
});

test("experimental account has separate SOL balances, explicit non-approval and bounded frozen identities", () => {
  const report = parsePhantomState(researchState(), T),
    book = report.state!.researchPaper!;
  assert.equal(report.state!.researchPaperStatus, "available");
  assert.equal(book.account.mode, "RESEARCH_PAPER");
  assert.equal(book.account.liveApproved, false);
  assert.equal(book.account.strictPolicyEligible, false);
  assert.equal(book.account.associationScope, "UNKNOWN_ASSOCIATIONS_ACCEPTED_FOR_PAPER");
  assert.equal(book.account.equityLamports, "1000000000");
  assert.equal(book.account.runHash, book.manifest.manifestHash);
  const pending: Record<string, any> = experimental();
  pending.pending = [
    {
      id: "research:synthetic-experiment:capture:0",
      mint,
      strategy: "momentum_breakout",
      amountLamports: "10000000",
      createdAt: T - 1500,
      readyAt: T + 500,
      eventId: "event:0",
      slippageBps: 25,
    },
  ];
  pending.account.pendingEntries = 1;
  pending.account.reservedLamports = "10010000";
  pending.account.availableCashLamports = "989990000";
  assert.equal(
    parsePhantomState(researchState(pending), T).state!.researchPaper!.account.reservedLamports,
    "10010000",
  );
  // The strict-policy book remains independent of the experimental reservation.
  assert.equal(parsePhantomState(researchState(pending), T).state!.cashLamports, "1000000000");
});

test("experimental unknown, stale, future or contradictory marks cannot certify fresh equity", () => {
  assert.equal(
    parsePhantomState(researchState(positionBook()), T).state!.researchPaper!.account
      .equityLamports,
    "998990000",
  );
  for (const change of [
    { markLamports: null },
    { markAt: null },
    { markAt: T - 5001 },
    { markAt: T + 1 },
  ]) {
    const r = positionBook();
    Object.assign(r.positions[0], change);
    const book = parsePhantomState(researchState(r), T).state!.researchPaper!;
    assert.equal(book.account.equityLamports, null);
    assert.equal(book.positions[0].markLamports, null);
  }
  const contradictory = positionBook();
  contradictory.account.equityLamports = "999999999";
  assert.equal(
    parsePhantomState(researchState(contradictory), T).state!.researchPaper!.account.equityLamports,
    null,
  );
  const unknown: Record<string, any> = experimental();
  unknown.account.equityLamports = null;
  assert.equal(
    parsePhantomState(researchState(unknown), T).state!.researchPaper!.account.equityLamports,
    null,
  );
});

test("experimental malformed mode or identity is unavailable without poisoning the legacy strict account", () => {
  for (const mutate of [
    (r: any) => {
      r.account.mode = "PAPER";
    },
    (r: any) => {
      r.manifest.mode = "LIVE";
    },
    (r: any) => {
      r.account.liveApproved = true;
    },
    (r: any) => {
      r.manifest.policy.strictPolicyEligible = true;
    },
    (r: any) => {
      r.account.bookId = "other-book";
    },
    (r: any) => {
      r.account.sourceHash = "f".repeat(64);
    },
    (r: any) => {
      r.account.policyHash = "f".repeat(64);
    },
    (r: any) => {
      r.account.runHash = "f".repeat(64);
    },
    (r: any) => {
      r.account.runHash = "not-a-hash";
    },
    (r: any) => {
      r.account.associationScope = "VERIFIED";
    },
    (r: any) => {
      r.manifest.policy.version = 2;
    },
  ]) {
    const input = experimental();
    mutate(input);
    const parsed = parsePhantomState(researchState(input), T);
    assert.equal(parsed.connection, "connected");
    assert.equal(parsed.state!.researchPaperStatus, "invalid");
    assert.equal(parsed.state!.researchPaper, null);
    assert.equal(parsed.state!.cashLamports, "1000000000");
    assert(parsed.state!.discardedRows > 0);
  }
});

test("experimental raw amounts reject numeric coercion, decimals, exponents, signs and noncanonical zeros", () => {
  for (const value of [1, "1.2", "1e9", "01", "+1", "-1", "9".repeat(41)]) {
    const input: Record<string, any> = experimental();
    input.account.cashLamports = value;
    assert.equal(parsePhantomState(researchState(input), T).state!.researchPaperStatus, "invalid");
  }
  for (const value of ["-0", "-01", "1.2", 0]) {
    const input: Record<string, any> = experimental();
    input.account.realizedPnlLamports = value;
    assert.equal(parsePhantomState(researchState(input), T).state!.researchPaperStatus, "invalid");
  }
  const large: Record<string, any> = experimental();
  for (const key of ["cashLamports", "availableCashLamports", "equityLamports"])
    large.account[key] = "18446744073709551615";
  large.account.realizedPnlLamports = String(18446744073709551615n - 1000000000n);
  assert.equal(
    parsePhantomState(researchState(large), T).state!.researchPaper!.account.cashLamports,
    "18446744073709551615",
  );
});

test("experimental reservations, counts, identities and bounded journal must reconcile", () => {
  for (const mutate of [
    (r: any) => {
      r.account.availableCashLamports = "999999999";
    },
    (r: any) => {
      r.account.reservedLamports = "1";
      r.account.availableCashLamports = "999999999";
    },
    (r: any) => {
      r.account.openPositions = 1;
    },
    (r: any) => {
      r.account.pendingExits = 1;
    },
    (r: any) => {
      r.account.realizedPnlLamports = "1";
    },
    (r: any) => {
      r.manifest.policy.maximumQuoteAgeMs = 30000;
    },
    (r: any) => {
      r.journal = [
        { sequence: 1, at: T, bookId: "other-book", kind: "ENTRY_INTENT", entryId: "entry:0" },
      ];
    },
    (r: any) => {
      r.journal = Array.from({ length: 201 }, (_, i) => ({
        sequence: i + 1,
        at: T,
        bookId: r.account.bookId,
        kind: "ENTRY_INTENT",
        entryId: `entry:${i}`,
      }));
    },
    (r: any) => {
      r.positions = [positionBook().positions[0]];
      r.positions[0].mint = "malformed";
      r.account.openPositions = 1;
    },
  ]) {
    const input = experimental();
    mutate(input);
    assert.equal(parsePhantomState(researchState(input), T).state!.researchPaperStatus, "invalid");
  }
});

test("experimental realized legs remain modeled P&L and malformed accounting is refused", () => {
  const input: Record<string, any> = experimental();
  input.account.realizedPnlLamports = "-1020000";
  input.account.cashLamports =
    input.account.availableCashLamports =
    input.account.equityLamports =
      "998980000";
  input.account.modeledSettledFeesLamports = "20000";
  const trade = {
    id: "exit:synthetic:0",
    positionId: "research:synthetic-experiment:capture:0",
    isFinalExit: true,
    mint,
    strategy: "momentum_breakout",
    openedAt: T - 10000,
    closedAt: T - 100,
    costLamports: "10000000",
    proceedsLamports: "9000000",
    feesLamports: "20000",
    pnlLamports: "-1020000",
    quantityRaw: "1000",
    reason: "STOP_LOSS",
  };
  input.trades = [trade];
  input.completedPositions = [{ ...trade, exitLegs: 1, finalReason: "STOP_LOSS" }];
  const parsed = parsePhantomState(researchState(input), T).state!.researchPaper!;
  assert.equal(parsed.account.realizedPnlLamports, "-1020000");
  assert.equal(parsed.completedPositions.length, 1);
  input.trades[0].pnlLamports = "1";
  assert.equal(parsePhantomState(researchState(input), T).state!.researchPaperStatus, "invalid");
});

test("experimental monitoring strips raw quote/config/transaction payloads and sanitizes visible limitations", () => {
  const input: Record<string, any> = experimental();
  input.account.apiKey = "DO_NOT_FORWARD";
  input.manifest.secret = "DO_NOT_FORWARD";
  input.manifest.policy.rpcUrl = "https://provider.invalid/?api-key=DO_NOT_FORWARD";
  input.limitations = ["authorization=DO_NOT_FORWARD https://provider.invalid/private"];
  input.journal = [
    {
      sequence: 1,
      at: T,
      bookId: input.account.bookId,
      kind: "MARK_OBSERVED",
      entryId: "research:synthetic-experiment:capture:0",
      mark: {
        quote: { route: ["DO_NOT_FORWARD"], transaction: "DO_NOT_FORWARD" },
        feeLamports: "10000",
      },
    },
  ];
  const serialized = JSON.stringify(parsePhantomState(researchState(input), T));
  assert(!serialized.includes("DO_NOT_FORWARD"));
  assert(!serialized.includes("provider.invalid"));
  assert(!serialized.includes('"mark"'));
});

test("experimental V2 source universe is explicitly identified and frozen snapshot clocks remain visible", () => {
  const input = experimental();
  input.manifest.policy.version = 2;
  input.manifest.policy.kind = "RESEARCH_PAPER_POLICY_V2";
  input.manifest.policy.sourceUniverse =
    "LEGACY_SPL_AND_METADATA_ONLY_TOKEN_2022_SOL_PAIRS_JUPITER_AGGREGATOR_QUOTES";
  const parsed = parsePhantomState(researchState(input), T + 20000);
  assert.equal(parsed.status, "stale");
  assert.equal(parsed.state!.researchPaperStatus, "available");
  assert.equal(parsed.state!.researchPaper!.manifest.policy.version, 2);
});
test("launch bridge preserves degraded typed/full coverage and never counts observed buys as fills", () => {
  const r = parsePhantomState(sample(), T);
  assert.equal(r.connection, "connected");
  assert.equal(r.status, "degraded");
  assert(r.readOnly);
  assert.equal(r.state!.events[0].verification, "TYPED_PROGRAM_EVENT");
  assert.equal(r.state!.health.typedLogs!.latencyMs.p95, 1);
  assert.equal(r.state!.health.latencyMs.p95, 195766);
  assert.equal(r.state!.positionCount, 0);
  assert.equal(r.state!.completedCount, 0);
  assert.equal(r.state!.completedNetLamports, "0");
});
test("non-paper or incompatible state is refused", () => {
  for (const change of [
    { mode: "LIVE" },
    { application: "OTHER" },
    { health: null },
    { cashLamports: 1 },
  ]) {
    const r = parsePhantomState({ ...sample(), ...change }, T);
    assert.equal(r.connection, "incompatible");
    assert.equal(r.state, null);
  }
});
test("typed or unknown verification is never promoted from a contradictory label", () => {
  const s = sample();
  s.events[0].verification = "FULL_TRANSACTION";
  assert.equal(parsePhantomState(s, T).state!.events[0].verification, "TYPED_PROGRAM_EVENT");
  const unknown = structuredClone(s) as Record<string, any>;
  delete unknown.events[0].verification;
  delete unknown.events[0].details;
  assert.equal(parsePhantomState(unknown, T).state!.events[0].verification, "UNKNOWN");
});
test("bad event rows, duplicate IDs and future observations do not become live events", () => {
  const s = sample();
  s.events.push(
    { ...s.events[0] },
    { ...s.events[0], id: "bad-signature", signature: "invalid" },
    { ...s.events[0], id: "future", receivedAt: T + 100000, processedAt: T + 100001 },
  );
  const r = parsePhantomState(s, T);
  assert.equal(r.state!.events.length, 1);
  assert.equal(r.state!.discardedRows, 3);
  assert.equal(
    parsePhantomState({ ...sample(), startedAt: T + 100000 }, T).connection,
    "incompatible",
  );
});
test("missing completed evidence and stale or unknown equity stay unknown", () => {
  const s: Record<string, any> = sample();
  delete s.completedPositions;
  s.equity = [{ at: T - 100000, equityLamports: "1000000000" }];
  let r = parsePhantomState(s, T);
  assert.equal(r.state!.completedCount, null);
  assert.equal(r.state!.completedNetLamports, null);
  assert.equal(r.state!.equityLamports, null);
  s.equity = [{ at: T - 100, equityLamports: null }];
  r = parsePhantomState(s, T);
  assert.equal(r.state!.equityLamports, null);
});
test("completed position totals use integer lamports and refuse duplicate or malformed groups", () => {
  const s: Record<string, any> = sample();
  s.completedPositions = [
    {
      positionId: "p1",
      mint,
      strategy: "test",
      openedAt: T - 5000,
      closedAt: T - 100,
      costLamports: "100",
      proceedsLamports: "80",
      feesLamports: "1",
      pnlLamports: "-21",
      exitLegs: 2,
      finalReason: "TIME_EXIT",
    },
  ];
  assert.equal(parsePhantomState(s, T).state!.completedNetLamports, "-21");
  s.completedPositions.push({ ...s.completedPositions[0] });
  let r = parsePhantomState(s, T);
  assert.equal(r.state!.completedNetLamports, null);
  assert.equal(r.state!.completedCount, null);
  s.completedPositions[1].positionId = "p2";
  s.completedPositions[1].pnlLamports = 123;
  r = parsePhantomState(s, T);
  assert.equal(r.state!.completedNetLamports, null);
});
test("large balances stay exact and non-SOL quote mints remain explicit", () => {
  const s = sample();
  s.cashLamports = "18446744073709551615";
  s.events[0].quoteMint = USDC;
  const r = parsePhantomState(s, T);
  assert.equal(r.state!.cashLamports, "18446744073709551615");
  assert.equal(r.state!.events[0].quoteMint, USDC);
  assert.equal(phantomSol("18446744073709551615"), "18446744073.70955");
  assert.equal(phantomSol(null), "—");
  assert.equal(phantomSol("-21", 9), "−0.000000021");
  assert.equal(phantomSol("1"), "0.000000001");
  assert.equal(phantomSol("-100"), "−0.0000001");
});
test("upstream snapshot time and observation age control freshness", () => {
  const late = parsePhantomState(sample(), T + 20000);
  assert.equal(late.status, "stale");
  assert.equal(late.state!.now, T);
  assert.equal(late.state!.sampledAt, T + 20000);
  const s = sample();
  s.events = [];
  s.health.lastEventAt = T - 70000;
  assert.equal(parsePhantomState(s, T).status, "stale");
  s.health.lastEventAt = null as never;
  assert.equal(parsePhantomState(s, T).status, "waiting");
});
test("raw upstream secrets/config and transaction bytes are not forwarded", () => {
  const s: Record<string, any> = sample();
  s.apiKey = "secret";
  s.transaction = "signed-bytes";
  s.health.lastError = "RPC https://provider.invalid/?api-key=secret token=secret";
  s.limitations = ["authorization=secret https://provider.invalid/secret"];
  const json = JSON.stringify(parsePhantomState(s, T));
  assert(!json.includes("secret"));
  assert(!json.includes("signed-bytes"));
  assert(!json.includes("provider.invalid"));
});
test("bridge accepts only the fixed local engine origin and never forwards credentials", () => {
  assert.equal(phantomOrigin(), "http://127.0.0.1:8790");
  assert.equal(
    phantomOrigin("http://host.docker.internal:8790"),
    "http://host.docker.internal:8790",
  );
  for (const url of [
    "https://127.0.0.1:8790",
    "http://127.0.0.1:8790/execute",
    "http://127.0.0.1:8790?target=evil",
    "http://user:pass@localhost:8790",
    "http://evil.invalid:8790",
    "http://localhost:80",
    "http://127.0.0.1.evil.invalid:8790",
  ])
    assert.throws(() => phantomOrigin(url));
});
test("bridge network path is GET-only, bounded, and refuses redirects", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (url, opts) => {
    calls++;
    assert.equal(String(url), "http://127.0.0.1:8790/state");
    assert.equal(opts?.method, "GET");
    assert.equal(opts?.redirect, "error");
    assert.equal(opts?.body, undefined);
    assert.deepEqual(opts?.headers, { accept: "application/json" });
    return Response.json(sample());
  };
  const r = await fetchPhantomBridge({ fetcher, now: () => T });
  assert.equal(calls, 1);
  assert.equal(r.connection, "connected");
  const oversized = await fetchPhantomBridge({
    fetcher: async () => new Response("x".repeat(4 * 1024 * 1024 + 1)),
    now: () => T,
  });
  assert.equal(oversized.connection, "unavailable");
});
test("upstream failures are explicit and do not leak transport error text", async () => {
  for (const fetcher of [
    async () => {
      throw Error("secret credential URL");
    },
    async () => new Response("private server error", { status: 503 }),
    async () => Response.json({ mode: "LIVE" }),
  ]) {
    const r = await fetchPhantomBridge({ fetcher, now: () => T });
    assert.equal(r.state, null);
    assert.notEqual(r.connection, "connected");
    assert(!JSON.stringify(r).includes("secret"));
  }
});

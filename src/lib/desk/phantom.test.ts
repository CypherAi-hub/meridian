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

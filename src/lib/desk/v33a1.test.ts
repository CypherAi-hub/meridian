import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRugcheckReport, holderTtlMs, UNKNOWN_TTL } from "./providers/holders.ts";
import { governorRoutePolicy, routeStateFromFailure } from "./routes.ts";
import { researchHealth } from "./research-health.ts";
import { emptyQuality } from "./types.ts";
import { assertPaperMode, deskSettings, loadDeskConfig } from "./config.ts";
import { observationFingerprint } from "./fingerprint.ts";
import { CircuitBreaker, resetBreakers } from "./circuit.ts";
import { desiredIntervalMs } from "./watch.ts";

test("rugcheck report parses top10 as a fraction, zero is valid not unknown", () => {
  const parsed = parseRugcheckReport({
    totalHolders: 7443,
    topHolders: [
      { pct: 5.1 },
      { pct: 3.2 },
      { pct: 2.0 },
      { pct: 1.4 },
      { pct: 1.1 },
      { pct: 0.8 },
      { pct: 0.7 },
      { pct: 0.5 },
      { pct: 0.3 },
      { pct: 0.06 },
    ],
  });
  assert.ok(parsed);
  assert.equal(parsed.status, "VALID");
  assert.equal(parsed.source, "rugcheck");
  assert.equal(parsed.holders, 7443);
  assert.ok(parsed.top10Pct != null);
  assert.ok(parsed.top10Pct > 0.14 && parsed.top10Pct < 0.16);
  const empty = parseRugcheckReport({ topHolders: [], totalHolders: 0 });
  assert.equal(empty, null);
});

test("holder TTL is longer for older buckets", () => {
  assert.equal(holderTtlMs("new_launch"), 30_000);
  assert.equal(holderTtlMs("early"), 60_000);
  assert.equal(holderTtlMs("emerging"), 120_000);
  assert.equal(holderTtlMs("established"), 300_000);
  assert.equal(holderTtlMs("mature"), 600_000);
  assert.equal(UNKNOWN_TTL, 20_000);
  assert.ok(UNKNOWN_TTL < holderTtlMs("new_launch"));
});

test("QUOTE_ONLY is a paper PASS, timeout is not a fake no-route", () => {
  assert.equal(governorRoutePolicy("QUOTE_ONLY"), "PASS");
  assert.equal(governorRoutePolicy("ROUTABLE"), "PASS");
  assert.equal(governorRoutePolicy("NO_ROUTE"), "FAIL");
  assert.equal(governorRoutePolicy("TIMEOUT"), "UNKNOWN");
  assert.equal(governorRoutePolicy(routeStateFromFailure("QUOTE_TIMEOUT")), "UNKNOWN");
  assert.notEqual(governorRoutePolicy("TIMEOUT"), "FAIL");
});

test("research health is DEGRADED when holder coverage is 0%", () => {
  const q = emptyQuality();
  q.holderCoveragePct = 0;
  q.uniqueTokens = 307;
  const rh = researchHealth(q);
  assert.equal(rh.status, "DEGRADED");
  assert.ok(rh.blockers.some((b) => b.toLowerCase().includes("holder")));
});

test("research health is independent of worker LIVE", () => {
  const q = emptyQuality();
  q.holderCoveragePct = 0.04;
  q.highConfidencePct = 0;
  q.mediumConfidencePct = 0.008;
  q.gradeA = 0;
  q.gradeB = 57;
  q.gradeC = 2842;
  q.researchOnly = 184;
  q.uniqueTokens = 307;
  q.routeCoverage = { checks: 100, routable: 68, noRoute: 5, timeout: 2, rateLimited: 10, errors: 0, notChecked: 15 };
  const rh = researchHealth(q);
  assert.equal(rh.status, "DEGRADED");
  assert.ok(rh.blockers.length >= 1);
});

test("research health HEALTHY only when GO gates pass", () => {
  const q = emptyQuality();
  q.holderCoveragePct = 0.85;
  q.highConfidencePct = 0.4;
  q.mediumConfidencePct = 0.3;
  q.gradeA = 300;
  q.gradeB = 300;
  q.gradeC = 100;
  q.researchOnly = 0;
  q.uniqueTokens = 600;
  q.routeCoverage = { checks: 100, routable: 80, noRoute: 8, timeout: 2, rateLimited: 0, errors: 0, notChecked: 5 };
  const rh = researchHealth(q);
  assert.equal(rh.status, "HEALTHY");
  assert.deepEqual(rh.blockers, []);
});

test("paper mode is locked and assertPaperMode does not throw", () => {
  assert.equal(deskSettings().executionMode, "PAPER");
  assert.equal(loadDeskConfig().executionMode, "PAPER");
  assert.doesNotThrow(() => assertPaperMode());
});

test("observation fingerprint is deterministic and ignores wall-clock", () => {
  const a = observationFingerprint({
    mint: "Mint111",
    eventTime: 1_000,
    price: 1.23,
    liquidity: 50_000,
    provider: "dexscreener",
  });
  const b = observationFingerprint({
    mint: "Mint111",
    eventTime: 1_500,
    price: 1.23,
    liquidity: 50_000,
    provider: "dexscreener",
  });
  const c = observationFingerprint({
    mint: "Mint111",
    eventTime: 1_000,
    price: 1.24,
    liquidity: 50_000,
    provider: "dexscreener",
  });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[a-f0-9]{64}$/);
});

test("circuit breaker canRequest aliases canCall", () => {
  resetBreakers();
  const b = new CircuitBreaker(2, 50);
  assert.equal(b.canRequest(0), true);
  b.failure("x", 0);
  b.failure("x", 0);
  assert.equal(b.canRequest(0), false);
  assert.equal(b.canCall(0), false);
});

test("active watch interval is 3s not universe 15s", () => {
  assert.equal(desiredIntervalMs("active"), 3_000);
  assert.equal(desiredIntervalMs("universe"), 15_000);
});

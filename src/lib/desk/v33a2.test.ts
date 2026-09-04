import assert from "node:assert/strict";
import { test } from "node:test";
import { validateProductionConfig, meridianEnvironment, currentEpochName, officialSoakAllowed, makeSoakIncident, SOAK_INCIDENT_TYPES } from "./env.ts";
import { decideLease, PRIMARY_LEASE } from "./lease.ts";
import { holderPriority, holderReasonFor, rankHolderJobs, makeHolderJob } from "./holder-queue.ts";
import { researchUrgency, selectActiveWatches, promoteWatch, demoteWatch, activateWatch, MAX_ACTIVE_WATCHES } from "./watch.ts";
import { FAST_PATH_FIELDS, SLOW_ENRICHMENT_FIELDS, fastPathForbidden, watchDeadline } from "./fast-path.ts";
import { routePriority, selectRouteJobs, shouldRefreshRoute, ROUTE_TTL_MS } from "./route-priority.ts";
import { AdaptiveRateBudget } from "./rate-budget.ts";
import { CircuitBreaker, resetBreakers } from "./circuit.ts";
import { inputQualityScore, labelQualityScore, overallQualityV2, gradeFromV2, lateWatchPenalty } from "./quality-v2.ts";
import { researchHealth } from "./research-health.ts";
import { emptyQuality } from "./types.ts";
import { classifyVeto, vetoDistribution, gateOutcomeGrouping, counterfactualVeto } from "./veto-report.ts";
import { governorRoutePolicy, routeStateFromFailure } from "./routes.ts";
import { parseRugcheckReport, unknownHolderObs } from "./providers/holders.ts";
import { loadDeskConfig } from "./config.ts";
import { BASELINE_SAFE_MOMENTUM_V1 } from "./baseline-strategy.ts";

test("production requires DATABASE_URL and rejects PGLite canonical", () => {
  const prev = process.env.MERIDIAN_ENV;
  process.env.MERIDIAN_ENV = "production";
  try {
    assert.throws(
      () => validateProductionConfig({ databaseUrl: null, databaseDriver: "pglite", executionMode: "PAPER" }),
      /DATABASE_URL_REQUIRED/,
    );
    assert.throws(
      () => validateProductionConfig({ databaseUrl: "postgres://x", databaseDriver: "pglite", executionMode: "PAPER" }),
      /PGLITE_NOT_ALLOWED/,
    );
    validateProductionConfig({ databaseUrl: "postgres://x", databaseDriver: "neon", executionMode: "PAPER" });
  } finally {
    if (prev == null) delete process.env.MERIDIAN_ENV;
    else process.env.MERIDIAN_ENV = prev;
  }
});

test("preview does not throw production validation", () => {
  const prev = process.env.MERIDIAN_ENV;
  process.env.MERIDIAN_ENV = "preview";
  try {
    validateProductionConfig({ databaseUrl: null, databaseDriver: "pglite", executionMode: "PAPER" });
    assert.equal(officialSoakAllowed(), false);
    assert.equal(currentEpochName(), "v33b_preview");
  } finally {
    if (prev == null) delete process.env.MERIDIAN_ENV;
    else process.env.MERIDIAN_ENV = prev;
  }
});

test("single writer lease acquire renew and conflict", () => {
  const now = 1_000_000;
  const a = decideLease(null, "w1", now);
  assert.equal(a.decision, "acquired");
  assert.equal(a.next.leaseName, PRIMARY_LEASE);
  const r = decideLease(a.next, "w1", now + 5_000);
  assert.equal(r.decision, "renewed");
  const c = decideLease(r.next, "w2", now + 6_000);
  assert.equal(c.decision, "conflict");
  const expired = decideLease({ ...r.next, expiresAt: now + 1_000 }, "w2", now + 40_000);
  assert.equal(expired.decision, "acquired");
});

test("holder priority orders positions before universe refresh", () => {
  assert.ok(holderPriority("OPEN_POSITION") < holderPriority("CANDIDATE"));
  assert.ok(holderPriority("CANDIDATE") < holderPriority("NEW_LAUNCH"));
  assert.ok(holderPriority("NEW_LAUNCH") < holderPriority("REFRESH"));
  assert.equal(holderReasonFor({ held: true }), "OPEN_POSITION");
  const jobs = rankHolderJobs([
    makeHolderJob("mature", { ageS: 1_000_000, now: 1 }),
    makeHolderJob("pos", { held: true, now: 2 }),
    makeHolderJob("new", { ageS: 60, now: 3 }),
  ]);
  assert.equal(jobs[0].mint, "pos");
  assert.equal(jobs[1].mint, "new");
});

test("research urgency ranks open paper and pending labels first", () => {
  assert.ok(researchUrgency({ hasOpenPaperPosition: true }) > researchUrgency({ hasPendingLabel: true }));
  assert.ok(researchUrgency({ isNewLaunch: true }) > researchUrgency({}));
  const { keep, demote } = selectActiveWatches(
    [
      { mint: "a", urgency: 10 },
      { mint: "b", urgency: 900 },
      { mint: "c", urgency: 5 },
    ],
    2,
  );
  assert.deepEqual(keep, ["b", "a"]);
  assert.deepEqual(demote, ["c"]);
  assert.equal(MAX_ACTIVE_WATCHES, 25);
});

test("active demotion and phase machine", () => {
  const now = 10;
  const p = promoteWatch("m", now, "considered", 80);
  assert.equal(p.phase, "PROMOTING");
  assert.equal(activateWatch(p).phase, "ACTIVE");
  const d = demoteWatch(p, now, "capacity");
  assert.equal(d.tier, "universe");
  assert.equal(d.reason, "capacity");
});

test("fast path does not execute full enrichment", () => {
  assert.equal(fastPathForbidden("holders"), true);
  assert.equal(fastPathForbidden("jupiter"), true);
  assert.equal(fastPathForbidden("priceUsd"), false);
  assert.ok(FAST_PATH_FIELDS.includes("priceUsd"));
  assert.ok(SLOW_ENRICHMENT_FIELDS.includes("holders"));
});

test("active scheduler deadline tracking", () => {
  const hit = watchDeadline({ scheduledAt: 0, startedAt: 10, completedAt: 80, deadlineMs: 3_000 });
  assert.equal(hit.deadlineMissed, false);
  const miss = watchDeadline({ scheduledAt: 0, startedAt: 100, completedAt: 8_000, deadlineMs: 3_000 });
  assert.equal(miss.deadlineMissed, true);
  assert.equal(miss.totalDelayMs, 8_000);
});

test("route priority and TTL", () => {
  assert.ok(routePriority("OPEN_POSITION") < routePriority("RESEARCH"));
  const selected = selectRouteJobs(
    [
      { mint: "r", priority: 4, reason: "RESEARCH" },
      { mint: "p", priority: 0, reason: "OPEN_POSITION" },
    ],
    1,
  );
  assert.equal(selected[0].mint, "p");
  assert.equal(shouldRefreshRoute({ lastQuotedAt: 0, now: ROUTE_TTL_MS - 1, priority: 4 }), false);
  assert.equal(shouldRefreshRoute({ lastQuotedAt: 0, now: ROUTE_TTL_MS + 1, priority: 4 }), true);
});

test("adaptive rate reduction and recovery", () => {
  const b = new AdaptiveRateBudget(1, 0.1, 2, 0);
  b.onRateLimit(0, 0);
  assert.ok(b.rate <= 0.5 + 1e-9);
  const before = b.rate;
  b.onHealthyWindow();
  assert.ok(b.rate > before);
  b.tokens = 0;
  b.lastRefill = 0;
  b.limitedUntil = 0;
  assert.equal(b.take(1, 0), false);
  assert.equal(b.take(1, 20_000), true);
});

test("Jupiter half-open circuit allows a single probe then reopens on fail", () => {
  resetBreakers();
  const c = new CircuitBreaker(2, 50);
  c.failure("429", 0);
  c.failure("429", 0);
  assert.equal(c.phase(0), "OPEN");
  assert.equal(c.canCall(0), false);
  assert.equal(c.canCall(60), true);
  assert.equal(c.phase(60), "HALF_OPEN");
  assert.equal(c.canCall(61), false);
  c.failure("429", 61);
  assert.equal(c.phase(61), "OPEN");
  c.success();
  assert.equal(c.phase(100), "CLOSED");
});

test("quality v2 input/label split cannot let path rescue missing holders", () => {
  const input = inputQualityScore({
    priceOk: true,
    liquidityOk: true,
    flowOk: true,
    holderOk: false,
    securityOk: true,
    routeOk: true,
    freshness: 1,
  });
  const label = labelQualityScore({ pathDensity: 1, routePath: true, liqPath: true, lateWatchPenalty: 1 });
  const overall = overallQualityV2(input, label, false);
  assert.ok(overall <= 74);
  assert.equal(gradeFromV2(overall, false), "TRAINING_GRADE_C");
  assert.ok(lateWatchPenalty(40) < lateWatchPenalty(3));
});

test("historical epoch remains unchanged: lifetime health can stay DEGRADED while epoch is separate", () => {
  const q = emptyQuality();
  q.uniqueTokens = 900;
  q.holderCoveragePct = 0.9;
  q.highConfidencePct = 0.4;
  q.mediumConfidencePct = 0.3;
  q.gradeA = 40;
  q.gradeB = 40;
  q.gradeC = 10;
  q.routeCoverage = { checks: 100, routable: 90, noRoute: 5, timeout: 0, rateLimited: 0, errors: 0, notChecked: 5 };
  q.epochUniqueTokens = 12;
  q.epochGradeA = 0;
  q.epochGradeB = 0;
  q.epochGradeC = 12;
  q.epochHolderCoveragePct = 0.1;
  q.holderCoverageAtDecisionPct = 0.1;
  const lifetime = researchHealth(q, { useEpoch: false });
  const epoch = researchHealth(q, { useEpoch: true });
  assert.equal(lifetime.status, "HEALTHY");
  assert.equal(epoch.status, "DEGRADED");
  assert.ok(epoch.blockingReasons.some((r) => r.metric === "holderCoverageAtDecision"));
});

test("late active-watch penalty lowers label quality", () => {
  assert.equal(lateWatchPenalty(2), 1);
  assert.ok(lateWatchPenalty(20) < 1);
  assert.ok(lateWatchPenalty(80) <= 0.2);
});

test("official soak starts only in production with neon", () => {
  assert.equal(officialSoakAllowed(), false);
  assert.notEqual(meridianEnvironment(), "production");
});

test("counterfactual veto and gate grouping do not invent zeros as unknown", () => {
  const dist = vetoDistribution([
    { governor_result: "vetoed", veto_reason_code: "HOLDER_UNKNOWN" },
    { governor_result: "vetoed", veto_reason_code: "NO_SELL_ROUTE" },
    { governor_result: "authorized", veto_reason_code: "TRADE_AUTHORIZED" },
  ]);
  assert.equal(dist.HOLDER_UNKNOWN, 1);
  assert.equal(dist.ROUTE, 1);
  assert.equal(classifyVeto("DATA_STALE"), "FRESHNESS");
  const grouped = gateOutcomeGrouping([
    { gate: "UNKNOWN", labels_complete: true, price: 1, price_after_15m: 1.2, rug_detected: false },
    { gate: "FAIL", labels_complete: true, price: 1, price_after_15m: 0.5, rug_detected: true },
  ]);
  assert.equal(grouped.UNKNOWN.n, 1);
  assert.ok((grouped.UNKNOWN.median15m ?? 0) > 0);
  const cf = counterfactualVeto([
    { veto_reason_code: "HOLDER_UNKNOWN", labels_complete: true, price: 1, price_after_15m: 1.1, rug_detected: false },
  ]);
  assert.equal(cf.HOLDER_UNKNOWN.n, 1);
});

test("rugcheck remains rugcheck, not solana_onchain", () => {
  const p = parseRugcheckReport({ topHolders: [{ pct: 10 }], totalHolders: 9 });
  assert.equal(p?.source, "rugcheck");
});

test("timeout stays UNKNOWN not a fake no-route under rate-limit storm", () => {
  assert.equal(governorRoutePolicy(routeStateFromFailure("QUOTE_TIMEOUT")), "UNKNOWN");
  assert.equal(governorRoutePolicy(routeStateFromFailure("RATE_LIMIT")), "UNKNOWN");
  assert.notEqual(governorRoutePolicy("TIMEOUT"), "FAIL");
});

test("paper mode and preview epoch are locked", () => {
  const s = loadDeskConfig();
  assert.equal(s.executionMode, "PAPER");
  assert.equal(s.collectionEpoch, "v33b_preview");
  assert.equal(s.databaseDriver, "pglite");
});

test("EXECUTION_MODE=PAPER is accepted as the Railway alias for MERIDIAN_EXECUTION_MODE", () => {
  const prev = process.env.EXECUTION_MODE;
  process.env.EXECUTION_MODE = "PAPER";
  try {
    assert.equal(loadDeskConfig().executionMode, "PAPER");
  } finally {
    if (prev == null) delete process.env.EXECUTION_MODE;
    else process.env.EXECUTION_MODE = prev;
  }
});

test("production epoch is blocked without neon canonical", () => {
  assert.equal(currentEpochName("preview"), "v33b_preview");
  assert.equal(currentEpochName("production"), "v33b_production_blocked");
  assert.equal(officialSoakAllowed("production"), false);
});

test("soak incident persistence shape does not invent resolution", () => {
  const row = makeSoakIncident({ type: "LEASE_LOST", severity: "error", durationSeconds: 12, now: 99 });
  assert.equal(row.incidentType, "LEASE_LOST");
  assert.equal(row.occurredAtMs, 99);
  assert.equal(row.durationSeconds, 12);
  assert.ok(SOAK_INCIDENT_TYPES.includes("RATE_LIMIT_STORM"));
  assert.ok(SOAK_INCIDENT_TYPES.includes("WORKER_DOWN"));
});

test("unknown holder does not fabricate 0 or 100 concentration", () => {
  const u = unknownHolderObs([{ provider: "birdeye", error: "down" }]);
  assert.equal(u.status, "UNKNOWN");
  assert.equal(u.top10Pct, null);
  assert.equal(u.holders, null);
  assert.notEqual(u.top10Pct, 0);
  assert.notEqual(u.top10Pct, 1);
});

test("baseline_safe_momentum_v1 is research data only, not a live strategy", () => {
  assert.equal(BASELINE_SAFE_MOMENTUM_V1.version, 1);
  assert.ok(BASELINE_SAFE_MOMENTUM_V1.requiredGates.includes("holder"));
  assert.ok(BASELINE_SAFE_MOMENTUM_V1.note.includes("Not live-wired"));
});
import assert from "node:assert/strict";
import { test } from "node:test";
import { CircuitBreaker, resetBreakers } from "./circuit.ts";
import { classifyRouteFailure, governorRoutePolicy, routeStateFromFailure } from "./routes.ts";
import { researchQualityScore, gradeFromScore, pathQualityFromGaps } from "./quality-score.ts";
import { shouldPromote, expireWatch, promoteWatch, desiredIntervalMs } from "./watch.ts";
import { relativeSpread, flagDisagreement } from "./disagreement.ts";
import { FEATURE_ENGINE_VERSION, LABEL_DEFINITION_VERSION, LABEL_DEFINITION, stableHash, FEATURE_SCHEMA } from "./versions.ts";
import { barrierResult, labelConfidence, pathGaps } from "./labels.ts";
import { deskSettings, configuredProviders } from "./config.ts";
import { ReplayClock, replayVisible } from "./replay.ts";
import { sanitizeTrainingRows, walkForwardSplit, tokenLeakage, corpusIndependence } from "./dataset.ts";
import { buildBaselineReport, edgeBucket } from "./baseline.ts";
import { cooldownKey } from "./leakage.ts";
import { asOfField, usableAt, workerStatusFromHeartbeat } from "./leakage.ts";
import { field } from "./providers/normalize.ts";
import type { LedgerRow } from "./types.ts";
import { evaluateCondition, validateStrategyDef, STRATEGIES } from "./strategies.ts";
import { requestFingerprint } from "./fingerprint.ts";
import { EXECUTION_ASSUMPTION_VERSION } from "./versions.ts";

test("holder provider fallback: unconfigured keys are explicit", () => {
  const cfg = configuredProviders();
  if (!cfg.birdeye) assert.equal(cfg.birdeye, false);
  if (!cfg.helius) assert.equal(cfg.helius, false);
});

test("missing holder never becomes PASS via route classifier", () => {
  assert.equal(governorRoutePolicy("UNKNOWN"), "UNKNOWN");
  assert.notEqual(governorRoutePolicy("UNKNOWN"), "PASS");
});

test("route failure classification", () => {
  assert.equal(classifyRouteFailure("http 429", 429), "RATE_LIMIT");
  assert.equal(classifyRouteFailure("timeout"), "QUOTE_TIMEOUT");
  assert.equal(classifyRouteFailure("could not find any route"), "NO_ROUTE");
  assert.equal(classifyRouteFailure("TOKEN_NOT_TRADABLE"), "TOKEN_UNSUPPORTED");
  assert.equal(classifyRouteFailure("circuit open"), "CIRCUIT_OPEN");
  assert.equal(routeStateFromFailure("NO_ROUTE"), "NO_ROUTE");
  assert.equal(routeStateFromFailure("QUOTE_TIMEOUT"), "TIMEOUT");
  assert.equal(routeStateFromFailure("RATE_LIMIT"), "RATE_LIMITED");
  assert.equal(governorRoutePolicy("TIMEOUT"), "UNKNOWN");
  assert.equal(governorRoutePolicy("NO_ROUTE"), "FAIL");
  assert.equal(governorRoutePolicy("ROUTABLE"), "PASS");
});

test("timeout is UNKNOWN not a fake no-route", () => {
  assert.equal(governorRoutePolicy(routeStateFromFailure("QUOTE_TIMEOUT")), "UNKNOWN");
});

test("high-resolution watch promotion", () => {
  assert.equal(shouldPromote({ considered: true }), true);
  assert.equal(shouldPromote({ edgeScore: 70 }), true);
  assert.equal(shouldPromote({ volAccel: 2.5 }), true);
  assert.equal(shouldPromote({ edgeScore: 10, volAccel: 1 }), false);
  assert.equal(desiredIntervalMs("active"), 3_000);
  assert.equal(desiredIntervalMs("universe"), 15_000);
});

test("high-resolution watch expiration", () => {
  const now = 1_000_000;
  const active = promoteWatch("Mint", now, "considered");
  assert.equal(active.tier, "active");
  const done = expireWatch(active, now + 61 * 60_000, {});
  assert.equal(done.tier, "universe");
  const dead = expireWatch(active, now + 1000, { dead: true });
  assert.equal(dead.reason, "dead");
});

test("barrier confidence from path gaps", () => {
  assert.equal(labelConfidence(3, 20), "HIGH");
  assert.equal(labelConfidence(12, 10), "MEDIUM");
  assert.equal(labelConfidence(22, 8), "LOW");
  assert.equal(labelConfidence(40, 8), "UNKNOWN");
  assert.equal(labelConfidence(2, 1), "UNKNOWN");
  const g = pathGaps([
    { ts: 0, px: 1, liq: 1, sell: 1 },
    { ts: 3000, px: 1.01, liq: 1, sell: 1 },
    { ts: 8000, px: 1.02, liq: 1, sell: 1 },
  ]);
  assert.equal(g.max, 5);
  assert.equal(g.count, 3);
});

test("ambiguous barrier when a large gap could hide order", () => {
  const t0 = 0;
  const hit = barrierResult(1, [
    { ts: t0, px: 1, liq: 50_000, sell: 1 },
    { ts: t0 + 22_000, px: 1.25, liq: 50_000, sell: 1 },
  ], 0.1, 0.1);
  assert.equal(hit, "AMBIGUOUS");
});

test("feature-engine version persistence is stable", () => {
  assert.equal(FEATURE_ENGINE_VERSION, "v1.3.0");
  assert.equal(stableHash(FEATURE_SCHEMA), stableHash(FEATURE_SCHEMA));
  assert.notEqual(stableHash(FEATURE_SCHEMA), stableHash({ ...FEATURE_SCHEMA, version: "other" }));
});

test("label-definition version persistence is stable", () => {
  assert.equal(LABEL_DEFINITION_VERSION, "labels_v1");
  assert.equal(LABEL_DEFINITION.liquidity_collapse_threshold, 0.6);
});

test("provider disagreement is flagged, not averaged", () => {
  const d = flagDisagreement({ priceA: 1, priceB: 1.1 });
  assert.equal(d.disagreement, true);
  assert.ok((d.spreadPct ?? 0) > 0.03);
  assert.equal(flagDisagreement({ priceA: 1, priceB: 1.01 }).disagreement, false);
  assert.equal(relativeSpread(100, 80), 20 / 90);
  assert.equal(relativeSpread(null, 1), null);
});

test("research quality score is explicit and graded", () => {
  const a = researchQualityScore({
    priceOk: true, liquidityOk: true, holderOk: true, routeOk: true, securityOk: true,
    pathQuality: 1, freshnessQuality: 1,
  });
  assert.equal(a, 100);
  assert.equal(gradeFromScore(a), "TRAINING_GRADE_A");
  assert.equal(gradeFromScore(80), "TRAINING_GRADE_B");
  assert.equal(gradeFromScore(60), "TRAINING_GRADE_C");
  assert.equal(gradeFromScore(40), "RESEARCH_ONLY");
  assert.equal(pathQualityFromGaps(4, 10), 1);
});

test("token-grouped dataset preparation", () => {
  const rows = [
    { tokenAddress: "A" },
    { tokenAddress: "A" },
    { tokenAddress: "B" },
  ];
  const stats = corpusIndependence(rows);
  assert.equal(stats.uniqueTokens, 2);
  assert.equal(stats.considerations, 3);
  assert.equal(stats.maxConsiderationsPerToken, 2);
});

test("time-safe dataset split does not random-shuffle", () => {
  const rows = [
    { decision_time: 1, tokenAddress: "A" },
    { decision_time: 5, tokenAddress: "B" },
    { decision_time: 9, tokenAddress: "C" },
  ];
  const split = walkForwardSplit(rows, 4, 8);
  assert.equal(split.train.length, 1);
  assert.equal(split.validation.length, 1);
  assert.equal(split.test.length, 1);
  assert.deepEqual(tokenLeakage(split.train, split.test), []);
});

test("sanitize training rows drops low confidence and incomplete", () => {
  const row = {
    labels_complete: true,
    research_quality_score: 90,
    barrier_label_confidence: "HIGH",
    decision_time: 1,
    tokenAddress: "M",
  } as LedgerRow;
  const kept = sanitizeTrainingRows([row, { ...row, labels_complete: false }, { ...row, barrier_label_confidence: "LOW" }]);
  assert.equal(kept.length, 1);
});

test("circuit breaker opens after threshold and recovers", () => {
  resetBreakers();
  const b = new CircuitBreaker(3, 50);
  b.failure("x", 0);
  b.failure("x", 0);
  assert.equal(b.canCall(0), true);
  b.failure("x", 0);
  assert.equal(b.canCall(0), false);
  assert.equal(b.state(), "OPEN_CIRCUIT");
  assert.equal(b.canCall(60), true);
});

test("replay clock is monotonic and hides future ingestion", () => {
  const clock = new ReplayClock(1000);
  clock.advanceTo(2000);
  assert.equal(clock.now, 2000);
  assert.throws(() => clock.advanceTo(1500));
  const visible = replayVisible(
    [
      { ingestedAt: 500, v: 1 },
      { ingestedAt: 2500, v: 2 },
    ],
    clock.now,
  );
  assert.equal(visible.length, 1);
  assert.equal(visible[0].v, 1);
});

test("late ingested data still cannot enter a decision", () => {
  const t0 = 1_000_000;
  const late = field(100, t0, t0 + 8_000, "dexscreener");
  assert.equal(asOfField(late, t0 + 5_000).value, null);
});

test("duplicate cooldown key is deterministic", () => {
  assert.equal(cooldownKey("m", "3.3.0", 40_000), cooldownKey("m", "3.3.0", 41_000));
});

test("paper-only execution mode", () => {
  assert.equal(deskSettings().executionMode, "PAPER");
});

test("baseline report does not treat considerations as independent tokens", () => {
  const mk = (tokenAddress: string, edge: number): LedgerRow =>
    ({
      tokenAddress,
      edge_score: edge,
      labels_complete: true,
      price: 1,
      price_after_15m: 1.02,
      bucket: "early",
      regime: "chop",
      hit_plus_10_before_minus_10: false,
      hit_plus_20_before_minus_10: false,
      rug_detected: false,
      liquidity_collapse: false,
    }) as LedgerRow;
  const report = buildBaselineReport([mk("A", 10), mk("A", 12), mk("B", 85)]);
  assert.equal(report.uniqueTokens, 2);
  assert.equal(report.considerations, 3);
  assert.ok(report.considerationsPerToken > 1);
  assert.equal(edgeBucket(85), "80-100");
  assert.equal(report.readyForModeling, false);
});

test("missing is not zero in quality inputs", () => {
  const s = researchQualityScore({
    priceOk: false,
    liquidityOk: false,
    holderOk: false,
    routeOk: false,
    securityOk: false,
    pathQuality: 0,
    freshnessQuality: 0,
  });
  assert.equal(s, 0);
});

test("barrier outcomes cover upper, lower, neither, insufficient", () => {
  const t0 = 0;
  assert.equal(
    barrierResult(1, [
      { ts: t0, px: 1, liq: 50_000, sell: 1 },
      { ts: t0 + 4_000, px: 1.12, liq: 50_000, sell: 1 },
    ], 0.1, 0.1),
    "UPPER_FIRST",
  );
  assert.equal(
    barrierResult(1, [
      { ts: t0, px: 1, liq: 50_000, sell: 1 },
      { ts: t0 + 4_000, px: 0.88, liq: 50_000, sell: 1 },
    ], 0.1, 0.1),
    "LOWER_FIRST",
  );
  assert.equal(
    barrierResult(1, [
      { ts: t0, px: 1, liq: 50_000, sell: 1 },
      { ts: t0 + 4_000, px: 1.02, liq: 50_000, sell: 1 },
    ], 0.1, 0.1),
    "NEITHER",
  );
  assert.equal(barrierResult(1, [{ ts: t0, px: 1, liq: 50_000, sell: 1 }], 0.1, 0.1), "INSUFFICIENT_DATA");
});

test("late data usableAt is false even if event_time is earlier", () => {
  const t0 = 1_000_000;
  const late = field(100, t0, t0 + 8_000, "dexscreener");
  assert.equal(usableAt(late, t0 + 5_000), false);
  const ok = field(100, t0, t0 + 1_000, "dexscreener");
  assert.equal(usableAt(ok, t0 + 5_000), true);
});

test("stale heartbeat is OFFLINE never fake LIVE", () => {
  assert.equal(workerStatusFromHeartbeat(null, null, 10_000, 90_000), "starting");
  assert.equal(workerStatusFromHeartbeat(1_000, null, 200_000, 90_000), "offline");
  assert.equal(workerStatusFromHeartbeat(1_000, "boom", 1_500, 90_000), "offline");
  assert.equal(workerStatusFromHeartbeat(1_000, null, 2_000, 90_000), "live");
});

test("DSL rejects unsupported operators and unknown features stay UNKNOWN", () => {
  assert.throws(() => evaluateCondition({ feature: "volAccel", op: "eval", value: 1 }, { volAccel: 2 }));
  assert.equal(evaluateCondition({ feature: "volAccel", op: ">", value: 1 }, { volAccel: null }), null);
  assert.equal(evaluateCondition({ feature: "volAccel", op: ">", value: 1 }, { volAccel: 2 }), true);
  for (const s of STRATEGIES) assert.equal(validateStrategyDef(s), true);
  assert.throws(() =>
    validateStrategyDef({
      ...STRATEGIES[0],
      entry: [{ feature: "volAccel", op: "exec", value: 1 }],
    }),
  );
});

test("request fingerprints are stable within a time bucket", () => {
  const a = requestFingerprint("jupiter", "quote", { mint: "M" }, 10);
  const b = requestFingerprint("jupiter", "quote", { mint: "M" }, 10);
  const c = requestFingerprint("jupiter", "quote", { mint: "M" }, 11);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("execution assumption version is pinned", () => {
  assert.equal(EXECUTION_ASSUMPTION_VERSION, "exec_v1");
});

test("NOT_CHECKED is UNKNOWN to the governor, NO_ROUTE is FAIL", () => {
  assert.equal(governorRoutePolicy(routeStateFromFailure("NOT_CHECKED")), "UNKNOWN");
  assert.equal(governorRoutePolicy(routeStateFromFailure("NO_ROUTE")), "FAIL");
  assert.equal(classifyRouteFailure("not checked"), "NOT_CHECKED");
});

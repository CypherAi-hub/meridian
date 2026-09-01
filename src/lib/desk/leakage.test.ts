import assert from "node:assert/strict";
import { test } from "node:test";
import { asOfField, asOfSnapshot, cooldownKey, workerStatusFromHeartbeat } from "./leakage.ts";
import { blankSnapshot, field } from "./providers/normalize.ts";

test("a decision cannot use data ingested after decision_time", () => {
  const t0 = 1_000_000;
  const late = field(1.5, t0, t0 + 8_000, "dexscreener");
  const asOf = asOfField(late, t0 + 5_000);
  assert.equal(asOf.value, null);
  assert.equal(asOf.error, "ingested_after_decision");
});

test("data received before decision_time remains usable", () => {
  const t0 = 1_000_000;
  const onTime = field(1.2, t0, t0 + 2_000, "dexscreener");
  const asOf = asOfField(onTime, t0 + 5_000);
  assert.equal(asOf.value, 1.2);
  assert.equal(asOf.stale, false);
});

test("stale data is marked stale", () => {
  const t0 = 1_000_000;
  const old = field(1, t0, t0, "dexscreener");
  const asOf = asOfField(old, t0 + 60_000);
  assert.equal(asOf.value, 1);
  assert.equal(asOf.stale, true);
});

test("asOfSnapshot nulls late quotes", () => {
  const t0 = 1_000_000;
  const snap = blankSnapshot("Mint", t0, t0);
  snap.priceUsd = field(1, t0, t0 + 9_000, "dexscreener");
  snap.sellQuote = {
    available: true,
    inMint: "a",
    outMint: "b",
    inAmount: "1",
    outAmount: "1",
    notionalUsd: 100,
    priceImpactPct: 0.01,
    impliedPriceUsd: 1,
    routeLabels: [],
    latencyMs: 10,
    eventTime: t0,
    ingestedAt: t0 + 9_000,
    source: "jupiter",
  };
  const frozen = asOfSnapshot(snap, t0 + 5_000);
  assert.equal(frozen.priceUsd.value, null);
  assert.equal(frozen.sellQuote, null);
});

test("restart does not duplicate considerations: cooldown key is deterministic", () => {
  const a = cooldownKey("mint", "3.25", 1_000_040, 20_000);
  const b = cooldownKey("mint", "3.25", 1_000_019, 20_000);
  const c = cooldownKey("mint", "3.25", 1_020_000, 20_000);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("worker OFFLINE when heartbeat is stale", () => {
  assert.equal(workerStatusFromHeartbeat(null, null), "starting");
  assert.equal(workerStatusFromHeartbeat(Date.now() - 5_000, null), "live");
  assert.equal(workerStatusFromHeartbeat(Date.now() - 120_000, null), "offline");
  assert.equal(workerStatusFromHeartbeat(Date.now(), "tick failed"), "offline");
});

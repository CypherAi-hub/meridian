import assert from "node:assert/strict";
import { test } from "node:test";
import { PRIMARY_LEASE } from "./lease.ts";
import { trainModel } from "./v34-model.ts";
import { parseSniperMode } from "./v35-lock.ts";
import { SHADOW_LEASE, assertNotPrimaryLease, assertShadowWarehouse, decideShadowLease, shadowDatabaseUrl } from "./v35-dev-lease.ts";
import { mapHeliusTx, fetchHeliusParticipantEvents, heliusHistoryUrl } from "./v35-helius.ts";
import { collectorBootGuard, parseWatchMints, runCollectorTick, V35_1_VERSION } from "./v35-collector.ts";
import { shadowPlaceOrder } from "./v35-sniper.ts";
import { refuseProductionPersist } from "./v35-persist.ts";

test("v3.5.1 refuses production warehouse and primary lease", () => {
  assert.notEqual(SHADOW_LEASE, PRIMARY_LEASE);
  assert.throws(() => assertNotPrimaryLease(PRIMARY_LEASE), /refused primary/);
  assert.equal(shadowDatabaseUrl({}), null);
  assert.throws(
    () => assertShadowWarehouse({ DATABASE_URL: "postgres://prod", MERIDIAN_WORKER: "1", PARTICIPANT_DATABASE_URL: "postgres://dev" }),
    /production worker/,
  );
  assert.throws(
    () => assertShadowWarehouse({ DATABASE_URL: "postgres://prod" }),
    /required/,
  );
  assert.throws(
    () =>
      assertShadowWarehouse({
        DATABASE_URL: "postgres://same",
        PARTICIPANT_DATABASE_URL: "postgres://same",
      }),
    /must not be the production/,
  );
  const url = assertShadowWarehouse({
    DATABASE_URL: "postgres://prod",
    PARTICIPANT_DATABASE_URL: "postgres://dev",
  });
  assert.equal(url, "postgres://dev");
  assert.equal(refuseProductionPersist({ PARTICIPANT_DATABASE_URL: "postgres://dev", DATABASE_URL: "postgres://prod" }), "postgres://dev");
});

test("shadow lease never names the production writer", () => {
  const got = decideShadowLease(null, "dev-1", 1000);
  assert.equal(got.decision, "acquired");
  assert.equal(got.next.leaseName, SHADOW_LEASE);
  assert.notEqual(got.next.leaseName, PRIMARY_LEASE);
  const conflict = decideShadowLease(got.next, "other", 1100);
  assert.equal(conflict.decision, "conflict");
});

test("helius mapper: swap buy/sell, liquidity, missing timestamp dropped", () => {
  const mint = "Mint111";
  const swap = mapHeliusTx(
    {
      signature: "sig1",
      timestamp: 1_700_000_000,
      type: "SWAP",
      tokenTransfers: [
        { fromUserAccount: "seller", toUserAccount: "buyer", mint, tokenAmount: 12 },
        { fromUserAccount: "x", toUserAccount: "y", mint: "OTHER", tokenAmount: 99 },
      ],
    },
    mint,
    9,
  );
  assert.equal(swap.length, 2);
  assert.equal(swap[0]?.side, "sell");
  assert.equal(swap[0]?.walletId, "seller");
  assert.equal(swap[1]?.side, "buy");
  assert.equal(swap[1]?.walletId, "buyer");
  const liq = mapHeliusTx(
    {
      signature: "sig2",
      timestamp: 1_700_000_010,
      type: "REMOVE_LIQUIDITY",
      tokenTransfers: [{ fromUserAccount: "lp", toUserAccount: "pool", mint, tokenAmount: 5 }],
    },
    mint,
    9,
  );
  assert.equal(liq[0]?.side, "liq_remove");
  assert.deepEqual(mapHeliusTx({ signature: "no-time", type: "SWAP" }, mint, 9), []);
});

test("helius provider failure is UNKNOWN and does not throw", async () => {
  const fail = await fetchHeliusParticipantEvents("Mint", {
    apiKey: "k",
    fetchImpl: async () => new Response("nope", { status: 500 }),
  });
  assert.equal(fail.ok, false);
  assert.equal(fail.providerStatus, "UNKNOWN");
  assert.equal(fail.events.length, 0);
  const missing = await fetchHeliusParticipantEvents("Mint", { apiKey: null });
  assert.equal(missing.providerStatus, "UNKNOWN");
});

test("collector tick ingests mapped events and cannot train or place orders", async () => {
  const mint = "Coin11111111111111111111111111111111111111111";
  const payload = [
    {
      signature: "abc",
      timestamp: 1_700_000_100,
      type: "SWAP",
      tokenTransfers: Array.from({ length: 30 }, (_, i) => ({
        fromUserAccount: `s${i}`,
        toUserAccount: `b${i}`,
        mint,
        tokenAmount: 10 + i,
      })),
    },
  ];
  const tick = await runCollectorTick({
    mints: [mint],
    apiKey: "k",
    ingestedAt: 1_700_000_100_000 + 5_000,
    fetchImpl: async (url) => {
      assert.ok(String(url).includes("api.helius.xyz"));
      assert.ok(String(url).includes(mint));
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.ok(tick.eventsIngested >= 2);
  assert.equal(tick.providerUnknown, 0);
  assert.throws(() => trainModel(), /ML_TRAINING_LOCKED/);
  assert.throws(() => shadowPlaceOrder(), /SNIPER_SHADOW/);
  assert.equal(parseSniperMode("SHADOW"), "SHADOW");
});

test("watch mint parse is bounded; boot guard matches warehouse rule", () => {
  assert.equal(parseWatchMints("a, b\nc").length, 3);
  assert.equal(parseWatchMints(Array.from({ length: 20 }, (_, i) => `m${i}`).join(",")).length, 8);
  assert.equal(collectorBootGuard({ PARTICIPANT_DATABASE_URL: "postgres://dev" }), "postgres://dev");
  assert.ok(heliusHistoryUrl("Mint", "key").includes("api-key=key"));
  assert.equal(V35_1_VERSION, "v35.1-participant-collector");
});

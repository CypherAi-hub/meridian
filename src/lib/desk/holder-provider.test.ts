import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { enrichHolders, getHolderConcentration, parseRugcheckReport } from "./providers/holders.ts";
import { blankSnapshot } from "./providers/normalize.ts";
import { resetBreakers } from "./circuit.ts";
import { resetBudgets } from "./rate-budget.ts";

function isolatedProviders(t: TestContext) {
  for (const name of [
    "BIRDEYE_API_KEY",
    "HELIUS_API_KEY",
    "HELIUS_RPC_URL",
    "HELIUS_GATEKEEPER_URL",
    "SOLANA_RPC_URL",
  ]) {
    const saved = process.env[name];
    delete process.env[name];
    t.after(() => {
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    });
  }
  resetBreakers();
  resetBudgets();
}

test("holder percentage points below one percent keep their actual units", () => {
  const p = parseRugcheckReport({ topHolders: [{ pct: 0.3 }, { pct: 0.5 }], totalHolders: 200 });
  assert.equal(p?.top10Pct, 0.008);
  assert.equal(p?.largestPct, 0.005);
  assert.equal(parseRugcheckReport({ topHolders: [{ pct: 1 }] })?.top10Pct, 0.01);
  for (const topHolders of [[{}], [{ pct: -1 }], [{ pct: NaN }], [{ pct: 60 }, { pct: 60 }]])
    assert.equal(parseRugcheckReport({ topHolders }), null);
});

test("cached holder observations retain their receipt time and expired unselected cache is stale", async (t) => {
  isolatedProviders(t);
  let now = 1800000000000,
    calls = 0;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ topHolders: [{ pct: 20 }], totalHolders: 200 });
  });
  const mint = "qa-holder-age";
  const first = await enrichHolders([blankSnapshot(mint, now, now)]);
  assert.equal(first.tokens[0].top10Pct.eventTime, now);
  now += 50000;
  const second = await enrichHolders([blankSnapshot(mint, now, now)]);
  assert.equal(calls, 1);
  assert.equal(second.tokens[0].top10Pct.eventTime, 1800000000000);
  assert.equal(second.tokens[0].top10Pct.ingestedAt, 1800000000000);
  now += 50000;
  const unselected = await enrichHolders([blankSnapshot(mint, now, now)], { jobs: [] });
  assert.equal(unselected.tokens[0].top10Pct.status, "STALE");
  assert.equal(unselected.tokens[0].top10Pct.eventTime, 1800000000000);
  assert.equal(calls, 1);
});

test("failed refresh does not renew the age of a stale security observation", async (t) => {
  isolatedProviders(t);
  let now = 1800000000000,
    down = false;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async () =>
    down
      ? new Response("unavailable", { status: 503 })
      : Response.json({ topHolders: [{ pct: 20 }], totalHolders: 200 }),
  );
  await getHolderConcentration("qa-holder-outage");
  down = true;
  now += 100000;
  const stale = await getHolderConcentration("qa-holder-outage");
  assert.equal(stale.status, "STALE");
  assert.equal(stale.observedAt, 1800000000000);
  now += 10000;
  const retry = await getHolderConcentration("qa-holder-outage");
  assert.equal(retry.observedAt, 1800000000000);
  assert.equal(retry.status, "STALE");
});

test("a failed supply lookup cannot turn the largest accounts into invented total supply", async (t) => {
  isolatedProviders(t);
  process.env.SOLANA_RPC_URL = "https://qa-rpc.invalid";
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, opts?: RequestInit) => {
    if (String(url).includes("rugcheck")) return new Response("unavailable", { status: 503 });
    const method = JSON.parse(String(opts?.body)).method;
    if (method === "getTokenSupply") throw Error("QA supply unavailable");
    return Response.json({ result: { value: [{ uiAmount: 10 }, { uiAmount: 5 }] } });
  });
  const result = await getHolderConcentration("qa-supply-failed");
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.top10Pct, null);
});

test("malformed largest-account amounts stay unknown instead of becoming zero concentration", async (t) => {
  isolatedProviders(t);
  process.env.SOLANA_RPC_URL = "https://qa-rpc.invalid";
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) =>
    String(url).includes("rugcheck")
      ? new Response("unavailable", { status: 503 })
      : Response.json({ result: { value: [{ uiAmount: -10 }, {}] } }),
  );
  const result = await getHolderConcentration("qa-largest-malformed");
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.top10Pct, null);
});

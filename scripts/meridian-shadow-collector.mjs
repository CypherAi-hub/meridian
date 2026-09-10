#!/usr/bin/env node
/**
 * V3.5.1 non-production participant collector.
 * Does NOT take meridian_primary_research_writer.
 * Does NOT use production DATABASE_URL.
 * Does NOT create paper orders.
 */
process.env.MERIDIAN_SHADOW_COLLECTOR = "1";
delete process.env.MERIDIAN_WORKER;

function die(message) {
  console.error(`[v35-shadow] FATAL ${message}`);
  process.exit(1);
}

const { collectorBootGuard, parseWatchMints, runCollectorTick, V35_1_VERSION } = await import(
  "../src/lib/desk/v35-collector.ts"
);
const { parseSniperMode } = await import("../src/lib/desk/v35-lock.ts");
const { SHADOW_LEASE, decideShadowLease } = await import("../src/lib/desk/v35-dev-lease.ts");
const { PRIMARY_LEASE } = await import("../src/lib/desk/lease.ts");
const { persistParticipantEvents, persistSniperSessions } = await import("../src/lib/desk/v35-persist.ts");
const { trainModel } = await import("../src/lib/desk/v34-model.ts");

let warehouse;
try {
  warehouse = collectorBootGuard(process.env);
} catch (e) {
  die(e instanceof Error ? e.message : String(e));
}
if (SHADOW_LEASE === PRIMARY_LEASE) die("shadow lease collided with primary");

let mode;
try {
  mode = parseSniperMode(process.env.SNIPER_MODE ?? "SHADOW");
} catch (e) {
  die(e instanceof Error ? e.message : String(e));
}

const mints = parseWatchMints(process.env.SHADOW_WATCH_MINTS);
const apiKey = (process.env.HELIUS_API_KEY ?? "").trim() || null;
const instanceId = `v35_${process.pid}_${Date.now().toString(36)}`;
let lease = decideShadowLease(null, instanceId, Date.now());
if (lease.next.leaseName === PRIMARY_LEASE) die("refused primary lease");

console.log("MERIDIAN V3.5.1 SHADOW COLLECTOR");
console.log(`version: ${V35_1_VERSION}`);
console.log("execution: SHADOW (not PAPER worker, not LIVE)");
console.log(`sniper mode: ${mode}`);
console.log(`lease: ${SHADOW_LEASE} ${lease.decision}`);
console.log(`mints: ${mints.length ? mints.join(",") : "(none — set SHADOW_WATCH_MINTS)"}`);
console.log(`helius: ${apiKey ? "configured" : "missing"}`);
console.log("trainModel: LOCKED");

const interval = Number(process.env.SHADOW_TICK_MS ?? 20_000);
let held = lease.next;

async function tick() {
  held = decideShadowLease(held, instanceId, Date.now()).next;
  if (!mints.length) {
    console.log("[v35-shadow] no mints configured; idle");
    return;
  }
  const result = await runCollectorTick({ mints, apiKey, sniperMode: mode });
  if (process.env.V35_PERSIST === "1") {
    const pg = (await import("pg")).default;
    const client = new pg.Client({ connectionString: warehouse, ssl: { rejectUnauthorized: false } });
    await client.connect();
    try {
      await persistParticipantEvents(client, result.events);
      await persistSniperSessions(client, result.sessions);
    } finally {
      await client.end();
    }
  }
  console.log(
    `[v35-shadow] tick events=${result.eventsIngested} sessions=${result.sessions.length} unknown=${result.providerUnknown}`,
  );
}

const timer = setInterval(() => {
  tick().catch((err) => console.error("[v35-shadow] tick error", err instanceof Error ? err.message : err));
}, interval);
void tick();

function shutdown() {
  clearInterval(timer);
  console.log("[v35-shadow] stop");
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
void trainModel;

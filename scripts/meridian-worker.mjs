#!/usr/bin/env node
/**
 * Railway / always-on production research worker.
 * Not the Vite frontend. Not `npm run dev`. Paper only. Requires DATABASE_URL.
 */
import http from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

process.env.MERIDIAN_WORKER = "1";
if (!process.env.MERIDIAN_ENV && (process.env.NODE_ENV ?? "").toLowerCase() === "production") {
  process.env.MERIDIAN_ENV = "production";
}
if (!process.env.MERIDIAN_EXECUTION_MODE && process.env.EXECUTION_MODE) {
  process.env.MERIDIAN_EXECUTION_MODE = process.env.EXECUTION_MODE;
}

function die(message) {
  console.error(`[meridian-worker] FATAL ${message}`);
  process.exit(1);
}

const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
if (!databaseUrl) die("DATABASE_URL is required. PGLite is not allowed as the production warehouse.");

const executionMode = (process.env.MERIDIAN_EXECUTION_MODE ?? process.env.EXECUTION_MODE ?? "PAPER").trim().toUpperCase();
if (executionMode !== "PAPER") die("ONLY_PAPER_MODE_ALLOWED");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrate = spawnSync(process.execPath, [join(root, "scripts/migrate.mjs")], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});
if (migrate.status !== 0) die(`migrations failed (exit ${migrate.status ?? "spawn"})`);

const { loadDeskConfig, configuredProviders, assertPaperMode } = await import("../src/lib/desk/config.ts");
const { currentEpochName, meridianEnvironment, canonicalDriver, validateProductionConfig } = await import(
  "../src/lib/desk/env.ts"
);
const { runTick, runActiveTick, ensureWorker, stopWorker, workerInstanceId } = await import(
  "../src/lib/desk/worker.server.ts"
);
const { acquirePrimaryLease } = await import("../src/lib/desk/repo.server.ts");

assertPaperMode();
const settings = loadDeskConfig();
validateProductionConfig({
  databaseUrl: settings.databaseUrl,
  databaseDriver: settings.databaseDriver,
  executionMode: "PAPER",
});
if (settings.databaseDriver !== "neon") die("PGLITE_NOT_ALLOWED_AS_PRODUCTION_CANONICAL_DB");

const instanceId = workerInstanceId();
const providers = configuredProviders();
const epoch = currentEpochName();
const envName = meridianEnvironment();

console.log("MERIDIAN PRODUCTION WORKER");
console.log(`database: ${canonicalDriver()}`);
console.log(`collection epoch: ${epoch}`);
console.log(`environment: ${envName}`);
console.log("execution mode: PAPER");
console.log(
  `providers: birdeye=${providers.birdeye ? "configured" : "missing"} helius=${providers.helius ? "configured" : "missing"} rpc=${providers.rpc} jupiter=${providers.jupiterMode} rugcheck=${providers.rugcheck ? "configured" : "missing"}`,
);
console.log(`worker instance id: ${instanceId}`);
console.log(`tick cadence: universe ${settings.universeWatchMs}ms / active ${settings.activeWatchMs}ms`);

let lease;
try {
  lease = await acquirePrimaryLease(instanceId);
} catch (err) {
  die(`writer lease failed: ${err instanceof Error ? err.message : String(err)}`);
}
console.log(`writer lease status: ${lease}`);

ensureWorker();
console.log("research worker started");

const port = Number(process.env.PORT || 0);
let server = null;
if (Number.isFinite(port) && port > 0) {
  server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/" || url.startsWith("/health") || url.startsWith("/api/health")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          role: "meridian-worker",
          epoch,
          executionMode: "PAPER",
          instanceId,
          lease,
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve, reject) => {
    server.listen(port, "0.0.0.0", (err) => (err ? reject(err) : resolve(null)));
  });
  console.log(`health listen :${port} (not the desk UI)`);
}

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[meridian-worker] ${signal} shutting down`);
  stopWorker();
  if (server) await new Promise((resolve) => server.close(() => resolve(null)));
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (err) => {
  die(err instanceof Error ? err.message : String(err));
});
process.on("uncaughtException", (err) => {
  die(err instanceof Error ? err.message : String(err));
});

void runTick()
  .then((snap) => {
    console.log(`tick complete status=${snap.worker.status} tokens=${snap.tokens.length}`);
  })
  .catch((err) => {
    die(err instanceof Error ? err.message : String(err));
  });

console.log("worker loop healthy");

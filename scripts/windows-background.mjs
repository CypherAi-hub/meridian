#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  statSync,
  renameSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

if (process.platform !== "win32")
  throw Error("This background launcher runs on the Windows PC only.");
if (Number(process.versions.node.split(".")[0]) < 22)
  throw Error("Omni requires Node.js 22 or newer.");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(join(root, "logs"), { recursive: true });
const logfile = join(root, "logs", "omni-autostart.log");
if (existsSync(logfile) && statSync(logfile).size > 2_000_000)
  renameSync(logfile, join(root, "logs", `omni-autostart-${Date.now()}.log`));
const log = (message) => appendFileSync(logfile, `${new Date().toISOString()} ${message}\n`);
const ready = () =>
  spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
    cwd: root,
    stdio: "ignore",
    timeout: 5000,
    windowsHide: true,
  }).status === 0;
try {
  log("Omni startup requested. Paper mode only; waiting for Docker.");
  if (!ready()) {
    const desktop = join(
      process.env.ProgramFiles ?? "C:\\Program Files",
      "Docker",
      "Docker",
      "Docker Desktop.exe",
    );
    if (!existsSync(desktop))
      throw Error("Install and open Docker Desktop with its WSL 2 Linux-container backend first.");
    const child = spawn(desktop, [], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    for (let i = 0; i < 60 && !ready(); i++) await delay(5000);
  }
  if (!ready())
    throw Error("Docker did not become ready. Open Docker Desktop and inspect its status.");
  const fd = openSync(logfile, "a");
  try {
    for (const action of ["init", "collect"]) {
      const result = spawnSync(process.execPath, [join(root, "scripts", "selfhost.mjs"), action], {
        cwd: root,
        stdio: ["ignore", fd, fd],
        windowsHide: true,
        timeout: 20 * 60_000,
      });
      if (result.error) throw result.error;
      if (result.status !== 0)
        throw Error(`Local ${action} failed (exit ${result.status}). Inspect the log above.`);
    }
  } finally {
    closeSync(fd);
  }
  let verified = false;
  for (let i = 0; i < 24; i++) {
    try {
      const r = await fetch("http://127.0.0.1:8080/api/sniper?view=live", {
        signal: AbortSignal.timeout(5000),
      });
      const b = await r.json();
      if (
        r.ok &&
        b.mode === "PAPER" &&
        b.books?.length === 3 &&
        b.worker?.status === "live" &&
        b.serverAt - b.worker.lastTickAt < 90000 &&
        b.books.every((book) => book.initialized && b.serverAt - book.updatedAt < 90000)
      ) {
        verified = true;
        break;
      }
    } catch {
      /* Waiting for migrations, collector lease, and first live tick. */
    }
    await delay(5000);
  }
  if (!verified)
    throw Error(
      "Containers started, but fresh paper-worker heartbeats were not verified. Inspect Docker logs.",
    );
  log(
    "VERIFIED: local paper worker and three strategy heartbeats are fresh. Open http://localhost:8080 to watch Live bot. Containers continue after this launcher exits.",
  );
} catch (error) {
  log("STARTUP FAILED: " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}

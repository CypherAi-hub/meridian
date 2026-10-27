#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync, closeSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = resolve(root, ".env.selfhost");
const action = process.argv[2];
function compose(args, options = {}) {
  const result = spawnSync("docker", ["compose", "--env-file", envFile, "-f", resolve(root, "compose.yaml"), ...args], { cwd: root, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  return result.status ?? 1;
}
if (action === "init") {
  if (!existsSync(envFile)) writeFileSync(envFile, `POSTGRES_PASSWORD=${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
  console.log("Local configuration ready. Keep .env.selfhost with this installation; do not commit it.");
} else if (!existsSync(envFile)) {
  console.error("Run node scripts/selfhost.mjs init first."); process.exitCode = 1;
} else if (action === "backup") {
  mkdirSync(resolve(root, "backups"), { recursive: true });
  const path = resolve(root, "backups", `meridian-${new Date().toISOString().replaceAll(":", "-")}.dump`);
  const fd = openSync(path, "wx", 0o600);
  let status;
  try { status = compose(["exec", "-T", "db", "pg_dump", "-U", "meridian", "-d", "meridian", "-Fc"], { stdio: ["ignore", fd, "inherit"] }); }
  finally { closeSync(fd); }
  if (status !== 0) { unlinkSync(path); process.exitCode = status; }
  else console.log(`Backup saved: ${path}`);
} else {
  const commands = {
    up: ["up", "-d", "--build", "web"],
    collect: ["--profile", "collect", "up", "-d", "--build", "web", "worker"],
    pause: ["--profile", "collect", "stop", "worker"],
    stop: ["--profile", "collect", "down"],
    status: ["--profile", "collect", "ps", "-a"],
    logs: ["--profile", "collect", "logs", "--tail", "100", "-f"],
    check: ["--profile", "collect", "config", "--quiet"],
  };
  if (!commands[action]) { console.error("Usage: node scripts/selfhost.mjs init|up|collect|pause|stop|status|logs|backup|check"); process.exitCode = 1; }
  else process.exitCode = compose(commands[action]);
}

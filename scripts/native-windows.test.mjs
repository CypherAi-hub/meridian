import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  identityMatches,
  pointsToCluster,
  postgresRecordMatches,
  redactLog,
  nativeLogger,
  paperBooksReady,
  phantomNodeArguments,
  isWorkerProcess,
  workerNodeArguments,
} from "./native-windows.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const marker = path.join(root, "scripts/native-windows.mjs");
const command = `"C:\\runtime\\node.exe" "${marker}" supervise`;
const info = { pid: 101, created: "2026-10-26T20:00:00.000Z", command };
const record = {
  pid: info.pid,
  created: info.created,
  commandHash: createHash("sha256").update(command).digest("hex"),
  root,
};

test("native Omni worker loads its absolute Windows ESM hook in the owned process", async () => {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, "data/native-worker-test-"));
  try {
    const envFile = path.join(directory, "fixture.env"),
      entry = path.join(directory, "fixture.ts");
    fs.writeFileSync(envFile, "NATIVE_LAUNCH_FIXTURE=synthetic\n");
    fs.writeFileSync(
      entry,
      'const mode: string = "PAPER"; console.log(JSON.stringify({pid:process.pid,parent:process.ppid,mode,fixture:process.env.NATIVE_LAUNCH_FIXTURE}));',
    );
    const child = spawn(process.execPath, workerNodeArguments(envFile, entry), {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    assert.equal(code, 0, stderr);
    const result = JSON.parse(stdout);
    assert.equal(result.pid, child.pid);
    assert.equal(result.parent, process.pid);
    assert.equal(result.mode, "PAPER");
    assert.equal(result.fixture, "synthetic");
  } finally {
    for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
  }
});

test("process inspection text cannot masquerade as another Node worker", () => {
  assert.equal(
    isWorkerProcess({
      exe: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      command:
        "Get-CimInstance Win32_Process | Where-Object {$_.CommandLine -like '*meridian-worker.mjs*'}",
    }),
    false,
  );
  assert.equal(
    isWorkerProcess({
      exe: "C:\\runtime\\node.exe",
      command:
        "node --env-file=.env.native --import ./scripts/desk-loader.mjs scripts/meridian-worker.mjs",
    }),
    true,
  );
  assert.equal(
    isWorkerProcess({
      exe: "C:\\runtime\\node.exe",
      command: 'node "C:\\My Workspace\\scripts\\meridian-worker.mjs"',
    }),
    true,
  );
  assert.equal(
    isWorkerProcess({
      exe: "C:\\runtime\\node.exe",
      command: "node scripts/native-windows.mjs supervise",
    }),
    false,
  );
});

test("process reuse requires PID, creation time, command hash and exact workspace marker", () => {
  assert.equal(identityMatches(record, info, marker), true);
  for (const changed of [
    { pid: 102 },
    { created: "2026-10-26T20:01:00.000Z" },
    { command: "node scripts/native-windows.mjs supervise" },
  ])
    assert.equal(identityMatches(record, { ...info, ...changed }, marker), false);
  assert.equal(identityMatches({ ...record, root: root + "-other" }, info, marker), false);
  assert.equal(identityMatches({ ...record, root: undefined }, info, marker), false);
  assert.equal(identityMatches(record, null, marker), false);
});
test("dedicated PG reuse verifies exact data directory, process start and server port", () => {
  const directory = path.join(root, "data/test-cluster");
  assert.equal(pointsToCluster(`postgres -D "${directory}" -p 55432`, directory), true);
  assert.equal(pointsToCluster(`postgres -D "${directory}-other" -p 55432`, directory), false);
  assert.equal(pointsToCluster("postgres -D test-cluster -p 55432", directory), true);
  const pidfile = `101\n${directory}\n${Date.parse(info.created) / 1000}\n55432\n`;
  assert.equal(postgresRecordMatches(pidfile, info, directory), true);
  assert.equal(postgresRecordMatches(pidfile.replace(/^101/, "102"), info, directory), false);
  assert.equal(postgresRecordMatches(pidfile.replace("55432", "5432"), info, directory), false);
  assert.equal(
    postgresRecordMatches(pidfile, { ...info, created: "2026-10-26T21:00:00.000Z" }, directory),
    false,
  );
});
test("readiness requires three distinct initialized fresh PAPER books, not an HTTP200", () => {
  const now = 1_000_000,
    value = {
      mode: "PAPER",
      worker: { status: "live", lastTickAt: now - 100 },
      books: [1, 2, 3].map((id) => ({
        id: String(id),
        initialized: true,
        ticks: 1,
        updatedAt: now - 100,
      })),
    };
  assert.equal(paperBooksReady(value, now - 1000, now), true);
  assert.equal(paperBooksReady({ ...value, mode: "LIVE" }, 0, now), false);
  assert.equal(paperBooksReady(value, now, now), false);
  assert.equal(paperBooksReady({ ...value, books: value.books.slice(0, 2) }, 0, now), false);
  assert.equal(
    paperBooksReady(
      { ...value, books: value.books.map((b) => ({ ...b, id: "duplicate" })) },
      0,
      now,
    ),
    false,
  );
  assert.equal(
    paperBooksReady(
      { ...value, books: value.books.map((b) => ({ ...b, updatedAt: now - 120_001 })) },
      0,
      now,
    ),
    false,
  );
  assert.equal(
    paperBooksReady({ ...value, worker: { status: "live", lastTickAt: now + 1 } }, 0, now),
    false,
  );
});
test("logs redact configured values, URL credentials and credential-looking fields", () => {
  const secret = "SYNTHETIC_TEST_SECRET_abcdef";
  const redacted = redactLog(
    `provider https://example.invalid/?api-key=${secret} database postgres://user:pass@example/db password=test123 token=abc123 direct=${secret}`,
    [secret],
  );
  assert.ok(!redacted.includes(secret));
  assert.ok(!redacted.includes("test123"));
  assert.ok(!redacted.includes("abc123"));
  assert.ok(!redacted.includes("user:pass"));
  assert.ok(redacted.includes("redacted"));
});
test("chunked child output is redacted before writing, oversized lines suppressed and rotation bounded", async () => {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, "data/native-log-test-"));
  try {
    const secret = "SYNTHETIC_SPLIT_SECRET_123456",
      log = nativeLogger("fixture", [secret], directory),
      stream = new PassThrough();
    log.attach(stream);
    stream.write("value=" + secret.slice(0, 10));
    stream.write(secret.slice(10) + "\n");
    stream.write("x".repeat(70_000));
    stream.write(secret + "\n");
    stream.end("safe\n");
    await new Promise((resolve) => stream.on("end", resolve));
    let text = fs.readFileSync(path.join(directory, "fixture.log"), "utf8");
    assert.ok(!text.includes(secret));
    assert.ok(text.includes("[oversized log line suppressed]"));
    assert.ok(text.includes("safe"));
    for (let i = 0; i < 40; i++) log.write("z".repeat(60_000) + "\n");
    const files = fs.readdirSync(directory);
    assert.ok(files.length <= 3);
    for (const name of files) assert.ok(fs.statSync(path.join(directory, name)).size <= 1_048_576);
  } finally {
    // Exact newly created fixture directory only; never recursive-delete a computed parent.
    for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
  }
});
test(
  "native PHANTOM import arguments execute TypeScript in the owned Node PID without a CLI child",
  { skip: !fs.existsSync(path.join(root, "packages/phantom/node_modules/tsx/dist/loader.mjs")) },
  async () => {
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    const directory = fs.mkdtempSync(path.join(root, "data/native-node-test-"));
    try {
      const envFile = path.join(directory, "fixture.env"),
        entry = path.join(directory, "fixture.ts");
      fs.writeFileSync(envFile, "NATIVE_LAUNCH_FIXTURE=synthetic\n");
      // A TS enum requires the tsx transform rather than native strip-only execution.
      fs.writeFileSync(
        entry,
        `enum Mode { PAPER = 'PAPER' }\nconst mode: Mode = Mode.PAPER; console.log(JSON.stringify({pid:process.pid,parent:process.ppid,mode,fixture:process.env.NATIVE_LAUNCH_FIXTURE}));\n`,
      );
      const child = spawn(process.execPath, phantomNodeArguments(envFile, entry), {
        cwd: root,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (value) => {
        stdout += value;
      });
      child.stderr.on("data", (value) => {
        stderr += value;
      });
      const code = await new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", resolve);
      });
      assert.equal(code, 0, stderr);
      const report = JSON.parse(stdout);
      assert.equal(report.pid, child.pid);
      assert.equal(report.parent, process.pid);
      assert.equal(report.mode, "PAPER");
      assert.equal(report.fixture, "synthetic");
    } finally {
      for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
      fs.rmdirSync(directory);
    }
  },
);

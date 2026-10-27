#!/usr/bin/env node
/** Current-user, loopback-only PAPER supervisor. Never initializes databases or kills port owners. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { parseEnv } from "node:util";
import { spawn, spawnSync } from "node:child_process";

const script = fileURLToPath(import.meta.url),
  root = path.resolve(path.dirname(script), "..");
const native = path.join(root, "data/native"),
  stateFile = path.join(native, "state.json"),
  lockFile = path.join(native, "supervisor.lock");
const phantom = path.join(root, "packages/phantom"),
  pgRoot = path.resolve(root, "../postgres-validation-runtime");
const pgExe = path.join(
    pgRoot,
    "node_modules/@embedded-postgres/windows-x64/native/bin/postgres.exe",
  ),
  cluster = path.join(pgRoot, "cluster");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const normalized = (value) => path.resolve(value).toLowerCase().replaceAll("/", "\\");
const psQuote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const readJson = (file, fallback = {}) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
};
function atomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
function powershell(code) {
  const p = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", code], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 15_000,
  });
  if (p.status !== 0)
    throw Error("Windows process/shortcut inspection failed; no unrelated process was changed.");
  return p.stdout.trim();
}
function inspect(saved = {}) {
  const ids = [
    process.pid,
    saved.supervisor?.pid,
    ...Object.values(saved.services ?? {}).map((v) => v.pid),
  ].filter(Number.isSafeInteger);
  const raw = powershell(
    `$wanted=@(${ids.join(",")});$tcp=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue|Where-Object {$_.LocalPort -in @(55432,8080,8790,8791)});$wanted+=@($tcp.OwningProcess);$procs=@(Get-CimInstance Win32_Process|Where-Object {$wanted -contains $_.ProcessId -or $_.CommandLine -like '*meridian-worker.mjs*'}|ForEach-Object {@{pid=[int]$_.ProcessId;parent=[int]$_.ParentProcessId;created=$_.CreationDate.ToUniversalTime().ToString('o');command=$_.CommandLine;exe=$_.ExecutablePath}});@{processes=$procs;listeners=@($tcp|ForEach-Object {@{pid=[int]$_.OwningProcess;port=[int]$_.LocalPort;address=$_.LocalAddress}})}|ConvertTo-Json -Depth 5 -Compress`,
  );
  return JSON.parse(raw);
}
export function identityMatches(record, info, marker, workspace = root) {
  return Boolean(
    record &&
    info &&
    typeof record.root === "string" &&
    record.pid === info.pid &&
    record.created === info.created &&
    record.commandHash === hash(info.command ?? "") &&
    normalized(record.root) === normalized(workspace) &&
    (info.command ?? "").toLowerCase().replaceAll("/", "\\").includes(normalized(marker)),
  );
}
/** Inspection commands can mention a script name without running that script. */
export function isWorkerProcess(info) {
  return Boolean(
    info?.exe &&
    path.win32.basename(info.exe).toLowerCase() === "node.exe" &&
    /(?:^|\s)(?:"[^"\r\n]*[\\/]meridian-worker\.mjs"|[^\s"\r\n]*[\\/]meridian-worker\.mjs)(?:\s|$)/i.test(
      info.command ?? "",
    ),
  );
}
const identity = (info) => {
  if (!info) throw Error("Cannot verify native process creation metadata.");
  return { pid: info.pid, created: info.created, commandHash: hash(info.command ?? ""), root };
};
export function pointsToCluster(command, expected = cluster) {
  const m = /(?:^|\s)-D\s+(?:"([^"]+)"|(\S+))/i.exec(command ?? "");
  return Boolean(
    m && normalized(path.resolve(path.dirname(expected), m[1] ?? m[2])) === normalized(expected),
  );
}
export function postgresRecordMatches(contents, info, expected = cluster) {
  const lines = String(contents).trim().split(/\r?\n/);
  return Boolean(
    info &&
    Number(lines[0]) === info.pid &&
    lines[1] &&
    normalized(lines[1]) === normalized(expected) &&
    Math.abs(Number(lines[2]) * 1000 - Date.parse(info.created)) < 5000 &&
    Number(lines[3]) === 55432,
  );
}
export function phantomNodeArguments(envFile, entry = path.join(phantom, "src/cli.ts")) {
  return [
    `--env-file=${envFile}`,
    "--import",
    pathToFileURL(path.join(phantom, "node_modules/tsx/dist/loader.mjs")).href,
    entry,
    "paper",
  ];
}
export function workerNodeArguments(
  envFile,
  entry = path.join(root, "scripts/meridian-worker.mjs"),
) {
  return [
    `--env-file=${envFile}`,
    "--experimental-strip-types",
    "--import",
    pathToFileURL(path.join(root, "scripts/desk-loader.mjs")).href,
    entry,
  ];
}
export function redactLog(text, secrets = []) {
  let result = String(text).replace(
    /\b(?:https?|postgres(?:ql)?):\/\/[^\s"'<>]+/gi,
    "[url redacted]",
  );
  for (const secret of secrets
    .filter((v) => typeof v === "string" && v.length >= 5)
    .sort((a, b) => b.length - a.length))
    result = result.replaceAll(secret, "[redacted]");
  return result.replace(
    /((?:private[_-]?key|api[_-]?key|password|secret|token)\s*["']?\s*[:=]\s*)["']?[^\s,"'}]+/gi,
    "$1[redacted]",
  );
}
export function nativeLogger(name, secrets, directory = native) {
  const file = path.join(directory, `${name}.log`),
    buffers = new Map(),
    discarding = new Set();
  const write = (text) => {
    const line = redactLog(text, secrets);
    if ((fs.existsSync(file) ? fs.statSync(file).size : 0) + Buffer.byteLength(line) > 1_048_576) {
      for (let n = 2; n >= 1; n--) {
        const target = `${file}.${n}`;
        if (fs.existsSync(target)) fs.unlinkSync(target);
        if (fs.existsSync(n === 1 ? file : `${file}.${n - 1}`))
          fs.renameSync(n === 1 ? file : `${file}.${n - 1}`, target);
      }
    }
    fs.appendFileSync(file, line);
  };
  return {
    write,
    attach(stream) {
      if (!stream) return;
      buffers.set(stream, "");
      stream.on("data", (chunk) => {
        let text = chunk.toString();
        if (discarding.has(stream)) {
          const end = text.indexOf("\n");
          if (end < 0) return;
          text = text.slice(end + 1);
          discarding.delete(stream);
        }
        let pending = buffers.get(stream) + text;
        const lines = pending.split("\n");
        pending = lines.pop();
        for (const line of lines)
          write(line.length > 65536 ? "[oversized log line suppressed]\n" : line + "\n");
        if (pending.length > 65536) {
          write("[oversized log line suppressed]\n");
          pending = "";
          discarding.add(stream);
        }
        buffers.set(stream, pending);
      });
      stream.on("end", () => {
        const tail = buffers.get(stream);
        if (tail && !discarding.has(stream)) write(tail + "\n");
        buffers.delete(stream);
        discarding.delete(stream);
      });
    },
  };
}
function configuration() {
  if (process.platform !== "win32" || Number(process.versions.node.split(".")[0]) < 24)
    throw Error("Native startup requires Windows and Node.js 24 or newer.");
  const envFile = path.join(root, ".env.native"),
    phantomEnvFile = path.join(phantom, ".env");
  if (!fs.existsSync(envFile) || !fs.existsSync(phantomEnvFile))
    throw Error(
      "Keep the existing private .env.native and packages/phantom/.env in place; see docs/WINDOWS-NATIVE.md.",
    );
  const env = parseEnv(fs.readFileSync(envFile, "utf8")),
    researchEnv = parseEnv(fs.readFileSync(phantomEnvFile, "utf8"));
  let database;
  try {
    database = new URL(env.DATABASE_URL);
  } catch {
    throw Error("The native DATABASE_URL is missing or invalid; its value was not logged.");
  }
  if (
    !["postgres:", "postgresql:"].includes(database.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(database.hostname) ||
    database.port !== "55432"
  )
    throw Error(
      "Native startup requires the existing isolated loopback PostgreSQL database on port 55432.",
    );
  for (const vars of [env, researchEnv])
    for (const key of ["MERIDIAN_EXECUTION_MODE", "EXECUTION_MODE", "PHANTOM_MODE"])
      if (vars[key] && vars[key] !== "PAPER")
        throw Error("Native startup refuses non-PAPER execution configuration.");
  const flags = readJson(path.join(root, ".grok/app-env.json"));
  const shared = {
    ...process.env,
    ...Object.fromEntries(
      Object.entries(flags).filter(([k, v]) => k.startsWith("VITE_") && typeof v === "string"),
    ),
    ...env,
    MERIDIAN_EXECUTION_MODE: "PAPER",
    EXECUTION_MODE: "PAPER",
    PORT: "0",
    HOST: "127.0.0.1",
  };
  const research = {
    ...shared,
    ...researchEnv,
    PHANTOM_MODE: "PAPER",
    PHANTOM_ENGINE_PORT: "8790",
    PHANTOM_ENGINE_URL: "http://127.0.0.1:8790",
  };
  const secrets = [
    ...Object.entries({ ...env, ...researchEnv })
      .filter(([k]) => /key|token|secret|password|credential|url/i.test(k))
      .map(([, v]) => v),
  ];
  const services = [
    {
      id: "postgres",
      port: 55432,
      marker: cluster,
      exe: pgExe,
      args: ["-D", cluster, "-h", "127.0.0.1", "-p", "55432"],
      cwd: pgRoot,
      env: process.env,
    },
    {
      id: "web",
      port: 8080,
      marker: path.join(root, "node_modules/vite/bin/vite.js"),
      args: [
        `--env-file=${envFile}`,
        path.join(root, "node_modules/vite/bin/vite.js"),
        "--host",
        "127.0.0.1",
        "--port",
        "8080",
        "--strictPort",
      ],
      cwd: root,
      env: { ...shared, MERIDIAN_WORKER: "0" },
    },
    {
      id: "worker",
      port: 0,
      marker: path.join(root, "scripts/meridian-worker.mjs"),
      args: workerNodeArguments(envFile),
      cwd: root,
      env: { ...shared, PORT: "0", MERIDIAN_WORKER: "1" },
    },
    {
      id: "phantom",
      port: 8790,
      marker: path.join(phantom, "src/cli.ts"),
      args: phantomNodeArguments(phantomEnvFile),
      cwd: phantom,
      env: research,
    },
    {
      id: "monitor",
      port: 8791,
      marker: path.join(phantom, "node_modules/next/dist/bin/next"),
      args: [
        path.join(phantom, "node_modules/next/dist/bin/next"),
        "dev",
        path.join(phantom, "dashboard"),
        "--hostname",
        "127.0.0.1",
        "--port",
        "8791",
      ],
      cwd: phantom,
      env: research,
    },
  ];
  for (const file of [
    pgExe,
    path.join(cluster, "PG_VERSION"),
    path.join(phantom, "node_modules/tsx/dist/loader.mjs"),
    ...services.filter((s) => !s.exe).map((s) => s.marker),
    path.join(root, "node_modules/pg/package.json"),
  ])
    if (!fs.existsSync(file))
      throw Error(
        "A required existing runtime, initialized cluster or dependency is missing; startup never installs or initializes it.",
      );
  return { env, research, services, secrets };
}
async function request(url, json = true) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return r.ok ? (json ? r.json() : r.text()) : null;
  } catch {
    return null;
  }
}
export function paperBooksReady(value, since = 0, now = Date.now()) {
  return Boolean(
    value?.mode === "PAPER" &&
    value.worker?.status === "live" &&
    Number(value.worker.lastTickAt) >= since &&
    now >= Number(value.worker.lastTickAt) &&
    now - Number(value.worker.lastTickAt) < 120_000 &&
    Array.isArray(value.books) &&
    value.books.length === 3 &&
    new Set(value.books.map((b) => b.id)).size === 3 &&
    value.books.every(
      (b) =>
        b.initialized === true &&
        b.ticks > 0 &&
        Number(b.updatedAt) >= since &&
        now >= Number(b.updatedAt) &&
        now - Number(b.updatedAt) < 120_000,
    ),
  );
}
async function snapshot(config) {
  const saved = readJson(stateFile),
    inventory = inspect(saved),
    processes = inventory.processes ?? [],
    listeners = inventory.listeners ?? [];
  let pgReady = false,
    postmaster = "";
  try {
    postmaster = fs.readFileSync(path.join(cluster, "postmaster.pid"), "utf8");
  } catch {}
  try {
    const { Client } = createRequire(import.meta.url)("pg");
    const client = new Client({
      connectionString: config.env.DATABASE_URL,
      connectionTimeoutMillis: 3000,
      query_timeout: 3000,
    });
    try {
      await client.connect();
      await client.query("select 1");
      pgReady = true;
    } finally {
      await client.end();
    }
  } catch {
    /* Never log connection values. */
  }
  const [home, live, current, monitor] = await Promise.all([
    request("http://127.0.0.1:8080/", false),
    request("http://127.0.0.1:8080/api/sniper?view=live"),
    request("http://127.0.0.1:8790/state"),
    request("http://127.0.0.1:8791/", false),
  ]);
  const { runtimeSourceVersion } = await import("../packages/phantom/src/runtime-version.ts");
  const result = {};
  for (const service of config.services) {
    const record = saved.services?.[service.id],
      process = processes.find((p) => p.pid === record?.pid);
    const portOwners = listeners.filter((p) => p.port === service.port),
      processAlive = identityMatches(record, process, service.marker);
    const owned =
      processAlive &&
      (!service.port ||
        (portOwners.length > 0 &&
          portOwners.every((p) => {
            const child = processes.find((x) => x.pid === p.pid);
            return (
              p.pid === record.pid ||
              (child?.parent === record.pid &&
                Date.parse(child.created) >= Date.parse(record.created) &&
                child.command?.toLowerCase().replaceAll("/", "\\").includes(normalized(root)))
            );
          })));
    const expectedPg =
      service.id === "postgres" &&
      portOwners.length &&
      portOwners.every((p) => {
        const info = processes.find((x) => x.pid === p.pid);
        return (
          ["127.0.0.1", "::1"].includes(p.address) &&
          info?.exe &&
          normalized(info.exe) === normalized(pgExe) &&
          pointsToCluster(info.command) &&
          postgresRecordMatches(postmaster, info)
        );
      });
    const since = owned ? Date.parse(process.created) : 0;
    const ready =
      service.id === "postgres"
        ? pgReady && Boolean(expectedPg || owned)
        : service.id === "web"
          ? typeof home === "string" && /Omni|omni/.test(home) && live?.mode === "PAPER"
          : service.id === "worker"
            ? paperBooksReady(live, since)
            : service.id === "phantom"
              ? current?.mode === "PAPER" &&
                current.sourceVersion === runtimeSourceVersion() &&
                !["STOPPED", "FAILED", "UNSUPPORTED"].includes(current.health?.status)
              : typeof monitor === "string" && /PHANTOM/.test(monitor);
    result[service.id] = {
      ready: Boolean(ready),
      owned: Boolean(owned),
      processAlive,
      pid: processAlive ? record.pid : null,
      occupied: portOwners.length > 0,
      loopbackOnly: portOwners.every((p) => ["127.0.0.1", "::1"].includes(p.address)),
      ...(service.id === "postgres" ? { dedicatedCluster: Boolean(expectedPg) } : {}),
      ...(service.id === "worker"
        ? {
            otherWorkerPresent: processes.some((p) => p.pid !== record?.pid && isWorkerProcess(p)),
          }
        : {}),
    };
  }
  return {
    mode: "PAPER",
    root,
    supervisor: identityMatches(
      saved.supervisor,
      processes.find((p) => p.pid === saved.supervisor?.pid),
      script,
    ),
    services: result,
    ready: Object.values(result).every((s) => s.ready && s.loopbackOnly),
    lastError: saved.lastError ?? null,
    urls: { omni: "http://127.0.0.1:8080", phantom: "http://127.0.0.1:8791" },
  };
}
async function supervise(config) {
  fs.mkdirSync(native, { recursive: true });
  const own = identity(inspect().processes.find((p) => p.pid === process.pid)),
    log = nativeLogger("supervisor", config.secrets);
  for (let attempt = 0; ; attempt++)
    try {
      fs.writeFileSync(lockFile, JSON.stringify(own), { flag: "wx" });
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const old = readJson(lockFile),
        info = inspect({ supervisor: old }).processes.find((p) => p.pid === old.pid);
      if (
        identityMatches(old, info, script) ||
        Date.now() - fs.statSync(lockFile).mtimeMs < 15_000 ||
        attempt >= 2
      )
        return;
      fs.unlinkSync(lockFile);
      await sleep(100);
    }
  const saved = readJson(stateFile);
  saved.supervisor = own;
  saved.services ??= {};
  saved.lastError = null;
  atomic(stateFile, saved);
  process.once("exit", () => {
    if (readJson(lockFile).pid === process.pid) {
      try {
        fs.unlinkSync(lockFile);
      } catch {}
    }
  });
  const retryAfter = new Map();
  for (;;) {
    try {
      const status = await snapshot(config);
      for (const service of config.services) {
        const s = status.services[service.id];
        if (s.processAlive || (service.id === "postgres" && s.ready && s.dedicatedCluster))
          continue;
        if (s.occupied || (service.id === "worker" && s.otherWorkerPresent))
          throw Error(
            `Handoff required: existing ${service.id} process is not owned by this launcher; it was left untouched.`,
          );
        if (Date.now() < (retryAfter.get(service.id) ?? 0)) continue;
        if (service.id !== "postgres" && !status.services.postgres.ready) break;
        const child = spawn(service.exe ?? process.execPath, service.args, {
          cwd: service.cwd,
          env: service.env,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const childLog = nativeLogger(service.id, config.secrets);
        childLog.attach(child.stdout);
        childLog.attach(child.stderr);
        child.on("error", () => log.write(`${service.id}: process launch failed\n`));
        child.on("exit", (code) => log.write(`${service.id}: exited ${code}\n`));
        await sleep(500);
        const info = inspect({ services: { child: { pid: child.pid } } }).processes.find(
          (p) => p.pid === child.pid,
        );
        if (
          info &&
          (info.command ?? "")
            .toLowerCase()
            .replaceAll("/", "\\")
            .includes(normalized(service.marker))
        )
          saved.services[service.id] = identity(info);
        retryAfter.set(service.id, Date.now() + 30_000);
        atomic(stateFile, saved);
        if (service.id === "postgres") break;
      }
      saved.lastError = null;
      saved.checkedAt = Date.now();
      atomic(stateFile, saved);
    } catch (e) {
      saved.lastError = redactLog(e.message, config.secrets);
      atomic(stateFile, saved);
      log.write(saved.lastError + "\n");
    }
    await sleep(10_000);
  }
}
async function start(config) {
  fs.mkdirSync(native, { recursive: true });
  let status = await snapshot(config);
  if (!status.supervisor) {
    const child = spawn(process.execPath, [script, "supervise"], {
      cwd: root,
      windowsHide: true,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }
  const deadline = Date.now() + 150_000;
  do {
    status = await snapshot(config);
    if (status.supervisor && status.lastError) throw Error(status.lastError);
    if (
      status.supervisor &&
      status.ready &&
      Object.entries(status.services).every(
        ([id, s]) => s.owned || (id === "postgres" && s.dedicatedCluster),
      )
    )
      return status;
    await sleep(1000);
  } while (Date.now() < deadline);
  throw Error(
    "Native startup is still waiting for authenticated database, matching source and fresh three-book worker readiness; inspect status and redacted data/native logs.",
  );
}
function shortcutPaths() {
  const name = `Omni-Native-${hash(normalized(root)).slice(0, 10)}`,
    startup = path.join(process.env.APPDATA ?? "", "Microsoft/Windows/Start Menu/Programs/Startup");
  if (!process.env.APPDATA || !fs.existsSync(startup))
    throw Error("Current-user Startup folder unavailable.");
  return {
    link: path.join(startup, `${name}.lnk`),
    vbs: path.join(native, "autostart.vbs"),
    description: name,
    wscript: path.join(process.env.SystemRoot ?? "C:/Windows", "System32/wscript.exe"),
  };
}
function autostart(enable) {
  const s = shortcutPaths();
  fs.mkdirSync(native, { recursive: true });
  const args = `"${s.vbs}"`;
  const check = `$shell=New-Object -ComObject WScript.Shell;$path=${psQuote(s.link)};$nativeShortcutArgs=${psQuote(args)};$description=${psQuote(s.description)};if(Test-Path -LiteralPath $path){$old=$shell.CreateShortcut($path);if($old.TargetPath -ne ${psQuote(s.wscript)} -or $old.Arguments -ne $nativeShortcutArgs -or $old.Description -ne $description){throw 'Unowned shortcut; unchanged'}};`;
  if (!enable) {
    powershell(check + `if(Test-Path -LiteralPath $path){Remove-Item -LiteralPath $path}`);
    return { autostart: false, servicesContinueRunning: true };
  }
  powershell(check);
  const command = `"${process.execPath}" "${script}" start`.replaceAll('"', '""');
  fs.writeFileSync(
    s.vbs,
    `Set shell = CreateObject("WScript.Shell")\r\nshell.Run "${command}", 0, False\r\n`,
  );
  powershell(
    check +
      `$link=$shell.CreateShortcut($path);$link.TargetPath=${psQuote(s.wscript)};$link.Arguments=$nativeShortcutArgs;$link.WorkingDirectory=${psQuote(root)};$link.Description=$description;$link.WindowStyle=7;$link.Save()`,
  );
  return { autostart: true, currentUserOnly: true, shortcut: s.link };
}
export async function main(action = "start") {
  if (!["start", "status", "supervise", "autostart-enable", "autostart-disable"].includes(action))
    throw Error("Use start, status, autostart-enable or autostart-disable.");
  if (action === "autostart-disable") {
    if (process.platform !== "win32") throw Error("Windows is required.");
    return autostart(false);
  }
  const config = configuration();
  if (action === "supervise") return supervise(config);
  if (action === "status") return snapshot(config);
  const status = await start(config);
  return action === "autostart-enable" ? { ...autostart(true), ready: status.ready } : status;
}
if (process.argv[1] && normalized(process.argv[1]) === normalized(script))
  main(process.argv[2])
    .then((value) => {
      if (value) console.log(JSON.stringify(value, null, 2));
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });

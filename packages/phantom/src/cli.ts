import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Engine } from "./engine.ts";
import { Store } from "./store.ts";
import { json } from "./types.ts";
import { replay, walkForward } from "./replay.ts";
import { createReplayStrategy, researchReplayConfiguration } from "./replay-strategy.ts";

const [command = "paper", ...args] = process.argv.slice(2);
try {
  if (command === "paper") {
    const engine = await new Engine().start();
    console.log(
      json({
        mode: "PAPER",
        engine: `http://127.0.0.1:${process.env.PHANTOM_ENGINE_PORT ?? 8790}/state`,
        dashboard: "http://127.0.0.1:8791",
        source: engine.health.source,
      }),
    );
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      await engine.stop();
      process.exit(0);
    };
    process.on("SIGINT", () => void close());
    process.on("SIGTERM", () => void close());
    const duration = args.find((a) => a.startsWith("--duration-ms="));
    if (duration) setTimeout(() => void close(), Number(duration.split("=")[1]));
  } else if (command === "kill") {
    const target = resolve(process.env.PHANTOM_KILL_FILE ?? "./data/KILL");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      "Entry shutdown requested locally. Remove this file only after reviewing system state.\n",
    );
    console.log(
      "Entry kill switch set. Pending entries will be vetoed; quote-based protective exits remain enabled.",
    );
  } else if (command === "migrate") {
    const store = await new Store().open(
      process.env.PHANTOM_DATABASE_URL,
      process.env.PHANTOM_DATA_DIR ?? "./data/warehouse",
    );
    await store.close();
    console.log("PHANTOM migrations applied");
  } else if (command === "export") {
    const store = await new Store().open(
      process.env.PHANTOM_DATABASE_URL,
      process.env.PHANTOM_DATA_DIR ?? "./data/warehouse",
    );
    const rows = await store.query(
      "SELECT payload FROM phantom_transactions ORDER BY slot,signature",
    );
    writeFileSync(
      args[0] ?? "data/transactions.json",
      json({ provenance: "recorded-chain", transactions: rows.map((x) => x.payload) }),
    );
    await store.close();
    console.log(`Exported ${rows.length} recorded transactions`);
  } else if (command === "replay-config") {
    writeFileSync(
      args[0] ?? "data/replay-config.json",
      json(researchReplayConfiguration("launch_sniper", Date.now())),
    );
    console.log("Research-only frozen replay configuration saved");
  } else if (command === "export-replay") {
    const port = Number(process.env.PHANTOM_ENGINE_PORT ?? 8790);
    const response = await fetch(`http://127.0.0.1:${port}/replay`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw Error("START_WORKER_BEFORE_REPLAY_EXPORT");
    const value = await response.json();
    writeFileSync(args[0] ?? "data/replay-input.json", json(value));
    console.log(
      `Exported ${value.observations.length} recorded quote/feature observations; missing observations are not synthesized`,
    );
  } else if (command === "walk-forward") {
    if (!args[0]) throw Error("Usage: walk-forward input.json output.json");
    const input = JSON.parse(readFileSync(args[0], "utf8"));
    const strategy = createReplayStrategy(input.configuration);
    const report = walkForward(input.observations, input.windows, input.embargoMs, () => strategy, {
      ...input.options,
      fillGuard: strategy.fillGuard,
    });
    writeFileSync(args[1] ?? "data/walk-forward-report.json", json(report));
    console.log(
      "Token-disjoint chronological walk-forward report saved; fixed research configuration, no future optimization",
    );
  } else if (command === "replay") {
    if (!args[0]) throw Error("Usage: replay input.json output.json");
    const input = JSON.parse(readFileSync(args[0], "utf8"));
    const evaluator = createReplayStrategy(input.configuration);
    const report = replay(input.observations, evaluator, {
      ...input.options,
      fillGuard: evaluator.fillGuard,
    });
    writeFileSync(
      args[1] ?? "data/replay-report.json",
      json({ ...report, configurationHash: evaluator.configurationHash }),
    );
    console.log("Replay report saved; research results are not live-trading approval");
  } else throw Error("Commands: paper, migrate, export, replay");
} catch (error) {
  console.error(error instanceof Error ? error.message : "PHANTOM_STARTUP_FAILED");
  process.exitCode = 1;
}

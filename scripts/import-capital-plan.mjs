#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
const path = resolve(process.argv[2] ?? "capital-plan.json");
const policy = JSON.parse(await readFile(path, "utf8"));
if (policy.mode !== "PAPER") throw Error("Only paper payout preferences can be imported");
const base = new URL(process.env.MERIDIAN_LOCAL_URL ?? "http://127.0.0.1:8080");
if (!["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
  throw Error("Configuration import requires a local server");
const endpoint = new URL("/api/capital", base);
const current = await fetch(endpoint, { signal: AbortSignal.timeout(15000) });
if (!current.ok) throw Error(`Capital settings unavailable: ${current.status}`);
const report = await current.json();
if (report.configured) {
  if (
    report.policy.recipient !== policy.recipient ||
    report.policy.profitMint !== policy.profitMint
  )
    throw Error("Existing destinations differ. Review them before replacing payout preferences.");
  console.log("Payout destinations already configured; existing settings preserved.");
} else {
  const r = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "configure", policy }),
    signal: AbortSignal.timeout(15000),
  });
  const result = await r.json();
  if (!r.ok) throw Error(result.error ?? `Import failed ${r.status}`);
  console.log(
    "Paper-only payout preferences saved. Deposit, signing, conversion and transfers remain locked.",
  );
}

#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const output = resolve(process.argv[2] ?? "artifacts/paper-sniper");
const url = new URL(process.env.MERIDIAN_LOCAL_URL ?? "http://127.0.0.1:8080");
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  throw Error("Report exporter requires a local server.");
const response = await fetch(new URL("/api/sniper", url), { signal: AbortSignal.timeout(15000) });
if (!response.ok) throw Error(`Sniper report failed: ${response.status}`);
const report = await response.json();
await mkdir(output, { recursive: true });
for (const view of ["experiments", "coverage"]) {
  const r = await fetch(new URL(`/api/sniper?view=${view}`, url), {
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw Error(`${view} export failed: ${r.status}`);
  await writeFile(resolve(output, `${view}.json`), JSON.stringify(await r.json(), null, 2));
}
await writeFile(resolve(output, "session.json"), JSON.stringify(report, null, 2));
const state = report.state,
  m = report.metrics;
const closed = state.trades.filter((t) => t.status === "closed");
const costs = [0, 0.5, 1, 2].map((extra) => ({
  extraPerRoundTripUsd: extra,
  closedTrades: closed.length,
  netClosedUsd: closed.reduce((sum, t) => sum + t.pnlUsd - extra, 0),
}));
const rejectCounts = {};
for (const c of state.candidates)
  for (const reason of c.reasons) rejectCounts[reason] = (rejectCounts[reason] ?? 0) + 1;
const review = {
  exportedAt: new Date().toISOString(),
  execution: "PAPER_ONLY",
  evidence: "UNPROVEN",
  metrics: m,
  extraCostSensitivity: costs,
  latestRejections: rejectCounts,
  limitations: [
    "Extra costs are arithmetic sensitivity on the same simulated closed trades, not a re-execution of a strategy.",
    "No future-data replay, live-fill evidence, inclusion probability, or untouched forward validation is established.",
    "Missing/stale exit marks are zero valued in equity; unresolved positions are not manufactured closes.",
    "An observed minimum execution delay can be longer in practice due to collector cadence and provider delays.",
  ],
};
await writeFile(resolve(output, "review.json"), JSON.stringify(review, null, 2));
console.log(
  JSON.stringify(
    {
      output,
      closed: m.closed,
      netUsd: m.netUsd,
      evidence: review.evidence,
      rejectedCandidates: state.candidates.filter((c) => c.reasons.length).length,
    },
    null,
    2,
  ),
);

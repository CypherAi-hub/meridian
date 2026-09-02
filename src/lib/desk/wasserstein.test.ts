import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeWasserstein, permutationP, wasserstein1, wasserstein2 } from "./wasserstein.ts";
import type { LedgerRow } from "./types.ts";

test("identical samples have W1 = 0", () => {
  const xs = [0.1, 0.2, 0.3, 0.4];
  assert.ok(Math.abs((wasserstein1(xs, xs) ?? 1) - 0) < 1e-12);
  assert.ok(Math.abs((wasserstein2(xs, xs) ?? 1) - 0) < 1e-12);
});

test("a constant shift of 1 has W1 = 1", () => {
  const a = [0, 1, 2, 3, 4];
  const b = a.map((x) => x + 1);
  const w = wasserstein1(a, b);
  assert.ok(w != null && Math.abs(w - 1) < 1e-9);
});

test("empty sample is null, not zero", () => {
  assert.equal(wasserstein1([], [1, 2]), null);
  assert.equal(wasserstein1([1], []), null);
});

test("separated samples have a small permutation p-value", () => {
  const a = Array.from({ length: 40 }, () => 0);
  const b = Array.from({ length: 40 }, () => 1);
  const w = wasserstein1(a, b) ?? 0;
  const p = permutationP(a, b, w, 199, 1);
  assert.ok(w > 0.9);
  assert.ok(p != null && p < 0.02);
});

test("clipped W1 is not dominated by a single moonshot", () => {
  const a = [0, 0.01, -0.01, 0.02];
  const b = [0, 0.01, -0.01, 50];
  const raw = wasserstein1(a, b) ?? 0;
  const body =
    wasserstein1(
      a.map((x) => Math.max(-1, Math.min(2, x))),
      b.map((x) => Math.max(-1, Math.min(2, x))),
    ) ?? 0;
  assert.ok(raw > 5);
  assert.ok(body < 1);
});

test("wasserstein report is honest when distributions match", () => {
  const mk = (token: string, edge: number, r15: number, t: number): LedgerRow =>
    ({
      tokenAddress: token,
      edge_score: edge,
      labels_complete: true,
      price: 1,
      price_after_15m: 1 + r15,
      theoretical_return: r15,
      execution_adjusted_return: r15 - 0.01,
      decision_time: t,
      bucket: "early",
      regime: "chop",
    }) as LedgerRow;
  const rows: LedgerRow[] = [];
  for (let i = 0; i < 20; i++) rows.push(mk(`low${i}`, 30, 0.0, 1_000 + i));
  for (let i = 0; i < 20; i++) rows.push(mk(`mid${i}`, 50, 0.0, 2_000 + i));
  const report = analyzeWasserstein(rows);
  assert.ok(report.tokenLowVsMid.w1 != null);
  assert.ok((report.tokenLowVsMid.w1 as number) < 1e-9);
  assert.ok((report.executionGapMeanAbs ?? 0) > 0);
});

test("token-level W1 does not treat repeated considerations as extra names", () => {
  const mk = (token: string, edge: number, r15: number): LedgerRow =>
    ({
      tokenAddress: token,
      edge_score: edge,
      labels_complete: true,
      price: 1,
      price_after_15m: 1 + r15,
      decision_time: 1,
      bucket: "early",
      regime: "chop",
    }) as LedgerRow;
  const rows: LedgerRow[] = [];
  for (let i = 0; i < 30; i++) rows.push(mk("ONLYLOW", 25, -0.1));
  for (let i = 0; i < 30; i++) rows.push(mk("ONLYMID", 55, 0.1));
  const report = analyzeWasserstein(rows);
  assert.equal(report.tokenLowVsMid.tokensA, 1);
  assert.equal(report.tokenLowVsMid.tokensB, 1);
  assert.equal(report.edgeLowVsMid.nA, 30);
});

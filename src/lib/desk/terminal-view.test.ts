import test from "node:test";
import assert from "node:assert/strict";
import {
  freshManualMark,
  manualValuation,
  recentTimestamp,
  toggleWatchlist,
  watchlistForView,
} from "./terminal-view.ts";
import { WSOL } from "./schema.ts";
const now = 1800000000000;
const position = {
  mint: WSOL,
  symbol: "SOL",
  decimals: 9,
  rawQty: "1000000000",
  costAtomic: "25000000",
  openedAt: now - 60000,
  markAtomic: "20000000",
  markedAt: now - 1000,
};
test("a read-only watchlist can remove stored tokens and preserve an empty local list", () => {
  const saved = [WSOL, "OTHER"];
  const local = toggleWatchlist(watchlistForView(saved, null, true), WSOL);
  assert.deepEqual(watchlistForView(saved, local, true), ["OTHER"]);
  assert.deepEqual(watchlistForView(saved, toggleWatchlist(local, "OTHER"), true), []);
  assert.deepEqual(saved, [WSOL, "OTHER"]);
});
test("writable mode uses server watchlist and local changes remain reversible", () => {
  assert.deepEqual(watchlistForView([WSOL], [], false), [WSOL]);
  assert.deepEqual(toggleWatchlist(toggleWatchlist([WSOL], "OTHER"), "OTHER"), [WSOL]);
  assert.deepEqual(watchlistForView(undefined, null, true), [WSOL]);
});
test("freshness rejects missing, future, expired and malformed clocks", () => {
  assert.equal(recentTimestamp(now - 45000, now, 45000), true);
  for (const at of [null, undefined, now + 1, now - 45001, NaN, Infinity, 1.5])
    assert.equal(recentTimestamp(at, now, 45000), false);
});
test("manual liquidation equity requires every position to have a fresh valid mark", () => {
  assert.deepEqual(manualValuation({ cashAtomic: "1000000000", positions: [position] }, now), {
    equityUsdc: 1020,
    unvaluedPositions: 0,
  });
  for (const change of [
    { markedAt: undefined },
    { markedAt: now - 45001 },
    { markedAt: now + 1 },
    { markAtomic: undefined },
    { markAtomic: "bad" },
    { markAtomic: "1e6" },
  ]) {
    assert.equal(freshManualMark({ ...position, ...change }, now), null);
    assert.deepEqual(
      manualValuation(
        { cashAtomic: "1000000000", positions: [position, { ...position, ...change }] },
        now,
      ),
      { equityUsdc: null, unvaluedPositions: 1 },
    );
  }
});
test("flat cash and a genuine zero mark remain known; input evidence is preserved", () => {
  const book = { cashAtomic: "1000000000", positions: [{ ...position, markAtomic: "0" }] };
  const before = structuredClone(book);
  assert.deepEqual(manualValuation(book, now), { equityUsdc: 1000, unvaluedPositions: 0 });
  assert.deepEqual(manualValuation({ ...book, positions: [] }, now), {
    equityUsdc: 1000,
    unvaluedPositions: 0,
  });
  assert.deepEqual(book, before);
});

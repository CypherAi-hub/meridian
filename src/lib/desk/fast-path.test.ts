import assert from "node:assert/strict";
import { test } from "node:test";
import { fastPathTargets } from "./fast-path.ts";
import { blankSnapshot } from "./providers/normalize.ts";

test("open-label targets survive falling off the universe and preserve requested priority", () => {
  const targets = fastPathTargets([blankSnapshot("present", 1, 1)], ["missing", "present", "missing"], 2);
  assert.deepEqual(targets.map(t => t.address), ["missing", "present"]);
  assert.equal(targets[0].priceUsd.value, null);
  assert.equal(targets[1].priceUsd.ingestedAt, 1);
});

test("fast targets honor the provider's thirty-mint limit", () => {
  assert.equal(fastPathTargets([], Array.from({length: 40}, (_, i) => `mint${i}`), 1).length, 30);
});

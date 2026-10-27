import assert from "node:assert/strict";
import { test } from "node:test";
import { fastPathTargets } from "./fast-path.ts";
import { blankSnapshot, mergeSnap, field } from "./providers/normalize.ts";

test("open-label targets survive falling off the universe and preserve requested priority", () => {
  const targets = fastPathTargets([blankSnapshot("present", 1, 1)], ["missing", "present", "missing"], 2);
  assert.deepEqual(targets.map(t => t.address), ["missing", "present"]);
  assert.equal(targets[0].priceUsd.value, null);
  assert.equal(targets[1].priceUsd.ingestedAt, 1);
});

test("fast targets honor the provider's thirty-mint limit", () => {
  assert.equal(fastPathTargets([], Array.from({length: 40}, (_, i) => `mint${i}`), 1).length, 30);
});


test("price refresh retains verified mint metadata without changing security timestamps",()=>{
  const prior=blankSnapshot("mint",1000,1000);
  prior.mintSafety={program:"legacy",supported:true,initialized:true};
  prior.mintAuth=field(false,1000,1000,"solana");
  const fresh=blankSnapshot("mint",2000,2000);fresh.priceUsd=field(2,2000,2000,"dexscreener");
  const merged=mergeSnap(fresh,prior);
  assert.equal(merged.mintSafety?.supported,true);assert.equal(merged.mintAuth.eventTime,1000);
  assert.equal(merged.priceUsd.eventTime,2000);
});

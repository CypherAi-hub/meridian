import test from "node:test";
import assert from "node:assert/strict";
import { poolTransactions } from "./pool-activity.ts";
const a =
  "5UNFty1RsCGFzEp9CRnmmH3cBaJAqELNjAFKUQWvpYUCDmkf73yHKXjUXdHJ25qxLe9RP3KkdjekFujmNpPALgTW";
const b =
  "5iRQrSm8i8bTSXszqNY8pJMKzfXa417S9ARqju7duks4ULMNMtt47XX4Jf9pSM3ntpajE1KkGadvRTLRvPGDrSb5";
test("raw pool feed preserves failed transactions, unknown times, and confirmation without inferring swaps", () => {
  const rows = poolTransactions([
    { signature: a, slot: 10, blockTime: null, err: null, confirmationStatus: "finalized" },
    {
      signature: b,
      slot: 11,
      blockTime: 1793039856,
      err: { InstructionError: [4, { Custom: 6001 }] },
      confirmationStatus: "confirmed",
    },
  ]);
  assert.equal(rows[0].status, "failed");
  assert.match(rows[0].error!, /6001/);
  assert.equal(rows[1].status, "succeeded");
  assert.equal(rows[1].blockTime, null);
  assert.equal("side" in rows[0], false);
  assert.equal("amount" in rows[0], false);
});
test("pool feed rejects malformed signatures and slots; missing error status stays unknown", () => {
  const rows = poolTransactions([
    { signature: a, slot: 10 },
    { signature: a, slot: 10 },
    { signature: a + "?redirect=evil", slot: 10 },
    { signature: b, slot: -1 },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "unknown");
});

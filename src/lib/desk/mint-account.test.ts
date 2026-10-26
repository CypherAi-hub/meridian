import test from "node:test";
import assert from "node:assert/strict";
import { parseMintAccount, LEGACY_TOKEN_PROGRAM } from "./providers/solana.ts";
function mint(initialized = 1, length = 82) {
  const bytes = new Uint8Array(length);
  bytes[44] = 6;
  bytes[45] = initialized;
  return Buffer.from(bytes).toString("base64");
}
test("mint permissions require the canonical token program, initialized mint and exact legacy layout", () => {
  const parsed = parseMintAccount(mint(), LEGACY_TOKEN_PROGRAM);
  assert.equal(parsed?.decimals, 6);
  assert.equal(parsed?.mintAuth, false);
  assert.equal(parsed?.freezeAuth, false);
  assert.equal(parseMintAccount(mint(), "untrusted-owner"), null);
  assert.equal(parseMintAccount(mint(0), LEGACY_TOKEN_PROGRAM), null);
  assert.equal(parseMintAccount(mint(1, 166), LEGACY_TOKEN_PROGRAM), null);
});

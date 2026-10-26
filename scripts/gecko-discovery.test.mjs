import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("a one-token provider budget retains new pools when the trending fetch cannot run", () => {
  const code = `
 import assert from 'node:assert/strict';
 const calls=[];
 globalThis.fetch=async (url)=>{calls.push(String(url));return new Response(JSON.stringify({data:[{
 id:'pool',attributes:{address:'pair',name:'NEW / SOL',base_token_price_usd:'0.01',reserve_in_usd:'50000',fdv_usd:'100000',market_cap_usd:'100000',pool_created_at:new Date(Date.now()-60000).toISOString()},
 relationships:{base_token:{data:{id:'solana_new-mint'}},quote_token:{data:{id:'solana_So11111111111111111111111111111111111111112'}}}
 }]}),{status:200});};
 const {fetchGeckoPools}=await import('./src/lib/desk/providers/gecko.ts');
 const result=await fetchGeckoPools();
 assert.equal(calls.length,1);assert.ok(calls[0].includes('/new_pools'));
 assert.equal(result.tokens.length,1);assert.equal(result.tokens[0].address,'new-mint');
 assert.match(result.error,/partial/);
 `;
  const child = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--import",
      "./scripts/desk-loader.mjs",
      "--input-type=module",
      "-e",
      code,
    ],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stdout + child.stderr);
});

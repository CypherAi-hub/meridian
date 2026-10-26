import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const invalidBodies = [
  ["missing input amount", { inAmount: undefined }],
  ["different input amount", { inAmount: "1" }],
  ["numeric input amount", { inAmount: 25000000 }],
  ["zero output", { outAmount: "0" }],
  ["negative output", { outAmount: "-1" }],
  ["fractional output", { outAmount: "1.5" }],
  ["exponent output", { outAmount: "1e6" }],
  ["numeric output", { outAmount: 1000000 }],
  ["output beyond u64", { outAmount: "18446744073709551616" }],
  ["provider error with output", { error: "synthetic failure" }],
  ["provider error code with output", { errorCode: 1, errorMessage: "synthetic failure" }],
];
for (const [name, change] of invalidBodies) {
  test(`paper quote rejects ${name} instead of treating it as executable evidence`, () => {
    const body = {
      inputMint: "USDC",
      outputMint: "TOKEN",
      inAmount: "25000000",
      outAmount: "1000000",
      ...change,
    };
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--import",
        "./scripts/desk-loader.mjs",
        "--input-type=module",
        "-e",
        `
      import assert from 'node:assert/strict';
      globalThis.fetch=async()=>Response.json(${JSON.stringify(body)});
      const {quotePaperSwap}=await import('./src/lib/desk/providers/jupiter.ts');
      const q=await quotePaperSwap({inputMint:'USDC',outputMint:'TOKEN',amount:'25000000',inDecimals:6,outDecimals:6,notionalUsd:25});
      assert.equal(q.available,false); assert.notEqual(q.routeState,'QUOTE_ONLY');
    `,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}

test("invalid requested raw size is rejected before a quote request is sent", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--import",
      "./scripts/desk-loader.mjs",
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    let calls=0; globalThis.fetch=async()=>{calls++;throw Error('must not call');};
    const {quotePaperSwap}=await import('./src/lib/desk/providers/jupiter.ts');
    for (const amount of ['0','-1','1.5','1e6','18446744073709551616']) {
      const q=await quotePaperSwap({inputMint:'USDC',outputMint:'TOKEN',amount,inDecimals:6,outDecimals:6,notionalUsd:25});
      assert.equal(q.available,false);
    }
    assert.equal(calls,0);
  `,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("partial paper exit audit uses its actual USDC output and price", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--import",
      "./scripts/desk-loader.mjs",
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    const {USDC,WSOL}=await import('./src/lib/desk/schema.ts');
    globalThis.fetch=async(url,opts)=>{
      assert.equal(opts.method??'GET','GET');
      const u=new URL(url); assert.equal(u.pathname,'/swap/v1/quote');
      return Response.json({inputMint:WSOL,outputMint:USDC,inAmount:'125000000',outAmount:'12500000'});
    };
    const {quotePaperSwap}=await import('./src/lib/desk/providers/jupiter.ts');
    const q=await quotePaperSwap({inputMint:WSOL,outputMint:USDC,amount:'125000000',inDecimals:9,outDecimals:6,notionalUsd:25});
    assert.equal(q.available,true); assert.equal(q.notionalUsd,12.5); assert.equal(q.impliedPriceUsd,100);
  `,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
for (const mismatch of [false, true])
  test(`paper quote adapter ${mismatch ? "rejects mismatched token identity" : "only requests exact-size read-only quotes"}`, () => {
    const code = `
 import assert from 'node:assert/strict';
 let calls=0;globalThis.fetch=async(url,opts)=>{
 calls++;assert.equal(opts.method??'GET','GET');const u=new URL(url);
 assert.equal(u.origin,'https://api.jup.ag');assert.equal(u.pathname,'/swap/v1/quote');assert.equal(u.searchParams.get('amount'),'25000000');
 return new Response(JSON.stringify({inputMint:'USDC',outputMint:${mismatch ? "'WRONG'" : "'TOKEN'"},inAmount:'25000000',outAmount:'1000000',routePlan:[{swapInfo:{label:'test'}}]}),{status:200});
 };
 const {quotePaperSwap}=await import('./src/lib/desk/providers/jupiter.ts');
 const q=await quotePaperSwap({inputMint:'USDC',outputMint:'TOKEN',amount:'25000000',inDecimals:6,outDecimals:6,notionalUsd:25});
 assert.equal(calls,1);assert.equal(q.available,${!mismatch});
 ${mismatch ? "assert.match(q.error,/identity mismatch/);" : "assert.equal(q.inAmount,'25000000');assert.equal(q.outAmount,'1000000');assert.equal(q.routeState,'QUOTE_ONLY');"}
 `;
    const result = spawnSync(
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
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });

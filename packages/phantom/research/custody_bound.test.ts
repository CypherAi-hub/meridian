/** Synthetic arithmetic and independent Python comparison; no chain/provider calls. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  CUSTODY_ARITHMETIC_KIND,
  CUSTODY_AMOUNT_FIELDS,
  evaluateCustodyArithmetic,
  type CustodyAmounts,
} from "../src/custody-bound.ts";

function fixture(patch: Partial<CustodyAmounts> = {}) {
  return {
    kind: CUSTODY_ARITHMETIC_KIND,
    amounts: {
      baseSupplyRaw: "1000000",
      baseVaultRaw: "950000",
      baseProtocolFeesRaw: "0",
      baseFundFeesRaw: "0",
      baseCreatorFeesRaw: "0",
      quoteVaultRaw: "20000000000",
      quoteProtocolFeesRaw: "0",
      quoteFundFeesRaw: "0",
      quoteCreatorFeesRaw: "0",
      internalLpSupplyRaw: "1000000",
      actualLpSupplyRaw: "50000",
      ...patch,
    },
  };
}
test("sharp fee boundary preserves the exact 10 percent limit", () => {
  const pass = evaluateCustodyArithmetic(fixture({ baseCreatorFeesRaw: "2632" }));
  assert.equal(pass.amounts.excludedPrincipalLowerRaw, "900000");
  assert.equal(pass.arithmeticCandidate, true);
  const fail = evaluateCustodyArithmetic(fixture({ baseCreatorFeesRaw: "2633" }));
  assert.equal(fail.amounts.excludedPrincipalLowerRaw, "899999");
  assert.equal(fail.amounts.creatorSupplyUpperBps, "1001");
  assert.equal(fail.creatorCapSatisfied, false);
});
test("fractional basis points cannot be floored into a passing result", () => {
  const r = evaluateCustodyArithmetic(
    fixture({ baseSupplyRaw: "101", baseVaultRaw: "90", actualLpSupplyRaw: "0" }),
  );
  assert.equal(r.creatorCapSatisfied, false);
  assert.equal(r.amounts.creatorSupplyUpperBps, "1090");
});
test("all three fee buckets count against creator and quote liquidity", () => {
  const r = evaluateCustodyArithmetic(
    fixture({
      baseProtocolFeesRaw: "1000",
      baseFundFeesRaw: "1000",
      baseCreatorFeesRaw: "633",
      quoteVaultRaw: "20000000006",
      quoteProtocolFeesRaw: "1",
      quoteFundFeesRaw: "2",
      quoteCreatorFeesRaw: "3",
    }),
  );
  assert.equal(r.creatorCapSatisfied, false);
  assert.equal(r.liquidityFloorSatisfied, true);
  assert.equal(
    evaluateCustodyArithmetic(fixture({ quoteVaultRaw: "19999999999" })).liquidityFloorSatisfied,
    false,
  );
});
test("minimum unminted LP is counted once; transfers and locks do not burn supply", () => {
  const r = evaluateCustodyArithmetic(
    fixture({
      baseSupplyRaw: "1000",
      baseVaultRaw: "1000",
      internalLpSupplyRaw: "1000",
      actualLpSupplyRaw: "900",
    }),
  );
  assert.equal(r.amounts.unmintedOrBurnedLpRaw, "100");
  assert.equal(r.amounts.excludedPrincipalLowerRaw, "100");
  assert.equal(r.creatorCapSatisfied, false);
  assert.equal(
    evaluateCustodyArithmetic(fixture({ actualLpSupplyRaw: "1000000" })).amounts
      .excludedPrincipalLowerRaw,
    "0",
  );
  assert.equal(
    evaluateCustodyArithmetic(fixture({ actualLpSupplyRaw: "0" })).amounts
      .excludedPrincipalLowerRaw,
    "950000",
  );
});
test("maximum u64 multiplication is exact beyond Number precision", () => {
  const n = ((1n << 64n) - 1n).toString();
  const r = evaluateCustodyArithmetic(
    fixture({
      baseSupplyRaw: n,
      baseVaultRaw: n,
      internalLpSupplyRaw: n,
      actualLpSupplyRaw: (BigInt(n) - 1n).toString(),
    }),
  );
  assert.equal(r.amounts.excludedPrincipalLowerRaw, "1");
  assert.equal(r.amounts.creatorSupplyUpperRaw, (BigInt(n) - 1n).toString());
  assert.equal(r.amounts.creatorSupplyUpperBps, "10000");
});
test("malformed values and unsupported input fields fail closed", () => {
  for (const value of [
    0,
    1,
    null,
    true,
    "01",
    "-1",
    "+1",
    "1.0",
    " 1",
    "1e3",
    "18446744073709551616",
    "9".repeat(10000),
  ])
    assert.throws(() => evaluateCustodyArithmetic(fixture({ baseSupplyRaw: value as string })));
  assert.throws(() => evaluateCustodyArithmetic({ ...fixture(), proofVerified: true }));
  for (const field of CUSTODY_AMOUNT_FIELDS) {
    const v = fixture() as { kind: string; amounts: Record<string, string> };
    delete v.amounts[field];
    assert.throws(() => evaluateCustodyArithmetic(v));
  }
  assert.throws(() => evaluateCustodyArithmetic({ kind: "OTHER", amounts: fixture().amounts }));
});
test("inconsistent supply, fees, and denominators are not clamped", () => {
  for (const patch of [
    { baseSupplyRaw: "0" },
    { internalLpSupplyRaw: "0" },
    { baseVaultRaw: "1000001" },
    { actualLpSupplyRaw: "1000001" },
    { baseCreatorFeesRaw: "950001" },
    { quoteProtocolFeesRaw: "20000000001" },
    { baseProtocolFeesRaw: "18446744073709551615", baseCreatorFeesRaw: "1" },
  ])
    assert.throws(() => evaluateCustodyArithmetic(fixture(patch)));
});
test("reachable synthetic initialization and external LP burn meet unchanged limits", () => {
  const D = 4_358_898_943_540n,
    initiallyMinted = D - 100n,
    burn = 4_140_953_996_263n;
  const r = evaluateCustodyArithmetic(
    fixture({
      baseSupplyRaw: "1000000000000000",
      baseVaultRaw: "950000000000000",
      internalLpSupplyRaw: D.toString(),
      actualLpSupplyRaw: (initiallyMinted - burn).toString(),
    }),
  );
  assert.equal(r.amounts.excludedPrincipalLowerRaw, "902500000000000");
  assert.equal(r.amounts.creatorSupplyUpperBps, "975");
  assert.equal(r.arithmeticCandidate, true);
  assert.equal(r.kind, "CONDITIONAL_ARITHMETIC_NOT_A_CUSTODY_CERTIFICATE");
  assert.equal(r.liveApproved, false);
});
test("independent Python evaluator matches 1536 deterministic integer fixtures", () => {
  const inputs = [];
  let seed = 17n;
  const word = () => (seed = (seed * 48271n) % 2147483647n);
  const next = (max: bigint) => ((word() << 62n) | (word() << 31n) | word()) % max;
  for (let i = 0; i < 1536; i++) {
    const S = 1n + next((1n << 64n) - 1n),
      B = next(S + 1n),
      D = 1n + next((1n << 64n) - 1n),
      M = next(D + 1n);
    const Fp = next(B + 1n),
      Ff = next(B - Fp + 1n),
      Fc = next(B - Fp - Ff + 1n);
    const Q = next(30_000_000_000n),
      Qp = next(Q + 1n),
      Qf = next(Q - Qp + 1n),
      Qc = next(Q - Qp - Qf + 1n);
    inputs.push(
      fixture({
        baseSupplyRaw: S.toString(),
        baseVaultRaw: B.toString(),
        internalLpSupplyRaw: D.toString(),
        actualLpSupplyRaw: M.toString(),
        baseProtocolFeesRaw: Fp.toString(),
        baseFundFeesRaw: Ff.toString(),
        baseCreatorFeesRaw: Fc.toString(),
        quoteVaultRaw: Q.toString(),
        quoteProtocolFeesRaw: Qp.toString(),
        quoteFundFeesRaw: Qf.toString(),
        quoteCreatorFeesRaw: Qc.toString(),
      }),
    );
  }
  // Qualifying cases and one-lamport boundaries must appear in the independent
  // comparison, not only fixtures whose generated liquidity is always too small.
  inputs[0] = fixture();
  inputs[1] = fixture({ quoteVaultRaw: "19999999999" });
  inputs[2] = fixture({ quoteVaultRaw: "20000000001" });
  inputs[3] = fixture({ baseCreatorFeesRaw: "2632" });
  inputs[4] = fixture({ baseCreatorFeesRaw: "2633" });
  inputs[5] = fixture({
    baseSupplyRaw: "18446744073709551615",
    baseVaultRaw: "18446744073709551615",
    internalLpSupplyRaw: "18446744073709551615",
    actualLpSupplyRaw: "18446744073709551614",
  });
  inputs[6] = fixture({
    quoteVaultRaw: "20000000006",
    quoteProtocolFeesRaw: "1",
    quoteFundFeesRaw: "2",
    quoteCreatorFeesRaw: "3",
  });
  inputs[7] = fixture({
    quoteVaultRaw: "20000000005",
    quoteProtocolFeesRaw: "1",
    quoteFundFeesRaw: "2",
    quoteCreatorFeesRaw: "3",
  });
  inputs[8] = fixture({
    quoteVaultRaw: "20000000007",
    quoteProtocolFeesRaw: "1",
    quoteFundFeesRaw: "2",
    quoteCreatorFeesRaw: "3",
  });
  const expected = inputs.map(evaluateCustodyArithmetic);
  assert.ok(inputs.some((v) => BigInt(v.amounts.baseSupplyRaw) > BigInt(Number.MAX_SAFE_INTEGER)));
  assert.ok(expected.some((r) => r.arithmeticCandidate));
  assert.ok(expected.some((r) => r.liquidityFloorSatisfied && !r.creatorCapSatisfied));
  const result = spawnSync(
    process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3"),
    [
      "-B",
      "-c",
      "import json,sys; sys.path.insert(0,sys.argv[1]); from custody_bound import evaluate; print(json.dumps([evaluate(v) for v in json.load(sys.stdin)]))",
      fileURLToPath(new URL("./", import.meta.url)),
    ],
    { input: JSON.stringify(inputs), encoding: "utf8", maxBuffer: 10_000_000, timeout: 20_000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), expected);
});

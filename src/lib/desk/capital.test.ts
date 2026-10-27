import test from "node:test";
import assert from "node:assert/strict";
import {
  isSolanaAddress,
  parseCapitalPolicy,
  planProfitDistribution,
  fundedReadiness,
  rejectLiveAction,
  type ProfitBalances,
} from "./capital.ts";
const recipient = "11111111111111111111111111111111";
const mint = "So11111111111111111111111111111111111111112";
const policy = () =>
  parseCapitalPolicy({
    mode: "PAPER",
    network: "solana-mainnet",
    recipient,
    profitMint: mint,
    profitLabel: "test",
    allocationBps: 10000,
    principalProtected: true,
    settlementAsset: "USDC",
    minimumPayoutAtomic: "1000000",
  });
const balances = (patch: Partial<ProfitBalances> = {}): ProfitBalances => ({
  freeUsdcAtomic: "1100000000",
  protectedPrincipalAtomic: "1000000000",
  netRealizedPnlAtomic: "100000000",
  profitAlreadyDistributedAtomic: "0",
  profitReservedAtomic: "0",
  operatingReserveAtomic: "0",
  ...patch,
});
test("addresses validate decoded byte length rather than spelling alone", () => {
  assert.ok(isSolanaAddress(recipient));
  assert.ok(isSolanaAddress(mint));
  assert.equal(isSolanaAddress("0".repeat(44)), false);
  assert.equal(isSolanaAddress("2".repeat(32)), false);
  assert.equal(isSolanaAddress("  " + mint), false);
});
test("all net profits can be planned without exposing principal", () => {
  const p = planProfitDistribution(policy(), balances());
  assert.equal(p.amountUsdcAtomic, "100000000");
  assert.equal(p.mode, "PAPER_PREVIEW");
  assert.equal(p.transferEnabled, false);
});
test("gross wins cannot erase losses or use deposited money as earnings", () => {
  assert.equal(
    planProfitDistribution(
      policy(),
      balances({ netRealizedPnlAtomic: "-10000000", freeUsdcAtomic: "2000000000" }),
    ).amountUsdcAtomic,
    "0",
  );
  assert.equal(
    planProfitDistribution(
      policy(),
      balances({ netRealizedPnlAtomic: "0", freeUsdcAtomic: "2000000000" }),
    ).amountUsdcAtomic,
    "0",
  );
});
test("paid and in-flight profits cannot be distributed twice", () => {
  assert.equal(
    planProfitDistribution(
      policy(),
      balances({ profitAlreadyDistributedAtomic: "70000000", profitReservedAtomic: "20000000" }),
    ).amountUsdcAtomic,
    "10000000",
  );
});
test("free cash and operating reserves bound payouts while inventory is open", () => {
  assert.equal(
    planProfitDistribution(
      policy(),
      balances({ freeUsdcAtomic: "1020000000", operatingReserveAtomic: "5000000" }),
    ).amountUsdcAtomic,
    "15000000",
  );
  assert.equal(
    planProfitDistribution(policy(), balances({ freeUsdcAtomic: "999000000" })).amountUsdcAtomic,
    "0",
  );
});
test("exact atomic arithmetic works beyond floating point limits", () => {
  const b = balances({
    freeUsdcAtomic: "9007199254740993000",
    protectedPrincipalAtomic: "9007199254740000000",
    netRealizedPnlAtomic: "999999999",
    operatingReserveAtomic: "0",
  });
  assert.equal(
    planProfitDistribution({ ...policy(), minimumPayoutAtomic: "1" }, b).amountUsdcAtomic,
    "993000",
  );
});
test("negative unsigned balances and live policy input fail closed", () => {
  assert.throws(() =>
    planProfitDistribution(policy(), balances({ profitAlreadyDistributedAtomic: "-1" })),
  );
  assert.throws(() => parseCapitalPolicy({ ...policy(), mode: "LIVE" }), /LIVE_EXECUTION_LOCKED/);
  assert.throws(() => rejectLiveAction("deposit"), /LIVE_EXECUTION_LOCKED/);
});
test("even passing readiness facts cannot automatically activate or publish a deposit address", () => {
  const r = fundedReadiness({
    verifiedForwardProfitable: true,
    independentlyAudited: true,
    walletOwnershipVerified: true,
    signerProvisioned: true,
    liveLimitsApproved: true,
    payoutRouteVerified: true,
    recipientTokenAccountVerified: true,
    securityAndAuthenticationVerified: true,
  });
  assert.equal(r.blockers.length, 0);
  assert.equal(r.liveExecutionEnabled, false);
  assert.equal(r.depositAddress, null);
  assert.equal(r.automaticPromotion, false);
});

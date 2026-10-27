/** Pinned-IDL synthetic account fixtures. No remote calls, real pools or profit claims. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PublicKey, Keypair } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { AccountLayout, MintLayout, NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  CPMM_PROGRAM,
  UPGRADEABLE_LOADER,
  MAINNET_GENESIS,
  CLOCK_SYSVAR,
  cpmmProgramData,
  captureCpmmSnapshot,
  inspectCpmmSnapshot,
  type CpmmRawCapture,
  type CustodyRpcAccount,
  type CustodyReadRpc,
} from "../src/custody-snapshot.ts";
const idl = JSON.parse(
  readFileSync(new URL("../vendor/raydium_cp_swap.json", import.meta.url), "utf8"),
);
const pub = (n: number) =>
  Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => (n + i) % 256)).publicKey;
function scalar(type: any, value: any): Buffer {
  if (type === "pubkey") return value.toBuffer();
  if (type === "bool") return Buffer.from([value ? 1 : 0]);
  if (typeof type === "string")
    return new BN(String(value)).toArrayLike(Buffer, "le", Number(type.slice(1)) / 8);
  return Buffer.concat(value.map((v: any) => scalar(type.array[0], v)));
}
function defaultValue(type: any): any {
  if (type === "pubkey") return PublicKey.default;
  if (type === "bool") return false;
  if (typeof type === "string") return 0;
  return Array.from({ length: type.array[1] }, () => defaultValue(type.array[0]));
}
function state(name: string, overrides: Record<string, any>) {
  const fields = idl.types.find((t: any) => t.name === name).type.fields;
  return Buffer.concat([
    Buffer.from(idl.accounts.find((a: any) => a.name === name).discriminator),
    ...fields.map((f: any) => scalar(f.type, overrides[f.name] ?? defaultValue(f.type))),
  ]);
}
function mint(supply: bigint, authority: PublicKey | null, decimals = 9) {
  const b = Buffer.alloc(MintLayout.span);
  MintLayout.encode(
    {
      mintAuthorityOption: authority ? 1 : 0,
      mintAuthority: authority ?? PublicKey.default,
      supply,
      decimals,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    b,
  );
  return b;
}
function token(mintKey: PublicKey, owner: PublicKey, amount: bigint, native = false) {
  const b = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode(
    {
      mint: mintKey,
      owner,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: native ? 1 : 0,
      isNative: native ? 2_039_280n : 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    b,
  );
  return b;
}
const rawAccount = (
  data: Buffer,
  owner: PublicKey,
  lamports = 1_000_000,
  executable = false,
): CustodyRpcAccount => ({
  data: [data.toString("base64"), "base64"],
  owner: owner.toBase58(),
  lamports,
  executable,
  rentEpoch: 18446744073709551615,
});
function fixture(reverse = false) {
  let base = pub(1);
  for (let i = 1; i < 250; i++) {
    const candidate = pub(i),
      first = Buffer.compare(candidate.toBuffer(), NATIVE_MINT.toBuffer()) < 0;
    if (first !== reverse) {
      base = candidate;
      break;
    }
  }
  const pool = pub(70),
    [authority, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_and_lp_mint_auth_seed")],
      CPMM_PROGRAM,
    );
  const derive = (seed: string, ...keys: PublicKey[]) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from(seed), ...keys.map((k) => k.toBuffer())],
      CPMM_PROGRAM,
    )[0];
  const lp = derive("pool_lp_mint", pool),
    bv = derive("pool_vault", pool, base),
    qv = derive("pool_vault", pool, NATIVE_MINT);
  const [config, cb] = PublicKey.findProgramAddressSync(
    [Buffer.from("amm_config"), Buffer.from([0, 0])],
    CPMM_PROGRAM,
  );
  const m0 = reverse ? NATIVE_MINT : base,
    m1 = reverse ? base : NATIVE_MINT;
  const poolFields: Record<string, any> = {
    amm_config: config,
    pool_creator: pub(71),
    token_0_mint: m0,
    token_1_mint: m1,
    token_0_vault: reverse ? qv : bv,
    token_1_vault: reverse ? bv : qv,
    token_0_program: TOKEN_PROGRAM_ID,
    token_1_program: TOKEN_PROGRAM_ID,
    lp_mint: lp,
    auth_bump: bump,
    lp_supply: "4358898943540",
    lp_mint_decimals: 9,
    mint_0_decimals: reverse ? 9 : 6,
    mint_1_decimals: reverse ? 6 : 9,
  };
  const configFields = {
    bump: cb,
    index: 0,
    trade_fee_rate: "2500",
    protocol_fee_rate: "120000",
    fund_fee_rate: "40000",
  };
  const program = Buffer.alloc(36);
  program.writeUInt32LE(2);
  cpmmProgramData().toBuffer().copy(program, 4);
  const programData = Buffer.alloc(55);
  programData.writeUInt32LE(3);
  programData.writeBigUInt64LE(900n, 4);
  programData[12] = 1;
  pub(73).toBuffer().copy(programData, 13);
  Buffer.from([127, 69, 76, 70, 1, 2]).copy(programData, 45);
  const values: CustodyRpcAccount[] = [
    rawAccount(state("PoolState", poolFields), CPMM_PROGRAM),
    rawAccount(mint(1_000_000_000_000_000n, null, 6), TOKEN_PROGRAM_ID),
    rawAccount(mint(0n, null), TOKEN_PROGRAM_ID),
    rawAccount(mint(217_944_947_177n, authority), TOKEN_PROGRAM_ID),
    rawAccount(token(base, authority, 950_000_000_000_000n), TOKEN_PROGRAM_ID),
    rawAccount(
      token(NATIVE_MINT, authority, 20_000_000_000n, true),
      TOKEN_PROGRAM_ID,
      20_002_039_280,
    ),
    rawAccount(state("AmmConfig", configFields), CPMM_PROGRAM),
    rawAccount(program, UPGRADEABLE_LOADER, 1_000_000, true),
    rawAccount(programData, UPGRADEABLE_LOADER),
  ];
  const clock = Buffer.alloc(40);
  clock.writeBigUInt64LE(1000n, 0);
  clock.writeBigInt64LE(1n, 32);
  values.push(rawAccount(clock, new PublicKey("Sysvar1111111111111111111111111111111111111")));
  const capture: CpmmRawCapture = {
    kind: "RAYDIUM_CPMM_RAW_SNAPSHOT_V1",
    chainGenesisHash: MAINNET_GENESIS,
    baseMint: base.toBase58(),
    pool: pool.toBase58(),
    requestedAt: 1000,
    receivedAt: 1100,
    request: {
      method: "getMultipleAccounts",
      addresses: [
        pool,
        base,
        NATIVE_MINT,
        lp,
        bv,
        qv,
        config,
        CPMM_PROGRAM,
        cpmmProgramData(),
        CLOCK_SYSVAR,
      ].map((k) => k.toBase58()),
      config: { encoding: "base64", commitment: "finalized", minContextSlot: 950 },
    },
    response: { context: { slot: 1000 }, value: values },
  };
  return {
    capture,
    values,
    base,
    authority,
    poolFields,
    configFields,
    data: (i: number, data: Buffer) => {
      values[i].data = [data.toString("base64"), "base64"];
    },
    pool: (overrides: Record<string, any>) => {
      values[0] = rawAccount(state("PoolState", { ...poolFields, ...overrides }), CPMM_PROGRAM);
    },
  };
}

describe("conditional CPMM account evidence", () => {
  it("uses the full mainnet genesis hash rather than a display abbreviation", () => {
    expect(MAINNET_GENESIS).toBe("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d");
  });
  it.each([false, true])(
    "validates both token orders without granting a custody certificate (reverse=%s)",
    (reverse) => {
      const f = fixture(reverse),
        r = inspectCpmmSnapshot(f.capture, 1200);
      expect(r.conditionalCandidate).toBe(true);
      expect(r.arithmetic.amounts.creatorSupplyUpperBps).toBe("975");
      expect(r.appliedExcludedPrincipalRaw).toBe("0");
      expect(r.appliedCreatorSupplyUpperRaw).toBe("1000000000000000");
      expect(r.creatorAssociationsVerified).toBe(false);
      expect(r.tradable).toBe(false);
      expect(r.liveApproved).toBe(false);
      expect(r.programIdentity.reviewedBuildMatchVerified).toBe(false);
      expect(r.accounts).toHaveLength(10);
    },
  );
  it("captures one coherent final batch and only three allowed read methods", async () => {
    const f = fixture(),
      calls: string[] = [];
    const rpc = {
      call: async (method: string, params: any[]) => {
        calls.push(method);
        if (method === "getGenesisHash") return MAINNET_GENESIS;
        if (method === "getAccountInfo") return { context: { slot: 950 }, value: f.values[0] };
        expect(params[0]).toEqual(f.capture.request.addresses);
        expect(params[1]).toEqual(f.capture.request.config);
        return f.capture.response;
      },
    } as CustodyReadRpc;
    let now = 1000;
    const capture = await captureCpmmSnapshot(
      rpc,
      f.capture.pool,
      f.capture.baseMint,
      () => (now += 10),
    );
    expect(calls).toEqual(["getGenesisHash", "getAccountInfo", "getMultipleAccounts"]);
    expect(inspectCpmmSnapshot(capture, 1040).conditionalCandidate).toBe(true);
  });
  it("rechecks pool mapping after discovery", async () => {
    const f = fixture(),
      original = structuredClone(f.values[0]);
    f.pool({ amm_config: pub(99) });
    const rpc = {
      call: async (method: string) =>
        method === "getGenesisHash"
          ? MAINNET_GENESIS
          : method === "getAccountInfo"
            ? { context: { slot: 950 }, value: original }
            : f.capture.response,
    } as CustodyReadRpc;
    const captured = await captureCpmmSnapshot(rpc, f.capture.pool, f.capture.baseMint, () => 1100);
    expect(captured.response.value[0]).toEqual(f.values[0]);
    expect(() => inspectCpmmSnapshot(captured, 1200)).toThrow("MAPPING");
  });
  it.each(["missing", "wrong owner", "truncated", "trailing bytes", "bad discriminator", "base64"])(
    "rejects malformed pool state: %s",
    (kind) => {
      const f = fixture();
      const data = Buffer.from(f.values[0].data[0], "base64");
      if (kind === "missing") f.capture.response.value[0] = null;
      if (kind === "wrong owner") f.values[0].owner = TOKEN_PROGRAM_ID.toBase58();
      if (kind === "truncated") f.data(0, data.subarray(0, data.length - 1));
      if (kind === "trailing bytes") f.data(0, Buffer.concat([data, Buffer.alloc(1)]));
      if (kind === "bad discriminator") {
        data[0] ^= 255;
        f.data(0, data);
      }
      if (kind === "base64") f.values[0].data[0] += " ";
      expect(() => inspectCpmmSnapshot(f.capture, 1200)).toThrow();
    },
  );
  it.each(["future", "stale", "confirmed", "slot behind", "duplicate address", "wrong cluster"])(
    "rejects temporal/context defect: %s",
    (kind) => {
      const f = fixture();
      if (kind === "future") f.capture.receivedAt = 1201;
      if (kind === "stale") f.capture.requestedAt = 0;
      if (kind === "confirmed") f.capture.request.config.commitment = "confirmed" as "finalized";
      if (kind === "slot behind") f.capture.response.context.slot = 949;
      if (kind === "duplicate address")
        f.capture.request.addresses[1] = f.capture.request.addresses[0];
      if (kind === "wrong cluster") f.capture.chainGenesisHash = "other";
      expect(() => inspectCpmmSnapshot(f.capture, kind === "stale" ? 31000 : 1200)).toThrow();
    },
  );
  it("does not count WSOL rent or un-synced donated lamports as quote liquidity", () => {
    const f = fixture();
    f.data(5, token(NATIVE_MINT, f.authority, 19_999_999_999n, true));
    f.values[5].lamports = 100_000_000_000;
    const r = inspectCpmmSnapshot(f.capture, 1200);
    expect(r.arithmetic.liquidityFloorSatisfied).toBe(false);
    expect(r.conditionalCandidate).toBe(false);
  });
  it("subtracts all fee buckets on each side", () => {
    const f = fixture();
    f.pool({
      protocol_fees_token_1: "1",
      fund_fees_token_1: "2",
      creator_fees_token_1: "3",
      creator_fees_token_0: "3000000000000",
    });
    const r = inspectCpmmSnapshot(f.capture, 1200);
    expect(r.arithmetic.amounts.netQuoteReserveLamports).toBe("19999999994");
    expect(r.arithmetic.amounts.netBaseReserveRaw).toBe("947000000000000");
    expect(r.conditionalCandidate).toBe(false);
  });
  it.each([
    "authority",
    "freeze",
    "delegate",
    "close",
    "token2022",
    "native backing",
    "LP authority",
    "LP mint PDA",
  ])("rejects unsafe mint/vault claims: %s", (kind) => {
    const f = fixture();
    if (kind === "authority") f.data(1, mint(1_000_000_000_000_000n, pub(93), 6));
    if (kind === "freeze") {
      const d = Buffer.from(f.values[1].data[0], "base64");
      d.writeUInt32LE(1, 46);
      pub(93).toBuffer().copy(d, 50);
      f.data(1, d);
    }
    if (kind === "delegate" || kind === "close") {
      const d = Buffer.from(f.values[4].data[0], "base64");
      d.writeUInt32LE(1, kind === "delegate" ? 72 : 129);
      pub(93)
        .toBuffer()
        .copy(d, kind === "delegate" ? 76 : 133);
      f.data(4, d);
    }
    if (kind === "token2022") f.values[1].owner = pub(94).toBase58();
    if (kind === "native backing") f.values[5].lamports = 19_000_000_000;
    if (kind === "LP authority") f.data(3, mint(217_944_947_177n, pub(93)));
    if (kind === "LP mint PDA") f.pool({ lp_mint: pub(94) });
    expect(() => inspectCpmmSnapshot(f.capture, 1200)).toThrow();
  });
  it("rejects future state fields and malformed bool encoding", () => {
    const f = fixture();
    f.pool({ padding1: [1, 0, 0, 0, 0, 0] });
    expect(() => inspectCpmmSnapshot(f.capture, 1200)).toThrow("UNREVIEWED");
    const g = fixture();
    const d = Buffer.from(g.values[6].data[0], "base64");
    d[9] = 2;
    g.data(6, d);
    expect(() => inspectCpmmSnapshot(g.capture, 1200)).toThrow("BOOL");
  });
  it.each([0, 2, 3, 255])(
    "rejects uninitialized, frozen, or invalid raw vault state %s",
    (stateByte) => {
      const f = fixture(),
        data = Buffer.from(f.values[4].data[0], "base64");
      data[108] = stateByte;
      f.data(4, data);
      expect(() => inspectCpmmSnapshot(f.capture, 1200)).toThrow("VAULT_ENCODING");
    },
  );
  it("does not exploit a paused withdrawal flag as proof of burned shares", () => {
    const f = fixture();
    f.pool({ status: 2 });
    f.data(3, mint(4_358_898_943_440n, f.authority));
    const r = inspectCpmmSnapshot(f.capture, 1200);
    expect(r.arithmetic.amounts.unmintedOrBurnedLpRaw).toBe("100");
    expect(r.conditionalCandidate).toBe(false);
  });
  it("rejects a missing initial100 share gap instead of inventing one", () => {
    const f = fixture();
    f.data(3, mint(4_358_898_943_500n, f.authority));
    expect(() => inspectCpmmSnapshot(f.capture, 1200)).toThrow("MINIMUM_LP_GAP");
  });
  it("honors open time and swap-disabled flag", () => {
    const f = fixture();
    f.pool({ status: 4 });
    expect(inspectCpmmSnapshot(f.capture, 1200).conditionalCandidate).toBe(false);
    f.pool({ open_time: "2" });
    expect(inspectCpmmSnapshot(f.capture, 1200).swapOpen).toBe(false);
  });
  it("uses the snapshot bank clock rather than later wall time for pool opening", () => {
    const f = fixture();
    f.pool({ open_time: "2" });
    f.capture.requestedAt = 3000;
    f.capture.receivedAt = 3100;
    expect(inspectCpmmSnapshot(f.capture, 3200).swapOpen).toBe(false);
  });
  it.each(["stale bank", "future bank", "wrong slot", "wrong owner", "truncated"])(
    "rejects bad bank freshness evidence: %s",
    (kind) => {
      const f = fixture(),
        data = Buffer.from(f.values[9].data[0], "base64");
      if (kind === "stale bank") {
        f.capture.requestedAt = 40000;
        f.capture.receivedAt = 40100;
      }
      if (kind === "future bank") data.writeBigInt64LE(4n, 32);
      if (kind === "wrong slot") data.writeBigUInt64LE(999n, 0);
      if (kind === "wrong owner") f.values[9].owner = TOKEN_PROGRAM_ID.toBase58();
      f.data(9, kind === "truncated" ? data.subarray(0, 39) : data);
      expect(() => inspectCpmmSnapshot(f.capture, kind === "stale bank" ? 40200 : 1200)).toThrow(
        "BANK_CLOCK",
      );
    },
  );
  it("normalizes executable payload independently of trailing allocation zeros", () => {
    const f = fixture(),
      r = inspectCpmmSnapshot(f.capture, 1200);
    expect(r.programIdentity.normalizedExecutableSha256).toBe(
      createHash("sha256")
        .update(Buffer.from([127, 69, 76, 70, 1, 2]))
        .digest("hex"),
    );
    const d = Buffer.from(f.values[8].data[0], "base64");
    f.data(8, Buffer.concat([d, Buffer.alloc(100)]));
    const changed = inspectCpmmSnapshot(f.capture, 1200);
    expect(changed.programIdentity.normalizedExecutableSha256).toBe(
      r.programIdentity.normalizedExecutableSha256,
    );
    expect(changed.programIdentity.rawPayloadSha256IncludingPadding).not.toBe(
      r.programIdentity.rawPayloadSha256IncludingPadding,
    );
  });
  it.each(["pointer", "owner", "same deployment slot", "empty executable"])(
    "rejects invalid or not active program evidence: %s",
    (kind) => {
      const f = fixture();
      if (kind === "pointer") {
        const d = Buffer.from(f.values[7].data[0], "base64");
        pub(93).toBuffer().copy(d, 4);
        f.data(7, d);
      }
      if (kind === "owner") f.values[8].owner = TOKEN_PROGRAM_ID.toBase58();
      if (kind === "same deployment slot") {
        const d = Buffer.from(f.values[8].data[0], "base64");
        d.writeBigUInt64LE(1000n, 4);
        f.data(8, d);
      }
      if (kind === "empty executable") {
        const d = Buffer.from(f.values[8].data[0], "base64");
        d.fill(0, 45);
        f.data(8, d);
      }
      expect(() => inspectCpmmSnapshot(f.capture, 1200)).toThrow();
    },
  );
});

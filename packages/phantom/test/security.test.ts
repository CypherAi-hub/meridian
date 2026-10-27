/** Synthetic account fixtures encoded from pinned official IDLs. No remote calls or real transactions. */
import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  MintLayout,
  AccountLayout,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  ExtensionType,
  AccountType,
} from "@solana/spl-token";
import { PUMP_PROGRAM_ID, GLOBAL_PDA, bondingCurvePda } from "@pump-fun/pump-sdk";
import { PUMP_AMM_PROGRAM_ID, GLOBAL_CONFIG_PDA, poolPda } from "@pump-fun/pump-swap-sdk";
import { SecurityReader } from "../src/security.ts";
import { checkTokenSafety } from "../src/risk.ts";
import { WSOL, type ChainEvent } from "../src/types.ts";
import type { Rpc } from "../src/stream.ts";

type Account = {
  owner: string;
  data: [string, string];
  lamports: number;
  executable: boolean;
  rentEpoch: number;
};
const pub = () => Keypair.generate().publicKey;
function account(data: Buffer, owner: PublicKey, lamports = 1000000): Account {
  return {
    owner: owner.toBase58(),
    data: [data.toString("base64"), "base64"],
    lamports,
    executable: false,
    rentEpoch: 0,
  };
}
function encodeScalar(type: any, value: any): Buffer {
  if (type === "pubkey") return value.toBuffer();
  if (type === "bool") return Buffer.from([value ? 1 : 0]);
  if (typeof type === "string" && /^[ui](8|16|32|64|128)$/.test(type)) {
    const width = Number(type.slice(1)) / 8;
    return new BN(String(value)).toArrayLike(Buffer, "le", width);
  }
  if (type.array) return Buffer.concat(value.map((v: any) => encodeScalar(type.array[0], v)));
  throw Error("SYNTHETIC_ENCODER_UNSUPPORTED_TYPE");
}
function defaultScalar(type: any): any {
  if (type === "pubkey") return PublicKey.default;
  if (type === "bool") return false;
  if (typeof type === "string") return 0;
  if (type.array) return Array.from({ length: type.array[1] }, () => defaultScalar(type.array[0]));
  throw Error("SYNTHETIC_ENCODER_UNSUPPORTED_TYPE");
}
function encoded(idlName: string, typeName: string, overrides: Record<string, any> = {}) {
  const idl = JSON.parse(
    fs.readFileSync(new URL(`../vendor/${idlName}.json`, import.meta.url), "utf8"),
  );
  const fields = idl.types.find((t: any) => t.name === typeName).type.fields;
  const values = Object.fromEntries(
    fields.map((f: any) => [f.name, overrides[f.name] ?? defaultScalar(f.type)]),
  );
  return Buffer.concat([
    Buffer.from(idl.accounts.find((a: any) => a.name === typeName).discriminator),
    ...fields.map((f: any) => encodeScalar(f.type, values[f.name])),
  ]);
}
function mintData(supply: bigint, initialized = true) {
  const data = Buffer.alloc(MintLayout.span);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply,
      decimals: 6,
      isInitialized: initialized,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data,
  );
  return data;
}
function tokenData(mint: PublicKey, owner: PublicKey, amount: bigint, delegate?: PublicKey) {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode(
    {
      mint,
      owner,
      amount,
      delegateOption: delegate ? 1 : 0,
      delegate: delegate ?? PublicKey.default,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: delegate ? amount : 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  return data;
}
function baseFixture(protocol: "pump" | "pumpswap" = "pump") {
  const mint = pub(),
    creator = pub(),
    pool =
      protocol === "pump" ? bondingCurvePda(mint) : poolPda(0, creator, mint, new PublicKey(WSOL));
  const baseVault = getAssociatedTokenAddressSync(mint, pool, true, TOKEN_PROGRAM_ID),
    accounts = new Map<string, Account>();
  accounts.set(mint.toBase58(), account(mintData(1000000n), TOKEN_PROGRAM_ID));
  accounts.set(baseVault.toBase58(), account(tokenData(mint, pool, 400000n), TOKEN_PROGRAM_ID));
  const holders = [{ pubkey: baseVault.toBase58(), account: accounts.get(baseVault.toBase58())! }];
  for (let i = 0; i < 30; i++) {
    const owner = i === 0 ? creator : pub(),
      address = pub().toBase58();
    holders.push({
      pubkey: address,
      account: account(tokenData(mint, owner, 20000n), TOKEN_PROGRAM_ID),
    });
  }
  if (protocol === "pump") {
    accounts.set(
      pool.toBase58(),
      account(
        encoded("pump", "BondingCurve", {
          virtual_token_reserves: "1073000",
          virtual_quote_reserves: "50000000000",
          real_token_reserves: "400000",
          real_quote_reserves: "30000000000",
          token_total_supply: "1000000",
          creator,
          quote_mint: new PublicKey(WSOL),
        }),
        PUMP_PROGRAM_ID,
        50000000000,
      ),
    );
    accounts.set(
      GLOBAL_PDA.toBase58(),
      account(
        encoded("pump", "Global", { initialized: true, initial_real_token_reserves: "800000" }),
        PUMP_PROGRAM_ID,
      ),
    );
  } else {
    const quoteVault = getAssociatedTokenAddressSync(
      new PublicKey(WSOL),
      pool,
      true,
      TOKEN_PROGRAM_ID,
    );
    accounts.set(
      pool.toBase58(),
      account(
        encoded("pump_amm", "Pool", {
          creator,
          base_mint: mint,
          quote_mint: new PublicKey(WSOL),
          pool_base_token_account: baseVault,
          pool_quote_token_account: quoteVault,
          coin_creator: creator,
          protocol_fees: "1000000000",
          creator_fees: "2000000000",
        }),
        PUMP_AMM_PROGRAM_ID,
      ),
    );
    accounts.set(
      GLOBAL_CONFIG_PDA.toBase58(),
      account(encoded("pump_amm", "GlobalConfig"), PUMP_AMM_PROGRAM_ID),
    );
    accounts.set(
      quoteVault.toBase58(),
      account(tokenData(new PublicKey(WSOL), pool, 50000000000n), TOKEN_PROGRAM_ID),
    );
  }
  const event: ChainEvent = {
    id: "SYNTHETIC-EVENT",
    protocol,
    kind: "buy",
    signature: "SYNTHETIC-SIGNATURE-NOT-ONCHAIN",
    slot: 100,
    mint: mint.toBase58(),
    quoteMint: WSOL,
    actor: pub().toBase58(),
    creator: creator.toBase58(),
    pool: pool.toBase58(),
    instruction: "buy",
    instructionIndex: "0",
    receivedAt: 1000,
    processedAt: 1000,
    blockTime: 1,
    commitment: "finalized",
    amountRaw: "1",
    quoteAmountRaw: "1",
    quantityEvidence: "program-event",
    details: { accounts: {} },
  };
  let clock = 1000,
    holderSlot = 100;
  const rpc = {
    call: vi.fn(async (method: string, params: any[]) => {
      if (method === "getAccountInfo")
        return { context: { slot: 100 }, value: accounts.get(params[0]) ?? null };
      if (method === "getMultipleAccounts")
        return {
          context: { slot: 100 },
          value: params[0].map((address: string) => accounts.get(address) ?? null),
        };
      if (method === "getProgramAccounts") return { context: { slot: holderSlot }, value: holders };
      throw Error("UNEXPECTED_SYNTHETIC_RPC_METHOD");
    }),
  };
  return {
    mint,
    creator,
    pool,
    baseVault,
    accounts,
    holders,
    event,
    rpc,
    reader: () => new SecurityReader(rpc as unknown as Rpc, () => clock),
    setClock: (value: number) => {
      clock = value;
    },
    setHolderSlot: (value: number) => {
      holderSlot = value;
    },
  };
}
function raydiumFixture(reverse = false) {
  const f = baseFixture(),
    program = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C"),
    pool = pub();
  const mint0 = reverse ? new PublicKey(WSOL) : f.mint,
    mint1 = reverse ? f.mint : new PublicKey(WSOL);
  const [authority, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_and_lp_mint_auth_seed")],
    program,
  );
  const vault0 = PublicKey.findProgramAddressSync(
      [Buffer.from("pool_vault"), pool.toBuffer(), mint0.toBuffer()],
      program,
    )[0],
    vault1 = PublicKey.findProgramAddressSync(
      [Buffer.from("pool_vault"), pool.toBuffer(), mint1.toBuffer()],
      program,
    )[0];
  const baseVault = reverse ? vault1 : vault0,
    quoteVault = reverse ? vault0 : vault1;
  const fields = {
    pool_creator: f.creator,
    token_0_mint: mint0,
    token_1_mint: mint1,
    token_0_vault: vault0,
    token_1_vault: vault1,
    token_0_program: TOKEN_PROGRAM_ID,
    token_1_program: TOKEN_PROGRAM_ID,
    auth_bump: bump,
    [reverse ? "protocol_fees_token_0" : "protocol_fees_token_1"]: "1000000000",
    [reverse ? "fund_fees_token_0" : "fund_fees_token_1"]: "2000000000",
    [reverse ? "creator_fees_token_0" : "creator_fees_token_1"]: "3000000000",
  };
  f.accounts.set(
    pool.toBase58(),
    account(encoded("raydium_cp_swap", "PoolState", fields), program),
  );
  f.accounts.set(
    baseVault.toBase58(),
    account(tokenData(f.mint, authority, 400000n), TOKEN_PROGRAM_ID),
  );
  f.accounts.set(
    quoteVault.toBase58(),
    account(tokenData(new PublicKey(WSOL), authority, 50000000000n), TOKEN_PROGRAM_ID),
  );
  f.holders[0] = { pubkey: baseVault.toBase58(), account: f.accounts.get(baseVault.toBase58())! };
  f.event.protocol = "raydium-cpmm";
  f.event.pool = pool.toBase58();
  return {
    ...f,
    raydiumProgram: program,
    raydiumPool: pool,
    baseVault,
    quoteVault,
    authority,
    poolFields: fields,
  };
}
afterEach(() => vi.unstubAllEnvs());

describe("finalized mint and holder security with synthetic evidence", () => {
  it("validates owner/state and reconciles full supply while excluding only the verified protocol vault", async () => {
    const f = baseFixture(),
      snapshot = await f.reader().inspect(f.event, { available: true, at: 1000 });
    expect(snapshot.evidence.mintAuthority).toBeNull();
    expect(snapshot.evidence.freezeAuthority).toBeNull();
    expect(snapshot.evidence.topHolderConcentrationBps).toBe(2000);
    expect(snapshot.evidence.directCreatorConcentrationBps).toBe(200);
    expect(snapshot.evidence.creatorAssociationsVerified).toBe(false);
    expect(snapshot.evidence.creatorAssociatedConcentrationBps).toBeNull();
    expect(snapshot.evidence.creatorConcentrationScope).toBe("DIRECT_OWNER_AND_DELEGATE_ONLY");
    expect(snapshot.evidence.mintSlot).toBe(100);
    expect(snapshot.evidence.holderSnapshotSlot).toBe(100);
    expect(snapshot.warnings).toContain("CREATOR_ASSOCIATED_SUPPLY_UNVERIFIED_DIRECT_CREATOR_ONLY");
    const productionVerdict = checkTokenSafety(
      { ...snapshot.evidence, abnormalCreatorActivity: false },
      undefined,
      1000,
    );
    expect(productionVerdict.allowed).toBe(false);
    expect(productionVerdict.reasons).toContain("CREATOR_ASSOCIATIONS_UNVERIFIED");
    expect(productionVerdict.reasons).toContain(
      "CREATOR_ASSOCIATED_CONCENTRATION_UNKNOWN_OR_EXCESSIVE",
    );
  });
  it("never excludes a large holder merely because instruction metadata labels it a vault", async () => {
    const f = baseFixture();
    f.event.details.accounts = { associated_bonding_curve: f.holders[1].pubkey };
    f.holders.splice(1);
    f.holders.push({
      pubkey: pub().toBase58(),
      account: account(tokenData(f.mint, f.creator, 600000n), TOKEN_PROGRAM_ID),
    });
    (f.event.details.accounts as Record<string, string>).associated_bonding_curve =
      f.holders[1].pubkey;
    const result = await f.reader().inspect(f.event, { available: true, at: 1000 });
    expect(result.evidence.topHolderConcentrationBps).toBe(6000);
    expect(result.evidence.creatorConcentrationBps).toBe(6000);
  });
  it("counts directly delegated creator-controlled supply without inferring hidden relationships", async () => {
    const f = baseFixture();
    f.holders[2].account = account(tokenData(f.mint, pub(), 20000n, f.creator), TOKEN_PROGRAM_ID);
    const result = await f.reader().inspect(f.event, { available: true, at: 1000 });
    expect(result.evidence.creatorConcentrationBps).toBe(400);
    expect(result.evidence.creatorAssociatedConcentrationBps).toBeNull();
  });
  it("rejects a one-raw-token excess over the creator cap instead of flooring it away", async () => {
    const f = baseFixture();
    f.holders[1].account = account(tokenData(f.mint, f.creator, 100001n), TOKEN_PROGRAM_ID);
    for (let i = 2; i < f.holders.length; i++)
      f.holders[i].account = account(
        tokenData(f.mint, pub(), i === f.holders.length - 1 ? 17251n : 17241n),
        TOKEN_PROGRAM_ID,
      );
    const snapshot = await f.reader().inspect(f.event, { available: true, at: 1000 });
    expect(snapshot.evidence.directCreatorConcentrationBps).toBe(1001);
    expect(checkTokenSafety(snapshot.evidence, undefined, 1000).reasons).toContain(
      "CREATOR_CONCENTRATION_UNKNOWN_OR_EXCESSIVE",
    );
  });
  it("rejects a fractional top-ten excess while preserving the exact cap", async () => {
    const f = baseFixture(),
      owners = f.holders.slice(1).map(() => pub());
    for (let i = 1; i < f.holders.length; i++)
      f.holders[i].account = account(
        tokenData(f.mint, owners[i - 1], i <= 10 ? 35000n : 12500n),
        TOKEN_PROGRAM_ID,
      );
    expect(
      (await f.reader().inspect(f.event, { available: true, at: 1000 })).evidence
        .topHolderConcentrationBps,
    ).toBe(3500);
    f.holders[1].account = account(tokenData(f.mint, owners[0], 35001n), TOKEN_PROGRAM_ID);
    f.holders[30].account = account(tokenData(f.mint, owners[29], 12499n), TOKEN_PROGRAM_ID);
    const snapshot = await f.reader().inspect(f.event, { available: true, at: 1000 });
    expect(snapshot.evidence.topHolderConcentrationBps).toBe(3501);
    expect(checkTokenSafety(snapshot.evidence, undefined, 1000).reasons).toContain(
      "HOLDER_CONCENTRATION_UNKNOWN_OR_EXCESSIVE",
    );
  });
  it.each(["incomplete", "duplicate", "wrong-owner", "uninitialized-token"] as const)(
    "rejects %s holder coverage rather than treating it as complete",
    async (kind) => {
      const f = baseFixture();
      if (kind === "incomplete") f.holders.pop();
      if (kind === "duplicate") f.holders.push(f.holders[1]);
      if (kind === "wrong-owner")
        f.holders[1].account = { ...f.holders[1].account, owner: PublicKey.default.toBase58() };
      if (kind === "uninitialized-token") {
        const data = Buffer.from(f.holders[1].account.data[0], "base64");
        data[108] = 0;
        f.holders[1].account = account(data, TOKEN_PROGRAM_ID);
      }
      const result = await f.reader().inspect(f.event, { available: true, at: 1000 });
      expect(result.evidence.topHolderConcentrationBps).toBeNull();
      expect(result.evidence.creatorConcentrationBps).toBeNull();
      expect(result.warnings).toContain("FULL_HOLDER_DISTRIBUTION_UNAVAILABLE_OR_UNVERIFIED");
    },
  );
  it("rejects an uninitialized mint and executable/falsely encoded account data", async () => {
    const f = baseFixture();
    f.accounts.set(f.mint.toBase58(), account(mintData(1000000n, false), TOKEN_PROGRAM_ID));
    await expect(f.reader().inspect(f.event, { available: true, at: 1000 })).rejects.toThrow(
      "MINT_NOT_INITIALIZED",
    );
    const g = baseFixture();
    g.accounts.get(g.mint.toBase58())!.executable = true;
    await expect(g.reader().inspect(g.event, { available: true, at: 1000 })).rejects.toThrow(
      "INVALID_RPC_ACCOUNT",
    );
    const h = baseFixture();
    h.accounts.get(h.mint.toBase58())!.data[1] = "jsonParsed";
    await expect(h.reader().inspect(h.event, { available: true, at: 1000 })).rejects.toThrow(
      "INVALID_RPC_ACCOUNT",
    );
  });
  it("rejects holder context older than the mint snapshot and preserves earliest evidence time", async () => {
    const f = baseFixture();
    f.setHolderSlot(99);
    expect(
      (await f.reader().inspect(f.event, { available: true, at: 1000 })).evidence
        .topHolderConcentrationBps,
    ).toBeNull();
    const g = baseFixture(),
      call = g.rpc.call.getMockImplementation()!;
    g.rpc.call.mockImplementation(async (method, params) => {
      const response = await call(method, params);
      if (method === "getProgramAccounts") g.setClock(50000);
      return response;
    });
    const snapshot = await g.reader().inspect(g.event, { available: true, at: 1000 });
    expect(snapshot.observedAt).toBe(1000);
    expect(snapshot.evidence.observedAt).toBe(1000);
    expect(checkTokenSafety(snapshot.evidence, undefined, 50000).reasons).toContain(
      "SECURITY_EVIDENCE_STALE_OR_FUTURE",
    );
  });
  it("surfaces Token-2022 permanent delegates and frozen defaults as risks", async () => {
    const f = baseFixture();
    const delegate = pub(),
      data = Buffer.alloc(166 + 4 + 32);
    mintData(1000000n).copy(data);
    data[165] = AccountType.Mint;
    data.writeUInt16LE(ExtensionType.PermanentDelegate, 166);
    data.writeUInt16LE(32, 168);
    delegate.toBuffer().copy(data, 170);
    f.accounts.set(f.mint.toBase58(), account(data, TOKEN_2022_PROGRAM_ID));
    const result = await f.reader().inspect(f.event, { available: true, at: 1000 });
    expect(result.evidence.permanentDelegate).toBe(delegate.toBase58());
    expect(checkTokenSafety(result.evidence, undefined, 1000).reasons).toContain(
      "PERMANENT_DELEGATE_ACTIVE",
    );
  });
  it("labels reputation only as a local denylist check and applies exact address matches", async () => {
    const f = baseFixture();
    vi.stubEnv("PHANTOM_DENYLIST", `  ${f.creator.toBase58()}  `);
    const result = await f.reader().inspect(f.event, { available: true, at: 1000 });
    expect(result.evidence.knownMalicious).toBe(true);
    expect(result.warnings).toContain("REPUTATION_CHECK_SCOPE_LOCAL_DENYLIST_ONLY");
  });
});

describe("protocol-specific liquidity evidence with synthetic accounts", () => {
  it("uses the current SDK versioned Pump curve reader and correct initial saleable-reserve progress baseline", async () => {
    const f = baseFixture();
    const snapshot = await f.reader().inspect(f.event, { available: true, at: 1000 });
    expect(snapshot.liquidityLamports).toBe(30000000000n);
    expect(snapshot.curveProgressBps).toBe(5000);
    expect(snapshot.evidence.liquidityAccessible).toBe(true);
    const old = baseFixture(),
      curve = old.accounts.get(old.pool.toBase58())!;
    curve.data[0] = Buffer.from(curve.data[0], "base64").subarray(0, 115).toString("base64");
    expect(
      (await old.reader().inspect(old.event, { available: true, at: 1000 })).liquidityLamports,
    ).toBe(30000000000n);
  });
  it("requires the mint-specific curve PDA, matching token vault authority, and actual account funding", async () => {
    const wrongPda = baseFixture();
    const alternate = pub();
    wrongPda.accounts.set(alternate.toBase58(), wrongPda.accounts.get(wrongPda.pool.toBase58())!);
    wrongPda.event.pool = alternate.toBase58();
    expect(
      (await wrongPda.reader().inspect(wrongPda.event, { available: true, at: 1000 })).evidence
        .liquidityAccessible,
    ).toBeNull();
    const wrongVault = baseFixture();
    wrongVault.accounts.set(
      wrongVault.baseVault.toBase58(),
      account(tokenData(wrongVault.mint, pub(), 400000n), TOKEN_PROGRAM_ID),
    );
    expect(
      (await wrongVault.reader().inspect(wrongVault.event, { available: true, at: 1000 }))
        .liquidityLamports,
    ).toBeNull();
    const unfunded = baseFixture();
    unfunded.accounts.get(unfunded.pool.toBase58())!.lamports = 1;
    expect(
      (await unfunded.reader().inspect(unfunded.event, { available: true, at: 1000 }))
        .liquidityLamports,
    ).toBeNull();
  });
  it("verifies PumpSwap pool/vault identity and subtracts accrued fees from accessible reserves", async () => {
    const f = baseFixture("pumpswap");
    const result = await f.reader().inspect(f.event, { available: true, at: 1000 });
    expect(result.liquidityLamports).toBe(47000000000n);
    expect(result.evidence.liquidityAccessible).toBe(true);
    const wrong = baseFixture("pumpswap"),
      q = getAssociatedTokenAddressSync(new PublicKey(WSOL), wrong.pool, true, TOKEN_PROGRAM_ID);
    wrong.accounts.set(
      q.toBase58(),
      account(tokenData(new PublicKey(WSOL), pub(), 50000000000n), TOKEN_PROGRAM_ID),
    );
    expect(
      (await wrong.reader().inspect(wrong.event, { available: true, at: 1000 })).evidence
        .liquidityAccessible,
    ).toBeNull();
  });
  it("does not treat PumpSwap nonzero disable flags as certified accessible", async () => {
    const f = baseFixture("pumpswap");
    f.accounts.set(
      GLOBAL_CONFIG_PDA.toBase58(),
      account(encoded("pump_amm", "GlobalConfig", { disable_flags: 1 }), PUMP_AMM_PROGRAM_ID),
    );
    expect(
      (await f.reader().inspect(f.event, { available: true, at: 1000 })).evidence
        .liquidityAccessible,
    ).toBe(false);
  });
  it.each([false, true])(
    "verifies Raydium CPMM quote/base orientation and subtracts all accrued quote-side fees (reversed=%s)",
    async (reverse) => {
      const f = raydiumFixture(reverse),
        result = await f.reader().inspect(f.event, { available: true, at: 1000 });
      expect(result.liquidityLamports).toBe(44000000000n);
      expect(result.evidence.liquidityAccessible).toBe(true);
      expect(result.evidence.topHolderConcentrationBps).toBe(2000);
      expect(f.rpc.call.mock.calls.some(([method]) => method === "getTokenAccountBalance")).toBe(
        false,
      );
    },
  );
  it("rejects a Raydium vault with the wrong token mint or authority and an altered mapped vault address", async () => {
    const wrongMint = raydiumFixture();
    wrongMint.accounts.set(
      wrongMint.quoteVault.toBase58(),
      account(tokenData(pub(), wrongMint.authority, 50000000000n), TOKEN_PROGRAM_ID),
    );
    expect(
      (await wrongMint.reader().inspect(wrongMint.event, { available: true, at: 1000 }))
        .liquidityLamports,
    ).toBeNull();
    const wrongAuthority = raydiumFixture();
    wrongAuthority.accounts.set(
      wrongAuthority.quoteVault.toBase58(),
      account(tokenData(new PublicKey(WSOL), pub(), 50000000000n), TOKEN_PROGRAM_ID),
    );
    expect(
      (await wrongAuthority.reader().inspect(wrongAuthority.event, { available: true, at: 1000 }))
        .liquidityLamports,
    ).toBeNull();
    const wrongAddress = raydiumFixture();
    wrongAddress.accounts.set(
      wrongAddress.raydiumPool.toBase58(),
      account(
        encoded("raydium_cp_swap", "PoolState", {
          ...wrongAddress.poolFields,
          token_1_vault: pub(),
        }),
        wrongAddress.raydiumProgram,
      ),
    );
    expect(
      (await wrongAddress.reader().inspect(wrongAddress.event, { available: true, at: 1000 }))
        .liquidityLamports,
    ).toBeNull();
  });
  it("rejects future-open or swap-disabled Raydium pools without inventing accessible reserves", async () => {
    for (const patch of [{ status: 4 }, { open_time: "99999" }]) {
      const f = raydiumFixture();
      f.accounts.set(
        f.raydiumPool.toBase58(),
        account(
          encoded("raydium_cp_swap", "PoolState", { ...f.poolFields, ...patch }),
          f.raydiumProgram,
        ),
      );
      expect(
        (await f.reader().inspect(f.event, { available: true, at: 1000 })).evidence
          .liquidityAccessible,
      ).toBe(false);
    }
  });
  it("reads pool fee buckets and vault balances in one finalized RPC context", async () => {
    const f = baseFixture("pumpswap");
    await f.reader().inspect(f.event, { available: true, at: 1000 });
    const batch = f.rpc.call.mock.calls.find(([method]) => method === "getMultipleAccounts");
    expect(batch?.[1][0]).toContain(f.pool.toBase58());
    expect(batch?.[1][0]).toContain(f.baseVault.toBase58());
    expect(batch?.[1][1]).toEqual({
      encoding: "base64",
      commitment: "finalized",
      minContextSlot: 100,
    });
  });
});

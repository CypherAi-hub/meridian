import { PublicKey, type AccountInfo } from "@solana/web3.js";
import {
  unpackMint,
  unpackAccount,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getExtensionTypes,
  ExtensionType,
  getTransferFeeConfig,
  getPermanentDelegate,
  getDefaultAccountState,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PUMP_SDK, PUMP_PROGRAM_ID, GLOBAL_PDA, bondingCurvePda } from "@pump-fun/pump-sdk";
import {
  PUMP_AMM_SDK,
  PUMP_AMM_PROGRAM_ID,
  GLOBAL_CONFIG_PDA,
  poolPda,
} from "@pump-fun/pump-swap-sdk";
import { BorshAccountsCoder } from "@coral-xyz/anchor";
import { Rpc } from "./stream.ts";
import { ADAPTERS } from "./decoder.ts";
import { type ChainEvent, WSOL } from "./types.ts";
import type { TokenSafetyEvidence } from "./risk.ts";

type RpcAccount = {
  owner: string;
  data: [string, string];
  lamports: number;
  executable: boolean;
  rentEpoch: number;
};
type ContextValue<T> = { context: { slot: number }; value: T };
export type SecurityEvidence = TokenSafetyEvidence & {
  /** Earliest inspection request; publication must not renew the freshness TTL. */
  evidenceRequestedAt: number;
  creatorAddress: string | null;
  directCreatorConcentrationBps: number | null;
  creatorConcentrationScope: "DIRECT_OWNER_AND_DELEGATE_ONLY";
  creatorAssociationsVerified: false;
  creatorAssociatedConcentrationBps: null;
  mintSlot: number | null;
  holderSnapshotSlot: number | null;
  liquiditySlot: number | null;
};
export type SecuritySnapshot = {
  evidence: SecurityEvidence;
  liquidityLamports: bigint | null;
  curveProgressBps: number | null;
  observedAt: number;
  warnings: string[];
  /** Original account response, retained for a separate strict research decoder. */
  mintAccountCapture?: ResearchMintAccountCapture;
};
export type ResearchMintAccountCapture = {
  address: string;
  owner: string;
  dataBase64: string;
  slot: number;
  requestedAt: number;
  observedAt: number;
  publishedAt: number;
};
const MAX_CAPTURED_MINT_BYTES = 65_536;
function captureClock(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0))
    throw Error("SECURITY_CAPTURE_CLOCK_INVALID");
  return value;
}
type PoolEvidence = {
  vaults: Set<string>;
  liquidityLamports: bigint;
  curveProgressBps: number | null;
  accessible: boolean;
  creator: string | null;
  slot: number;
};
const tokenPrograms = [TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()];
const key = (value: unknown) => {
  if (typeof value !== "string") throw Error("INVALID_ACCOUNT_PUBLIC_KEY");
  return new PublicKey(value);
};
function context(value: unknown, minSlot = 0): number {
  const slot = (value as { slot?: unknown })?.slot;
  if (typeof slot !== "number" || !Number.isSafeInteger(slot) || slot < minSlot)
    throw Error("RPC_CONTEXT_SLOT_INVALID_OR_BEHIND");
  return slot;
}
function info(account: RpcAccount, maxDataBytes?: number): AccountInfo<Buffer> {
  if (
    !account ||
    typeof account.executable !== "boolean" ||
    account.executable ||
    !Number.isSafeInteger(account.lamports) ||
    account.lamports < 0 ||
    !Array.isArray(account.data) ||
    account.data[1] !== "base64" ||
    typeof account.data[0] !== "string"
  )
    throw Error("INVALID_RPC_ACCOUNT");
  if (maxDataBytes !== undefined && account.data[0].length > 4 * Math.ceil(maxDataBytes / 3))
    throw Error("SECURITY_MINT_CAPTURE_TOO_LARGE");
  const data = Buffer.from(account.data[0], "base64");
  if (maxDataBytes !== undefined && data.length > maxDataBytes)
    throw Error("SECURITY_MINT_CAPTURE_TOO_LARGE");
  if (data.toString("base64") !== account.data[0]) throw Error("NONCANONICAL_ACCOUNT_BASE64");
  return {
    data,
    owner: key(account.owner),
    lamports: account.lamports,
    executable: account.executable,
    rentEpoch: account.rentEpoch,
  };
}
function nativeQuote(mint: PublicKey) {
  return mint.equals(new PublicKey(WSOL)) || mint.equals(PublicKey.default);
}
function positiveReserve(value: bigint) {
  if (value < 0n) throw Error("NEGATIVE_ACCESSIBLE_RESERVES");
  return value;
}

/** Finalized account evidence. Missing coverage is explicit; public addresses never prove hidden ownership. */
export class SecurityReader {
  constructor(
    private readonly rpc: Rpc,
    private readonly clock: () => number = Date.now,
  ) {}
  private async account(address: PublicKey, minSlot: number, maxDataBytes?: number) {
    const requestedAt = captureClock(this.clock());
    const result = await this.rpc.call<ContextValue<RpcAccount | null>>("getAccountInfo", [
      address.toBase58(),
      { encoding: "base64", commitment: "finalized", minContextSlot: minSlot },
    ]);
    const observedAt = captureClock(this.clock());
    if (observedAt < requestedAt) throw Error("SECURITY_CAPTURE_CLOCK_REGRESSED");
    const slot = context(result.context, minSlot);
    if (!result.value) throw Error("SECURITY_ACCOUNT_MISSING");
    return { account: info(result.value, maxDataBytes), slot, requestedAt, observedAt };
  }
  private async accounts(addresses: PublicKey[], minSlot: number) {
    const result = await this.rpc.call<ContextValue<(RpcAccount | null)[]>>("getMultipleAccounts", [
      addresses.map((a) => a.toBase58()),
      { encoding: "base64", commitment: "finalized", minContextSlot: minSlot },
    ]);
    const slot = context(result.context, minSlot);
    if (
      !Array.isArray(result.value) ||
      result.value.length !== addresses.length ||
      result.value.some((a) => !a)
    )
      throw Error("POOL_SNAPSHOT_ACCOUNT_MISSING");
    return { accounts: result.value.map((a) => info(a!)), slot };
  }
  private vaultInfo(
    address: PublicKey,
    account: AccountInfo<Buffer>,
    mint: PublicKey,
    authority: PublicKey,
    program: PublicKey,
  ) {
    const token = unpackAccount(address, account, program);
    if (
      !token.mint.equals(mint) ||
      !token.owner.equals(authority) ||
      !token.isInitialized ||
      token.isFrozen ||
      token.delegate !== null
    )
      throw Error("POOL_VAULT_MINT_AUTHORITY_OR_STATE_MISMATCH");
    return { amount: token.amount };
  }
  private async pool(
    event: ChainEvent,
    mintProgram: PublicKey,
    minSlot: number,
  ): Promise<PoolEvidence> {
    if (event.quoteMint !== WSOL || !event.pool) throw Error("POOL_SOL_QUOTE_REQUIRED");
    const poolKey = key(event.pool),
      mint = key(event.mint),
      result = await this.account(poolKey, minSlot),
      poolInfo = result.account;
    if (event.protocol === "pump") {
      if (!poolKey.equals(bondingCurvePda(mint)) || !poolInfo.owner.equals(PUMP_PROGRAM_ID))
        throw Error("PUMP_CURVE_PDA_OR_OWNER_MISMATCH");
      const baseVault = getAssociatedTokenAddressSync(mint, poolKey, true, mintProgram);
      const snapshot = await this.accounts([poolKey, GLOBAL_PDA, baseVault], result.slot),
        [curveInfo, globalInfo, vaultAccount] = snapshot.accounts;
      if (!curveInfo.owner.equals(PUMP_PROGRAM_ID) || !globalInfo.owner.equals(PUMP_PROGRAM_ID))
        throw Error("PUMP_STATE_OWNER_MISMATCH");
      const curve = PUMP_SDK.decodeBondingCurve(curveInfo);
      if (!nativeQuote(curve.quoteMint)) throw Error("PUMP_QUOTE_MINT_MISMATCH");
      const global = PUMP_SDK.decodeGlobal(globalInfo);
      if (!global.initialized) throw Error("PUMP_GLOBAL_UNINITIALIZED");
      const initial = BigInt(global.initialRealTokenReserves.toString()),
        remaining = BigInt(curve.realTokenReserves.toString());
      const curveProgressBps =
        initial > 0n && remaining <= initial
          ? Number(((initial - remaining) * 10000n) / initial)
          : null;
      this.vaultInfo(baseVault, vaultAccount, mint, poolKey, mintProgram);
      const liquidity = positiveReserve(BigInt(curve.realQuoteReserves.toString()));
      // Account lamports also include rent and accrued fees; accessible curve reserves cannot exceed the account balance.
      if (liquidity > BigInt(curveInfo.lamports))
        throw Error("PUMP_RESERVES_EXCEED_ACCOUNT_BALANCE");
      return {
        vaults: new Set([baseVault.toBase58()]),
        liquidityLamports: liquidity,
        curveProgressBps,
        accessible: !curve.complete && liquidity > 0n,
        creator: curve.creator.equals(PublicKey.default) ? null : curve.creator.toBase58(),
        slot: snapshot.slot,
      };
    }
    if (event.protocol === "pumpswap") {
      if (!poolInfo.owner.equals(PUMP_AMM_PROGRAM_ID)) throw Error("PUMPSWAP_POOL_OWNER_MISMATCH");
      const expectedBase = getAssociatedTokenAddressSync(mint, poolKey, true, mintProgram),
        expectedQuote = getAssociatedTokenAddressSync(
          new PublicKey(WSOL),
          poolKey,
          true,
          TOKEN_PROGRAM_ID,
        );
      const snapshot = await this.accounts(
          [poolKey, GLOBAL_CONFIG_PDA, expectedBase, expectedQuote],
          result.slot,
        ),
        [currentPoolInfo, globalInfo, baseInfo, quoteInfo] = snapshot.accounts;
      if (
        !currentPoolInfo.owner.equals(PUMP_AMM_PROGRAM_ID) ||
        !globalInfo.owner.equals(PUMP_AMM_PROGRAM_ID)
      )
        throw Error("PUMPSWAP_STATE_OWNER_MISMATCH");
      const pool = PUMP_AMM_SDK.decodePool(currentPoolInfo);
      if (
        !pool.baseMint.equals(mint) ||
        !pool.quoteMint.equals(new PublicKey(WSOL)) ||
        !poolKey.equals(poolPda(pool.index, pool.creator, pool.baseMint, pool.quoteMint))
      )
        throw Error("PUMPSWAP_POOL_MINT_OR_PDA_MISMATCH");
      const global = PUMP_AMM_SDK.decodeGlobalConfig(globalInfo);
      if (
        !pool.poolBaseTokenAccount.equals(expectedBase) ||
        !pool.poolQuoteTokenAccount.equals(expectedQuote)
      )
        throw Error("PUMPSWAP_VAULT_ADDRESS_MISMATCH");
      const baseVault = this.vaultInfo(expectedBase, baseInfo, mint, poolKey, mintProgram),
        quoteVault = this.vaultInfo(
          expectedQuote,
          quoteInfo,
          new PublicKey(WSOL),
          poolKey,
          TOKEN_PROGRAM_ID,
        );
      const liquidity = positiveReserve(
        quoteVault.amount -
          BigInt(pool.protocolFees.toString()) -
          BigInt(pool.creatorFees.toString()),
      );
      // Nonzero feature-disable flags are conservatively not certified as accessible here.
      return {
        vaults: new Set([expectedBase.toBase58()]),
        liquidityLamports: liquidity,
        curveProgressBps: null,
        accessible: global.disableFlags === 0 && baseVault.amount > 0n && liquidity > 0n,
        creator: (pool.coinCreator.equals(PublicKey.default)
          ? pool.creator
          : pool.coinCreator
        ).toBase58(),
        slot: snapshot.slot,
      };
    }
    if (event.protocol !== "raydium-cpmm") throw Error("POOL_PROTOCOL_UNSUPPORTED");
    const adapter = ADAPTERS.find((a) => a.protocol === "raydium-cpmm")!;
    if (poolInfo.owner.toBase58() !== adapter.address) throw Error("RAYDIUM_POOL_OWNER_MISMATCH");
    const initialPool = new BorshAccountsCoder(adapter.idl).decode(
      "PoolState",
      poolInfo.data,
    ) as Record<string, any>;
    const snapshot = await this.accounts(
        [poolKey, initialPool.token_0_vault, initialPool.token_1_vault],
        result.slot,
      ),
      [currentPoolInfo, vault0Info, vault1Info] = snapshot.accounts;
    if (currentPoolInfo.owner.toBase58() !== adapter.address)
      throw Error("RAYDIUM_POOL_OWNER_MISMATCH");
    const pool = new BorshAccountsCoder(adapter.idl).decode(
      "PoolState",
      currentPoolInfo.data,
    ) as Record<string, any>;
    if (
      !pool.token_0_vault.equals(initialPool.token_0_vault) ||
      !pool.token_1_vault.equals(initialPool.token_1_vault)
    )
      throw Error("POOL_VAULT_MAPPING_CHANGED_DURING_READ");
    const mint0 = pool.token_0_mint as PublicKey,
      mint1 = pool.token_1_mint as PublicKey;
    const zeroBase = mint0.equals(mint) && mint1.equals(new PublicKey(WSOL)),
      oneBase = mint1.equals(mint) && mint0.equals(new PublicKey(WSOL));
    if (!zeroBase && !oneBase) throw Error("RAYDIUM_POOL_MINT_MISMATCH");
    const program = new PublicKey(adapter.address),
      [authority, bump] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault_and_lp_mint_auth_seed")],
        program,
      );
    if (pool.auth_bump !== bump) throw Error("RAYDIUM_AUTHORITY_BUMP_MISMATCH");
    const baseMintProgram = (zeroBase ? pool.token_0_program : pool.token_1_program) as PublicKey,
      quoteProgram = (zeroBase ? pool.token_1_program : pool.token_0_program) as PublicKey;
    if (!baseMintProgram.equals(mintProgram) || !quoteProgram.equals(TOKEN_PROGRAM_ID))
      throw Error("RAYDIUM_VAULT_TOKEN_PROGRAM_MISMATCH");
    const expected0 = PublicKey.findProgramAddressSync(
        [Buffer.from("pool_vault"), poolKey.toBuffer(), mint0.toBuffer()],
        program,
      )[0],
      expected1 = PublicKey.findProgramAddressSync(
        [Buffer.from("pool_vault"), poolKey.toBuffer(), mint1.toBuffer()],
        program,
      )[0];
    if (!expected0.equals(pool.token_0_vault) || !expected1.equals(pool.token_1_vault))
      throw Error("RAYDIUM_VAULT_ADDRESS_MISMATCH");
    const baseAddress = zeroBase ? expected0 : expected1,
      quoteAddress = zeroBase ? expected1 : expected0;
    const baseVault = this.vaultInfo(
        baseAddress,
        zeroBase ? vault0Info : vault1Info,
        mint,
        authority,
        mintProgram,
      ),
      quoteVault = this.vaultInfo(
        quoteAddress,
        zeroBase ? vault1Info : vault0Info,
        new PublicKey(WSOL),
        authority,
        TOKEN_PROGRAM_ID,
      );
    const fees = zeroBase
      ? BigInt(String(pool.protocol_fees_token_1)) +
        BigInt(String(pool.fund_fees_token_1)) +
        BigInt(String(pool.creator_fees_token_1))
      : BigInt(String(pool.protocol_fees_token_0)) +
        BigInt(String(pool.fund_fees_token_0)) +
        BigInt(String(pool.creator_fees_token_0));
    const liquidity = positiveReserve(quoteVault.amount - fees);
    return {
      vaults: new Set([baseAddress.toBase58()]),
      liquidityLamports: liquidity,
      curveProgressBps: null,
      accessible:
        (Number(pool.status) & 4) === 0 &&
        BigInt(String(pool.open_time)) * 1000n <= BigInt(this.clock()) &&
        baseVault.amount > 0n &&
        liquidity > 0n,
      creator: (pool.pool_creator as PublicKey).toBase58(),
      slot: snapshot.slot,
    };
  }
  async inspect(
    event: ChainEvent,
    sellRoute: { available: boolean; at: number } | null,
  ): Promise<SecuritySnapshot> {
    const mintAddress = key(event.mint);
    const inspectionStartedAt = captureClock(this.clock());
    const e: SecurityEvidence = {
      mint: mintAddress.toBase58(),
      observedAt: inspectionStartedAt,
      evidenceRequestedAt: inspectionStartedAt,
      mintAuthority: undefined,
      freezeAuthority: undefined,
      tokenProgram: "unknown",
      extensionsVerified: false,
      extensions: [],
      transferFeeBps: null,
      permanentDelegate: undefined,
      transferRestricted: null,
      creatorConcentrationBps: null,
      topHolderConcentrationBps: null,
      knownMalicious: null,
      sellRouteAvailable: sellRoute?.available ?? null,
      sellRouteObservedAt: sellRoute?.at ?? null,
      liquidityAccessible: null,
      abnormalCreatorActivity: null,
      creatorAddress: event.creator ?? null,
      directCreatorConcentrationBps: null,
      creatorConcentrationScope: "DIRECT_OWNER_AND_DELEGATE_ONLY",
      creatorAssociationsVerified: false,
      creatorAssociatedConcentrationBps: null,
      mintSlot: null,
      holderSnapshotSlot: null,
      liquiditySlot: null,
    };
    const warnings: string[] = [];
    const result = await this.account(mintAddress, event.slot, MAX_CAPTURED_MINT_BYTES),
      account = result.account;
    if (result.requestedAt < inspectionStartedAt) throw Error("SECURITY_CAPTURE_CLOCK_REGRESSED");
    e.mintSlot = result.slot;
    if (!tokenPrograms.includes(account.owner.toBase58())) {
      const observedAt = captureClock(this.clock());
      if (observedAt < result.observedAt || result.requestedAt < inspectionStartedAt)
        throw Error("SECURITY_CAPTURE_CLOCK_REGRESSED");
      e.observedAt = observedAt;
      return {
        evidence: e,
        liquidityLamports: null,
        curveProgressBps: null,
        observedAt,
        warnings: ["UNSUPPORTED_MINT_OWNER"],
      };
    }
    if (account.data.length > MAX_CAPTURED_MINT_BYTES)
      throw Error("SECURITY_MINT_CAPTURE_TOO_LARGE");
    const rawMintCapture = {
      address: mintAddress.toBase58(),
      owner: account.owner.toBase58(),
      dataBase64: account.data.toString("base64"),
      slot: result.slot,
      requestedAt: result.requestedAt,
      observedAt: result.observedAt,
    };
    const mint = unpackMint(mintAddress, account, account.owner);
    if (!mint.isInitialized) throw Error("MINT_NOT_INITIALIZED");
    e.mintAuthority = mint.mintAuthority?.toBase58() ?? null;
    e.freezeAuthority = mint.freezeAuthority?.toBase58() ?? null;
    e.tokenProgram = account.owner.equals(TOKEN_PROGRAM_ID) ? "spl-token" : "token-2022";
    e.extensions = getExtensionTypes(mint.tlvData).map((t) => ExtensionType[t]);
    e.extensionsVerified = true;
    const transfer = getTransferFeeConfig(mint);
    e.transferFeeBps = transfer
      ? Math.max(
          transfer.olderTransferFee.transferFeeBasisPoints,
          transfer.newerTransferFee.transferFeeBasisPoints,
        )
      : 0;
    e.permanentDelegate = getPermanentDelegate(mint)?.delegate.toBase58() ?? null;
    e.transferRestricted = getDefaultAccountState(mint)?.state === 2;
    let pool: PoolEvidence | null = null;
    try {
      pool = await this.pool(event, account.owner, result.slot);
      e.liquidityAccessible = pool.accessible;
      e.liquiditySlot = pool.slot;
      if (pool.creator) e.creatorAddress = pool.creator;
    } catch {
      warnings.push("LIQUIDITY_STATE_UNAVAILABLE_OR_UNVERIFIED");
    }
    try {
      const owners = await this.rpc.call<ContextValue<{ pubkey: string; account: RpcAccount }[]>>(
        "getProgramAccounts",
        [
          account.owner.toBase58(),
          {
            encoding: "base64",
            commitment: "finalized",
            withContext: true,
            minContextSlot: result.slot,
            filters: [{ memcmp: { offset: 0, bytes: event.mint } }],
          },
        ],
      );
      const holderSlot = context(owners.context, result.slot);
      if (!Array.isArray(owners.value) || owners.value.length > 100000)
        throw Error("HOLDER_SNAPSHOT_UNBOUNDED");
      const totals = new Map<string, bigint>(),
        seen = new Set<string>();
      let accounted = 0n,
        creatorControlled = 0n;
      for (const holder of owners.value) {
        if (seen.has(holder.pubkey)) throw Error("DUPLICATE_TOKEN_ACCOUNT");
        seen.add(holder.pubkey);
        const token = unpackAccount(key(holder.pubkey), info(holder.account), account.owner);
        if (!token.isInitialized || !token.mint.equals(key(event.mint)))
          throw Error("INVALID_TOKEN_ACCOUNT_IN_SNAPSHOT");
        accounted += token.amount;
        if (pool?.vaults.has(holder.pubkey)) continue;
        const owner = token.owner.toBase58();
        totals.set(owner, (totals.get(owner) ?? 0n) + token.amount);
        if (e.creatorAddress && owner === e.creatorAddress) creatorControlled += token.amount;
        else if (e.creatorAddress && token.delegate?.toBase58() === e.creatorAddress)
          creatorControlled +=
            token.delegatedAmount < token.amount ? token.delegatedAmount : token.amount;
      }
      if (accounted !== mint.supply || mint.supply === 0n)
        throw Error("HOLDER_SUPPLY_NOT_RECONCILED");
      const top = [...totals.values()]
        .sort((a, b) => (a > b ? -1 : a < b ? 1 : 0))
        .slice(0, 10)
        .reduce((sum, value) => sum + value, 0n);
      // Round upward: a fractional excess must not be floored into a passing cap.
      e.topHolderConcentrationBps = Number((top * 10000n + mint.supply - 1n) / mint.supply);
      e.holderSnapshotSlot = holderSlot;
      if (e.creatorAddress) {
        e.directCreatorConcentrationBps = Number(
          (creatorControlled * 10000n + mint.supply - 1n) / mint.supply,
        );
        e.creatorConcentrationBps = e.directCreatorConcentrationBps;
      }
    } catch {
      warnings.push("FULL_HOLDER_DISTRIBUTION_UNAVAILABLE_OR_UNVERIFIED");
    }
    const deny = new Set(
      (process.env.PHANTOM_DENYLIST ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    );
    e.knownMalicious =
      deny.has(event.mint) || deny.has(event.creator ?? "") || deny.has(e.creatorAddress ?? "");
    warnings.push(
      "REPUTATION_CHECK_SCOPE_LOCAL_DENYLIST_ONLY",
      "CREATOR_ASSOCIATED_SUPPLY_UNVERIFIED_DIRECT_CREATOR_ONLY",
      "LP_WITHDRAWAL_CONTROL_NOT_CERTIFIED",
      "CREATOR_BEHAVIOR_REQUIRES_POINT_IN_TIME_WALLET_GRAPH",
    );
    const observedAt = captureClock(this.clock());
    if (observedAt < result.observedAt || result.requestedAt < inspectionStartedAt)
      throw Error("SECURITY_CAPTURE_CLOCK_REGRESSED");
    e.observedAt = observedAt;
    return {
      evidence: e,
      liquidityLamports: pool?.liquidityLamports ?? null,
      curveProgressBps: pool?.curveProgressBps ?? null,
      observedAt,
      warnings,
      mintAccountCapture: Object.freeze({ ...rawMintCapture, publishedAt: observedAt }),
    };
  }
}

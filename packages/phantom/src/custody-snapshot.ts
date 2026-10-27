import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID, NATIVE_MINT, unpackAccount, unpackMint } from "@solana/spl-token";
import { CUSTODY_ARITHMETIC_KIND, custodyRaw, evaluateCustodyArithmetic } from "./custody-bound.ts";

/** Read-only research, deliberately independent of Engine, credentials and ledger. */
export const CPMM_PROGRAM = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
export const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
export const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const REVIEWED_CPMM_SOURCE = "f4b9b26342afe9122d5ff67cd7a4f19ded4ac0a5";
export const CLOCK_SYSVAR = new PublicKey("SysvarC1ock11111111111111111111111111111111");
const SYSVAR_OWNER = new PublicKey("Sysvar1111111111111111111111111111111111111");
const idlBytes = readFileSync(new URL("../vendor/raydium_cp_swap.json", import.meta.url));
const idl = JSON.parse(idlBytes.toString("utf8")) as Idl;
const coder = new BorshAccountsCoder(idl);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const raw = (value: unknown) => custodyRaw(String(value));
const key = (value: string) => {
  const parsed = new PublicKey(value);
  if (parsed.toBase58() !== value) throw Error("CUSTODY_ADDRESS_NONCANONICAL");
  return parsed;
};
const pda = (seed: string, ...parts: PublicKey[]) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from(seed), ...parts.map((p) => p.toBuffer())],
    CPMM_PROGRAM,
  );
export const cpmmProgramData = () =>
  PublicKey.findProgramAddressSync([CPMM_PROGRAM.toBuffer()], UPGRADEABLE_LOADER)[0];
const instant = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

export type CustodyRpcAccount = {
  owner: string;
  data: [string, "base64"];
  executable: boolean;
  lamports: number;
  rentEpoch?: number;
};
type AccountResponse<T> = { context: { slot: number }; value: T };
export type CpmmRawCapture = {
  kind: "RAYDIUM_CPMM_RAW_SNAPSHOT_V1";
  chainGenesisHash: string;
  baseMint: string;
  pool: string;
  requestedAt: number;
  receivedAt: number;
  request: {
    method: "getMultipleAccounts";
    addresses: string[];
    config: { encoding: "base64"; commitment: "finalized"; minContextSlot: number };
  };
  response: AccountResponse<(CustodyRpcAccount | null)[]>;
};
export interface CustodyReadRpc {
  call<T>(
    method: "getGenesisHash" | "getAccountInfo" | "getMultipleAccounts",
    params: unknown[],
  ): Promise<T>;
}
export function inspectCpmmProgramIdentity(
  programAccount: CustodyRpcAccount | null,
  programDataAccount: CustodyRpcAccount | null,
  snapshotSlot: number,
) {
  if (!instant(snapshotSlot)) throw Error("CUSTODY_PROGRAM_SNAPSHOT_SLOT_INVALID");
  const program = account(programAccount),
    programData = account(programDataAccount);
  if (
    !program.owner.equals(UPGRADEABLE_LOADER) ||
    !program.executable ||
    program.data.length !== 36 ||
    program.data.readUInt32LE(0) !== 2 ||
    !new PublicKey(program.data.subarray(4, 36)).equals(cpmmProgramData()) ||
    !programData.owner.equals(UPGRADEABLE_LOADER) ||
    programData.executable ||
    programData.data.length <= 45 ||
    programData.data.readUInt32LE(0) !== 3 ||
    programData.data[12] > 1
  )
    throw Error("CUSTODY_UPGRADEABLE_PROGRAM_IDENTITY_INVALID");
  const deploymentSlot = programData.data.readBigUInt64LE(4);
  if (deploymentSlot >= BigInt(snapshotSlot)) throw Error("CUSTODY_DEPLOYMENT_NOT_YET_ACTIVE");
  const payload = programData.data.subarray(45);
  let end = payload.length;
  while (end > 0 && payload[end - 1] === 0) end--;
  if (end === 0) throw Error("CUSTODY_EXECUTABLE_EMPTY");
  return {
    programId: CPMM_PROGRAM.toBase58(),
    programDataAddress: cpmmProgramData().toBase58(),
    deploymentSlot: deploymentSlot.toString(),
    upgradeAuthority:
      programData.data[12] === 1
        ? new PublicKey(programData.data.subarray(13, 45)).toBase58()
        : null,
    rawPayloadSha256IncludingPadding: sha(payload),
    normalizedExecutableSha256: sha(payload.subarray(0, end)),
    hashNormalization: "LOADER_V3_HEADER_45_BYTES_TRIM_TRAILING_ZEROS_SHA256" as const,
    reviewedBuildMatchVerified: false as const,
  };
}
function account(value: CustodyRpcAccount | null): AccountInfo<Buffer> {
  if (
    !value ||
    typeof value.executable !== "boolean" ||
    !instant(value.lamports) ||
    !Array.isArray(value.data) ||
    value.data.length !== 2 ||
    value.data[1] !== "base64" ||
    typeof value.data[0] !== "string" ||
    value.data[0].length > 16_000_000
  )
    throw Error("CUSTODY_RPC_ACCOUNT_INVALID");
  const data = Buffer.from(value.data[0], "base64");
  if (data.toString("base64") !== value.data[0]) throw Error("CUSTODY_BASE64_NONCANONICAL");
  // rentEpoch is not used: real RPC often serializes u64::MAX as an unsafe JS number.
  return {
    data,
    owner: key(value.owner),
    lamports: value.lamports,
    executable: value.executable,
    rentEpoch: 0,
  };
}
function exactLayout(name: "PoolState" | "AmmConfig", info: AccountInfo<Buffer>) {
  const definition = idl.types!.find((t) => t.name === name)!.type as {
    fields: Array<{ type: string | { array: [string, number] } }>;
  };
  const width = (type: string): number => {
    if (type === "pubkey") return 32;
    if (type === "bool") return 1;
    if (/^u(8|16|32|64|128)$/.test(type)) return Number(type.slice(1)) / 8;
    throw Error("CUSTODY_IDL_LAYOUT_UNSUPPORTED");
  };
  let offset = 8;
  for (const field of definition.fields) {
    if (field.type === "bool" && info.data[offset] > 1)
      throw Error("CUSTODY_BOOL_ENCODING_INVALID");
    offset +=
      typeof field.type === "string"
        ? width(field.type)
        : width(field.type.array[0]) * field.type.array[1];
  }
  if (!info.owner.equals(CPMM_PROGRAM) || info.executable || info.data.length !== offset)
    throw Error("CUSTODY_STATE_OWNER_OR_LAYOUT_INVALID");
  return coder.decode(name, info.data) as Record<string, any>;
}
function mappings(poolAddress: PublicKey, pool: Record<string, any>, base: PublicKey) {
  const m0 = pool.token_0_mint as PublicKey,
    m1 = pool.token_1_mint as PublicKey;
  const baseIs0 = m0.equals(base) && m1.equals(NATIVE_MINT);
  const baseIs1 = m1.equals(base) && m0.equals(NATIVE_MINT);
  if ((!baseIs0 && !baseIs1) || Buffer.compare(m0.toBuffer(), m1.toBuffer()) >= 0)
    throw Error("CUSTODY_SOL_PAIR_OR_MINT_ORDER_INVALID");
  const [authority, bump] = pda("vault_and_lp_mint_auth_seed");
  const lp = pda("pool_lp_mint", poolAddress)[0];
  const v0 = pda("pool_vault", poolAddress, m0)[0],
    v1 = pda("pool_vault", poolAddress, m1)[0];
  if (
    pool.auth_bump !== bump ||
    !lp.equals(pool.lp_mint) ||
    !v0.equals(pool.token_0_vault) ||
    !v1.equals(pool.token_1_vault) ||
    !pool.token_0_program.equals(TOKEN_PROGRAM_ID) ||
    !pool.token_1_program.equals(TOKEN_PROGRAM_ID)
  )
    throw Error("CUSTODY_POOL_PDA_OR_TOKEN_PROGRAM_INVALID");
  return {
    authority,
    baseIs0,
    lp,
    addresses: [
      poolAddress,
      base,
      NATIVE_MINT,
      lp,
      baseIs0 ? v0 : v1,
      baseIs0 ? v1 : v0,
      pool.amm_config as PublicKey,
      CPMM_PROGRAM,
      cpmmProgramData(),
      CLOCK_SYSVAR,
    ].map((p) => p.toBase58()),
  };
}

/** Three read calls, no retries. Save the returned response before inspection, including invalid/missing accounts. */
export async function captureCpmmSnapshot(
  rpc: CustodyReadRpc,
  poolAddress: string,
  baseMint: string,
  clock: () => number = Date.now,
): Promise<CpmmRawCapture> {
  const poolKey = key(poolAddress),
    baseKey = key(baseMint);
  const genesis = await rpc.call<string>("getGenesisHash", []);
  if (genesis !== MAINNET_GENESIS) throw Error("CUSTODY_MAINNET_REQUIRED");
  const discovery = await rpc.call<AccountResponse<CustodyRpcAccount | null>>("getAccountInfo", [
    poolAddress,
    { encoding: "base64", commitment: "finalized" },
  ]);
  if (!instant(discovery.context?.slot)) throw Error("CUSTODY_DISCOVERY_SLOT_INVALID");
  const initial = exactLayout("PoolState", account(discovery.value));
  const { addresses } = mappings(poolKey, initial, baseKey);
  const config = {
    encoding: "base64" as const,
    commitment: "finalized" as const,
    minContextSlot: discovery.context.slot,
  };
  const requestedAt = clock();
  const response = await rpc.call<CpmmRawCapture["response"]>("getMultipleAccounts", [
    addresses,
    config,
  ]);
  const receivedAt = clock();
  const capture: CpmmRawCapture = {
    kind: "RAYDIUM_CPMM_RAW_SNAPSHOT_V1",
    chainGenesisHash: genesis,
    baseMint,
    pool: poolAddress,
    requestedAt,
    receivedAt,
    request: { method: "getMultipleAccounts", addresses, config },
    response,
  };
  return capture;
}

/**
 * Replays a saved RPC response at its decision time. Passing this checker validates
 * schema, account mappings and conditional arithmetic, not RPC authenticity or a
 * reviewed-source/deployed-byte match. Applied exclusion is therefore always zero.
 */
export function inspectCpmmSnapshot(capture: CpmmRawCapture, decisionAt: number) {
  if (
    capture.kind !== "RAYDIUM_CPMM_RAW_SNAPSHOT_V1" ||
    capture.chainGenesisHash !== MAINNET_GENESIS ||
    ![capture.requestedAt, capture.receivedAt, decisionAt].every(instant) ||
    capture.requestedAt > capture.receivedAt ||
    capture.receivedAt > decisionAt ||
    decisionAt - capture.requestedAt > 30_000 ||
    capture.request?.method !== "getMultipleAccounts" ||
    capture.request.config?.encoding !== "base64" ||
    capture.request.config?.commitment !== "finalized" ||
    !instant(capture.request.config.minContextSlot) ||
    !instant(capture.response?.context?.slot) ||
    capture.response.context.slot < capture.request.config.minContextSlot ||
    !Array.isArray(capture.request.addresses) ||
    capture.request.addresses.length !== 10 ||
    new Set(capture.request.addresses).size !== 10 ||
    !Array.isArray(capture.response.value) ||
    capture.response.value.length !== 10
  )
    throw Error("CUSTODY_SNAPSHOT_CONTEXT_OR_TIMING_INVALID");
  const infos = capture.response.value.map(account);
  const pool = exactLayout("PoolState", infos[0]);
  const map = mappings(key(capture.pool), pool, key(capture.baseMint));
  if (map.addresses.some((address, i) => address !== capture.request.addresses[i]))
    throw Error("CUSTODY_ACCOUNT_MAPPING_CHANGED_OR_MISMATCHED");
  const bankClock = infos[9];
  if (
    !bankClock.owner.equals(SYSVAR_OWNER) ||
    bankClock.executable ||
    bankClock.data.length !== 40 ||
    bankClock.data.readBigUInt64LE(0) !== BigInt(capture.response.context.slot)
  )
    throw Error("CUSTODY_BANK_CLOCK_SLOT_OR_LAYOUT_INVALID");
  const bankUnixTimestamp = bankClock.data.readBigInt64LE(32),
    bankAtMs = bankUnixTimestamp * 1000n;
  if (
    bankUnixTimestamp < 0n ||
    bankAtMs > BigInt(decisionAt) + 2000n ||
    BigInt(decisionAt) - bankAtMs > 30_000n
  )
    throw Error("CUSTODY_BANK_CLOCK_STALE_OR_FUTURE");
  const config = exactLayout("AmmConfig", infos[6]);
  const configIndex = Buffer.alloc(2);
  configIndex.writeUInt16BE(config.index);
  const [configAddress, configBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("amm_config"), configIndex],
    CPMM_PROGRAM,
  );
  if (!configAddress.equals(pool.amm_config) || config.bump !== configBump)
    throw Error("CUSTODY_CONFIG_PDA_INVALID");
  if (
    pool.padding.some((n: any) => raw(n) !== 0n) ||
    pool.padding1.some((n: number) => n !== 0) ||
    config.padding.some((n: any) => raw(n) !== 0n) ||
    pool.creator_fee_on > 2 ||
    pool.status > 7
  )
    throw Error("CUSTODY_UNREVIEWED_STATE_FLAGS_OR_PADDING");
  if (
    raw(config.trade_fee_rate) + raw(config.creator_fee_rate) >= 1_000_000n ||
    raw(config.protocol_fee_rate) + raw(config.fund_fee_rate) > 1_000_000n
  )
    throw Error("CUSTODY_FEE_CONFIGURATION_UNSUPPORTED");
  const mintAt = (i: number) => {
    if (
      !infos[i].owner.equals(TOKEN_PROGRAM_ID) ||
      infos[i].executable ||
      infos[i].data.length !== 82
    )
      throw Error("CUSTODY_LEGACY_MINT_REQUIRED");
    if (
      infos[i].data.readUInt32LE(0) > 1 ||
      infos[i].data.readUInt32LE(46) > 1 ||
      infos[i].data[45] !== 1
    )
      throw Error("CUSTODY_MINT_ENCODING_INVALID");
    const mint = unpackMint(key(map.addresses[i]), infos[i], TOKEN_PROGRAM_ID);
    if (!mint.isInitialized || mint.freezeAuthority !== null)
      throw Error("CUSTODY_MINT_STATE_UNSAFE");
    return mint;
  };
  const base = mintAt(1),
    quote = mintAt(2),
    lp = mintAt(3);
  if (
    base.mintAuthority !== null ||
    quote.mintAuthority !== null ||
    quote.decimals !== 9 ||
    !lp.mintAuthority?.equals(map.authority) ||
    lp.decimals !== 9 ||
    pool.lp_mint_decimals !== lp.decimals ||
    (map.baseIs0 ? pool.mint_0_decimals : pool.mint_1_decimals) !== base.decimals ||
    (map.baseIs0 ? pool.mint_1_decimals : pool.mint_0_decimals) !== quote.decimals
  )
    throw Error("CUSTODY_MINT_AUTHORITY_OR_DECIMALS_INVALID");
  const vaultAt = (i: number, mint: PublicKey, native: boolean) => {
    if (
      !infos[i].owner.equals(TOKEN_PROGRAM_ID) ||
      infos[i].executable ||
      infos[i].data.length !== 165
    )
      throw Error("CUSTODY_LEGACY_VAULT_REQUIRED");
    if (
      infos[i].data[108] !== 1 ||
      infos[i].data.readUInt32LE(72) > 1 ||
      infos[i].data.readUInt32LE(109) > 1 ||
      infos[i].data.readUInt32LE(129) > 1
    )
      throw Error("CUSTODY_VAULT_ENCODING_INVALID");
    const vault = unpackAccount(key(map.addresses[i]), infos[i], TOKEN_PROGRAM_ID);
    if (
      !vault.isInitialized ||
      vault.isFrozen ||
      !vault.owner.equals(map.authority) ||
      !vault.mint.equals(mint) ||
      vault.delegate !== null ||
      vault.delegatedAmount !== 0n ||
      vault.closeAuthority !== null ||
      vault.isNative !== native
    )
      throw Error("CUSTODY_VAULT_STATE_UNSAFE");
    if (
      native &&
      (vault.rentExemptReserve === null ||
        vault.amount + vault.rentExemptReserve > BigInt(infos[i].lamports))
    )
      throw Error("CUSTODY_WRAPPED_SOL_BACKING_INVALID");
    return vault;
  };
  const baseVault = vaultAt(4, key(capture.baseMint), false),
    quoteVault = vaultAt(5, NATIVE_MINT, true);
  const side = map.baseIs0 ? "0" : "1",
    other = map.baseIs0 ? "1" : "0";
  const input = {
    kind: CUSTODY_ARITHMETIC_KIND,
    amounts: {
      baseSupplyRaw: base.supply.toString(),
      baseVaultRaw: baseVault.amount.toString(),
      baseProtocolFeesRaw: raw(pool[`protocol_fees_token_${side}`]).toString(),
      baseFundFeesRaw: raw(pool[`fund_fees_token_${side}`]).toString(),
      baseCreatorFeesRaw: raw(pool[`creator_fees_token_${side}`]).toString(),
      quoteVaultRaw: quoteVault.amount.toString(),
      quoteProtocolFeesRaw: raw(pool[`protocol_fees_token_${other}`]).toString(),
      quoteFundFeesRaw: raw(pool[`fund_fees_token_${other}`]).toString(),
      quoteCreatorFeesRaw: raw(pool[`creator_fees_token_${other}`]).toString(),
      internalLpSupplyRaw: raw(pool.lp_supply).toString(),
      actualLpSupplyRaw: lp.supply.toString(),
    },
  };
  const arithmetic = evaluateCustodyArithmetic(input);
  if (BigInt(arithmetic.amounts.unmintedOrBurnedLpRaw) < 100n)
    throw Error("CUSTODY_SOURCE_LINEAGE_MINIMUM_LP_GAP_MISSING");
  const programIdentity = inspectCpmmProgramIdentity(
    capture.response.value[7],
    capture.response.value[8],
    capture.response.context.slot,
  );
  const swapOpen = (pool.status & 4) === 0 && raw(pool.open_time) <= bankUnixTimestamp;
  return {
    kind: "VALIDATED_ACCOUNT_SNAPSHOT_CONDITIONAL_ON_PROGRAM_SEMANTICS" as const,
    captureJsonSha256: sha(Buffer.from(JSON.stringify(capture))),
    snapshotSlot: capture.response.context.slot,
    requestedAt: capture.requestedAt,
    availableAt: capture.receivedAt,
    decisionAt,
    bankUnixTimestamp: bankUnixTimestamp.toString(),
    maximumBankAgeMs: 30_000,
    maximumFutureBankClockSkewMs: 2000,
    baseMint: capture.baseMint,
    pool: capture.pool,
    scope: "CURRENT_PRINCIPAL_CLAIMS_WITHOUT_NEW_CONSIDERATION" as const,
    reviewedSourceCommit: REVIEWED_CPMM_SOURCE,
    idlSha256: sha(idlBytes),
    accounts: map.addresses.map((address, i) => ({
      address,
      owner: infos[i].owner.toBase58(),
      dataSha256: sha(infos[i].data),
    })),
    programIdentity,
    arithmeticInput: input,
    arithmetic,
    swapOpen,
    conditionalCandidate: arithmetic.arithmeticCandidate && swapOpen,
    appliedExcludedPrincipalRaw: "0",
    appliedCreatorSupplyUpperRaw: base.supply.toString(),
    blockers: [
      "REVIEWED_SOURCE_DEPLOYED_BYTE_MATCH_UNVERIFIED",
      "RPC_RESPONSE_AUTHENTICITY_NOT_PROVEN_BY_OFFLINE_CHECKER",
    ],
    creatorAssociationsVerified: false as const,
    tradable: false as const,
    liveApproved: false as const,
  };
}

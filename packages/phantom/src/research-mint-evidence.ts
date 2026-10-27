import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import {
  AccountType,
  ExtensionType,
  MINT_SIZE,
  ACCOUNT_SIZE,
  MULTISIG_SIZE,
  MintLayout,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  isMintExtension,
  METADATA_POINTER_SIZE,
} from "@solana/spl-token";

/** Offline, bounded decoding only. These bytes are not an RPC or deployment attestation. */
export interface ResearchMintAccountCapture {
  address: string;
  owner: string;
  dataBase64: string;
  slot: number;
  requestedAt: number;
  observedAt: number;
  publishedAt: number;
}

export const MAX_RESEARCH_MINT_ACCOUNT_BYTES = 65_536;
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fail = (code: string): never => {
  throw Error(`RESEARCH_MINT_${code}`);
};
const clock = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function publicKey(value: unknown): PublicKey {
  if (typeof value !== "string") return fail("PUBLIC_KEY_INVALID");
  try {
    const key = new PublicKey(value);
    if (key.toBase58() !== value) return fail("PUBLIC_KEY_INVALID");
    return key;
  } catch {
    return fail("PUBLIC_KEY_INVALID");
  }
}

/**
 * TokenMetadata is variable-length, not a fixed ExtensionType.getTypeLen record.
 * Layout: optional-nonzero authority[32], mint[32], 3 Borsh UTF-8 strings, then
 * Vec<(String,String)>. Matches @solana/spl-token-metadata@0.1.6/src/state.ts.
 * Bound lengths before decoding/iterating; do not allocate from untrusted counts.
 */
function validateTokenMetadata(data: Buffer, mint: PublicKey): void {
  if (data.length < 80) return fail("METADATA_LAYOUT_INVALID");
  if (!new PublicKey(data.subarray(32, 64)).equals(mint)) return fail("METADATA_MINT_MISMATCH");
  let cursor = 64;
  const u32 = () => {
    if (cursor + 4 > data.length) return fail("METADATA_LAYOUT_INVALID");
    const value = data.readUInt32LE(cursor);
    cursor += 4;
    return value;
  };
  const string = () => {
    const length = u32();
    if (length > data.length - cursor) return fail("METADATA_LAYOUT_INVALID");
    const bytes = data.subarray(cursor, cursor + length);
    cursor += length;
    try {
      return utf8.decode(bytes);
    } catch {
      return fail("METADATA_UTF8_INVALID");
    }
  };
  string();
  string();
  string();
  const count = u32();
  if (count > Math.floor((data.length - cursor) / 8)) return fail("METADATA_LAYOUT_INVALID");
  const keys = new Set<string>();
  for (let i = 0; i < count; i++) {
    const key = string();
    string();
    if (keys.has(key)) return fail("METADATA_DUPLICATE_KEY");
    keys.add(key);
  }
  if (cursor !== data.length) return fail("METADATA_LAYOUT_INVALID");
}

/** Strict subset of Token-2022 TLV. Unallocated space must be an all-zero tail. */
function decodeExtensions(data: Buffer, mint: PublicKey) {
  if (data.length === MINT_SIZE) return { extensions: [] as string[], unallocatedTlvBytes: 0 };
  if (
    data.length <= ACCOUNT_SIZE ||
    data.length === MULTISIG_SIZE ||
    data[ACCOUNT_SIZE] !== AccountType.Mint ||
    data.subarray(MINT_SIZE, ACCOUNT_SIZE).some((b) => b !== 0)
  )
    return fail("EXTENDED_LAYOUT_INVALID");
  const ids = new Set<number>();
  let cursor = ACCOUNT_SIZE + 1,
    unallocatedTlvBytes = 0;
  while (cursor < data.length) {
    const remaining = data.length - cursor;
    if (remaining < 2) return fail("TLV_TRUNCATED");
    const type = data.readUInt16LE(cursor);
    if (type === ExtensionType.Uninitialized) {
      // Includes the protocol's two-byte padding when packed size would be 355.
      // Rust permits unused tail allocation. Never let it hide a later payload.
      if (data.subarray(cursor).some((b) => b !== 0)) return fail("TLV_PADDING_INVALID");
      unallocatedTlvBytes = remaining;
      break;
    }
    if (remaining < 4) return fail("TLV_TRUNCATED");
    const length = data.readUInt16LE(cursor + 2),
      start = cursor + 4;
    if (length > data.length - start) return fail("TLV_TRUNCATED");
    if (ids.has(type)) return fail("TLV_DUPLICATE_EXTENSION");
    let mintExtension: boolean;
    try {
      mintExtension = isMintExtension(type);
    } catch {
      return fail("TLV_UNKNOWN_EXTENSION");
    }
    if (!mintExtension) return fail("ACCOUNT_EXTENSION_UNSUPPORTED");
    if (type !== ExtensionType.MetadataPointer && type !== ExtensionType.TokenMetadata)
      return fail("EXTENSION_UNSUPPORTED");
    const payload = data.subarray(start, start + length);
    if (type === ExtensionType.MetadataPointer && length !== METADATA_POINTER_SIZE)
      return fail("METADATA_POINTER_LENGTH_INVALID");
    if (type === ExtensionType.TokenMetadata) validateTokenMetadata(payload, mint);
    ids.add(type);
    cursor = start + length;
  }
  // The on-mint metadata initializer requires a MetadataPointer extension.
  // The current pointer may be external/null: it is mutable and is not fetched.
  if (ids.has(ExtensionType.TokenMetadata) && !ids.has(ExtensionType.MetadataPointer))
    return fail("METADATA_POINTER_REQUIRED");
  return {
    extensions: [...ids].sort((a, b) => a - b).map((type) => ExtensionType[type]),
    unallocatedTlvBytes,
  };
}

export interface ResearchMintEvidence {
  readonly kind: "DECODED_RESEARCH_MINT_CAPTURE_NOT_ATTESTED";
  readonly mint: string;
  readonly address: string;
  readonly tokenProgram: "spl-token" | "token-2022";
  readonly requestedAt: number;
  readonly observedAt: number;
  readonly publishedAt: number;
  readonly slot: number;
  readonly initialized: true;
  readonly mintAuthority: string | null;
  readonly freezeAuthority: string | null;
  readonly extensions: readonly string[];
  readonly transferFeeBps: 0;
  readonly permanentDelegate: null;
  readonly transferRestricted: false;
  readonly mintSupplyRaw: string;
  readonly decimals: number;
  readonly unallocatedTlvBytes: number;
  readonly rawAccountSha256: string;
  readonly captureSha256: string;
  readonly decoderLibrary: "@solana/spl-token@0.4.15";
  readonly provenanceScope: "CALLER_SUPPLIED_RAW_ACCOUNT_NOT_ATTESTED";
}

/**
 * expectedObservedAt binds the raw response completion time, not the later whole
 * security snapshot publication. No clock freshness, wallet safety, metadata
 * truth or chain authenticity is inferred.
 * The consumer must bind this detached result to its frozen policy and decision time.
 * Active authorities are retained, not replaced with null. Unsupported extensions
 * throw even when their fee/authority/configuration bytes happen to be zero.
 * Sources: solana.com/docs/tokens/extensions/metadata; spl-token@0.4.15 mint.ts,
 * extensionType.ts; token-2022/interface/src/extension/mod.rs (padding/TLV layout).
 */
export function verifyResearchMintCapture(
  capture: ResearchMintAccountCapture,
  expectedMint: string,
  expectedObservedAt: number,
): ResearchMintEvidence {
  if (
    !capture ||
    typeof capture !== "object" ||
    Array.isArray(capture) ||
    Object.keys(capture).sort().join(",") !==
      "address,dataBase64,observedAt,owner,publishedAt,requestedAt,slot"
  )
    return fail("CAPTURE_SHAPE_INVALID");
  let c: ResearchMintAccountCapture;
  try {
    c = structuredClone(capture);
  } catch {
    return fail("CAPTURE_SHAPE_INVALID");
  }
  const mint = publicKey(c.address),
    expected = publicKey(expectedMint),
    owner = publicKey(c.owner);
  if (!mint.equals(expected)) return fail("IDENTITY_MISMATCH");
  if (
    !clock(c.slot) ||
    !clock(c.requestedAt) ||
    !clock(c.observedAt) ||
    !clock(c.publishedAt) ||
    !clock(expectedObservedAt) ||
    c.observedAt !== expectedObservedAt ||
    c.requestedAt > c.observedAt ||
    c.observedAt > c.publishedAt
  )
    return fail("CAPTURE_CLOCK_INVALID");
  const legacy = owner.equals(TOKEN_PROGRAM_ID);
  if (!legacy && !owner.equals(TOKEN_2022_PROGRAM_ID)) return fail("OWNER_UNSUPPORTED");
  if (
    typeof c.dataBase64 !== "string" ||
    c.dataBase64.length === 0 ||
    c.dataBase64.length > 4 * Math.ceil(MAX_RESEARCH_MINT_ACCOUNT_BYTES / 3)
  )
    return fail("BASE64_INVALID_OR_OVERSIZE");
  const data = Buffer.from(c.dataBase64, "base64");
  if (data.toString("base64") !== c.dataBase64 || data.length > MAX_RESEARCH_MINT_ACCOUNT_BYTES)
    return fail("BASE64_INVALID_OR_OVERSIZE");
  if (data.length < MINT_SIZE || (legacy && data.length !== MINT_SIZE))
    return fail("BASE_LAYOUT_INVALID");
  if (data.readUInt32LE(0) > 1 || data.readUInt32LE(46) > 1 || data[45] > 1)
    return fail("BASE_ENCODING_INVALID");
  if (data[45] !== 1) return fail("UNINITIALIZED");
  const ext = legacy
    ? { extensions: [] as string[], unallocatedTlvBytes: 0 }
    : decodeExtensions(data, mint);
  let state: ReturnType<typeof MintLayout.decode>;
  try {
    state = MintLayout.decode(data.subarray(0, MINT_SIZE));
  } catch {
    return fail("BASE_LAYOUT_INVALID");
  }
  return Object.freeze({
    kind: "DECODED_RESEARCH_MINT_CAPTURE_NOT_ATTESTED",
    mint: c.address,
    address: c.address,
    tokenProgram: legacy ? "spl-token" : "token-2022",
    requestedAt: c.requestedAt,
    observedAt: c.observedAt,
    publishedAt: c.publishedAt,
    slot: c.slot,
    initialized: true,
    mintAuthority: state.mintAuthorityOption === 0 ? null : state.mintAuthority.toBase58(),
    freezeAuthority: state.freezeAuthorityOption === 0 ? null : state.freezeAuthority.toBase58(),
    extensions: Object.freeze(ext.extensions),
    transferFeeBps: 0,
    permanentDelegate: null,
    transferRestricted: false,
    mintSupplyRaw: state.supply.toString(),
    decimals: state.decimals,
    unallocatedTlvBytes: ext.unallocatedTlvBytes,
    rawAccountSha256: sha(data),
    captureSha256: sha(
      JSON.stringify({
        address: c.address,
        owner: c.owner,
        dataBase64: c.dataBase64,
        slot: c.slot,
        requestedAt: c.requestedAt,
        observedAt: c.observedAt,
        publishedAt: c.publishedAt,
      }),
    ),
    decoderLibrary: "@solana/spl-token@0.4.15",
    provenanceScope: "CALLER_SUPPLIED_RAW_ACCOUNT_NOT_ATTESTED",
  });
}

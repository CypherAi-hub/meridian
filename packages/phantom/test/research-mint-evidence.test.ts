/** Synthetic offline mint bytes only. No RPC, wallet, signature or chain attestation. */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import {
  MintLayout,
  MINT_SIZE,
  ACCOUNT_SIZE,
  MULTISIG_SIZE,
  AccountType,
  ExtensionType,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getMintLen,
  getTypeLen,
  unpackMint,
} from "@solana/spl-token";
import {
  pack as packMetadata,
  unpack as unpackMetadata,
  type TokenMetadata,
} from "@solana/spl-token-metadata";
import {
  verifyResearchMintCapture,
  MAX_RESEARCH_MINT_ACCOUNT_BYTES,
  type ResearchMintAccountCapture,
} from "../src/research-mint-evidence.ts";

const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
const MINT = key(7),
  AUTHORITY = key(9),
  NOW = 100_000;
function mint(authority: PublicKey | null = null, freeze: PublicKey | null = null) {
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    {
      mintAuthorityOption: authority ? 1 : 0,
      mintAuthority: authority ?? PublicKey.default,
      supply: 18_446_744_073_709_551_615n,
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: freeze ? 1 : 0,
      freezeAuthority: freeze ?? PublicKey.default,
    },
    data,
  );
  return data;
}
function tlv(type: number, value: Buffer = Buffer.alloc(0)) {
  const header = Buffer.alloc(4);
  header.writeUInt16LE(type);
  header.writeUInt16LE(value.length, 2);
  return Buffer.concat([header, value]);
}
const pointer = () =>
  tlv(ExtensionType.MetadataPointer, Buffer.concat([AUTHORITY.toBuffer(), MINT.toBuffer()]));
function metadata(patch: Partial<TokenMetadata> = {}) {
  return Buffer.from(
    packMetadata({
      mint: MINT,
      name: "Synthetic token",
      symbol: "SYN",
      uri: "https://example.invalid/token.json",
      additionalMetadata: [["description", "Synthetic offline fixture"]],
      ...patch,
    }),
  );
}
function extended(entries: Buffer[], tail: Buffer = Buffer.alloc(0)) {
  return Buffer.concat([
    mint(),
    Buffer.alloc(ACCOUNT_SIZE - MINT_SIZE),
    Buffer.from([AccountType.Mint]),
    ...entries,
    tail,
  ]);
}
const capture = (data: Buffer = mint(), owner = TOKEN_PROGRAM_ID): ResearchMintAccountCapture => ({
  address: MINT.toBase58(),
  owner: owner.toBase58(),
  dataBase64: data.toString("base64"),
  slot: 123,
  requestedAt: NOW - 10,
  observedAt: NOW,
  publishedAt: NOW + 10,
});
const decode = (data: Buffer, owner = TOKEN_2022_PROGRAM_ID) =>
  verifyResearchMintCapture(capture(data, owner), MINT.toBase58(), NOW);
function replace(c: ResearchMintAccountCapture, mutate: (data: Buffer) => void) {
  const data = Buffer.from(c.dataBase64, "base64");
  mutate(data);
  c.dataBase64 = data.toString("base64");
  return c;
}

describe("bounded raw research mint evidence", () => {
  it("decodes a canonical legacy mint and retains exact supply and explicit provenance", () => {
    const c = capture(),
      result = verifyResearchMintCapture(c, MINT.toBase58(), NOW);
    expect(result).toMatchObject({
      mint: c.address,
      address: c.address,
      tokenProgram: "spl-token",
      initialized: true,
      requestedAt: NOW - 10,
      observedAt: NOW,
      publishedAt: NOW + 10,
      slot: 123,
      mintAuthority: null,
      freezeAuthority: null,
      extensions: [],
      transferFeeBps: 0,
      permanentDelegate: null,
      transferRestricted: false,
      mintSupplyRaw: "18446744073709551615",
      decimals: 6,
      decoderLibrary: "@solana/spl-token@0.4.15",
      provenanceScope: "CALLER_SUPPLIED_RAW_ACCOUNT_NOT_ATTESTED",
    });
    expect(result.rawAccountSha256).toBe(createHash("sha256").update(mint()).digest("hex"));
    expect(result.captureSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result).not.toHaveProperty("allowed");
    expect(result).not.toHaveProperty("liveApproved");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.extensions)).toBe(true);
  });
  it("retains active mint/freeze authorities for a separate policy veto", () => {
    const result = decode(mint(AUTHORITY, key(10)), TOKEN_PROGRAM_ID);
    expect(result.mintAuthority).toBe(AUTHORITY.toBase58());
    expect(result.freezeAuthority).toBe(key(10).toBase58());
  });
  it("does not infer an authority from the unused body of a None COption", () => {
    const c = replace(capture(), (data) => {
      AUTHORITY.toBuffer().copy(data, 4);
      AUTHORITY.toBuffer().copy(data, 50);
    });
    expect(verifyResearchMintCapture(c, c.address, NOW).mintAuthority).toBeNull();
    expect(verifyResearchMintCapture(c, c.address, NOW).freezeAuthority).toBeNull();
  });
  it.each([mint(), extended([])])(
    "accepts extension-free Token-2022 mint layouts without claiming legacy ownership",
    (data) => {
      expect(decode(data)).toMatchObject({ tokenProgram: "token-2022", extensions: [] });
    },
  );
  it("matches the library's MetadataPointer mint layout and permits passive external pointers", () => {
    const data = extended([pointer()]);
    expect(data.length).toBe(getMintLen([ExtensionType.MetadataPointer]));
    expect(
      unpackMint(
        MINT,
        { data, owner: TOKEN_2022_PROGRAM_ID, executable: false, lamports: 0 },
        TOKEN_2022_PROGRAM_ID,
      ).isInitialized,
    ).toBe(true);
    expect(decode(data).extensions).toEqual(["MetadataPointer"]);
    const external = tlv(
      ExtensionType.MetadataPointer,
      Buffer.concat([Buffer.alloc(32), key(33).toBuffer()]),
    );
    expect(decode(extended([external])).extensions).toEqual(["MetadataPointer"]);
    expect(
      decode(extended([tlv(ExtensionType.MetadataPointer, Buffer.alloc(64))])).extensions,
    ).toEqual(["MetadataPointer"]);
  });
  it("validates variable-length library-packed metadata with Unicode and optional update authority", () => {
    const value = metadata({
      name: "Token 🌍",
      symbol: "研究",
      updateAuthority: AUTHORITY,
      additionalMetadata: [
        ["a", ""],
        ["", "value"],
        ["\uFEFFkey", "preserve BOM"],
      ],
    });
    expect(unpackMetadata(value).mint.equals(MINT)).toBe(true);
    const result = decode(extended([pointer(), tlv(ExtensionType.TokenMetadata, value)]));
    expect(result.extensions).toEqual(["MetadataPointer", "TokenMetadata"]);
    expect(result.mintAuthority).toBeNull(); // Metadata update authority is not mint authority.
  });
  it("does not require sorted insertion order for the TLV records", () => {
    expect(
      decode(extended([tlv(ExtensionType.TokenMetadata, metadata()), pointer()])).extensions,
    ).toEqual(["MetadataPointer", "TokenMetadata"]);
  });
  it("allows complete zero-only unused allocation and reports its size", () => {
    expect(decode(extended([pointer()], Buffer.alloc(10))).unallocatedTlvBytes).toBe(10);
  });
  it("rejects the multisig-size collision but accepts the protocol's two-byte adjustment", () => {
    const value = metadata({ name: "n".repeat(37), symbol: "", uri: "", additionalMetadata: [] });
    const data = extended([pointer(), tlv(ExtensionType.TokenMetadata, value)]);
    expect(data.length).toBe(MULTISIG_SIZE);
    expect(() => decode(data)).toThrow("EXTENDED_LAYOUT");
    const canonicalLength = getMintLen([ExtensionType.MetadataPointer], {
      [ExtensionType.TokenMetadata]: value.length,
    });
    expect(canonicalLength).toBe(MULTISIG_SIZE + 2);
    expect(decode(Buffer.concat([data, Buffer.alloc(2)])).extensions).toEqual([
      "MetadataPointer",
      "TokenMetadata",
    ]);
  });
  it("is deterministic, detached, and binds timestamp/slot provenance separately from bytes", () => {
    const c = capture(),
      before = verifyResearchMintCapture(c, c.address, NOW);
    expect(verifyResearchMintCapture({ ...c }, c.address, NOW)).toEqual(before);
    c.observedAt++;
    c.slot++;
    c.dataBase64 = mint(AUTHORITY).toString("base64");
    const after = verifyResearchMintCapture(c, c.address, NOW + 1);
    expect(before.mintAuthority).toBeNull();
    expect(after.mintAuthority).toBe(AUTHORITY.toBase58());
    expect(after.captureSha256).not.toBe(before.captureSha256);
    const sameBytes = verifyResearchMintCapture(
      { ...c, dataBase64: mint().toString("base64") },
      c.address,
      NOW + 1,
    );
    expect(sameBytes.rawAccountSha256).toBe(before.rawAccountSha256);
    expect(sameBytes.captureSha256).not.toBe(before.captureSha256);
  });
  it.each(["", "invalid", " " + MINT.toBase58(), MINT.toBase58() + " "])(
    "rejects noncanonical public keys %s",
    (value) => {
      expect(() =>
        verifyResearchMintCapture({ ...capture(), address: value }, MINT.toBase58(), NOW),
      ).toThrow("PUBLIC_KEY");
      expect(() =>
        verifyResearchMintCapture({ ...capture(), owner: value }, MINT.toBase58(), NOW),
      ).toThrow("PUBLIC_KEY");
      expect(() => verifyResearchMintCapture(capture(), value, NOW)).toThrow("PUBLIC_KEY");
    },
  );
  it("rejects capture identity/owner mismatch and missing/unexpected fields", () => {
    expect(() => verifyResearchMintCapture(capture(), key(8).toBase58(), NOW)).toThrow("IDENTITY");
    expect(() => decode(mint(), key(8))).toThrow("OWNER_UNSUPPORTED");
    for (const bad of [null, [], {}, { ...capture(), executable: false }])
      expect(() =>
        verifyResearchMintCapture(bad as ResearchMintAccountCapture, MINT.toBase58(), NOW),
      ).toThrow("CAPTURE_SHAPE");
    const c = capture();
    Reflect.deleteProperty(c, "slot");
    expect(() => verifyResearchMintCapture(c, MINT.toBase58(), NOW)).toThrow("CAPTURE_SHAPE");
  });
  it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects malformed clocks %s",
    (value) => {
      for (const field of ["requestedAt", "observedAt", "publishedAt", "slot"] as const)
        expect(() =>
          verifyResearchMintCapture({ ...capture(), [field]: value }, MINT.toBase58(), NOW),
        ).toThrow("CLOCK");
      expect(() => verifyResearchMintCapture(capture(), MINT.toBase58(), value)).toThrow("CLOCK");
    },
  );
  it("requires exact expected observation time but makes no wall-clock freshness claim", () => {
    expect(() => verifyResearchMintCapture(capture(), MINT.toBase58(), NOW + 1)).toThrow("CLOCK");
    expect(
      verifyResearchMintCapture(
        { ...capture(), requestedAt: 0, observedAt: 0, publishedAt: 0 },
        MINT.toBase58(),
        0,
      ).observedAt,
    ).toBe(0);
  });
  it("retains response and publication separately and rejects reversed causal clocks", () => {
    const c = capture();
    expect(verifyResearchMintCapture(c, c.address, c.observedAt)).toMatchObject({
      requestedAt: NOW - 10,
      observedAt: NOW,
      publishedAt: NOW + 10,
    });
    expect(() => verifyResearchMintCapture(c, c.address, c.publishedAt)).toThrow("CLOCK");
    for (const patch of [{ requestedAt: NOW + 1 }, { publishedAt: NOW - 1 }])
      expect(() => verifyResearchMintCapture({ ...c, ...patch }, c.address, c.observedAt)).toThrow(
        "CLOCK",
      );
    const baseHash = verifyResearchMintCapture(c, c.address, c.observedAt).captureSha256;
    for (const patch of [{ requestedAt: NOW - 11 }, { publishedAt: NOW + 11 }]) {
      const result = verifyResearchMintCapture({ ...c, ...patch }, c.address, c.observedAt);
      expect(result.captureSha256).not.toBe(baseHash);
    }
  });
  it.each([
    "",
    " ",
    "%%%",
    mint().toString("base64") + "\n",
    mint().toString("base64").replace(/=+$/, ""),
  ])("rejects noncanonical base64 %#", (value) => {
    expect(() =>
      verifyResearchMintCapture({ ...capture(), dataBase64: value }, MINT.toBase58(), NOW),
    ).toThrow("BASE64");
  });
  it("rejects oversized and non-string account data before accepting any mint", () => {
    const huge = Buffer.alloc(MAX_RESEARCH_MINT_ACCOUNT_BYTES + 1).toString("base64");
    for (const value of [huge, 123, null])
      expect(() =>
        verifyResearchMintCapture(
          { ...capture(), dataBase64: value } as ResearchMintAccountCapture,
          MINT.toBase58(),
          NOW,
        ),
      ).toThrow("BASE64");
  });
  it.each([0, 81, 83, 165, 166, 234])(
    "requires exact 82-byte legacy layout: length %s",
    (length) => {
      expect(() =>
        decode(Buffer.concat([mint(), Buffer.alloc(200)]).subarray(0, length), TOKEN_PROGRAM_ID),
      ).toThrow(length === 0 ? "BASE64" : "BASE_LAYOUT");
    },
  );
  it.each([0, 46])("rejects malformed COption tag at offset %s", (offset) => {
    const c = replace(capture(), (data) => data.writeUInt32LE(2, offset));
    expect(() => verifyResearchMintCapture(c, c.address, NOW)).toThrow("BASE_ENCODING");
  });
  it.each([0, 2, 255])("rejects uninitialized or invalid initialization byte %s", (state) => {
    const c = replace(capture(), (data) => {
      data[45] = state;
    });
    expect(() => verifyResearchMintCapture(c, c.address, NOW)).toThrow(
      state === 0 ? "UNINITIALIZED" : "BASE_ENCODING",
    );
  });
  it.each([83, 100, 165])("rejects an incomplete extended mint header of length %s", (length) => {
    expect(() => decode(Buffer.concat([mint(), Buffer.alloc(100)]).subarray(0, length))).toThrow(
      "EXTENDED_LAYOUT",
    );
  });
  it("rejects account type confusion and nonzero mint-to-account padding", () => {
    for (const offset of [82, 120, 164, 165]) {
      const data = extended([pointer()]);
      data[offset] = 2;
      expect(() => decode(data)).toThrow("EXTENDED_LAYOUT");
    }
  });
  it.each([1, 2, 3])("rejects a truncated nonzero TLV header of length %s", (length) => {
    expect(() => decode(extended([Buffer.from([18, 0, 64]).subarray(0, length)]))).toThrow(
      "TLV_TRUNCATED",
    );
  });
  it("rejects values crossing the TLV boundary and duplicate extension IDs", () => {
    const truncated = pointer().subarray(0, 67);
    expect(() => decode(extended([truncated]))).toThrow("TLV_TRUNCATED");
    expect(() => decode(extended([pointer(), pointer()]))).toThrow("DUPLICATE_EXTENSION");
    expect(() =>
      decode(
        extended([
          pointer(),
          tlv(ExtensionType.TokenMetadata, metadata()),
          tlv(ExtensionType.TokenMetadata, metadata()),
        ]),
      ),
    ).toThrow("DUPLICATE_EXTENSION");
  });
  it("rejects a hidden extension/payload behind an uninitialized terminator", () => {
    expect(() =>
      decode(extended([pointer()], Buffer.concat([Buffer.alloc(4), pointer()]))),
    ).toThrow("PADDING_INVALID");
    expect(() => decode(extended([pointer()], Buffer.from([0, 0, 1, 0])))).toThrow(
      "PADDING_INVALID",
    );
    expect(() => decode(extended([pointer()], Buffer.alloc(1)))).toThrow("TLV_TRUNCATED");
  });
  it.each([
    ExtensionType.ImmutableOwner,
    ExtensionType.TransferFeeAmount,
    ExtensionType.CpiGuard,
    ExtensionType.TransferHookAccount,
  ])("rejects account-only extension %s", (type) => {
    expect(() => decode(extended([tlv(type, Buffer.alloc(getTypeLen(type)))]))).toThrow(
      "ACCOUNT_EXTENSION",
    );
  });
  it.each([
    ExtensionType.TransferFeeConfig,
    ExtensionType.TransferHook,
    ExtensionType.PermanentDelegate,
    ExtensionType.NonTransferable,
    ExtensionType.ConfidentialTransferMint,
    ExtensionType.MintCloseAuthority,
    ExtensionType.DefaultAccountState,
    ExtensionType.InterestBearingConfig,
    ExtensionType.PausableConfig,
  ])("rejects unreviewed mint extension %s even with all-zero control bytes", (type) => {
    expect(() => decode(extended([tlv(type, Buffer.alloc(getTypeLen(type)))]))).toThrow(
      "EXTENSION_UNSUPPORTED",
    );
  });
  it.each([16, 17, 24, 65535])("rejects unknown/unimplemented extension ID %s", (type) => {
    expect(() => decode(extended([tlv(type)]))).toThrow("UNKNOWN_EXTENSION");
  });
  it.each([0, 63, 65])("requires a 64-byte MetadataPointer, got %s", (length) => {
    expect(() =>
      decode(extended([tlv(ExtensionType.MetadataPointer, Buffer.alloc(length))])),
    ).toThrow("POINTER_LENGTH");
  });
  it("requires local metadata mint identity and the initializer's pointer extension", () => {
    expect(() =>
      decode(extended([pointer(), tlv(ExtensionType.TokenMetadata, metadata({ mint: key(88) }))])),
    ).toThrow("METADATA_MINT_MISMATCH");
    expect(() => decode(extended([tlv(ExtensionType.TokenMetadata, metadata())]))).toThrow(
      "POINTER_REQUIRED",
    );
  });
  it.each([Buffer.alloc(0), Buffer.alloc(79)])(
    "rejects incomplete variable metadata %#",
    (value) => {
      expect(() => decode(extended([pointer(), tlv(ExtensionType.TokenMetadata, value)]))).toThrow(
        "METADATA_LAYOUT",
      );
    },
  );
  it("rejects malicious variable lengths/counts, invalid UTF8, and trailing metadata bytes", () => {
    const empty = metadata({ name: "", symbol: "", uri: "", additionalMetadata: [] });
    const badLength = Buffer.from(empty);
    badLength.writeUInt32LE(0xffffffff, 64);
    const badCount = Buffer.from(empty);
    badCount.writeUInt32LE(0xffffffff, 76);
    for (const value of [badLength, badCount, Buffer.concat([empty, Buffer.from([0])])])
      expect(() => decode(extended([pointer(), tlv(ExtensionType.TokenMetadata, value)]))).toThrow(
        "METADATA_LAYOUT",
      );
    const invalidUtf8 = metadata({ name: "x" });
    invalidUtf8[68] = 255;
    expect(() =>
      decode(extended([pointer(), tlv(ExtensionType.TokenMetadata, invalidUtf8)])),
    ).toThrow("METADATA_UTF8");
  });
  it("rejects duplicate additional metadata keys without conflating distinct BOM keys", () => {
    const duplicate = metadata({
      additionalMetadata: [
        ["key", "one"],
        ["key", "two"],
      ],
    });
    expect(() =>
      decode(extended([pointer(), tlv(ExtensionType.TokenMetadata, duplicate)])),
    ).toThrow("DUPLICATE_KEY");
    const distinct = metadata({
      additionalMetadata: [
        ["key", "one"],
        ["\uFEFFkey", "two"],
      ],
    });
    expect(
      decode(extended([pointer(), tlv(ExtensionType.TokenMetadata, distinct)])).initialized,
    ).toBe(true);
  });
});

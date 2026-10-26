/** Synthetic wallet/transaction fixtures only. Never broadcast or interpreted as real market evidence. */
import { describe, it, expect, vi } from "vitest";
import { Keypair, SystemProgram } from "@solana/web3.js";
import bs58 from "bs58";
import { WalletHistoryReader } from "../src/wallet-reader.ts";
import { WalletIntelligence, type TradeObservation } from "../src/intelligence.ts";
import type { Rpc } from "../src/stream.ts";
import type { Store } from "../src/store.ts";
import type { RpcTransaction } from "../src/decoder.ts";

const key = () => Keypair.generate().publicKey.toBase58();
const signature = bs58.encode(Buffer.alloc(64, 7));
function transfer(amount = 1000n) {
  const data = Buffer.alloc(12);
  data.writeUInt32LE(2);
  data.writeBigUInt64LE(amount, 4);
  return { programIdIndex: 2, accounts: [0, 1], data: bs58.encode(data) };
}
function fixture() {
  const a = key(),
    b = key(),
    outer = key();
  let now = 1000;
  const tx: RpcTransaction = {
    slot: 100,
    blockTime: 1,
    version: 0,
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [a, b, SystemProgram.programId.toBase58(), outer],
        instructions: [transfer()],
      },
    },
    meta: { err: null },
  };
  const rows = new Map<string, any>();
  const store = {
    get: vi.fn(async (id: string) => rows.get(id) ?? null),
    save: vi.fn(async (id: string, value: unknown) => {
      rows.set(
        id,
        JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v))),
      );
    }),
  };
  const rpc = {
    call: vi.fn(async (method: string, _params?: unknown[]) => {
      if (method === "getSignaturesForAddress") return [{ signature, err: null }];
      if (method === "getTransaction") return tx;
      throw Error("UNEXPECTED_SYNTHETIC_RPC");
    }),
  };
  const intelligence = new WalletIntelligence(),
    services = new Set<string>();
  const reader = () =>
    new WalletHistoryReader(
      rpc as unknown as Rpc,
      store as unknown as Store,
      intelligence,
      services,
      () => now,
    );
  return {
    a,
    b,
    outer,
    tx,
    rows,
    store,
    rpc,
    intelligence,
    services,
    reader,
    setClock: (at: number) => {
      now = at;
    },
  };
}
describe("bounded wallet history with committed top-level transfer evidence", () => {
  it("reads a structurally validated synthetic v1 committed top-level transfer with numeric RPC version opt-in", async () => {
    const f = fixture();
    f.tx.version = 1;
    Object.assign(f.tx.transaction.message, {
      header: {
        numRequiredSignatures: 1,
        numReadonlySignedAccounts: 0,
        numReadonlyUnsignedAccounts: 2,
      },
      recentBlockhash: key(),
      transactionConfig: {
        priorityFee: 8180,
        computeUnitLimit: 30000,
        loadedAccountsDataSizeLimit: 200000,
        heapSize: null,
      },
    });
    const result = await f.reader().inspect(f.a, new Set([f.a, f.b]));
    expect(result.funding).toHaveLength(1);
    expect(result.funding[0].amountLamports).toBe(1000n);
    expect(f.rpc.call.mock.calls.find(([method]) => method === "getTransaction")![1]).toEqual([
      signature,
      { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 1 },
    ]);
  });
  it.each([
    "missing-config",
    "incoherent-v0",
    "future-config",
    "lookup-addresses",
    "missing-header",
    "unsafe-priority",
  ] as const)("does not infer v1 wallet funding from synthetic %s responses", async (fault) => {
    const f = fixture();
    f.tx.version = 1;
    Object.assign(f.tx.transaction.message, {
      header: {
        numRequiredSignatures: 1,
        numReadonlySignedAccounts: 0,
        numReadonlyUnsignedAccounts: 2,
      },
      recentBlockhash: key(),
      transactionConfig: {
        priorityFee: 8180,
        computeUnitLimit: 30000,
        loadedAccountsDataSizeLimit: 200000,
        heapSize: null,
      },
    });
    const message = f.tx.transaction.message;
    if (fault === "missing-config") delete message.transactionConfig;
    if (fault === "incoherent-v0") f.tx.version = 0;
    if (fault === "future-config")
      Object.assign(message.transactionConfig!, { futureBudgetField: 10 });
    if (fault === "lookup-addresses")
      f.tx.meta!.loadedAddresses = { writable: [key()], readonly: [] };
    if (fault === "missing-header") delete message.header;
    if (fault === "unsafe-priority")
      message.transactionConfig!.priorityFee = Number.MAX_SAFE_INTEGER + 1;
    const result = await f.reader().inspect(f.a, new Set([f.a, f.b]));
    expect(result.funding).toEqual([]);
    expect(result.signaturesReviewed).toBe(0);
    expect(result.historyComplete).toBe(false);
  });
  it("does not turn a caught failed System CPI into a funding relationship", async () => {
    const f = fixture();
    f.tx.transaction.message.instructions = [
      { programIdIndex: 3, accounts: [], data: bs58.encode(Buffer.from([1])) },
    ];
    f.tx.meta!.innerInstructions = [{ index: 0, instructions: [transfer()] }];
    f.tx.meta!.logMessages = [
      `Program ${f.outer} invoke [1]`,
      `Program ${SystemProgram.programId} invoke [2]`,
      `Program ${SystemProgram.programId} failed: insufficient lamports`,
      `Program ${f.outer} success`,
    ];
    const result = await f.reader().inspect(f.a, new Set([f.a, f.b]));
    expect(result.funding).toEqual([]);
    expect(f.rows.get(`wallet:${f.a}`).fundingCandidates).toEqual([]);
    expect(result.historyComplete).toBe(false);
    expect(result.signaturesReviewed).toBe(1);
  });
  it("keeps the caught-inner-CPI funding veto for structurally valid synthetic v1 transactions", async () => {
    const f = fixture();
    f.tx.version = 1;
    Object.assign(f.tx.transaction.message, {
      header: {
        numRequiredSignatures: 1,
        numReadonlySignedAccounts: 0,
        numReadonlyUnsignedAccounts: 2,
      },
      recentBlockhash: key(),
      transactionConfig: {
        priorityFee: "8180",
        computeUnitLimit: 30000,
        loadedAccountsDataSizeLimit: 200000,
        heapSize: null,
      },
    });
    f.tx.transaction.message.instructions = [
      { programIdIndex: 3, accounts: [], data: bs58.encode(Buffer.from([1])) },
    ];
    f.tx.meta!.innerInstructions = [{ index: 0, instructions: [transfer()] }];
    f.tx.meta!.logMessages = [
      `Program ${f.outer} invoke [1]`,
      `Program ${SystemProgram.programId} invoke [2]`,
      `Program ${SystemProgram.programId} failed: insufficient lamports`,
      `Program ${f.outer} success`,
    ];
    const result = await f.reader().inspect(f.a, new Set([f.a, f.b]));
    expect(result.signaturesReviewed).toBe(1);
    expect(result.funding).toEqual([]);
    expect(f.rows.get(`wallet:${f.a}`).fundingCandidates).toEqual([]);
  });
  it("does not claim successful inner instructions are verified funding without a frame-aware decoder", async () => {
    const f = fixture();
    f.tx.transaction.message.instructions = [
      { programIdIndex: 3, accounts: [], data: bs58.encode(Buffer.from([1])) },
    ];
    f.tx.meta!.innerInstructions = [{ index: 0, instructions: [transfer()] }];
    f.tx.meta!.logMessages = [
      `Program ${f.outer} invoke [1]`,
      `Program ${SystemProgram.programId} invoke [2]`,
      `Program ${SystemProgram.programId} success`,
      `Program ${f.outer} success`,
    ];
    expect((await f.reader().inspect(f.a, new Set([f.a, f.b]))).funding).toEqual([]);
  });
  it("records exact committed top-level transfers and sums repeated same-pair instructions rather than overwriting them", async () => {
    const f = fixture();
    f.tx.transaction.message.instructions = [transfer(100n), transfer(200n)];
    const result = await f.reader().inspect(f.a, new Set([f.a, f.b]));
    expect(result.funding).toHaveLength(1);
    expect(result.funding[0]).toMatchObject({
      from: f.a,
      to: f.b,
      amountLamports: 300n,
      signature,
      eventAt: 1000,
      observedAt: 1000,
      sharedService: false,
    });
  });
  it("caches raw reviewed transfers independent of related-set membership and recognizes expanded context without another RPC", async () => {
    const f = fixture(),
      reader = f.reader();
    expect((await reader.inspect(f.a, new Set([f.a]))).funding).toEqual([]);
    const stored = f.rows.get(`wallet:${f.a}`);
    expect(stored.schemaVersion).toBe(2);
    expect(stored.fundingCandidates).toHaveLength(1);
    expect(stored.funding).toBeUndefined();
    const second = await reader.inspect(f.a, new Set([f.a, f.b]));
    expect(second.funding).toHaveLength(1);
    expect(
      f.rpc.call.mock.calls.filter(([method]) => method === "getSignaturesForAddress"),
    ).toHaveLength(1);
    const restarted = await f.reader().inspect(f.a, new Set([f.a, f.b]));
    expect(restarted.funding[0].amountLamports).toBe(1000n);
    expect(
      f.rpc.call.mock.calls.filter(([method]) => method === "getSignaturesForAddress"),
    ).toHaveLength(1);
  });
  it("does not reuse legacy context-filtered cache records as raw coverage", async () => {
    const f = fixture();
    f.rows.set(`wallet:${f.a}`, {
      wallet: f.a,
      observedAt: 1000,
      signaturesReviewed: 6,
      historyComplete: false,
      funding: [],
      launches: [],
    });
    const result = await f.reader().inspect(f.a, new Set([f.a, f.b]));
    expect(result.funding).toHaveLength(1);
    expect(result.schemaVersion).toBe(2);
    expect(
      f.rpc.call.mock.calls.filter(([method]) => method === "getSignaturesForAddress"),
    ).toHaveLength(1);
  });
  it("reapplies current shared-service exclusions when reusing cached raw transfer evidence", async () => {
    const f = fixture(),
      reader = f.reader();
    await reader.inspect(f.a, new Set([f.a]));
    f.services.add(f.a);
    expect((await reader.inspect(f.a, new Set([f.a, f.b]))).funding[0].sharedService).toBe(true);
  });
  it("keeps later-observed funding out of earlier point-in-time demand features", async () => {
    const f = fixture();
    await f.reader().inspect(f.a, new Set([f.a, f.b]));
    const buys: TradeObservation[] = [f.a, f.b].map((wallet, i) => ({
      signature: `SYNTHETIC-BUY-${i}`,
      instructionIndex: "0",
      mint: "fixture",
      wallet,
      side: "buy",
      quoteAmount: 100n,
      tokenAmount: 100n,
      quoteMint: "SOL",
      eventAt: 900,
      observedAt: 900,
    }));
    expect(f.intelligence.demand(buys, 999).independentBuyerUnits).toBe(2);
    expect(f.intelligence.demand(buys, 1000).independentBuyerUnits).toBe(1);
  });
  it("rejects future transfer timestamps and future-dated cached evidence rather than backdating relationships", async () => {
    const f = fixture();
    f.tx.blockTime = 2;
    expect((await f.reader().inspect(f.a, new Set([f.a, f.b]))).funding).toEqual([]);
    const g = fixture();
    g.rows.set(`wallet:${g.a}`, {
      schemaVersion: 2,
      wallet: g.a,
      observedAt: 2000,
      signaturesReviewed: 1,
      historyComplete: false,
      fundingCandidates: [
        {
          from: g.a,
          to: g.b,
          amountLamports: "999999",
          signature,
          eventAt: 1000,
          observedAt: 2000,
          sharedService: false,
        },
      ],
      launches: [],
    });
    const result = await g.reader().inspect(g.a, new Set([g.a, g.b]));
    expect(result.funding[0].amountLamports).toBe(1000n);
    expect(result.funding[0].observedAt).toBe(1000);
    expect(g.rpc.call).toHaveBeenCalled();
  });
  it("preserves the first observation time when the same finalized transfer is refreshed", async () => {
    const f = fixture(),
      reader = f.reader();
    await reader.inspect(f.a, new Set([f.a, f.b]));
    f.setClock(400000);
    const refreshed = await reader.inspect(f.a, new Set([f.a, f.b]));
    expect(refreshed.observedAt).toBe(400000);
    expect(refreshed.funding[0].observedAt).toBe(1000);
  });
  it("does not redate a previously observed transfer when chain block time remains unavailable", async () => {
    const f = fixture(),
      reader = f.reader();
    f.tx.blockTime = null;
    await reader.inspect(f.a, new Set([f.a, f.b]));
    f.setClock(400000);
    const refreshed = await reader.inspect(f.a, new Set([f.a, f.b]));
    expect(refreshed.funding[0]).toMatchObject({ eventAt: 1000, observedAt: 1000 });
    const calls = f.rpc.call.mock.calls.length;
    const restored = await f.reader().inspect(f.a, new Set([f.a, f.b]));
    expect(restored.funding[0]).toMatchObject({ eventAt: 1000, observedAt: 1000 });
    expect(f.rpc.call.mock.calls).toHaveLength(calls);
  });
  it("does not record funding from failed transactions or mismatched signature responses", async () => {
    const failed = fixture();
    failed.tx.meta!.err = { InstructionError: [0, "synthetic"] };
    expect(
      (await failed.reader().inspect(failed.a, new Set([failed.a, failed.b]))).funding,
    ).toEqual([]);
    const mismatch = fixture();
    mismatch.tx.transaction.signatures = [bs58.encode(Buffer.alloc(64, 8))];
    expect(
      (await mismatch.reader().inspect(mismatch.a, new Set([mismatch.a, mismatch.b]))).funding,
    ).toEqual([]);
  });
});

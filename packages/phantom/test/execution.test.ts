/** All RPC responses and accounts in this file are explicitly synthetic fixtures. No network or real wallet is used. */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Keypair, PublicKey, SystemProgram, VersionedTransaction, type Connection } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { BN } from '@coral-xyz/anchor';
import type { Global, FeeConfig, BondingCurve } from '@pump-fun/pump-sdk';
import bs58 from 'bs58';
import {
  JupiterQuoteClient, rawAmount, buildPumpV3Instruction, assertLivePolicy, GuardedLiveExecutor,
  quotePumpSnapshot, PumpQuoteClient, type PumpSnapshot, type LiveOrder, type LiveOrderStore, type LivePolicy,
} from '../src/execution.ts';

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const quoteFixture = (overrides: Record<string, unknown> = {}) => ({
  inputMint: SOL, outputMint: USDC, inAmount: '9007199254740993', outAmount: '20000000000000001',
  otherAmountThreshold: '19800000000000000', priceImpact: -0.1, router: 'metis',
  transaction: null, requestId: 'SYNTHETIC-QUOTE', feeBps: 2, feeMint: SOL,
  routePlan: [{ swapInfo: { label: 'Synthetic route' } }], ...overrides,
});

function syntheticPumpSnapshot(): PumpSnapshot {
  const zero = new BN(0), pub = PublicKey.default;
  const global: Global = {
    initialized: true, authority: pub, feeRecipient: pub, initialVirtualTokenReserves: new BN('1073000000000000'),
    initialVirtualSolReserves: new BN('30000000000'), initialRealTokenReserves: new BN('793100000000000'),
    tokenTotalSupply: new BN('1000000000000000'), feeBasisPoints: new BN(100), withdrawAuthority: pub,
    enableMigrate: true, poolMigrationFee: zero, creatorFeeBasisPoints: new BN(50), feeRecipients: [pub],
    setCreatorAuthority: pub, adminSetCreatorAuthority: pub, createV2Enabled: true, whitelistPda: pub,
    reservedFeeRecipient: pub, mayhemModeEnabled: false, reservedFeeRecipients: [], isCashbackEnabled: false,
    buybackFeeRecipients: [pub], buybackBasisPoints: new BN(2000), initialVirtualQuoteReserves: zero,
    whitelistedQuoteMints: [], creatorFeeConfigurable: false, maxConfigurableCreatorFeeBps: zero,
    holderRewardClaimAuthority: pub, isHolderRewardEnabled: false, maxCurveDepth: 0,
  };
  const fees = { lpFeeBps: zero, protocolFeeBps: new BN(100), creatorFeeBps: new BN(50) };
  const feeConfig: FeeConfig = { admin: pub, flatFees: fees, feeTiers: [{ marketCapLamportsThreshold: zero, fees }],
    stableFeeTiers: [], exoticFlatFees: fees };
  const bondingCurve: BondingCurve = { virtualTokenReserves: new BN('1073000000000000'),
    virtualQuoteReserves: new BN('30000000000'), realTokenReserves: new BN('793100000000000'),
    realQuoteReserves: new BN('10000000000'), tokenTotalSupply: new BN('1000000000000000'), complete: false,
    creator: Keypair.generate().publicKey, isMayhemMode: false, isCashbackCoin: false, quoteMint: new PublicKey(SOL),
    creatorFeeBps: zero, canEditCreatorFee: false, isHolderReward: false, creatorFee: zero, protocolFees: zero,
    depth: 0, initialVirtualQuoteReserves: zero, postCompleteBaseOut: zero, postCompleteQuoteIn: zero };
  return { mint: Keypair.generate().publicKey.toBase58(), global, feeConfig, bondingCurve,
    mintSupply: 1000000000000000n, curveBaseTokenBalance: 793100000000000n, observedAt: 1000, contextSlot: 123 };
}

describe('official reserve quoting with synthetic snapshots', () => {
  it('charges current dynamic fee schedule; same-snapshot round trip is a loss, never free profit', () => {
    const snapshot = syntheticPumpSnapshot();
    const entry = quotePumpSnapshot(snapshot, { inputMint: SOL, outputMint: snapshot.mint, amount: 10000000n });
    const exit = quotePumpSnapshot(snapshot, { inputMint: snapshot.mint, outputMint: SOL, amount: BigInt(entry.outAmount) });
    expect(BigInt(exit.outAmount)).toBeLessThan(10000000n);
    expect(entry.source).toBe('PUMP_ONCHAIN'); expect(entry.contextSlot).toBe(123);
    expect(entry.liquidityLamports).toBe('10000000000');
    expect(entry.impactBps).toBeGreaterThanOrEqual(150);
    const expensive = syntheticPumpSnapshot(); expensive.mint = snapshot.mint;
    expensive.feeConfig.feeTiers[0].fees.protocolFeeBps = new BN(500);
    const worse = quotePumpSnapshot(expensive, { inputMint: SOL, outputMint: snapshot.mint, amount: 10000000n });
    expect(BigInt(worse.outAmount)).toBeLessThan(BigInt(entry.outAmount));
  });
  it('rejects migration and insufficient accessible sell liquidity rather than quoting virtual reserves as cash', () => {
    const migrated = syntheticPumpSnapshot(); migrated.bondingCurve.complete = true;
    expect(() => quotePumpSnapshot(migrated, { inputMint: SOL, outputMint: migrated.mint, amount: 10000000n })).toThrow('MIGRATED');
    const illiquid = syntheticPumpSnapshot(); illiquid.bondingCurve.realQuoteReserves = new BN(1);
    expect(() => quotePumpSnapshot(illiquid, { inputMint: illiquid.mint, outputMint: SOL, amount: 1000000000n })).toThrow('ACCESSIBLE_RESERVES');
  });
  it('fails closed on missing or malicious RPC account ownership', async () => {
    const missing = { getMultipleAccountsInfoAndContext: async () => ({ context: { slot: 1 }, value: [null, null, null, null] }) };
    await expect(new PumpQuoteClient(missing as unknown as Connection).snapshot(Keypair.generate().publicKey.toBase58())).rejects.toThrow('ACCOUNT_MISSING');
    const malicious = { getMultipleAccountsInfoAndContext: async () => ({ context: { slot: 1 }, value: Array.from({ length: 6 }, () => ({ owner: PublicKey.default })) }) };
    await expect(new PumpQuoteClient(malicious as unknown as Connection).snapshot(Keypair.generate().publicKey.toBase58())).rejects.toThrow('OWNER_MISMATCH');
  });
});

describe('quote-only Jupiter V2 with synthetic provider fixtures', () => {
  it('retains integers beyond Number.MAX_SAFE_INTEGER and never asks for a taker or transaction', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) => Response.json(quoteFixture()));
    const client = new JupiterQuoteClient({ apiKey: 'synthetic-test-key', fetch: fetcher as typeof fetch, now: () => 1234 });
    const result = await client.quote({ inputMint: SOL, outputMint: USDC, amount: 9007199254740993n });
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.pathname).toBe('/swap/v2/order');
    expect(url.searchParams.get('amount')).toBe('9007199254740993');
    expect(url.searchParams.has('taker')).toBe(false);
    expect(url.searchParams.get('maxSupportedTransactionVersion')).toBe('0');
    expect(result.outAmount).toBe('20000000000000001');
    expect(result.minOutAmount).toBe('19800000000000000');
    expect(result.impactBps).toBe(10);
    expect(result.observedAt).toBe(1234);
    expect(result.contextSlot).toBeNull();
    expect(result.feeBps).toBe(2);
  });
  it('does not interpret deprecated priceImpactPct as a current measured price impact', async () => {
    const client = new JupiterQuoteClient({ apiKey: 'fixture', fetch: async () => Response.json(quoteFixture({ priceImpact: undefined, priceImpactPct: '0.01' })) });
    expect((await client.quote({ inputMint: SOL, outputMint: USDC, amount: 9007199254740993n })).impactBps).toBeNull();
  });
  it.each([
    [{ inAmount: '1' }, 'REQUEST_MISMATCH'], [{ outputMint: SOL }, 'REQUEST_MISMATCH'],
    [{ outAmount: 2 }, 'INTEGER_STRING'], [{ otherAmountThreshold: undefined }, 'INTEGER_STRING'],
    [{ otherAmountThreshold: '1' }, 'SLIPPAGE_CAP'], [{ outAmount: '0' }, 'U64'],
    [{ errorCode: 1 }, 'UNAVAILABLE'], [{ router: undefined, routePlan: [] }, 'ROUTE_MISSING'],
  ])('rejects unsafe or unavailable response %#', async (override, message) => {
    const client = new JupiterQuoteClient({ apiKey: 'fixture', fetch: async () => Response.json(quoteFixture(override)) });
    await expect(client.quote({ inputMint: SOL, outputMint: USDC, amount: 9007199254740993n })).rejects.toThrow(message);
  });
  it('fails on HTTP rate limits without exposing provider body or API key', async () => {
    const client = new JupiterQuoteClient({ apiKey: 'fixture', fetch: async () => new Response('sensitive body', { status: 429 }) });
    await expect(client.quote({ inputMint: SOL, outputMint: USDC, amount: 1n })).rejects.toThrow('JUPITER_HTTP_429');
  });
  it('aborts a hung provider and reports timeout rather than no-route', async () => {
    const fetcher: typeof fetch = async (_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('fixture-aborted')));
    });
    const client = new JupiterQuoteClient({ apiKey: 'fixture', fetch: fetcher, timeoutMs: 5 });
    await expect(client.quote({ inputMint: SOL, outputMint: USDC, amount: 1n })).rejects.toThrow('JUPITER_QUOTE_TIMEOUT');
  });
  it('rejects floating-point, negative and overflowing raw amounts', () => {
    for (const n of [1, '-1', '1.2', '01', '18446744073709551616', '0']) expect(() => rawAmount(n)).toThrow();
    expect(rawAmount('18446744073709551615')).toBe(18446744073709551615n);
  });
});

describe('official Pump SDK builders with synthetic accounts, never broadcast', () => {
  const common = () => ({
    mint: Keypair.generate().publicKey, user: Keypair.generate().publicKey, tokenProgram: TOKEN_PROGRAM_ID,
    quoteMint: new PublicKey(SOL), quoteTokenProgram: TOKEN_PROGRAM_ID,
    buybackFeeRecipient: Keypair.generate().publicKey, amountIn: 123456789012345n, minimumOut: 100n,
    isCashbackCoin: false,
    state: { observedAt: 1000, now: 1001, maxAgeMs: 2000, mintAndTokenProgramsVerified: true, tokenSecurityPassed: true },
  });
  it.each(['BUY', 'SELL'] as const)('builds %s with the pinned official discriminator and exact u64 inputs', async (side) => {
    const input = common();
    const instruction = await buildPumpV3Instruction({ ...input, side });
    const idl = JSON.parse(readFileSync(new URL('../vendor/pump.json', import.meta.url), 'utf8'));
    const expected = idl.instructions.find((x: { name: string }) => x.name === (side === 'BUY' ? 'buy_exact_quote_in_v3' : 'sell_v3'));
    expect(instruction.programId.toBase58()).toBe(idl.address);
    expect([...instruction.data.subarray(0, 8)]).toEqual(expected.discriminator);
    expect(instruction.data.readBigUInt64LE(8)).toBe(input.amountIn);
    expect(instruction.data.readBigUInt64LE(16)).toBe(input.minimumOut);
    expect(instruction.keys).toHaveLength(17);
    expect(instruction.keys[8].pubkey.equals(input.user)).toBe(true);
  });
  it('rejects stale state, unchecked programs, and unsupported cashback V3 coins', async () => {
    await expect(buildPumpV3Instruction({ ...common(), side: 'BUY', isCashbackCoin: true })).rejects.toThrow('CASHBACK_UNSUPPORTED');
    const stale = common(); stale.state.now = 99999;
    await expect(buildPumpV3Instruction({ ...stale, side: 'BUY' })).rejects.toThrow('STALE');
    const unchecked = common(); unchecked.state.mintAndTokenProgramsVerified = false;
    await expect(buildPumpV3Instruction({ ...unchecked, side: 'SELL' })).rejects.toThrow('UNVERIFIED');
  });
});

class SyntheticOrderStore implements LiveOrderStore {
  rows = new Map<string, LiveOrder>();
  async get(id: string) { return this.rows.get(id) ?? null; }
  async pending() { return [...this.rows.values()].filter((order) => !['CONFIRMED', 'FAILED', 'EXPIRED'].includes(order.status)); }
  async claim(order: LiveOrder) { if (this.rows.has(order.id)) return false; this.rows.set(order.id, structuredClone(order)); return true; }
  async put(order: LiveOrder) { this.rows.set(order.id, structuredClone(order)); }
}

function liveFixture() {
  const signer = Keypair.generate(), recipient = Keypair.generate().publicKey;
  const policy: LivePolicy = { mode: 'LIVE', enabled: true, acknowledgement: 'I_ACCEPT_REAL_FUNDS_AT_RISK',
    dedicatedWallet: signer.publicKey.toBase58(), maxWalletLamports: 2_000_000_000n, maxTradeLamports: 100_000_000n,
    reserveLamports: 10_000_000n, maxFeeLamports: 1_000_000n, maxPriorityFeeLamports: 100_000n,
    allowedPrograms: [SystemProgram.programId.toBase58()] };
  const store = new SyntheticOrderStore();
  let submitted: VersionedTransaction | undefined;
  const rpc = {
    getBalance: vi.fn(async () => 1_000_000_000),
    getLatestBlockhash: vi.fn(async () => ({ blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 200 })),
    getFeeForMessage: vi.fn(async () => ({ value: 15000 })),
    simulateTransaction: vi.fn(async () => ({ value: { err: null } })),
    sendRawTransaction: vi.fn(async (bytes: Uint8Array) => { submitted = VersionedTransaction.deserialize(bytes); return bs58.encode(submitted.signatures[0]); }),
    getSignatureStatuses: vi.fn(async () => ({ value: [null] as unknown[] })),
    getBlockHeight: vi.fn(async () => 100),
    getTransaction: vi.fn(async () => submitted ? ({
      slot: 123, transaction: submitted,
      meta: { err: null, fee: 15000, preBalances: [1_000_000_000, 0, 0], postBalances: [999_960_000, 25000, 0],
        preTokenBalances: [], postTokenBalances: [], loadedAddresses: { writable: [], readonly: [] } },
    }) : null),
  };
  const governor = vi.fn(async () => ({ allowed: true, reasons: [] as string[] }));
  const audit = vi.fn(async () => ({ maxNativeDebitLamports: 25000n }));
  const executor = () => new GuardedLiveExecutor(rpc as unknown as Connection, signer, policy, store, governor, audit, () => 1234);
  const input = { id: 'SYNTHETIC-NOT-A-REAL-ORDER',
    instructions: [SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: recipient, lamports: 25000n })],
    maxNativeDebitLamports: 25000n, priorityFeeLamports: 10000n };
  return { rpc, policy, store, governor, audit, executor, input, signer };
}

describe('guarded submission state machine with synthetic RPC only', () => {
  it('performs no RPC, signing, persistence, or submission in paper mode', async () => {
    const f = liveFixture(); f.policy.mode = 'PAPER';
    await expect(f.executor().submit(f.input)).rejects.toThrow('LIVE_DISABLED');
    expect(f.rpc.getBalance).not.toHaveBeenCalled(); expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
    expect(f.store.rows.size).toBe(0);
  });
  it('requires explicit acknowledgement, matching dedicated limited-funds wallet, reserve, and fee caps', () => {
    const f = liveFixture(), wallet = f.signer.publicKey.toBase58();
    for (const patch of [{ enabled: false }, { acknowledgement: '' }, { dedicatedWallet: PublicKey.default.toBase58() },
      { maxWalletLamports: 1n }, { maxTradeLamports: 1n }, { reserveLamports: 1_000_000_000n }, { maxFeeLamports: 1n }]) {
      expect(() => assertLivePolicy({ ...f.policy, ...patch }, wallet, 1_000_000_000n, 25000n, 15000n, 10000n)).toThrow();
    }
  });
  it('risk veto and simulation failures never broadcast', async () => {
    const veto = liveFixture(); veto.governor.mockResolvedValue({ allowed: false, reasons: ['KILL_SWITCH'] });
    await expect(veto.executor().submit(veto.input)).rejects.toThrow('RISK_GOVERNOR_VETO');
    expect(veto.rpc.sendRawTransaction).not.toHaveBeenCalled();
    const failed = liveFixture(); failed.rpc.simulateTransaction.mockResolvedValue({ value: { err: { InstructionError: [0, 'Custom'] } } } as never);
    await expect(failed.executor().submit(failed.input)).rejects.toThrow('SIMULATION_FAILED');
    expect(failed.rpc.sendRawTransaction).not.toHaveBeenCalled();
  });
  it('deduplicates concurrent and restarted calls before broadcasting', async () => {
    const f = liveFixture(), executor = f.executor();
    const orders = await Promise.all([executor.submit(f.input), executor.submit(f.input)]);
    expect(orders[0].signature).toBe(orders[1].signature);
    expect(orders[0].status).toBe('SUBMITTED');
    expect(f.rpc.sendRawTransaction).toHaveBeenCalledTimes(1);
    await f.executor().submit(f.input);
    expect(f.rpc.sendRawTransaction).toHaveBeenCalledTimes(1);
  });
  it('persists signed bytes before send and never treats an ambiguous network result as success', async () => {
    const f = liveFixture();
    f.rpc.sendRawTransaction.mockImplementation(async () => {
      expect(f.store.rows.get(f.input.id)?.transactionBase64).toBeTruthy();
      throw new Error('synthetic transport failed after possible broadcast');
    });
    expect((await f.executor().submit(f.input)).status).toBe('UNKNOWN');
    await f.executor().submit(f.input);
    expect(f.rpc.sendRawTransaction).toHaveBeenCalledTimes(1);
  });
  it('blocks a different order while an earlier debit is unresolved, including after a restart', async () => {
    const f = liveFixture(); await f.executor().submit(f.input);
    await expect(f.executor().submit({ ...f.input, id: 'SYNTHETIC-SECOND-ORDER' })).rejects.toThrow('REQUIRES_RECONCILIATION');
    expect(f.rpc.sendRawTransaction).toHaveBeenCalledTimes(1);
  });
  it('marks an absent expired signature expired and does not create a replacement transaction', async () => {
    const f = liveFixture(); await f.executor().submit(f.input);
    f.rpc.getBlockHeight.mockResolvedValue(201);
    expect((await f.executor().reconcile(f.input.id)).status).toBe('EXPIRED');
    await f.executor().submit(f.input);
    expect(f.rpc.sendRawTransaction).toHaveBeenCalledTimes(1);
  });
  it('requires confirmed transaction metadata before recording success and uses actual balance deltas', async () => {
    const f = liveFixture(); await f.executor().submit(f.input);
    f.rpc.getSignatureStatuses.mockResolvedValue({ value: [{ err: null, confirmationStatus: 'confirmed' }] });
    const result = await f.executor().reconcile(f.input.id);
    expect(result.status).toBe('CONFIRMED');
    expect(result.actual).toEqual({ feeLamports: '15000', nativeDeltaLamports: '-40000', tokenDeltas: {}, slot: 123 });
  });
  it('accounts for network costs on a confirmed failed transaction', async () => {
    const f = liveFixture(); await f.executor().submit(f.input);
    f.rpc.getSignatureStatuses.mockResolvedValue({ value: [{ err: { Custom: 1 }, confirmationStatus: 'confirmed' }] });
    const getTransaction = f.rpc.getTransaction.getMockImplementation()!;
    f.rpc.getTransaction.mockImplementation(async () => {
      const tx = await getTransaction();
      return tx ? { ...tx, meta: { ...tx.meta, err: { Custom: 1 }, postBalances: [999_985_000, 0, 0] } } as never : null;
    });
    const result = await f.executor().reconcile(f.input.id);
    expect(result.status).toBe('FAILED'); expect(result.actual?.feeLamports).toBe('15000');
    expect(result.actual?.nativeDeltaLamports).toBe('-15000');
  });
});

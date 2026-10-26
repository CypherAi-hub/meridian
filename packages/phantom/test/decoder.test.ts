import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BN, type Idl } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { ADAPTERS, VERSIONED_ADAPTERS, decodeTransaction, decodeLogNotification, validateTransactionConfig, validateTransactionLayout, type RpcTransaction } from '../src/decoder.ts';
import { WSOL } from '../src/types.ts';

// Generated cases are SYNTHETIC. The separately attributed real-pump-buy fixture is mainnet capture.
const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
const actor = key(2), mint = key(3), pool = key(4);
const sig = bs58.encode(new Uint8Array(64).fill(7));
function defaults(type: any, idl: Idl): any {
  if (typeof type === 'string') {
    if (type === 'pubkey') return key(12);
    if (type === 'bool') return false;
    if (type === 'string') return '';
    if (type === 'bytes') return Buffer.alloc(0);
    return ['u8', 'u16', 'u32', 'i8', 'i16', 'i32', 'f32', 'f64'].includes(type) ? 0 : new BN(0);
  }
  if ('option' in type) return null;
  if ('vec' in type) return [];
  if ('array' in type) return Array.from({ length: type.array[1] }, () => defaults(type.array[0], idl));
  if ('defined' in type) {
    const definition: any = idl.types!.find(t => t.name === type.defined.name)!.type;
    if (definition.kind === 'struct') return Object.fromEntries(definition.fields.map((f: any, i: number) => typeof f === 'string' || !('name' in f) ? [String(i), defaults(f, idl)] : [f.name, defaults(f.type, idl)]));
    return { [definition.variants[0].name]: {} };
  }
  throw Error('Unknown synthetic fixture type');
}
function fixture(schema: typeof ADAPTERS[number], name: string, overrides: Record<string, unknown> = {}): RpcTransaction {
  const instruction = schema.idl.instructions.find(i => i.name === name)!;
  const args = Object.fromEntries(instruction.args.map(a => [a.name, defaults(a.type, schema.idl)]));
  Object.assign(args, overrides);
  const keys: string[] = [schema.address];
  const accounts = instruction.accounts.map((a, i) => {
    if ('accounts' in a) throw Error('Nested unsupported fixture');
    const named = a.name === 'user' || a.name === 'creator' || a.name === 'payer' ? actor.toBase58() : /^(base_mint|mint|token_0_mint|output_token_mint)$/.test(a.name) ? mint.toBase58() : /^(quote_mint|token_1_mint|input_token_mint)$/.test(a.name) ? WSOL : /^(pool|pool_state|bonding_curve)$/.test(a.name) ? pool.toBase58() : key(i + 30).toBase58();
    keys.push(a.address ?? named); return keys.length - 1;
  });
  return { slot: 123, blockTime: 100, version: 0, transaction: { signatures: [sig], message: { accountKeys: keys, instructions: [{ programIdIndex: 0, accounts, data: bs58.encode(schema.coder.encode(name, args)) }] } }, meta: { err: null, fee: 5000, innerInstructions: [], preTokenBalances: [], postTokenBalances: [], logMessages: [] } };
}
function eventLog(schema: typeof ADAPTERS[number], name: string, overrides: Record<string, unknown>): string {
  const definition = schema.idl.events!.find(e => e.name === name)!;
  const type: any = schema.idl.types!.find(t => t.name === name)!.type;
  const fields = Object.fromEntries(type.fields.map((f: any) => [f.name, defaults(f.type, schema.idl)]));
  Object.assign(fields, overrides);
  return `Program data: ${Buffer.concat([Buffer.from(definition.discriminator), schema.typesCoder.encode(name, fields)]).toString('base64')}`;
}
function addTradeEvent(tx: RpcTransaction, schema: typeof ADAPTERS[number], instruction = 'buy_v3'): void {
  tx.meta!.logMessages = [`Program ${schema.address} invoke [1]`, eventLog(schema, 'TradeEvent', { user: actor, mint, quote_mint: new PublicKey(WSOL), is_buy: true, ix_name: instruction, token_amount: new BN(123456), quote_amount: new BN(9999) }), `Program ${schema.address} success`];
}
function syntheticV1(tx: RpcTransaction): RpcTransaction {
  const copy = structuredClone(tx), message = copy.transaction.message, oldKeys = message.accountKeys;
  const keys = [...new Set([actor.toBase58(), ...oldKeys])];
  const remap = (ix: typeof message.instructions[number]) => ({ ...ix, programIdIndex: keys.indexOf(oldKeys[ix.programIdIndex]), accounts: ix.accounts.map(i => keys.indexOf(oldKeys[i])) });
  message.instructions = message.instructions.map(remap);
  if (copy.meta?.innerInstructions) copy.meta.innerInstructions = copy.meta.innerInstructions.map(group => ({ ...group, instructions: group.instructions.map(remap) }));
  message.accountKeys = keys;
  message.header = { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 };
  message.recentBlockhash = key(90).toBase58();
  message.transactionConfig = { priorityFee: 8180, computeUnitLimit: 196132, loadedAccountsDataSizeLimit: 67108864, heapSize: null };
  copy.version = 1;
  return copy;
}

describe('verified protocol instruction decoding', () => {
  it('decodes Pump launch creation slot, signature and creator from current official schema', () => {
    const tx = fixture(ADAPTERS[0], 'create_v2', { creator: actor });
    const events = decodeTransaction(tx, 1000, 'finalized', 1001);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'launch', mint: mint.toBase58(), creator: actor.toBase58(), slot: 123, signature: sig, receivedAt: 1000, processedAt: 1001, commitment: 'finalized' });
  });
  it('handles Solana v0 loaded writable/readonly account addresses', () => {
    const tx = fixture(ADAPTERS[0], 'buy_v3');
    const keys = tx.transaction.message.accountKeys;
    tx.meta!.loadedAddresses = { writable: keys.slice(2, 10), readonly: keys.slice(10) };
    tx.transaction.message.accountKeys = keys.slice(0, 2);
    expect(decodeTransaction(tx, 1000)[0]?.kind).toBe('buy');
  });
  it('decodes inner protocol instructions and ignores lookalike logs as launch evidence', () => {
    const tx = fixture(ADAPTERS[1], 'create_pool');
    const instruction = tx.transaction.message.instructions[0];
    tx.transaction.message.accountKeys.push(key(100).toBase58());
    tx.transaction.message.instructions = [{ programIdIndex: tx.transaction.message.accountKeys.length - 1, accounts: [], data: '' }];
    tx.meta!.innerInstructions = [{ index: 0, instructions: [instruction] }];
    expect(decodeTransaction(tx, 1000)[0]).toMatchObject({ protocol: 'pumpswap', kind: 'pool', instructionIndex: '0.0' });
    tx.meta!.innerInstructions = [];
    tx.meta!.logMessages = ['Program log: Instruction: CreatePool'];
    expect(decodeTransaction(tx, 1000)).toEqual([]);
  });
  it('rejects malformed bytes, invalid fixed accounts, failed transactions and unsupported versions', () => {
    const tx = fixture(ADAPTERS[0], 'buy_v3');
    const wrongAccount = structuredClone(tx), fixed = ADAPTERS[0].idl.instructions.find(i => i.name === 'buy_v3')!.accounts.findIndex(a => 'address' in a && a.address);
    expect(fixed).toBeGreaterThanOrEqual(0);
    wrongAccount.transaction.message.accountKeys[wrongAccount.transaction.message.instructions[0].accounts[fixed]] = key(105).toBase58();
    expect(decodeTransaction(wrongAccount, 1000)).toEqual([]);
    expect(decodeTransaction({ ...tx, version: 1 }, 1000)).toEqual([]);
    expect(decodeTransaction({ ...tx, meta: { ...tx.meta!, err: { InstructionError: [0, 'Failed'] } } }, 1000)).toEqual([]);
    tx.transaction.message.instructions[0].data = 'not_base58_0';
    expect(decodeTransaction(tx, 1000)).toEqual([]);
  });
  it.each([null, {}, { transaction: {} }, { slot: -1 }, { meta: { err: null }, slot: 1 }])('malformed envelopes fail closed without crashing', value => {
    expect(() => decodeTransaction(value as unknown as RpcTransaction, 1000)).not.toThrow();
    expect(decodeTransaction(value as unknown as RpcTransaction, 1000)).toEqual([]);
  });
  it('decodes the actual captured pre-upgrade buy via official historical IDL without invented defaults', () => {
    const tx = JSON.parse(fs.readFileSync(new URL('./fixtures/real-pump-buy.json', import.meta.url), 'utf8'));
    const events = decodeTransaction(tx, 1000);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'buy', instruction: 'buy_exact_quote_in_v2', slot: 461770647 });
    expect(events[0].details.instructionSchema).toBe('pump-2026-09-12');
    expect(events[0].details.args).not.toHaveProperty('partial_fill');
    expect(events[0]).toMatchObject({ quantityEvidence: 'program-event', amountRaw: expect.stringMatching(/^\d+$/), quoteAmountRaw: expect.stringMatching(/^\d+$/) });
    expect(events[0].details.eventSchema).toBe('pump-sdk-4.3.1');
    expect(events[0].details).not.toHaveProperty('unsupportedTrailingBytes');
    expect(events[0].details).toMatchObject({ eventInstructionLabelMismatch: true, executionSupported: false });
  });
});

describe('read-only Solana v1 JSON transactions', () => {
  it('decodes the attributed finalized mainnet v1 fixture with actual event amounts and total-lamport config', () => {
    const tx: RpcTransaction = JSON.parse(fs.readFileSync(new URL('./fixtures/real-v1-transaction.json', import.meta.url), 'utf8'));
    const source = JSON.parse(fs.readFileSync(new URL('./fixtures/real-v1-transaction.source.json', import.meta.url), 'utf8'));
    expect(source).toMatchObject({ synthetic: false, version: 1, signature: tx.transaction.signatures[0], slot: tx.slot });
    expect(tx.slot).toBe(461797644);
    const decoded = decodeTransaction(tx, 1000);
    expect(decoded).toHaveLength(1);
    expect(decoded[0]).toMatchObject({ kind: 'sell', instruction: 'sell_v3', instructionIndex: '1.0', amountRaw: '1312376936857', quoteAmountRaw: '748764363', quantityEvidence: 'program-event' });
    expect(decoded[0].details).toMatchObject({ transactionVersion: 1, executionSupported: false, executionUnsupportedReason: 'TRANSACTION_V1_READ_ONLY_EXECUTION_UNCERTIFIED', transactionConfig: { computeUnitLimit: 196132, loadedAccountsDataSizeLimit: 67108864, heapSize: null, priorityFee: '8180' }, priorityFeeLamports: '8180', priorityFeeUnit: 'LAMPORTS_TOTAL' });
  });
  it('preserves exact u64 total priority fees without converting them to prices per compute unit', () => {
    const tx = syntheticV1(fixture(ADAPTERS[0], 'buy_v3'));
    tx.transaction.message.transactionConfig!.priorityFee = '18446744073709551615';
    expect(validateTransactionLayout(tx).config!.priorityFee).toBe('18446744073709551615');
    expect(decodeTransaction(tx, 1000)[0].details.priorityFeeLamports).toBe('18446744073709551615');
    expect(validateTransactionConfig({ computeUnitLimit: null, loadedAccountsDataSizeLimit: null, heapSize: null, priorityFee: null }).priorityFee).toBeNull();
  });
  it.each([
    { priorityFee: Number.MAX_SAFE_INTEGER + 1 }, { priorityFee: '18446744073709551616' },
    { priorityFee: -1 }, { priorityFee: '1.5' }, { priorityFee: '01' }, { priorityFee: undefined },
    { computeUnitLimit: -1 }, { computeUnitLimit: 1.5 }, { computeUnitLimit: 4294967296 },
    { loadedAccountsDataSizeLimit: '123' }, { heapSize: 32000 }, { heapSize: 32769 },
    { futureBudgetRequest: 1 },
  ])('rejects malformed or unsupported synthetic v1 config %#', override => {
    const tx = syntheticV1(fixture(ADAPTERS[0], 'buy_v3'));
    Object.assign(tx.transaction.message.transactionConfig!, override);
    expect(() => validateTransactionLayout(tx)).toThrow('TRANSACTION_V1_CONFIG_INVALID_OR_UNSUPPORTED');
    expect(decodeTransaction(tx, 1000)).toEqual([]);
  });
  it.each(['missing-config', 'v0-config', 'legacy-config', 'future-version', 'lookups', 'loaded-addresses', 'duplicate-keys', 'readonly-payer', 'signature-count', 'missing-blockhash', 'invalid-index'] as const)('fails closed for incoherent synthetic %s layout', fault => {
    const tx = syntheticV1(fixture(ADAPTERS[0], 'buy_v3')), message = tx.transaction.message;
    if (fault === 'missing-config') delete message.transactionConfig;
    if (fault === 'v0-config') tx.version = 0;
    if (fault === 'legacy-config') tx.version = 'legacy';
    if (fault === 'future-version') tx.version = 2;
    if (fault === 'lookups') message.addressTableLookups = [{}];
    if (fault === 'loaded-addresses') tx.meta!.loadedAddresses = { writable: [key(110).toBase58()], readonly: [] };
    if (fault === 'duplicate-keys') message.accountKeys.push(message.accountKeys[0]);
    if (fault === 'readonly-payer') message.header!.numReadonlySignedAccounts = 1;
    if (fault === 'signature-count') message.header!.numRequiredSignatures = 2;
    if (fault === 'missing-blockhash') delete message.recentBlockhash;
    if (fault === 'invalid-index') message.instructions[0].accounts[0] = 255;
    expect(() => validateTransactionLayout(tx)).toThrow();
    expect(decodeTransaction(tx, 1000)).toEqual([]);
  });
  it('preserves unknown event fields and instruction-label vetoes alongside the unconditional v1 execution veto', () => {
    const sdk = VERSIONED_ADAPTERS.find(a => a.schemaVersion === 'pump-sdk-4.3.1')!;
    const tx = syntheticV1(fixture(sdk, 'buy_v3')); addTradeEvent(tx, sdk, 'SYNTHETIC_UNRECOGNIZED_LABEL');
    const encoded = tx.meta!.logMessages![1].slice(14);
    tx.meta!.logMessages![1] = `Program data: ${Buffer.concat([Buffer.from(encoded, 'base64'), Buffer.from([1, 2])]).toString('base64')}`;
    const decoded = decodeTransaction(tx, 1000)[0];
    expect(decoded.amountRaw).toBe('123456');
    expect(decoded.details).toMatchObject({ transactionVersion: 1, eventSchema: 'KNOWN_PREFIX_UNKNOWN_TRAILING_BYTES', eventInstructionLabelMismatch: true, executionSupported: false, executionUnsupportedReason: 'TRANSACTION_V1_READ_ONLY_EXECUTION_UNCERTIFIED' });
  });
});

describe('actual amount attribution', () => {
  it('never turns transaction-wide net balances or instruction maximums into fill volume', () => {
    const tx = fixture(ADAPTERS[0], 'buy_v3');
    tx.meta!.preTokenBalances = [{ accountIndex: 1, mint: mint.toBase58(), owner: actor.toBase58(), uiTokenAmount: { amount: '0', decimals: 6 } }];
    tx.meta!.postTokenBalances = [{ accountIndex: 1, mint: mint.toBase58(), owner: actor.toBase58(), uiTokenAmount: { amount: '999999', decimals: 6 } }];
    expect(decodeTransaction(tx, 1000)[0]).toMatchObject({ amountRaw: null, quoteAmountRaw: null, quantityEvidence: 'unavailable' });
  });
  it('accepts exact typed event amounts emitted by the matching executing protocol', () => {
    const tx = fixture(ADAPTERS[0], 'buy_v3'); addTradeEvent(tx, ADAPTERS[0]);
    expect(decodeTransaction(tx, 1000)[0]).toMatchObject({ amountRaw: '123456', quoteAmountRaw: '9999', quantityEvidence: 'program-event' });
  });
  it('uses the SDK4.3.1 exact current instruction and event schema when both match', () => {
    const sdk = VERSIONED_ADAPTERS.find(a => a.schemaVersion === 'pump-sdk-4.3.1')!;
    const tx = fixture(sdk, 'buy_v3'); addTradeEvent(tx, sdk);
    const decoded = decodeTransaction(tx, 1000)[0];
    expect(decoded.details).toMatchObject({ instructionSchema: 'pump-sdk-4.3.1', eventSchema: 'pump-sdk-4.3.1' });
    expect(decoded.details).not.toHaveProperty('unsupportedTrailingBytes');
    expect(decoded.details).not.toHaveProperty('executionSupported');
    expect(decoded.amountRaw).toBe('123456');
  });
  it('supports the official PumpSwapSDK2.2.0 instruction and event schemas', () => {
    const sdk = VERSIONED_ADAPTERS.find(a => a.schemaVersion === 'pump-amm-sdk-2.2.0')!;
    const tx = fixture(sdk, 'buy_v2');
    tx.meta!.logMessages = [`Program ${sdk.address} invoke [1]`, eventLog(sdk, 'BuyEvent', { user: actor, pool, ix_name: 'buy_v2', base_amount_out: new BN(1234), user_quote_amount_in: new BN(99) }), `Program ${sdk.address} success`];
    const decoded = decodeTransaction(tx, 1000)[0];
    expect(decoded).toMatchObject({ protocol: 'pumpswap', kind: 'buy', amountRaw: '1234', quoteAmountRaw: '99', quantityEvidence: 'program-event' });
    expect(decoded.details).toMatchObject({ instructionSchema: 'pump-amm-sdk-2.2.0', eventSchema: 'pump-amm-sdk-2.2.0' });
  });
  it('keeps the unknown-schema execution veto for genuinely unmatched trailing bytes', () => {
    const sdk = VERSIONED_ADAPTERS.find(a => a.schemaVersion === 'pump-sdk-4.3.1')!;
    const tx = fixture(sdk, 'buy_v3'); addTradeEvent(tx, sdk);
    const encoded = tx.meta!.logMessages![1].slice(14);
    tx.meta!.logMessages![1] = `Program data: ${Buffer.concat([Buffer.from(encoded, 'base64'), Buffer.from([9, 8, 7, 6])]).toString('base64')}`;
    const decoded = decodeTransaction(tx, 1000)[0];
    expect(decoded.amountRaw).toBe('123456');
    expect(decoded.details).toMatchObject({ eventSchema: 'KNOWN_PREFIX_UNKNOWN_TRAILING_BYTES', knownPrefixSchema: 'pump-sdk-4.3.1', unsupportedTrailingBytes: 4, executionSupported: false });
  });
  it('rejects spoofed program data under another program invocation', () => {
    const tx = fixture(ADAPTERS[0], 'buy_v3'); addTradeEvent(tx, ADAPTERS[0]);
    tx.meta!.logMessages![0] = `Program ${key(90).toBase58()} invoke [1]`;
    tx.meta!.logMessages![2] = `Program ${key(90).toBase58()} success`;
    expect(decodeTransaction(tx, 1000)[0].quantityEvidence).toBe('unavailable');
  });
  it('discards amount events from a failed CPI even when the outer transaction succeeds', () => {
    const tx = fixture(ADAPTERS[0], 'buy_v3'); addTradeEvent(tx, ADAPTERS[0]);
    tx.meta!.logMessages![2] = `Program ${ADAPTERS[0].address} failed: custom program error: 0x1`;
    expect(decodeTransaction(tx, 1000)[0].quantityEvidence).toBe('unavailable');
  });
  it('discards a successful child event when its ancestor invocation later fails', () => {
    const tx = fixture(ADAPTERS[0], 'buy_v3'); addTradeEvent(tx, ADAPTERS[0]);
    tx.meta!.logMessages = [
      `Program ${key(90).toBase58()} invoke [1]`,
      `Program ${ADAPTERS[0].address} invoke [2]`,
      tx.meta!.logMessages![1],
      `Program ${ADAPTERS[0].address} success`,
      `Program ${key(90).toBase58()} failed: custom program error: 0x1`,
    ];
    expect(decodeTransaction(tx, 1000)[0].quantityEvidence).toBe('unavailable');
  });
  it('does not ambiguously attribute one event to repeated actor/mint trade legs', () => {
    const tx = fixture(ADAPTERS[0], 'buy_v3'); addTradeEvent(tx, ADAPTERS[0]);
    tx.transaction.message.instructions.push({ ...tx.transaction.message.instructions[0] });
    const result = decodeTransaction(tx, 1000);
    expect(result).toHaveLength(2);
    expect(result.every(x => x.amountRaw === null && x.quantityEvidence === 'unavailable')).toBe(true);
  });
  it('accepts the old official instruction encoding by exact bytes rather than padding newer fields', () => {
    const legacy = VERSIONED_ADAPTERS.find(a => a.schemaVersion === 'pump-2026-09-12')!;
    const tx = fixture(legacy, 'buy_exact_quote_in_v2');
    expect(decodeTransaction(tx, 1000)[0].details.instructionSchema).toBe('pump-2026-09-12');
    tx.transaction.message.instructions[0].data = bs58.encode(Buffer.concat([Buffer.from(bs58.decode(tx.transaction.message.instructions[0].data)), Buffer.from([254])]));
    expect(decodeTransaction(tx, 1000)).toEqual([]);
  });
});

describe('fast finalized typed-program-event observations', () => {
  it('decodes the captured real event without any full-transaction fetch or order eligibility', () => {
    const capture: RpcTransaction = JSON.parse(fs.readFileSync(new URL('./fixtures/real-pump-buy.json', import.meta.url), 'utf8'));
    const result = decodeLogNotification(capture.meta!.logMessages, capture.transaction.signatures[0], capture.slot, 1000, 1001);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: 'buy', commitment: 'finalized', amountRaw: '529899842623', quoteAmountRaw: '106675377', quoteMint: WSOL, receivedAt: 1000, processedAt: 1001, quantityEvidence: 'program-event' });
    expect(result[0].id).toMatch(/:log:\d+$/);
    expect(result[0].details).toMatchObject({ source: 'TYPED_PROGRAM_EVENT', fullTransactionVerified: false, executionSupported: false, eventSchema: 'pump-sdk-4.3.1' });
  });
  it('does not infer a launch from human-readable instruction log labels', () => {
    expect(decodeLogNotification([`Program ${ADAPTERS[0].address} invoke [1]`, 'Program log: Instruction: Create', `Program ${ADAPTERS[0].address} success`], sig, 123, 1000)).toEqual([]);
  });
  it('requires actual encoded event fields and records the source log index', () => {
    const sdk = VERSIONED_ADAPTERS.find(a => a.schemaVersion === 'pump-sdk-4.3.1')!;
    const lines = [`Program ${sdk.address} invoke [1]`, 'Program log: irrelevant', eventLog(sdk, 'CreateEvent', { user: actor, creator: actor, mint, bonding_curve: pool, quote_mint: new PublicKey(WSOL), timestamp: new BN(100) }), `Program ${sdk.address} success`];
    const result = decodeLogNotification(lines, sig, 123, 1000, 1001);
    expect(result[0]).toMatchObject({ id: `${sig}:log:2`, kind: 'launch', mint: mint.toBase58(), actor: actor.toBase58(), creator: actor.toBase58(), pool: pool.toBase58(), amountRaw: null, quoteAmountRaw: null, blockTime: 100 });
  });
  it('ignores PumpSwap trade notifications until the mint pair is verified from pool state', () => {
    const sdk = VERSIONED_ADAPTERS.find(a => a.schemaVersion === 'pump-amm-sdk-2.2.0')!;
    const lines = [`Program ${sdk.address} invoke [1]`, eventLog(sdk, 'BuyEvent', { user: actor, pool, base_amount_out: new BN(12), user_quote_amount_in: new BN(10) }), `Program ${sdk.address} success`];
    expect(decodeLogNotification(lines, sig, 123, 1000)).toEqual([]);
    const observed = decodeLogNotification(lines, sig, 123, 1000, 1001, { resolvePool: p => p === pool.toBase58() ? { mint: mint.toBase58(), quoteMint: WSOL } : undefined });
    expect(observed[0]).toMatchObject({ mint: mint.toBase58(), quoteMint: WSOL, kind: 'buy', amountRaw: '12', quoteAmountRaw: '10' });
    expect(observed[0].details).toMatchObject({ mintEvidence: 'VERIFIED_POOL_MAPPING', fullTransactionVerified: false, executionSupported: false });
  });
  it('never emits fast observations from spoofed data or a failed program invocation', () => {
    const sdk = VERSIONED_ADAPTERS.find(a => a.schemaVersion === 'pump-sdk-4.3.1')!;
    const tx = fixture(sdk, 'buy_v3'); addTradeEvent(tx, sdk);
    const lines = tx.meta!.logMessages!;
    expect(decodeLogNotification([`Program ${key(90).toBase58()} invoke [1]`, lines[1], `Program ${key(90).toBase58()} success`], sig, 123, 1000)).toEqual([]);
    expect(decodeLogNotification([lines[0], lines[1], `Program ${sdk.address} failed: custom error`], sig, 123, 1000)).toEqual([]);
  });
  it('fails closed for malformed signatures, slots or non-event payloads', () => {
    expect(decodeLogNotification([], 'not-a-signature', 123, 1000)).toEqual([]);
    expect(decodeLogNotification([], sig, -1, 1000)).toEqual([]);
    expect(decodeLogNotification({}, sig, 123, 1000)).toEqual([]);
    expect(decodeLogNotification([null, {}, 'Program data: malformed'], sig, 123, 1000)).toEqual([]);
  });
});

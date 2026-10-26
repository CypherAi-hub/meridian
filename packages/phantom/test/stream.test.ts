import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import type { SubscribeRequest, SubscribeUpdateTransaction } from '@triton-one/yellowstone-grpc';
import { PROGRAMS, decodeLogNotification, type RpcTransaction } from '../src/decoder.ts';
import { Rpc, SolanaStream, normalizeYellowstoneTransaction, startYellowstone, enrichmentPriority, ENRICHMENT_PRIORITY } from '../src/stream.ts';
import { WSOL, type Health, type ChainEvent } from '../src/types.ts';

// Generated transport responses are SYNTHETIC. Separately attributed fixtures are recorded chain data.
const signature = (n: number) => bs58.encode(new Uint8Array(64).fill(n));
const tx = (n: number): RpcTransaction => ({ slot: n, blockTime: null, transaction: { signatures: [signature(n)], message: { accountKeys: [], instructions: [] } }, meta: { err: null } });
const health = (): Health => ({ status: 'STARTING', source: 'synthetic-test', received: 0, decoded: 0, rejected: 0, errors: 0, lastEventAt: null, latencyMs: { p50: null, p95: null }, backfillGaps: 0, queueDepth: 0 });
function cursorStore(initial?: string) {
  const cursors = new Map(PROGRAMS.map(p => [p, initial]));
  return { cursors, cursor: vi.fn(async (program: string, value?: string) => { if (value) cursors.set(program, value); return cursors.get(program); }) };
}
const rpcMock = (fn: (method: string, params: unknown[]) => Promise<unknown>) => ({ call: <T>(method: string, params: unknown[]) => fn(method, params) as Promise<T> });
function checkpointStore(slot: string | null = null) {
  let state: any = slot == null ? null : { slot };
  return { get: vi.fn(async () => state), save: vi.fn(async (_id: string, value: unknown) => { state = structuredClone(value); }), state: () => state };
}

describe('public RPC budget and errors', () => {
  it('serializes requests across Retry-After 429 cooldown instead of flooding retries', async () => {
    let now = 0; const pauses: number[] = [], sent: number[] = [];
    let calls = 0;
    const send = vi.fn(async () => { sent.push(now); return ++calls === 1 ? new Response('limited', { status: 429, headers: { 'retry-after': '12' } }) : Response.json({ jsonrpc: '2.0', result: calls }); }) as unknown as typeof fetch;
    const rpc = new Rpc('https://synthetic.invalid', 1000, { fetch: send, now: () => now, sleep: async ms => { pauses.push(ms); now += ms; } });
    const [a, b] = await Promise.all([rpc.call('first', []), rpc.call('second', [])]);
    expect(a).toBe(2); expect(b).toBe(3);
    expect(pauses).toEqual([12_000, 1000]);
    expect(sent).toEqual([0, 12_000, 13_000]);
  });
  it('uses 10-second minimum public429 cooldown and never includes secret URL/body in errors', async () => {
    let now = 0; const pauses: number[] = [];
    const rpc = new Rpc('https://secret-token.invalid', 0, { retries: 1, now: () => now, sleep: async ms => { pauses.push(ms); now += ms; }, fetch: vi.fn(async () => new Response('secret response', { status: 429 })) as unknown as typeof fetch });
    await expect(rpc.call('getTransaction', [])).rejects.toThrow('RPC_getTransaction_HTTP_429');
    expect(pauses).toEqual([10_000]);
  });
  it('rejects malformed JSON RPC results rather than fabricating a result', async () => {
    const rpc = new Rpc('https://synthetic.invalid', 0, { fetch: vi.fn(async () => Response.json({ jsonrpc: '2.0' })) as unknown as typeof fetch });
    await expect(rpc.call('missing', [])).rejects.toThrow('INVALID_RESPONSE');
  });
});

describe('finalized Solana backfill and cursor safety', () => {
  it('requests numeric v1 capability and durably receives the attributed JSON v1 fixture', async () => {
    const capture: RpcTransaction = JSON.parse(fs.readFileSync(new URL('./fixtures/real-v1-transaction.json', import.meta.url), 'utf8'));
    const receive = vi.fn(async () => undefined), store = cursorStore(), requests: unknown[][] = [];
    const rpc = rpcMock(async (method, params) => {
      if (method === 'getSignaturesForAddress') return [{ signature: capture.transaction.signatures[0], slot: capture.slot, err: null }];
      requests.push(params); return capture;
    });
    const stream = new SolanaStream(rpc, 'wss://synthetic.invalid', store, health(), receive, { attempts: 1, retryMs: 0 });
    await stream.backfill();
    expect(requests).toHaveLength(1);
    expect(requests[0][1]).toMatchObject({ maxSupportedTransactionVersion: 1, encoding: 'json', commitment: 'finalized' });
    expect(receive).toHaveBeenCalledExactlyOnceWith(capture, expect.any(Number), 'finalized');
    expect(store.cursors.get(PROGRAMS[0])).toBe(capture.transaction.signatures[0]);
    await stream.stop();
  });
  it('does not advance a durable cursor across malformed v1 configuration', async () => {
    const capture: RpcTransaction = JSON.parse(fs.readFileSync(new URL('./fixtures/real-v1-transaction.json', import.meta.url), 'utf8'));
    delete capture.transaction.message.transactionConfig; // Synthetic corruption of the separate recorded fixture.
    const receive = vi.fn(async () => undefined), h = health(), store = cursorStore(signature(1));
    const rpc = rpcMock(async method => method === 'getSignaturesForAddress' ? [{ signature: capture.transaction.signatures[0], slot: capture.slot, err: null }, { signature: signature(1), slot: 1, err: null }] : capture);
    const stream = new SolanaStream(rpc, 'wss://synthetic.invalid', store, h, receive, { attempts: 1, retryMs: 0 });
    await stream.backfill();
    expect(receive).not.toHaveBeenCalled();
    expect(store.cursors.get(PROGRAMS[0])).toBe(signature(1));
    expect(h.backfillGaps).toBeGreaterThan(0);
    await stream.stop();
  });
  it('advances a cursor only after every transaction is durably received', async () => {
    const store = cursorStore(signature(1)), h = health();
    let release!: () => void;
    const persisted = new Promise<void>(resolve => { release = resolve; });
    const receive = vi.fn(async (_tx: RpcTransaction, _at: number, _commitment: 'confirmed' | 'finalized') => persisted);
    const rpc = rpcMock(async method => method === 'getSignaturesForAddress' ? [{ signature: signature(2), slot: 2, err: null }, { signature: signature(1), slot: 1, err: null }] : tx(2));
    const stream = new SolanaStream(rpc, 'wss://synthetic.invalid', store, h, receive, { retryMs: 0 });
    const filling = stream.backfill();
    await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce());
    expect(store.cursors.get(PROGRAMS[0])).toBe(signature(1));
    release(); await filling;
    expect(store.cursors.get(PROGRAMS[0])).toBe(signature(2));
    expect(receive.mock.calls[0][2]).toBe('finalized');
    await stream.stop();
  });
  it('retains old restart cursor after processing failure then replays successfully', async () => {
    const store = cursorStore(signature(1)), h = health(); let fail = true;
    const rpc = rpcMock(async method => method === 'getSignaturesForAddress' ? [{ signature: signature(2), slot: 2, err: null }, { signature: signature(1), slot: 1, err: null }] : tx(2));
    const first = new SolanaStream(rpc, 'wss://synthetic.invalid', store, h, async () => { if (fail) throw Error('SYNTHETIC_DATABASE_FAILURE'); }, { retryMs: 0, attempts: 1 });
    await first.backfill();
    expect(store.cursors.get(PROGRAMS[0])).toBe(signature(1)); expect(h.backfillGaps).toBeGreaterThan(0);
    await first.stop(); fail = false;
    const received = vi.fn(async () => undefined);
    const restarted = new SolanaStream(rpc, 'wss://synthetic.invalid', store, health(), received, { retryMs: 0 });
    await restarted.backfill();
    expect(received).toHaveBeenCalledOnce(); expect(store.cursors.get(PROGRAMS[0])).toBe(signature(2));
    await restarted.stop();
  });
  it('retries temporarily missing finalized transactions without dropping the queue entry', async () => {
    let tries = 0; const h = health();
    const rpc = rpcMock(async method => method === 'getSignaturesForAddress' ? [{ signature: signature(2), slot: 2, err: null }] : ++tries < 3 ? null : tx(2));
    const receive = vi.fn(async () => undefined), stream = new SolanaStream(rpc, 'wss://synthetic.invalid', cursorStore(), h, receive, { retryMs: 0 });
    await stream.backfill(); expect(tries).toBe(3); expect(receive).toHaveBeenCalledOnce(); expect(h.backfillGaps).toBe(0);
    await stream.stop();
  });
  it('never advances across bounded pagination gaps or a missing historical cursor', async () => {
    const store = cursorStore(signature(1)), h = health();
    const rpc = rpcMock(async method => method === 'getSignaturesForAddress' ? [{ signature: signature(3), slot: 3, err: null }, { signature: signature(2), slot: 2, err: null }] : tx(3));
    const stream = new SolanaStream(rpc, 'wss://synthetic.invalid', store, h, async () => undefined, { retryMs: 0, attempts: 1, pageSize: 2, maxPages: 1 });
    await stream.backfill();
    expect(store.cursors.get(PROGRAMS[0])).toBe(signature(1)); expect(h.status).toBe('DEGRADED'); expect(h.backfillGaps).toBeGreaterThan(0);
    await stream.stop();
  });
  it('deduplicates repeated program appearances and skips failed transaction rows', async () => {
    const store = cursorStore(), receive = vi.fn(async () => undefined);
    const rpc = rpcMock(async method => method === 'getSignaturesForAddress' ? [{ signature: signature(3), slot: 3, err: { failed: true } }, { signature: signature(2), slot: 2, err: null }] : tx(2));
    const stream = new SolanaStream(rpc, 'wss://synthetic.invalid', store, health(), receive, { retryMs: 0 });
    await stream.backfill(); expect(receive).toHaveBeenCalledOnce(); expect(store.cursors.get(PROGRAMS[0])).toBe(signature(3));
    await stream.stop();
  });
  it('does not mistake a mismatched RPC transaction signature for persisted history', async () => {
    const store = cursorStore(), h = health();
    const rpc = rpcMock(async method => method === 'getSignaturesForAddress' ? [{ signature: signature(2), slot: 2, err: null }] : tx(3));
    const stream = new SolanaStream(rpc, 'wss://synthetic.invalid', store, h, async () => undefined, { retryMs: 0, attempts: 1 });
    await stream.backfill(); expect(store.cursors.get(PROGRAMS[0])).toBeUndefined(); expect(h.backfillGaps).toBeGreaterThan(0); await stream.stop();
  });
  it('bounds an overloaded transaction queue and never claims initial lookback recovered unknown drops', async () => {
    const h = health(), store = cursorStore();
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const socket = { onopen: null as (() => void) | null, onmessage: null as ((event: { data: unknown }) => void) | null, onerror: null as (() => void) | null, onclose: null as (() => void) | null, send: vi.fn(), close: vi.fn() };
    const rpc = rpcMock(async (method, params) => {
      if (method === 'getSignaturesForAddress') return [];
      await gate; const value = tx(1); value.transaction.signatures = [String(params[0])]; return value;
    });
    const stream = new SolanaStream(rpc, 'wss://synthetic.invalid', store, h, async () => undefined, { websocket: () => socket, maxQueue: 2, attempts: 1, retryMs: 0, backfillIntervalMs: 1_000_000 });
    stream.start(); socket.onopen?.();
    for (let i = 1; i <= 10_000; i++) { const bytes = Buffer.alloc(64); bytes.writeUInt32LE(i); socket.onmessage?.({ data: JSON.stringify({ method: 'logsNotification', params: { result: { value: { signature: bs58.encode(bytes), err: null } } } }) }); }
    expect(h.received).toBe(10_000); expect(h.queueDepth).toBeLessThanOrEqual(2); expect(h.backfillGaps).toBe(1);
    await stream.backfill(); expect(h.status).toBe('DEGRADED'); expect(h.backfillGaps).toBe(1);
    release(); await stream.stop();
  });
  it('caps failed-signature gap examples and retains an unknown-gap marker after the cap', async () => {
    const h = health(), store = cursorStore();
    const rpc = rpcMock(async method => method === 'getSignaturesForAddress' ? [] : null);
    const stream = new SolanaStream(rpc, 'wss://synthetic.invalid', store, h, async () => undefined, { attempts: 1, retryMs: 0, maxQueue: 1000 });
    const completions: Promise<boolean>[] = [];
    for (let i = 1; i <= 400; i++) { const bytes = Buffer.alloc(64); bytes.writeUInt32LE(i); completions.push((stream as any).enqueue(bs58.encode(bytes))); }
    await Promise.all(completions);
    expect(h.errors).toBe(400); expect(h.backfillGaps).toBe(129);
    expect((stream as any).gaps.size).toBe(128);
    await stream.backfill(); expect(h.status).toBe('DEGRADED'); expect(h.backfillGaps).toBe(129); await stream.stop();
  });
});

function wsFixture() {
  const socket = { onopen: null as (() => void) | null, onmessage: null as ((event: { data: unknown }) => void) | null, onerror: null as (() => void) | null, onclose: null as (() => void) | null, send: vi.fn(), close: vi.fn() };
  return { socket, notify: (s: string, slot = 123, logs: string[] = []) => socket.onmessage?.({ data: JSON.stringify({ method: 'logsNotification', params: { result: { context: { slot }, value: { signature: s, logs, err: null } } } }) }) };
}
describe('independent bounded finalized typed-log path', () => {
  it('publishes actual typed events while full transaction enrichment is still waiting', async () => {
    const capture: RpcTransaction = JSON.parse(fs.readFileSync(new URL('./fixtures/real-pump-buy.json', import.meta.url), 'utf8'));
    const ws = wsFixture(), h = health(), observed: ChainEvent[] = [];
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const rpc = rpcMock(async method => { if (method === 'getSignaturesForAddress') return []; await gate; return capture; });
    const enriched = vi.fn(async () => undefined);
    const stream = new SolanaStream(rpc, 'wss://synthetic.invalid', cursorStore(), h, enriched, { websocket: () => ws.socket, onLogs: e => { const events = decodeLogNotification(e.logs, e.signature, e.slot, e.receivedAt); observed.push(...events); return events; }, backfillIntervalMs: 1_000_000 });
    stream.start(); ws.socket.onopen?.(); ws.notify(capture.transaction.signatures[0], capture.slot, capture.meta!.logMessages);
    await vi.waitFor(() => expect(stream.logMetrics().processed).toBe(1));
    expect(observed[0].details.executionSupported).toBe(false); expect(observed[0].amountRaw).toBe('529899842623'); expect(enriched).not.toHaveBeenCalled();
    expect(stream.logMetrics().latencyMs.p95).toBeTypeOf('number');
    expect(ws.socket.send.mock.calls.every(([raw]) => JSON.parse(raw).params[1].commitment === 'finalized')).toBe(true);
    release(); await stream.stop();
  });
  it('prioritizes verified launches and watched mints over lower-priority full fetches', async () => {
    const ws = wsFixture(), fetched: string[] = []; let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const rpc = rpcMock(async (method, params) => { if (method === 'getSignaturesForAddress') return []; fetched.push(String(params[0])); if (fetched.length === 1) await gate; const value = tx(1); value.transaction.signatures = [String(params[0])]; return value; });
    const stream = new SolanaStream(rpc, 'wss://synthetic.invalid', cursorStore(), health(), async () => undefined, { websocket: () => ws.socket, maxQueue: 2, onLogs: e => [{ kind: e.signature === signature(5) ? 'launch' : 'buy', mint: e.signature === signature(4) ? 'watched' : 'other', protocol: 'pump', quoteMint: WSOL } as ChainEvent], isWatchedMint: mint => mint === 'watched', backfillIntervalMs: 1_000_000 });
    stream.start(); ws.notify(signature(1)); await vi.waitFor(() => expect(fetched).toHaveLength(1));
    for (const n of [2, 3, 4, 5]) ws.notify(signature(n));
    await vi.waitFor(() => expect(stream.logMetrics().processed).toBe(5)); release();
    await vi.waitFor(() => expect(fetched).toHaveLength(3)); expect(fetched).toEqual([signature(1), signature(5), signature(4)]);
    await stream.stop();
  });
  it('keeps SOL launches ahead of non-SOL launches/pools and preserves FIFO admission for equal-priority launches', async () => {
    const ws = wsFixture(), h = health(), fetched: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const rpc = rpcMock(async (method, params) => {
      if (method === 'getSignaturesForAddress') return [];
      fetched.push(String(params[0]));
      if (fetched.length === 1) await gate;
      const value = tx(1); value.transaction.signatures = [String(params[0])]; return value;
    });
    const observations = new Map([
      [2, { kind: 'pool', quoteMint: 'SYNTHETIC-NON-SOL' }],
      [3, { kind: 'launch', quoteMint: 'SYNTHETIC-NON-SOL' }],
      [4, { kind: 'pool', quoteMint: WSOL }],
      [5, { kind: 'launch', quoteMint: WSOL }],
      [6, { kind: 'launch', quoteMint: WSOL }],
      [7, { kind: 'launch', quoteMint: WSOL }],
      [8, { kind: 'launch', quoteMint: 'SYNTHETIC-NON-SOL' }],
    ]);
    const stream = new SolanaStream(rpc, 'wss://synthetic.invalid', cursorStore(), h, async () => undefined, {
      websocket: () => ws.socket, maxQueue: 2, backfillIntervalMs: 1_000_000,
      onLogs: e => {
        const n = Array.from({ length: 8 }, (_, i) => i + 1).find(n => signature(n) === e.signature)!;
        const fields = observations.get(n);
        return fields ? [{ ...fields, protocol: 'pump', mint: 'SYNTHETIC-MINT' } as ChainEvent] : [];
      },
    });
    stream.start(); ws.notify(signature(1));
    await vi.waitFor(() => expect(fetched).toEqual([signature(1)]));
    for (const n of [2, 3, 4, 5, 6, 7, 8]) ws.notify(signature(n));
    await vi.waitFor(() => expect(stream.logMetrics().processed).toBe(8));
    expect(h.queueDepth).toBe(2);
    expect(h.backfillGaps).toBeGreaterThan(0);
    expect(h.status).toBe('DEGRADED');
    release();
    await vi.waitFor(() => expect(fetched).toHaveLength(3));
    expect(fetched).toEqual([signature(1), signature(5), signature(6)]);
    await stream.stop();
  });
  it('still fetches undecodable logs and non-SOL observations instead of treating them as complete history', async () => {
    const ws = wsFixture(), fetched: string[] = [];
    const rpc = rpcMock(async (method, params) => {
      if (method === 'getSignaturesForAddress') return [];
      fetched.push(String(params[0]));
      const value = tx(1); value.transaction.signatures = [String(params[0])]; return value;
    });
    const stream = new SolanaStream(rpc, 'wss://synthetic.invalid', cursorStore(), health(), async () => undefined, {
      websocket: () => ws.socket, backfillIntervalMs: 1_000_000,
      onLogs: e => e.signature === signature(1) ? [] : [{ kind: 'pool', protocol: 'pumpswap', mint: 'SYNTHETIC-MINT', quoteMint: 'SYNTHETIC-NON-SOL' } as ChainEvent],
    });
    stream.start(); ws.notify(signature(1)); ws.notify(signature(2));
    await vi.waitFor(() => expect(fetched).toEqual([signature(1), signature(2)]));
    expect(stream.logMetrics().processed).toBe(2);
    await stream.stop();
  });
  it('bounds the fast callback queue separately and surfaces dropped observations as a coverage gap', async () => {
    const ws = wsFixture(), h = health(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const rpc = rpcMock(async (method, params) => { if (method === 'getSignaturesForAddress') return []; await gate; const value = tx(1); value.transaction.signatures = [String(params[0])]; return value; });
    const stream = new SolanaStream(rpc, 'wss://synthetic.invalid', cursorStore(), h, async () => undefined, { websocket: () => ws.socket, maxQueue: 2, maxLogQueue: 2, onLogs: async () => { await gate; return []; }, backfillIntervalMs: 1_000_000 });
    stream.start(); for (let n = 1; n <= 100; n++) ws.notify(signature(n));
    expect(stream.logMetrics()).toMatchObject({ received: 100, processed: 0, queueDepth: 2, dropped: 97 });
    expect(h.status).toBe('DEGRADED'); expect(h.backfillGaps).toBeGreaterThan(0); expect(h.queueDepth).toBeLessThanOrEqual(2);
    release(); await stream.stop();
  });
  it('handles callback failures without unhandled promises and still schedules full enrichment', async () => {
    const ws = wsFixture(), received = vi.fn(async () => undefined), h = health();
    const rpc = rpcMock(async (method, params) => { if (method === 'getSignaturesForAddress') return []; const value = tx(1); value.transaction.signatures = [String(params[0])]; return value; });
    const stream = new SolanaStream(rpc, 'wss://synthetic.invalid', cursorStore(), h, received, { websocket: () => ws.socket, onLogs: async () => { throw Error('SYNTHETIC_FAST_STORE_FAILURE'); }, backfillIntervalMs: 1_000_000 });
    stream.start(); ws.notify(signature(1)); await vi.waitFor(() => expect(received).toHaveBeenCalledOnce());
    expect(stream.logMetrics().errors).toBe(1); expect(h.backfillGaps).toBe(1); await stream.stop();
  });
  it('deduplicates the same signature across protocol subscription notifications', async () => {
    const ws = wsFixture(), onLogs = vi.fn(async () => []), rpc = rpcMock(async (method, params) => { if (method === 'getSignaturesForAddress') return []; const value = tx(1); value.transaction.signatures = [String(params[0])]; return value; });
    const stream = new SolanaStream(rpc, 'wss://synthetic.invalid', cursorStore(), health(), async () => undefined, { websocket: () => ws.socket, onLogs, backfillIntervalMs: 1_000_000 });
    stream.start(); ws.notify(signature(1)); ws.notify(signature(1)); await vi.waitFor(() => expect(stream.logMetrics().processed).toBe(1)); expect(onLogs).toHaveBeenCalledOnce(); await stream.stop();
  });
});

describe('SOL-only enrichment scope with synthetic typed observations', () => {
  const event = (kind: ChainEvent['kind'], quoteMint = WSOL, protocol: ChainEvent['protocol'] = 'pump') => ({ kind, quoteMint, protocol, mint: 'SYNTHETIC-MINT' } as ChainEvent);
  it('prioritizes native SOL and WSOL launches above SOL pools and watched SOL trades', () => {
    expect(enrichmentPriority([event('launch')])).toBe(ENRICHMENT_PRIORITY.SOL_LAUNCH);
    expect(enrichmentPriority([event('launch', '11111111111111111111111111111111')])).toBe(ENRICHMENT_PRIORITY.SOL_LAUNCH);
    expect(enrichmentPriority([event('pool')])).toBe(ENRICHMENT_PRIORITY.SOL_POOL);
    expect(enrichmentPriority([event('sell')], () => true)).toBe(ENRICHMENT_PRIORITY.WATCHED_SOL_TRADE);
    expect(enrichmentPriority([event('buy')], () => false)).toBe(ENRICHMENT_PRIORITY.SOL_ACTIVITY);
    expect(ENRICHMENT_PRIORITY.SOL_LAUNCH).toBeGreaterThan(ENRICHMENT_PRIORITY.SOL_POOL);
    expect(ENRICHMENT_PRIORITY.SOL_POOL).toBeGreaterThan(ENRICHMENT_PRIORITY.WATCHED_SOL_TRADE);
  });
  it('does not promote unsupported quotes through launch/pool kinds or watched mint membership', () => {
    const watched = vi.fn(() => true);
    for (const kind of ['launch', 'pool', 'buy', 'sell'] as const)
      expect(enrichmentPriority([event(kind, 'SYNTHETIC-NON-SOL')], watched)).toBe(ENRICHMENT_PRIORITY.BACKGROUND);
    expect(enrichmentPriority([event('launch', '11111111111111111111111111111111', 'pumpswap')], watched)).toBe(ENRICHMENT_PRIORITY.BACKGROUND);
    expect(watched).not.toHaveBeenCalled();
  });
  it('uses the highest eligible SOL leg in mixed transactions and keeps unknown layouts at background', () => {
    expect(enrichmentPriority([event('launch', 'SYNTHETIC-NON-SOL'), event('buy')])).toBe(ENRICHMENT_PRIORITY.SOL_ACTIVITY);
    expect(enrichmentPriority([event('pool'), event('launch')])).toBe(ENRICHMENT_PRIORITY.SOL_LAUNCH);
    expect(enrichmentPriority([])).toBe(ENRICHMENT_PRIORITY.BACKGROUND);
  });
});

class FakeDuplex extends EventEmitter {
  destroyed = false; writes: SubscribeRequest[] = []; paused = false;
  destroy() { this.destroyed = true; this.emit('close'); }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  write(request: SubscribeRequest) { this.writes.push(request); }
}
function yellowstone(slot = '110'): SubscribeUpdateTransaction {
  return { slot, bankId: '1', transaction: { signature: new Uint8Array(64).fill(9), isVote: false, index: '0', transaction: { signatures: [new Uint8Array(64).fill(9)], message: { versioned: true, header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 }, accountKeys: [new Uint8Array(32).fill(2)], recentBlockhash: new Uint8Array(32), instructions: [], addressTableLookups: [] } }, meta: { fee: '5000', preBalances: [], postBalances: [], innerInstructions: [], innerInstructionsNone: false, logMessages: [], logMessagesNone: false, preTokenBalances: [], postTokenBalances: [], rewards: [], loadedWritableAddresses: [new Uint8Array(32).fill(3)], loadedReadonlyAddresses: [new Uint8Array(32).fill(4)], returnDataNone: true } } } as unknown as SubscribeUpdateTransaction;
}
function yellowClient() {
  const streams: FakeDuplex[] = [], requests: SubscribeRequest[] = [];
  return { streams, requests, subscribe: vi.fn(async (request: SubscribeRequest) => { requests.push(request); const stream = new FakeDuplex(); streams.push(stream); return stream; }), subscribeReplayInfo: vi.fn(async () => ({ firstAvailable: '0' })) };
}

describe('Yellowstone finalized contract, durable replay and reconnect', () => {
  it('normalizes protobuf v0 keys, signatures and loaded account addresses without number truncation', () => {
    const normalized = normalizeYellowstoneTransaction(yellowstone());
    expect(normalized.version).toBe(0); expect(normalized.slot).toBe(110);
    expect(normalized.meta?.loadedAddresses?.writable[0]).toBe(bs58.encode(new Uint8Array(32).fill(3)));
    expect(normalized.meta?.loadedAddresses?.readonly[0]).toBe(bs58.encode(new Uint8Array(32).fill(4)));
    expect(() => normalizeYellowstoneTransaction(yellowstone('9007199254740993'))).toThrow('INVALID_SLOT');
  });
  it.each([true, false])('identifies v1 from protobuf config presence before versioned=%s and preserves total priority lamports', versioned => {
    const value = yellowstone(), message = value.transaction!.transaction!.message!;
    value.transaction!.meta!.loadedWritableAddresses = [];
    value.transaction!.meta!.loadedReadonlyAddresses = [];
    message.versioned = versioned;
    message.config = { priorityFee: '18446744073709551615', computeUnitLimit: 196132, loadedAccountsDataSizeLimit: 67108864 };
    const normalized = normalizeYellowstoneTransaction(value);
    expect(normalized.version).toBe(1);
    expect(normalized.transaction.message.header).toEqual(message.header);
    expect(normalized.transaction.message.transactionConfig).toEqual({ priorityFee: '18446744073709551615', computeUnitLimit: 196132, loadedAccountsDataSizeLimit: 67108864, heapSize: null });
    expect(normalized.transaction.message.addressTableLookups).toEqual([]);
    expect(normalized.meta!.loadedAddresses).toEqual({ writable: [], readonly: [] });
  });
  it('retains v1 config through the installed Yellowstone9 protobuf encoder/decoder without a raw Solana SDK wire decoder', async () => {
    // Import the pinned generated codec directly, avoiding this SDK's unsupported Windows native client.
    const codec = await import(new URL('./grpc/geyser.js', import.meta.resolve('@triton-one/yellowstone-grpc')).href);
    const value = yellowstone(), message = value.transaction!.transaction!.message!;
    value.transaction!.meta!.loadedWritableAddresses = [];
    value.transaction!.meta!.loadedReadonlyAddresses = [];
    message.config = { priorityFee: '18446744073709551615', computeUnitLimit: 30000, loadedAccountsDataSizeLimit: 200000 };
    const protobufBytes = codec.SubscribeUpdateTransaction.encode(value).finish();
    const decoded = codec.SubscribeUpdateTransaction.decode(protobufBytes) as SubscribeUpdateTransaction;
    expect(decoded.transaction!.transaction!.message!.config!.priorityFee).toBe('18446744073709551615');
    expect(normalizeYellowstoneTransaction(decoded)).toMatchObject({ version: 1, transaction: { message: { transactionConfig: { priorityFee: '18446744073709551615', computeUnitLimit: 30000, loadedAccountsDataSizeLimit: 200000, heapSize: null } } } });
  });
  it.each(['future-config', 'unsafe-priority', 'null-config', 'missing-header', 'lookups', 'loaded-addresses', 'invalid-u32'] as const)('rejects synthetic protobuf v1 %s without a v0 downgrade', fault => {
    const value = yellowstone(), message = value.transaction!.transaction!.message!;
    value.transaction!.meta!.loadedWritableAddresses = [];
    value.transaction!.meta!.loadedReadonlyAddresses = [];
    message.config = { computeUnitLimit: 30000, loadedAccountsDataSizeLimit: 200000, priorityFee: '8180' };
    if (fault === 'future-config') Object.assign(message.config, { futureBudgetField: 1 });
    if (fault === 'unsafe-priority') (message.config as any).priorityFee = Number.MAX_SAFE_INTEGER + 1;
    if (fault === 'null-config') (message as any).config = null;
    if (fault === 'missing-header') message.header = undefined;
    if (fault === 'lookups') message.addressTableLookups.push({ accountKey: new Uint8Array(32).fill(3), writableIndexes: new Uint8Array([0]), readonlyIndexes: new Uint8Array() });
    if (fault === 'loaded-addresses') value.transaction!.meta!.loadedWritableAddresses.push(new Uint8Array(32).fill(3));
    if (fault === 'invalid-u32') message.config!.computeUnitLimit = 2 ** 32;
    expect(() => normalizeYellowstoneTransaction(value)).toThrow();
  });
  it('requires durable checkpoint storage rather than claiming restart recovery without it', async () => {
    const h = health(); await expect(startYellowstone('synthetic', '', h, async () => undefined)).rejects.toThrow('DURABLE_CHECKPOINT'); expect(h.status).toBe('UNSUPPORTED');
  });
  it('persists only after receive, then reconnects with an inclusive overlapping fromSlot', async () => {
    const client = yellowClient(), store = checkpointStore('100'), h = health();
    let resolve!: () => void; const gate = new Promise<void>(done => { resolve = done; });
    const receive = vi.fn(async () => gate);
    const handle = await startYellowstone('synthetic', '', h, receive, { store, clientFactory: () => client, reconnectMs: 1 });
    expect(client.requests[0]).toMatchObject({ commitment: 2, fromSlot: '68' });
    client.streams[0].emit('data', { transaction: yellowstone('110') });
    await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce()); expect(store.state().slot).toBe('100');
    resolve(); await handle.idle(); expect(store.state().slot).toBe('110');
    client.streams[0].emit('error', { code: 14 });
    await vi.waitFor(() => expect(client.requests).toHaveLength(2)); expect(client.requests[1].fromSlot).toBe('78');
    await handle.stop();
  });
  it('replays from the old checkpoint after a persistence failure instead of advancing', async () => {
    const client = yellowClient(), store = checkpointStore('100'), h = health();
    const handle = await startYellowstone('synthetic', '', h, async () => { throw Error('SYNTHETIC_PERSIST_FAILURE'); }, { store, clientFactory: () => client, reconnectMs: 1 });
    client.streams[0].emit('data', { transaction: yellowstone('110') }); await handle.idle();
    expect(store.save).not.toHaveBeenCalled(); expect(h.backfillGaps).toBe(1);
    await vi.waitFor(() => expect(client.requests).toHaveLength(2)); expect(client.requests[1].fromSlot).toBe('68'); await handle.stop();
  });
  it('retains the durable replay boundary after malformed v1 protobuf config without calling receive', async () => {
    const client = yellowClient(), store = checkpointStore('100'), h = health(), receive = vi.fn(async () => undefined);
    const handle = await startYellowstone('synthetic', '', h, receive, { store, clientFactory: () => client, reconnectMs: 10000 });
    const value = yellowstone('110');
    (value.transaction!.transaction!.message as any).config = { futureBudgetField: 1 };
    client.streams[0].emit('data', { transaction: value });
    await handle.idle();
    expect(receive).not.toHaveBeenCalled();
    expect(store.state().slot).toBe('100');
    expect(store.save).not.toHaveBeenCalled();
    expect(h.backfillGaps).toBe(1);
    await handle.stop();
  });
  it('marks unsupported when server cannot replay the required slot range', async () => {
    const client = yellowClient(), store = checkpointStore('100'), h = health();
    client.subscribeReplayInfo.mockResolvedValue({ firstAvailable: '101' });
    const handle = await startYellowstone('synthetic', '', h, async () => undefined, { store, clientFactory: () => client, reconnectMs: 1 });
    expect(h.status).toBe('UNSUPPORTED'); expect(h.lastError).toBe('YELLOWSTONE_REPLAY_HISTORY_UNAVAILABLE'); expect(client.subscribe).not.toHaveBeenCalled(); await handle.stop();
  });
  it('does not silently fall back to current head when fromSlot is rejected', async () => {
    const client = yellowClient(), store = checkpointStore('100'), h = health();
    const handle = await startYellowstone('synthetic', '', h, async () => undefined, { store, clientFactory: () => client, reconnectMs: 1 });
    client.streams[0].emit('error', { code: 3 });
    expect(h.status).toBe('UNSUPPORTED'); expect(h.lastError).toBe('YELLOWSTONE_FROM_SLOT_REPLAY_UNSUPPORTED'); expect(client.requests).toHaveLength(1); await handle.stop();
  });
  it('reconnects on graceful end and answers server keepalive pings', async () => {
    const client = yellowClient(), store = checkpointStore(), h = health();
    const handle = await startYellowstone('synthetic', '', h, async () => undefined, { store, clientFactory: () => client, reconnectMs: 1 });
    client.streams[0].emit('data', { ping: {} }); expect(client.streams[0].writes[0].ping?.id).toBe(1);
    client.streams[0].emit('end'); await vi.waitFor(() => expect(client.requests).toHaveLength(2)); await handle.stop();
  });
});

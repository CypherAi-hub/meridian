import bs58 from 'bs58';
import type { SubscribeRequest, SubscribeUpdate, SubscribeUpdateTransaction } from '@triton-one/yellowstone-grpc';
import { PROGRAMS, type RpcTransaction } from './decoder.ts';
import { WSOL, type Health, type ChainEvent } from './types.ts';
import type { Store } from './store.ts';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export interface RpcOptions { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number; retries?: number; }
/** One serialized lane, including HTTP backoff, prevents retry storms on public RPCs. */
export class Rpc {
  private next = 0; private sequence = 0; private lane: Promise<unknown> = Promise.resolve();
  constructor(readonly url: string, readonly intervalMs = 1000, private options: RpcOptions = {}) {}
  call<T>(method: string, params: unknown[]): Promise<T> {
    const turn = this.lane.then(() => this.request<T>(method, params));
    this.lane = turn.catch(() => undefined); return turn;
  }
  private async request<T>(method: string, params: unknown[]): Promise<T> {
    const pause = this.options.sleep ?? sleep, now = this.options.now ?? Date.now, send = this.options.fetch ?? fetch;
    for (let attempt = 0; ; attempt++) {
      if (this.next > now()) await pause(this.next - now());
      this.next = now() + this.intervalMs;
      const response = await send(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++this.sequence, method, params }), signal: AbortSignal.timeout(12_000) });
      const retryable = response.status === 429 || response.status === 503;
      if (retryable && attempt < (this.options.retries ?? 3)) {
        const header = response.headers.get('retry-after');
        const requested = header == null ? 0 : /^\d+(\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - now();
        const cooldown = Math.min(60_000, Math.max((response.status === 429 ? 10_000 : 1000) * 2 ** attempt, Number.isFinite(requested) ? requested : 0));
        this.next = now() + cooldown;
        // Consume response to release connections; do not print provider bodies or credential-bearing URLs.
        await response.arrayBuffer(); continue;
      }
      if (!response.ok) throw Error(`RPC_${method}_HTTP_${response.status}`);
      const body = await response.json() as { result?: T; error?: { code?: number } };
      if (body.error) {
        if ([429, -32005].includes(body.error.code ?? 0) && attempt < (this.options.retries ?? 3)) { this.next = now() + Math.min(60_000, 1000 * 2 ** attempt); continue; }
        throw Error(`RPC_${method}_${body.error.code ?? 'INVALID_RESPONSE'}`);
      }
      if (!Object.prototype.hasOwnProperty.call(body, 'result')) throw Error(`RPC_${method}_INVALID_RESPONSE`);
      return body.result as T;
    }
  }
}
export type Receive = (tx: RpcTransaction, receivedAt: number, commitment: 'confirmed' | 'finalized') => Promise<void>;
interface WebSocketLike { onopen: (() => void) | null; onmessage: ((event: { data: unknown }) => void) | null; onerror: (() => void) | null; onclose: (() => void) | null; send(data: string): void; close(): void; }
export interface FinalizedLogEnvelope { signature: string; slot: number; logs: string[]; receivedAt: number; commitment: 'finalized'; }
export interface TypedLogMetrics { received: number; processed: number; dropped: number; errors: number; queueDepth: number; latencyMs: { p50: number | null; p95: number | null }; }
export interface SolanaStreamOptions { websocket?: (url: string) => WebSocketLike; reconnectMs?: number; retryMs?: number; attempts?: number; maxQueue?: number; pageSize?: number; maxPages?: number; backfillIntervalMs?: number; onLogs?: (envelope: FinalizedLogEnvelope) => Promise<ChainEvent[] | void> | ChainEvent[] | void; isWatchedMint?: (mint: string) => boolean; maxLogQueue?: number; }
/** Admission priority affects enrichment only, never evidence validity or order authorization.
 * Empty/unknown layouts and non-SOL pairs retain the background full-fetch fallback.
 * Equal priorities remain FIFO; a new item may evict only a strictly lower priority.
 */
export const ENRICHMENT_PRIORITY = Object.freeze({ BACKGROUND: 0, SOL_ACTIVITY: 1, WATCHED_SOL_TRADE: 2, SOL_POOL: 3, SOL_LAUNCH: 4 });
export function enrichmentPriority(events: readonly ChainEvent[], isWatchedMint?: (mint: string) => boolean): number {
  let priority: number = ENRICHMENT_PRIORITY.BACKGROUND;
  for (const event of events) {
    // Pump represents native SOL using Pubkey::default(); normal decoders normalize it to WSOL.
    const sol = event.quoteMint === WSOL || (event.protocol === 'pump' && event.quoteMint === '11111111111111111111111111111111');
    if (!sol) continue;
    if (event.kind === 'launch') priority = Math.max(priority, ENRICHMENT_PRIORITY.SOL_LAUNCH);
    else if (event.kind === 'pool') priority = Math.max(priority, ENRICHMENT_PRIORITY.SOL_POOL);
    else if (['buy', 'sell', 'swap'].includes(event.kind) && isWatchedMint?.(event.mint)) priority = Math.max(priority, ENRICHMENT_PRIORITY.WATCHED_SOL_TRADE);
    else priority = Math.max(priority, ENRICHMENT_PRIORITY.SOL_ACTIVITY);
  }
  return priority;
}
interface Pending { signature: string; receivedAt: number; priority: number; resolve: (ok: boolean) => void; }
type SignatureRow = { signature: string; slot: number; err: unknown };
export class SolanaStream {
  private ws: WebSocketLike | null = null; private stopped = false; private started = false;
  private queue: Pending[] = []; private queued = new Map<string, Promise<boolean>>(); private seen = new Map<string, number>(); private gaps = new Set<string>();
  private untrackedGaps = false; private gapRevision = 0;
  private logQueue: FinalizedLogEnvelope[] = []; private logQueued = new Set<string>(); private logSeen = new Map<string, number>(); private logBusy = false;
  private typedMetrics: Omit<TypedLogMetrics, 'latencyMs'> = { received: 0, processed: 0, dropped: 0, errors: 0, queueDepth: 0 }; private typedLatencies: number[] = [];
  private busy = false; private timer: ReturnType<typeof setInterval> | null = null; private reconnect: ReturnType<typeof setTimeout> | null = null; private backfilling: Promise<void> | null = null;
  constructor(private rpc: Pick<Rpc, 'call'>, private wsUrl: string, private store: Pick<Store, 'cursor'>, readonly health: Health, private receive: Receive, private options: SolanaStreamOptions = {}) {}
  private error(error: unknown) { this.health.errors++; this.health.status = 'DEGRADED'; this.health.lastError = error instanceof Error ? error.message : 'STREAM_ERROR'; }
  private gap(key: string, reason: string) {
    if (!this.gaps.has(key) || key === 'queue-overflow') this.gapRevision++;
    if (this.gaps.size < 128 || this.gaps.has(key)) this.gaps.add(key); else this.untrackedGaps = true;
    this.health.backfillGaps = this.gaps.size + Number(this.untrackedGaps); this.health.status = 'DEGRADED'; this.health.lastError = reason;
  }
  private resolved(key: string) { this.gaps.delete(key); this.health.backfillGaps = this.gaps.size + Number(this.untrackedGaps); }
  logMetrics(): TypedLogMetrics {
    const sorted = [...this.typedLatencies].sort((a, b) => a - b), percentile = (p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] : null;
    return { ...this.typedMetrics, latencyMs: { p50: percentile(0.5), p95: percentile(0.95) } };
  }
  private enqueueLogs(envelope: FinalizedLogEnvelope): void {
    this.typedMetrics.received++;
    if (this.logSeen.has(envelope.signature) || this.logQueued.has(envelope.signature)) return;
    if (this.logQueue.length >= (this.options.maxLogQueue ?? 2000)) { this.typedMetrics.dropped++; this.gap('typed-log-overflow', 'TYPED_LOG_QUEUE_OVERFLOW_FULL_BACKFILL_REQUIRED'); void this.enqueue(envelope.signature, envelope.receivedAt); return; }
    this.logQueued.add(envelope.signature); this.logQueue.push(envelope); this.typedMetrics.queueDepth = this.logQueue.length; void this.drainLogs();
  }
  private async drainLogs(): Promise<void> {
    if (this.logBusy) return; this.logBusy = true;
    try {
      while (!this.stopped && this.logQueue.length) {
        const envelope = this.logQueue.shift()!; this.typedMetrics.queueDepth = this.logQueue.length;
        let priority = 0;
        try {
          const observations = await this.options.onLogs?.(envelope);
          if (Array.isArray(observations)) priority = enrichmentPriority(observations, this.options.isWatchedMint);
          this.typedMetrics.processed++;
          this.typedLatencies.push(Math.max(0, Date.now() - envelope.receivedAt)); if (this.typedLatencies.length > 2048) this.typedLatencies.shift();
          this.logSeen.set(envelope.signature, Date.now()); if (this.logSeen.size > 10_000) this.logSeen.delete(this.logSeen.keys().next().value!);
        } catch { this.typedMetrics.errors++; this.gap('typed-log-handler', 'TYPED_LOG_CALLBACK_FAILED_FULL_BACKFILL_REQUIRED'); }
        finally { this.logQueued.delete(envelope.signature); }
        if (!this.stopped) void this.enqueue(envelope.signature, envelope.receivedAt, priority);
      }
    } finally { this.logBusy = false; }
  }
  private enqueue(signature: string, receivedAt = Date.now(), priority = 0): Promise<boolean> {
    if (this.seen.has(signature)) return Promise.resolve(true);
    const existing = this.queued.get(signature);
    if (existing) {
      const at = this.queue.findIndex(item => item.signature === signature);
      if (at >= 0 && this.queue[at].priority < priority) { const [item] = this.queue.splice(at, 1); item.priority = priority; const before = this.queue.findIndex(x => x.priority < priority); this.queue.splice(before < 0 ? this.queue.length : before, 0, item); }
      return existing;
    }
    if (this.stopped) return Promise.resolve(false);
    if (this.queue.length >= (this.options.maxQueue ?? 500)) {
      const lowest = this.queue.at(-1);
      if (lowest && priority > lowest.priority) { this.queue.pop(); this.queued.delete(lowest.signature); lowest.resolve(false); this.gap('queue-overflow', 'LOW_PRIORITY_ENRICHMENT_EVICTED_BACKFILL_REQUIRED'); }
      else { this.gap('queue-overflow', 'QUEUE_OVERFLOW_REQUIRES_BACKFILL'); return Promise.resolve(false); }
    }
    let resolve!: (ok: boolean) => void;
    const promise = new Promise<boolean>(done => { resolve = done; });
    this.queued.set(signature, promise); const before = this.queue.findIndex(x => x.priority < priority); this.queue.splice(before < 0 ? this.queue.length : before, 0, { signature, receivedAt, priority, resolve }); this.health.queueDepth = this.queue.length;
    void this.drain(); return promise;
  }
  private async drain() {
    if (this.busy) return; this.busy = true;
    try {
      while (!this.stopped && this.queue.length) {
        const item = this.queue.shift()!; this.health.queueDepth = this.queue.length;
        let ok = false;
        for (let attempt = 0; attempt < (this.options.attempts ?? 4) && !this.stopped; attempt++) {
          try {
            const tx = await this.rpc.call<RpcTransaction | null>('getTransaction', [item.signature, { encoding: 'json', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
            if (!tx) throw Error('FINALIZED_TRANSACTION_NOT_AVAILABLE');
            if (tx.transaction?.signatures?.[0] !== item.signature || !Number.isSafeInteger(tx.slot)) throw Error('RPC_TRANSACTION_ID_MISMATCH');
            await this.receive(tx, item.receivedAt, 'finalized'); ok = true; break;
          } catch (e) { this.error(e); if (attempt + 1 < (this.options.attempts ?? 4)) await sleep((this.options.retryMs ?? 500) * 2 ** attempt); }
        }
        if (ok) { this.seen.set(item.signature, Date.now()); if (this.seen.size > 10_000) this.seen.delete(this.seen.keys().next().value!); this.resolved(item.signature); }
        else this.gap(item.signature, 'TRANSACTION_PROCESSING_FAILED_CURSOR_NOT_ADVANCED');
        this.queued.delete(item.signature); item.resolve(ok);
      }
    } finally { this.busy = false; }
  }
  /** Cursor is a completed durable boundary, not an enqueue watermark. */
  backfill(): Promise<void> {
    if (this.backfilling) return this.backfilling;
    if (this.stopped) return Promise.resolve();
    this.backfilling = this.runBackfill().finally(() => { this.backfilling = null; }); return this.backfilling;
  }
  private async runBackfill() {
    try {
      let recoveredAll = true, allHadDurableCursors = true;
      const gapRevisionAtStart = this.gapRevision;
      for (const program of PROGRAMS) {
        if (this.stopped) break;
        const until = await this.store.cursor(program), batch: SignatureRow[] = [];
        if (!until) allHadDurableCursors = false;
        const limit = this.options.pageSize ?? 100, maxPages = until ? (this.options.maxPages ?? 10) : 1;
        let before: string | undefined, newest: string | undefined, reached = !until;
        for (let page = 0; page < maxPages && !this.stopped; page++) {
          const rows = await this.rpc.call<SignatureRow[]>('getSignaturesForAddress', [program, { limit, commitment: 'finalized', ...(before ? { before } : {}) }]);
          if (!Array.isArray(rows) || rows.some(r => !r || typeof r.signature !== 'string' || !Number.isSafeInteger(r.slot))) throw Error('MALFORMED_SIGNATURE_PAGE');
          newest ??= rows[0]?.signature;
          const cursorAt = until ? rows.findIndex(r => r.signature === until) : -1;
          batch.push(...(cursorAt >= 0 ? rows.slice(0, cursorAt) : rows));
          if (cursorAt >= 0) { reached = true; break; }
          if (rows.length < limit) break;
          before = rows.at(-1)?.signature;
        }
        if (!reached) { this.gap(`cursor:${program}`, 'BACKFILL_CURSOR_NOT_REACHED_HISTORY_GAP'); recoveredAll = false; }
        let complete = true;
        for (const row of batch.reverse()) {
          if (this.stopped) { complete = false; recoveredAll = false; break; }
          if (row.err == null && !await this.enqueue(row.signature)) { complete = false; recoveredAll = false; break; }
        }
        // A restart after any failure replays from the old durable boundary. Store/event dedup is mandatory.
        if (newest && reached && complete && !this.stopped) { await this.store.cursor(program, newest); this.resolved(`cursor:${program}`); }
      }
      // A first-run lookback does not prove recovery of dropped notifications. Clear
      // unknown overflow only after a full pass from every prior durable boundary,
      // with no newly dropped messages while that pass was processing.
      if (recoveredAll && allHadDurableCursors && gapRevisionAtStart === this.gapRevision && !this.stopped) {
        this.untrackedGaps = false; this.resolved('queue-overflow'); this.resolved('typed-log-overflow'); this.resolved('typed-log-handler');
      }
      if (!this.gaps.size && !this.untrackedGaps && !this.stopped) { this.health.status = 'LIVE'; delete this.health.lastError; }
    } catch (e) { this.error(e); }
  }
  private connect() {
    if (this.stopped) return;
    try {
      const socket = this.options.websocket?.(this.wsUrl) ?? new WebSocket(this.wsUrl) as unknown as WebSocketLike;
      this.ws = socket;
      socket.onopen = () => { PROGRAMS.forEach((address, i) => socket.send(JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'logsSubscribe', params: [{ mentions: [address] }, { commitment: 'finalized' }] }))); void this.backfill(); };
      socket.onmessage = message => {
        try {
          const body = JSON.parse(String(message.data));
          if (body.error) { this.error(Error(`WS_SUBSCRIBE_${body.error.code}`)); return; }
          if (body.method !== 'logsNotification') return;
          const value = body.params?.result?.value;
          if (typeof value?.signature !== 'string' || value.err != null) return;
          this.health.received++; this.health.lastEventAt = Date.now();
          if (this.options.onLogs) {
            const slot = body.params?.result?.context?.slot;
            if (!Number.isSafeInteger(slot) || slot < 0 || !Array.isArray(value.logs) || value.logs.some((line: unknown) => typeof line !== 'string')) { this.error(Error('MALFORMED_FINALIZED_LOG_NOTIFICATION')); void this.enqueue(value.signature); return; }
            this.enqueueLogs({ signature: value.signature, slot, logs: value.logs, receivedAt: this.health.lastEventAt, commitment: 'finalized' });
          } else void this.enqueue(value.signature);
        } catch (e) { this.error(e); }
      };
      socket.onerror = () => this.error(Error('WEBSOCKET_CONNECTION_ERROR'));
      socket.onclose = () => this.scheduleReconnect();
    } catch (e) { this.error(e); this.scheduleReconnect(); }
  }
  private scheduleReconnect() { if (this.stopped || this.reconnect) return; this.health.status = 'RECONNECTING'; this.reconnect = setTimeout(() => { this.reconnect = null; this.connect(); }, this.options.reconnectMs ?? 2000); }
  start() { if (this.started) return; this.started = true; this.connect(); this.timer = setInterval(() => { void this.backfill(); }, this.options.backfillIntervalMs ?? 30_000); }
  async stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); if (this.reconnect) clearTimeout(this.reconnect); this.ws?.close(); this.logQueue.length = 0; this.logQueued.clear(); this.typedMetrics.queueDepth = 0; for (const pending of this.queue.splice(0)) { this.queued.delete(pending.signature); pending.resolve(false); } while (this.busy || this.logBusy) await sleep(20); await this.backfilling; }
}

interface YellowstoneDuplex { on(event: string, listener: (...args: any[]) => void): unknown; destroy(): unknown; pause?(): unknown; resume?(): unknown; write?(request: SubscribeRequest): unknown; }
interface YellowstoneClient { subscribe(request: SubscribeRequest): Promise<YellowstoneDuplex>; subscribeReplayInfo?(): Promise<{ firstAvailable?: string }>; }
export interface YellowstoneOptions { store?: Pick<Store, 'get' | 'save'>; clientFactory?: () => Promise<YellowstoneClient> | YellowstoneClient; reconnectMs?: number; maxReconnectMs?: number; replayOverlapSlots?: number; maxQueue?: number; }
const checkpointId = 'yellowstone-finalized-checkpoint';
function subscription(fromSlot?: string): SubscribeRequest { return { accounts: {}, slots: {}, transactions: { protocols: { vote: false, failed: false, accountInclude: PROGRAMS, accountExclude: [], accountRequired: [] } }, transactionsStatus: {}, blocks: {}, blocksMeta: {}, entry: {}, blockFooter: {}, accountsDataSlice: [], commitment: 2, ...(fromSlot ? { fromSlot } : {}) }; }
const asSafeSlot = (value: unknown): number => { if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw Error('YELLOWSTONE_INVALID_SLOT'); return Number(value); };
/** Normalization is exported for contract tests against installed Yellowstone protobuf types. */
export function normalizeYellowstoneTransaction(tx: SubscribeUpdateTransaction): RpcTransaction {
  const slot = asSafeSlot(tx.slot), info = tx.transaction;
  if (!info?.transaction?.message || !info.meta) throw Error('YELLOWSTONE_INCOMPLETE_TRANSACTION');
  const message = info.transaction.message, meta = info.meta;
  const key = (x: Uint8Array) => { if (!(x instanceof Uint8Array) || x.length !== 32) throw Error('YELLOWSTONE_INVALID_ACCOUNT_KEY'); return bs58.encode(x); };
  const sig = (x: Uint8Array) => { if (!(x instanceof Uint8Array) || x.length !== 64) throw Error('YELLOWSTONE_INVALID_SIGNATURE'); return bs58.encode(x); };
  const convert = (ix: { programIdIndex: number; accounts: Uint8Array; data: Uint8Array; stackHeight?: number | null }) => ({ programIdIndex: ix.programIdIndex, accounts: Array.from(ix.accounts), data: bs58.encode(ix.data), ...(ix.stackHeight == null ? {} : { stackHeight: ix.stackHeight }) });
  const balance = (x: typeof meta.preTokenBalances[number]) => { if (!x.uiTokenAmount || !/^\d+$/.test(x.uiTokenAmount.amount)) throw Error('YELLOWSTONE_INVALID_TOKEN_BALANCE'); return { accountIndex: x.accountIndex, mint: x.mint, owner: x.owner, uiTokenAmount: x.uiTokenAmount }; };
  const signatures = info.transaction.signatures.length ? info.transaction.signatures.map(sig) : [sig(info.signature)];
  const fee = Number(meta.fee);
  return { slot, blockTime: null, version: message.versioned ? 0 : 'legacy', transaction: { signatures, message: { accountKeys: message.accountKeys.map(key), instructions: message.instructions.map(convert) } }, meta: { err: meta.err ?? null, ...(Number.isSafeInteger(fee) ? { fee } : {}), loadedAddresses: { writable: meta.loadedWritableAddresses.map(key), readonly: meta.loadedReadonlyAddresses.map(key) }, innerInstructions: meta.innerInstructions.map(g => ({ index: g.index, instructions: g.instructions.map(convert) })), preTokenBalances: meta.preTokenBalances.map(balance), postTokenBalances: meta.postTokenBalances.map(balance), logMessages: meta.logMessages } };
}

/** Finalized-only Yellowstone stream. Inclusive durable-slot replay and store dedup protect
 * reconnects; unavailable replay is surfaced as unsupported instead of skipping a history gap. */
export async function startYellowstone(endpoint: string, token: string, health: Health, receive: Receive, options: YellowstoneOptions = {}) {
  if (!options.store) { health.status = 'UNSUPPORTED'; health.lastError = 'YELLOWSTONE_REQUIRES_DURABLE_CHECKPOINT_STORE'; throw Error(health.lastError); }
  const store = options.store;
  const initial = await store.get(checkpointId);
  let checkpoint: number | null = initial?.slot == null ? null : asSafeSlot(String(initial.slot));
  let stopped = false, terminal = false, generation = 0, failures = 0, pending = 0;
  let active: Promise<void> = Promise.resolve(), stream: YellowstoneDuplex | null = null, timer: ReturnType<typeof setTimeout> | null = null;
  const overlap = options.replayOverlapSlots ?? 32;
  const fail = (reason: string, unsupported = false) => { health.errors++; health.status = unsupported ? 'UNSUPPORTED' : 'RECONNECTING'; health.lastError = reason; health.backfillGaps = 1; terminal ||= unsupported; };
  const replayFrom = () => checkpoint == null ? undefined : String(Math.max(0, checkpoint - overlap));
  const connect = async (): Promise<void> => {
    if (stopped || terminal) return;
    const current = ++generation; let broken = false, source: YellowstoneDuplex | null = null;
    const disconnect = (reason: string, unsupported = false) => {
      if (broken || stopped || current !== generation) return; broken = true; fail(reason, unsupported); source?.destroy();
      if (!terminal) { failures++; const delay = Math.min(options.maxReconnectMs ?? 30_000, (options.reconnectMs ?? 1000) * 2 ** Math.min(failures - 1, 8)); timer = setTimeout(() => { timer = null; void active.then(connect); }, delay); }
    };
    try {
      const client = await (options.clientFactory ? options.clientFactory() : import('@triton-one/yellowstone-grpc').then(m => {
        // SDK 9 ships CJS/ESM interop; the constructor may sit under default.default.
        const candidate = m.default as unknown as { default?: unknown } | ((...args: unknown[]) => unknown);
        const constructor = (typeof candidate === 'function' ? candidate : candidate.default) as new (endpoint: string, token: string, options: undefined) => YellowstoneClient;
        return new constructor(endpoint, token, undefined);
      }));
      const fromSlot = replayFrom();
      if (fromSlot && client.subscribeReplayInfo) {
        try {
          const replay = await client.subscribeReplayInfo();
          if (replay.firstAvailable != null && asSafeSlot(replay.firstAvailable) > Number(fromSlot)) { disconnect('YELLOWSTONE_REPLAY_HISTORY_UNAVAILABLE', true); return; }
        } catch (e) {
          // UNIMPLEMENTED replay-info is allowed; fromSlot must still be accepted by subscribe.
          if ((e as { code?: number })?.code !== 12) throw e;
        }
      }
      const connected = await client.subscribe(subscription(fromSlot)); source = connected;
      if (stopped || current !== generation) { connected.destroy(); return; }
      stream = connected; health.status = 'CONNECTING';
      connected.on('data', (update: SubscribeUpdate) => {
        if (broken || stopped || current !== generation) return;
        if (update.ping) { source?.write?.({ ...subscription(), ping: { id: 1 } }); return; }
        if (!update.transaction) return;
        if (pending >= (options.maxQueue ?? 500)) { disconnect('YELLOWSTONE_QUEUE_OVERFLOW_REPLAY_REQUIRED'); return; }
        const receivedAt = Date.now(); health.received++; health.lastEventAt = receivedAt; pending++; health.queueDepth = pending;
        if (pending >= Math.min(200, options.maxQueue ?? 500)) source?.pause?.();
        active = active.then(async () => {
          if (broken || stopped || current !== generation) return;
          const normalized = normalizeYellowstoneTransaction(update.transaction!);
          if (normalized.meta?.err != null) return;
          // A finalized stream cannot safely move the durable cursor beyond unexpected late slots.
          if (checkpoint != null && normalized.slot < checkpoint - overlap) { disconnect('YELLOWSTONE_OUT_OF_ORDER_HISTORY_GAP', true); return; }
          await receive(normalized, receivedAt, 'finalized');
          checkpoint = checkpoint == null ? normalized.slot : Math.max(checkpoint, normalized.slot);
          await store.save(checkpointId, { slot: String(checkpoint), commitment: 'finalized', replayOverlapSlots: overlap });
          failures = 0; health.backfillGaps = 0; health.status = 'LIVE'; delete health.lastError;
        }).catch(() => disconnect('YELLOWSTONE_PERSIST_OR_DECODE_FAILED_REPLAY_REQUIRED')).finally(() => { pending--; health.queueDepth = pending; if (pending < 100 && !broken && !stopped) source?.resume?.(); });
      });
      connected.on('error', (error: { code?: number }) => disconnect(fromSlot && [3, 11, 12].includes(error?.code ?? 0) ? 'YELLOWSTONE_FROM_SLOT_REPLAY_UNSUPPORTED' : 'YELLOWSTONE_STREAM_ERROR', Boolean(fromSlot && [3, 11, 12].includes(error?.code ?? 0))));
      connected.on('end', () => disconnect('YELLOWSTONE_STREAM_ENDED'));
      connected.on('close', () => disconnect('YELLOWSTONE_STREAM_CLOSED'));
    } catch (error) {
      const fromSlot = replayFrom();
      disconnect(fromSlot && [3, 11, 12].includes((error as { code?: number })?.code ?? 0) ? 'YELLOWSTONE_FROM_SLOT_REPLAY_UNSUPPORTED' : 'YELLOWSTONE_CONNECT_FAILED', Boolean(fromSlot && [3, 11, 12].includes((error as { code?: number })?.code ?? 0)));
    }
  };
  await connect();
  return { stop: async () => { stopped = true; if (timer) clearTimeout(timer); stream?.destroy(); await active; }, checkpoint: () => checkpoint, idle: () => active };
}

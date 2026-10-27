import fs from "node:fs";
import { BorshInstructionCoder, BorshEventCoder, BorshCoder, type Idl } from "@coral-xyz/anchor";
import bs58 from "bs58";
import { WSOL, type ChainEvent, type Protocol } from "./types.ts";

export type Instruction = {
  programIdIndex: number;
  accounts: number[];
  data: string;
  stackHeight?: number | null;
};
export type TransactionConfig = {
  computeUnitLimit: number | null;
  loadedAccountsDataSizeLimit: number | null;
  heapSize: number | null;
  /** Total lamports, never micro-lamports per compute unit. */ priorityFee: number | string | null;
};
export type MessageHeader = {
  numRequiredSignatures: number;
  numReadonlySignedAccounts: number;
  numReadonlyUnsignedAccounts: number;
};
type TokenBalance = {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
};
export type RpcTransaction = {
  slot: number;
  blockTime: number | null;
  version?: unknown;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: string[];
      instructions: Instruction[];
      header?: MessageHeader;
      recentBlockhash?: string;
      transactionConfig?: TransactionConfig;
      addressTableLookups?: unknown[];
    };
  };
  meta: {
    err: unknown;
    loadedAddresses?: { writable: string[]; readonly: string[] };
    innerInstructions?: { index: number; instructions: Instruction[] }[];
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
    logMessages?: string[];
    fee?: number;
  } | null;
};
type Adapter = {
  protocol: Protocol;
  address: string;
  idl: Idl;
  coder: BorshInstructionCoder;
  eventCoder: BorshEventCoder;
  typesCoder: BorshCoder["types"];
  schemaVersion: string;
};
const load = (name: string, protocol: Protocol): Adapter => {
  const idl = JSON.parse(
    fs.readFileSync(new URL(`../vendor/${name}.json`, import.meta.url), "utf8"),
  ) as Idl;
  return {
    protocol,
    address: idl.address,
    idl,
    coder: new BorshInstructionCoder(idl),
    eventCoder: new BorshEventCoder(idl),
    typesCoder: new BorshCoder(idl).types,
    schemaVersion: name,
  };
};
export const ADAPTERS = [
  load("pump", "pump"),
  load("pump_amm", "pumpswap"),
  load("raydium_cp_swap", "raydium-cpmm"),
];
export const VERSIONED_ADAPTERS = [
  load("pump-sdk-4.3.1", "pump"),
  load("pump-amm-sdk-2.2.0", "pumpswap"),
  ...ADAPTERS,
  load("pump-2026-09-12", "pump"),
  load("pump_amm-2026-09-12", "pumpswap"),
];
export const PROGRAMS = ADAPTERS.map((a) => a.address);
const keyValid = (v: unknown): v is string => {
  try {
    return typeof v === "string" && bs58.decode(v).length === 32;
  } catch {
    return false;
  }
};
const signatureValid = (v: unknown): v is string => {
  try {
    return typeof v === "string" && bs58.decode(v).length === 64;
  } catch {
    return false;
  }
};
const indexValid = (v: unknown, length: number): v is number =>
  Number.isInteger(v) && Number(v) >= 0 && Number(v) < length;
type NormalizedTransactionConfig = Omit<TransactionConfig, "priorityFee"> & {
  priorityFee: string | null;
};
/** RPC JSON/protobuf configuration validation only; this does not deserialize or certify raw v1 wire transactions.
 * Fields and units: https://solana.com/upgrades/larger-transaction-sizes (SIMD-0385).
 */
export function validateTransactionConfig(value: unknown): NormalizedTransactionConfig {
  const names = ["computeUnitLimit", "loadedAccountsDataSizeLimit", "heapSize", "priorityFee"];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== names.length ||
    !names.every((name) => Object.hasOwn(value, name))
  )
    throw Error("TRANSACTION_V1_CONFIG_INVALID_OR_UNSUPPORTED");
  const config = value as TransactionConfig;
  for (const field of ["computeUnitLimit", "loadedAccountsDataSizeLimit", "heapSize"] as const) {
    const amount = config[field];
    if (
      amount !== null &&
      (typeof amount !== "number" ||
        !Number.isSafeInteger(amount) ||
        amount < 0 ||
        amount > 0xffffffff)
    )
      throw Error("TRANSACTION_V1_CONFIG_INVALID_OR_UNSUPPORTED");
  }
  if (
    config.heapSize !== null &&
    (config.heapSize < 32768 || config.heapSize > 262144 || config.heapSize % 1024 !== 0)
  )
    throw Error("TRANSACTION_V1_CONFIG_INVALID_OR_UNSUPPORTED");
  let priorityFee: string | null = null;
  if (config.priorityFee !== null) {
    const fee = config.priorityFee;
    if (
      !(
        (typeof fee === "number" && Number.isSafeInteger(fee) && fee >= 0) ||
        (typeof fee === "string" && fee.length <= 20 && /^(0|[1-9]\d*)$/.test(fee))
      ) ||
      BigInt(fee) > 18_446_744_073_709_551_615n
    )
      throw Error("TRANSACTION_V1_CONFIG_INVALID_OR_UNSUPPORTED");
    priorityFee = String(fee);
  }
  return {
    computeUnitLimit: config.computeUnitLimit,
    loadedAccountsDataSizeLimit: config.loadedAccountsDataSizeLimit,
    heapSize: config.heapSize,
    priorityFee,
  };
}
/** Shared structural gate for protocol observations and committed top-level wallet funding evidence. */
export function validateTransactionLayout(tx: RpcTransaction): {
  version: "legacy" | 0 | 1;
  keys: string[];
  config: NormalizedTransactionConfig | null;
} {
  const version = tx?.version == null ? "legacy" : tx.version;
  if (version !== "legacy" && version !== 0 && version !== 1)
    throw Error("TRANSACTION_VERSION_UNSUPPORTED");
  const message = tx?.transaction?.message;
  if (!message || !Array.isArray(message.accountKeys) || !Array.isArray(message.instructions))
    throw Error("TRANSACTION_MESSAGE_INVALID");
  const loaded = tx.meta?.loadedAddresses;
  if (loaded != null && (!Array.isArray(loaded.writable) || !Array.isArray(loaded.readonly)))
    throw Error("TRANSACTION_MESSAGE_INVALID");
  const keys = [...message.accountKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
  if (!keys.every(keyValid)) throw Error("TRANSACTION_MESSAGE_INVALID");
  const hasConfig = Object.hasOwn(message, "transactionConfig");
  if (version !== 1) {
    if (hasConfig) throw Error("TRANSACTION_VERSION_CONFIG_MISMATCH");
    return { version, keys, config: null };
  }
  if (!hasConfig) throw Error("TRANSACTION_V1_CONFIG_REQUIRED");
  const config = validateTransactionConfig(message.transactionConfig),
    header = message.header;
  if (
    (message.addressTableLookups !== undefined &&
      (!Array.isArray(message.addressTableLookups) || message.addressTableLookups.length !== 0)) ||
    (loaded && (loaded.writable.length !== 0 || loaded.readonly.length !== 0))
  )
    throw Error("TRANSACTION_V1_ADDRESS_LOOKUPS_UNSUPPORTED");
  if (
    !header ||
    ![
      header.numRequiredSignatures,
      header.numReadonlySignedAccounts,
      header.numReadonlyUnsignedAccounts,
    ].every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ||
    header.numRequiredSignatures < 1 ||
    header.numReadonlySignedAccounts >= header.numRequiredSignatures ||
    header.numRequiredSignatures + header.numReadonlyUnsignedAccounts > keys.length ||
    !Array.isArray(tx.transaction.signatures) ||
    tx.transaction.signatures.length !== header.numRequiredSignatures ||
    !tx.transaction.signatures.every(signatureValid) ||
    !keyValid(message.recentBlockhash) ||
    keys.length > 255 ||
    new Set(keys).size !== keys.length ||
    message.instructions.length > 255
  )
    throw Error("TRANSACTION_V1_LAYOUT_INVALID");
  let payloadBytes = 0;
  for (const ix of message.instructions) {
    if (
      !ix ||
      !indexValid(ix.programIdIndex, keys.length) ||
      !Array.isArray(ix.accounts) ||
      ix.accounts.length > 255 ||
      !ix.accounts.every((i) => indexValid(i, keys.length)) ||
      typeof ix.data !== "string" ||
      ix.data.length > 6000
    )
      throw Error("TRANSACTION_V1_LAYOUT_INVALID");
    let bytes: Uint8Array;
    try {
      bytes = bs58.decode(ix.data);
    } catch {
      throw Error("TRANSACTION_V1_LAYOUT_INVALID");
    }
    payloadBytes += ix.accounts.length + bytes.length;
  }
  const configBytes =
    (config.priorityFee !== null ? 8 : 0) +
    [config.computeUnitLimit, config.loadedAccountsDataSizeLimit, config.heapSize].filter(
      (n) => n !== null,
    ).length *
      4;
  // Known v1 field lengths also bound malformed JSON payloads, without SDK wire decoding.
  if (
    42 +
      keys.length * 32 +
      configBytes +
      message.instructions.length * 4 +
      payloadBytes +
      tx.transaction.signatures.length * 64 >
    4096
  )
    throw Error("TRANSACTION_V1_LAYOUT_INVALID");
  return { version, keys, config };
}
function serialize(v: unknown): unknown {
  if (v == null) return v;
  if (typeof v === 'object' && 'toBase58' in v) return (v as { toBase58(): string }).toBase58();
  if (typeof v === 'object' && 'toArrayLike' in v) return String(v);
  if (Array.isArray(v)) return v.map(serialize);
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, value]) => [k, serialize(value)]));
  return v;
}
function eventKind(protocol: Protocol, instruction: string): ChainEvent['kind'] | null {
  if (protocol === 'pump') {
    if (['create', 'create_v2'].includes(instruction)) return 'launch';
    if (/^buy(_|$)/.test(instruction)) return 'buy';
    if (/^sell(_|$)/.test(instruction)) return 'sell';
    if (['migrate', 'migrate_v2'].includes(instruction)) return 'migrate';
  } else if (protocol === 'pumpswap') {
    if (instruction === 'create_pool') return 'pool';
    if (/^buy(_|$)/.test(instruction)) return 'buy';
    if (/^sell(_|$)/.test(instruction)) return 'sell';
  } else {
    if (['initialize', 'initialize_with_permission'].includes(instruction)) return 'pool';
    if (['swap_base_input', 'swap_base_output'].includes(instruction)) return 'swap';
  }
  return null;
}
type ProgramEvent = { protocol: Protocol; name: string; data: Record<string, unknown>; schemaVersion: string; unsupportedTrailingBytes: number; logIndex: number };
function typedEvents(logs: unknown): ProgramEvent[] {
  if (!Array.isArray(logs)) return [];
  const result: ProgramEvent[] = [], stack: { program: string; events: ProgramEvent[] }[] = [];
  for (const [logIndex, log] of logs.entries()) {
    if (typeof log !== 'string') continue;
    const invoke = /^Program (\S+) invoke \[(\d+)\]$/.exec(log);
    if (invoke) {
      const depth = Number(invoke[2]);
      if (depth !== stack.length + 1 || !keyValid(invoke[1])) { stack.length = 0; continue; }
      stack.push({ program: invoke[1], events: [] }); continue;
    }
    const end = /^Program (\S+) (success|failed:)/.exec(log);
    if (end) {
      if (stack.at(-1)?.program !== end[1]) { stack.length = 0; continue; }
      const completed = stack.pop()!;
      // Failed CPI rolls back its own events; a later ancestor failure also
      // invalidates all of its nested events even when an outer caller catches it.
      if (end[2] === 'success') { const parent = stack.at(-1); if (parent) parent.events.push(...completed.events); else result.push(...completed.events); }
      continue;
    }
    if (!log.startsWith('Program data: ')) continue;
    let best: ProgramEvent | null = null;
    for (const adapter of VERSIONED_ADAPTERS.filter(a => a.address === stack.at(-1)?.program)) try {
      const encoded = log.slice(14), event = adapter.eventCoder.decode(encoded);
      if (!event) continue;
      const definition = adapter.idl.events?.find(e => e.name === event.name);
      if (!definition) continue;
      const roundtrip = Buffer.concat([Buffer.from(definition.discriminator), adapter.typesCoder.encode(event.name, event.data)]);
      const raw = Buffer.from(encoded, 'base64');
      // Append-only unknown fields are not guessed. Known fields may inform the activity feed
      // only when their complete re-encoding exactly matches the actual emitted byte prefix.
      if (roundtrip.length > raw.length || !roundtrip.equals(raw.subarray(0, roundtrip.length))) continue;
      const candidate = { protocol: adapter.protocol, name: event.name, data: serialize(event.data) as Record<string, unknown>, schemaVersion: adapter.schemaVersion, unsupportedTrailingBytes: raw.length - roundtrip.length, logIndex };
      // Prefer an exact official schema over any shorter compatible prefix; if
      // no exact version exists, preserve only the longest verified known prefix.
      if (!best || candidate.unsupportedTrailingBytes < best.unsupportedTrailingBytes) best = candidate;
      if (!candidate.unsupportedTrailingBytes) break;
    } catch { /* Unknown versions stay unavailable, never padded to fit a newer layout. */ }
    if (best) stack.at(-1)!.events.push(best);
  }
  return result;
}
function matches(event: ProgramEvent, instruction: ChainEvent): boolean {
  if (event.protocol !== instruction.protocol) return false;
  const d = event.data;
  if (event.protocol === 'raydium-cpmm') return event.name === 'SwapEvent' && String(d.pool_id ?? '') === instruction.pool && (d.input_mint === instruction.mint || d.output_mint === instruction.mint) && (d.input_mint === instruction.quoteMint || d.output_mint === instruction.quoteMint);
  if (String(d.user ?? d.creator ?? '') !== instruction.actor) return false;
  if (String(d.mint ?? d.base_mint ?? '') !== instruction.mint && String(d.pool ?? '') !== instruction.pool) return false;
  // Official Pump docs define Pubkey::default() for native-SOL pairs while
  // versioned instruction accounts pass WSOL for the same quote asset.
  const quoteMint = event.protocol === 'pump' && d.quote_mint === '11111111111111111111111111111111' ? WSOL : d.quote_mint;
  if (quoteMint != null && quoteMint !== instruction.quoteMint) return false;
  return (event.name === 'TradeEvent' && typeof d.is_buy === 'boolean' && (instruction.kind === 'buy' || instruction.kind === 'sell') && d.is_buy === (instruction.kind === 'buy')) || (event.name === 'BuyEvent' && instruction.kind === 'buy') || (event.name === 'SellEvent' && instruction.kind === 'sell') || (event.name === 'CreateEvent' && instruction.kind === 'launch') || (event.name === 'CreatePoolEvent' && instruction.kind === 'pool');
}
const amountValid = (v: unknown): v is string => typeof v === 'string' && /^\d+$/.test(v) && BigInt(v) > 0n;

export interface LogDecodeOptions {
  /** Caller must supply mappings learned from fully verified transaction/account state only. */
  resolvePool?: (pool: string, protocol: Protocol) => { mint: string; quoteMint: string } | undefined;
  /** Actorless events may prioritize a full fetch, never become trade evidence. */
  onEnrichmentHint?: (hint: LogEnrichmentHint) => void;
}
export type LogEnrichmentHint = Readonly<{
  scope: 'ENRICHMENT_PRIORITY_ONLY';
  source: 'TYPED_PROGRAM_EVENT';
  protocol: 'raydium-cpmm';
  kind: 'buy' | 'sell' | 'swap';
  signature: string;
  slot: number;
  receivedAt: number;
  pool: string;
  mint: string;
  quoteMint: string;
  eventName: 'SwapEvent';
  eventSchema: string;
  logIndex: number;
  executionSupported: false;
}>;
/** Low-latency observations from finalized RPC notifications. These are real typed
 * program events, not guesses based on human-readable log labels. They are never
 * full-transaction evidence or order authorization. PumpSwap trade events omit
 * mint fields, so unknown pools are skipped rather than assigning a guessed mint.
 */
export function decodeLogNotification(logs: unknown, signature: string, slot: number, receivedAt: number, now = Date.now(), options: LogDecodeOptions = {}): ChainEvent[] {
  if (!signatureValid(signature) || !Number.isSafeInteger(slot) || slot < 0 || !Number.isFinite(receivedAt) || !Number.isFinite(now)) return [];
  const observations: ChainEvent[] = [];
  for (const event of typedEvents(logs)) {
    const d = event.data;
    // Official CPMM SwapEvent omits the trader. Its exact typed mint pair can
    // prioritize enrichment without inventing an actor, launch or position.
    if (event.protocol === 'raydium-cpmm' && event.name === 'SwapEvent' && !event.unsupportedTrailingBytes &&
        keyValid(d.pool_id) && keyValid(d.input_mint) && keyValid(d.output_mint) && d.input_mint !== d.output_mint &&
        amountValid(d.input_amount) && amountValid(d.output_amount)) {
      const buying = d.input_mint === WSOL, selling = d.output_mint === WSOL;
      options.onEnrichmentHint?.({
        scope: 'ENRICHMENT_PRIORITY_ONLY', source: 'TYPED_PROGRAM_EVENT', protocol: 'raydium-cpmm',
        kind: buying ? 'buy' : selling ? 'sell' : 'swap', signature, slot, receivedAt,
        pool: d.pool_id, mint: buying ? d.output_mint : d.input_mint,
        quoteMint: buying ? WSOL : d.output_mint, eventName: 'SwapEvent', eventSchema: event.schemaVersion,
        logIndex: event.logIndex, executionSupported: false,
      });
    }
    let kind: ChainEvent['kind'] | null = null;
    if (event.protocol === 'pump') {
      if (event.name === 'TradeEvent' && typeof d.is_buy === 'boolean') kind = d.is_buy ? 'buy' : 'sell';
      else if (event.name === 'CreateEvent') kind = 'launch';
    } else if (event.protocol === 'pumpswap') {
      if (event.name === 'BuyEvent') kind = 'buy';
      else if (event.name === 'SellEvent') kind = 'sell';
      else if (event.name === 'CreatePoolEvent') kind = 'pool';
    }
    if (!kind) continue;
    const actor = d.user ?? d.creator, pool = typeof (d.pool ?? d.bonding_curve) === 'string' ? String(d.pool ?? d.bonding_curve) : '';
    let mint = d.mint ?? d.base_mint, quoteMint = d.quote_mint;
    if (event.protocol === 'pumpswap' && (!mint || !quoteMint)) {
      const known = options.resolvePool?.(pool, event.protocol); mint = known?.mint; quoteMint = known?.quoteMint;
    }
    if (event.protocol === 'pump' && quoteMint === '11111111111111111111111111111111') quoteMint = WSOL;
    if (!keyValid(actor) || !keyValid(mint) || !keyValid(quoteMint) || mint === quoteMint) continue;
    let amount: unknown = null, quote: unknown = null;
    if (kind === 'buy' || kind === 'sell') {
      amount = d.token_amount ?? d.base_amount_out ?? d.base_amount_in;
      quote = d.user_quote_amount_in ?? d.user_quote_amount_out ?? d.quote_amount ?? d.sol_amount;
      if (!amountValid(amount) || !amountValid(quote)) continue;
    }
    const creator = d.creator ?? d.coin_creator;
    const timestamp = typeof d.timestamp === 'string' && /^\d+$/.test(d.timestamp) && Number.isSafeInteger(Number(d.timestamp)) ? Number(d.timestamp) : null;
    observations.push({ id: `${signature}:log:${event.logIndex}`, protocol: event.protocol, kind, signature, slot, mint, quoteMint, actor, ...(keyValid(creator) ? { creator } : {}), pool, instruction: typeof d.ix_name === 'string' && d.ix_name ? d.ix_name : event.name, instructionIndex: `log:${event.logIndex}`, receivedAt, processedAt: now, blockTime: timestamp, commitment: 'finalized', amountRaw: amountValid(amount) ? amount : null, quoteAmountRaw: amountValid(quote) ? quote : null, quantityEvidence: amountValid(amount) && amountValid(quote) ? 'program-event' : 'unavailable', details: { source: 'TYPED_PROGRAM_EVENT', fullTransactionVerified: false, executionSupported: false, eventName: event.name, programEvent: d, eventSchema: event.unsupportedTrailingBytes ? 'KNOWN_PREFIX_UNKNOWN_TRAILING_BYTES' : event.schemaVersion, ...(event.unsupportedTrailingBytes ? { knownPrefixSchema: event.schemaVersion, unsupportedTrailingBytes: event.unsupportedTrailingBytes } : {}), ...(event.protocol === 'pumpswap' && (kind === 'buy' || kind === 'sell') ? { mintEvidence: 'VERIFIED_POOL_MAPPING' } : { mintEvidence: 'PROGRAM_EVENT_FIELD' }) } });
  }
  return observations;
}

/** Decode successful instruction bytes against pinned official IDLs. Transaction-wide net
 * balances and requested bounds are never fabricated as fills. Quantities require unique,
 * typed events emitted while the matching program executes. Invalid input fails closed. */
export function decodeTransaction(tx: RpcTransaction, receivedAt: number, commitment: 'confirmed' | 'finalized' = 'finalized', now = Date.now()): ChainEvent[] {
  try { return decodeChecked(tx, receivedAt, commitment, now); } catch { return []; }
}
function decodeChecked(tx: RpcTransaction, receivedAt: number, commitment: 'confirmed' | 'finalized', now: number): ChainEvent[] {
  if (!tx || !tx.meta || tx.meta.err != null || !Number.isSafeInteger(tx.slot) || tx.slot < 0 || !signatureValid(tx.transaction?.signatures?.[0]) || !Number.isFinite(receivedAt) || !Number.isFinite(now)) return [];
  const transactionLayout = validateTransactionLayout(tx);
  const message = tx.transaction.message;
  if (!Array.isArray(message?.accountKeys) || !Array.isArray(message.instructions)) return [];
  const keys = transactionLayout.keys;
  if (!keys.every(keyValid)) return [];
  const instructions: { ix: Instruction; index: string }[] = [];
  const innerGroups = Array.isArray(tx.meta.innerInstructions) ? tx.meta.innerInstructions : [];
  for (const [i, ix] of message.instructions.entries()) {
    instructions.push({ ix, index: String(i) });
    for (const group of innerGroups.filter(g => g?.index === i)) if (Array.isArray(group.instructions)) for (const [j, child] of group.instructions.entries()) instructions.push({ ix: child, index: `${i}.${j}` });
  }
  const result: ChainEvent[] = [];
  for (const { ix, index } of instructions) {
    if (!ix || !indexValid(ix.programIdIndex, keys.length) || !Array.isArray(ix.accounts) || !ix.accounts.every(i => indexValid(i, keys.length)) || typeof ix.data !== 'string') continue;
    let decoded: ReturnType<BorshInstructionCoder['decode']> = null, adapter: Adapter | undefined;
    let bytes: Buffer; try { bytes = Buffer.from(bs58.decode(ix.data)); } catch { continue; }
    for (const candidate of VERSIONED_ADAPTERS.filter(a => a.address === keys[ix.programIdIndex])) try {
      const attempt = candidate.coder.decode(bytes);
      if (!attempt || !candidate.coder.encode(attempt.name, attempt.data).equals(bytes)) continue;
      decoded = attempt; adapter = candidate; break;
    } catch { /* Try a pinned official historical layout, never invent missing arguments. */ }
    if (!decoded || !adapter) continue;
    const kind = eventKind(adapter.protocol, decoded.name);
    if (!kind) continue;
    const layout = adapter.idl.instructions.find(i => i.name === decoded.name);
    if (!layout || layout.accounts.some(a => 'accounts' in a) || ix.accounts.length < layout.accounts.length) continue;
    const accounts: Record<string, string> = {}; let invalid = false;
    for (const [i, account] of layout.accounts.entries()) {
      const key = keys[ix.accounts[i]];
      if (!key || ('address' in account && account.address && account.address !== key)) { invalid = true; break; }
      accounts[account.name] = key;
    }
    if (invalid) continue;
    const args = serialize(decoded.data) as Record<string, unknown>;
    const actor = accounts.user ?? accounts.creator ?? accounts.payer;
    let mint = accounts.mint ?? accounts.base_mint ?? accounts.token_0_mint ?? accounts.input_token_mint;
    let quoteMint = accounts.quote_mint ?? accounts.token_1_mint ?? accounts.output_token_mint ?? WSOL;
    let finalKind = kind;
    if (adapter.protocol === 'raydium-cpmm' && kind === 'swap') {
      if (mint === WSOL) { [mint, quoteMint] = [quoteMint, mint]; finalKind = 'buy'; }
      else if (quoteMint === WSOL) finalKind = 'sell';
    } else if (adapter.protocol === 'raydium-cpmm' && mint === WSOL) [mint, quoteMint] = [quoteMint, mint];
    if (!actor || !mint || !quoteMint || mint === quoteMint) continue;
    result.push({ id: `${tx.transaction.signatures[0]}:${index}`, protocol: adapter.protocol, kind: finalKind, signature: tx.transaction.signatures[0], slot: tx.slot, mint, quoteMint, actor, creator: kind === 'launch' ? String(args.creator ?? actor) : undefined, pool: accounts.bonding_curve ?? accounts.pool ?? accounts.pool_state ?? '', instruction: decoded.name, instructionIndex: index, receivedAt, processedAt: now, blockTime: Number.isFinite(tx.blockTime) ? tx.blockTime : null, commitment, amountRaw: null, quoteAmountRaw: null, quantityEvidence: 'unavailable', details: { args, accounts, instructionSchema: adapter.schemaVersion, quantityReason: 'NO_UNAMBIGUOUS_PROGRAM_EVENT', transactionFeeLamports: Number.isSafeInteger(tx.meta.fee) ? tx.meta.fee : null, ...(transactionLayout.version === 1 ? { transactionVersion: 1, transactionConfig: transactionLayout.config, priorityFeeLamports: transactionLayout.config!.priorityFee ?? '0', priorityFeeUnit: 'LAMPORTS_TOTAL', executionSupported: false, executionUnsupportedReason: 'TRANSACTION_V1_READ_ONLY_EXECUTION_UNCERTIFIED' } : {}) } });
  }
  const emitted = typedEvents(tx.meta.logMessages);
  for (const event of result) {
    const candidates = emitted.filter(x => matches(x, event));
    if (candidates.length !== 1 || result.filter(x => matches(candidates[0], x)).length !== 1) continue;
    const data = candidates[0].data;
    event.details.programEvent = data;
    event.details.eventSchema = candidates[0].unsupportedTrailingBytes ? 'KNOWN_PREFIX_UNKNOWN_TRAILING_BYTES' : candidates[0].schemaVersion;
    if (candidates[0].unsupportedTrailingBytes) {
      event.details.knownPrefixSchema = candidates[0].schemaVersion;
      event.details.unsupportedTrailingBytes = candidates[0].unsupportedTrailingBytes;
      event.details.executionSupported = false;
    }
    if (typeof data.ix_name === 'string' && data.ix_name && data.ix_name !== event.instruction) {
      // The deployed event label may differ from the parent instruction. The
      // uniquely matching amount event remains visible, but execution stays unsupported.
      event.details.eventInstructionLabelMismatch = true;
      event.details.executionSupported = false;
    }
    event.creator = String(data.creator ?? data.coin_creator ?? event.creator ?? '') || undefined;
    if (event.kind !== 'buy' && event.kind !== 'sell') continue;
    let amount: unknown, quote: unknown;
    if (event.protocol === 'raydium-cpmm') {
      if (data.input_mint === event.mint) { amount = data.input_amount; quote = data.output_amount; }
      else { amount = data.output_amount; quote = data.input_amount; }
    } else {
      amount = data.token_amount ?? data.base_amount_out ?? data.base_amount_in;
      quote = data.user_quote_amount_in ?? data.user_quote_amount_out ?? data.quote_amount ?? data.sol_amount;
    }
    if (amountValid(amount) && amountValid(quote)) {
      event.amountRaw = amount; event.quoteAmountRaw = quote; event.quantityEvidence = 'program-event'; delete event.details.quantityReason;
    }
  }
  return result;
}

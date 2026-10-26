# Data-source research and verified limits

Research date: **2026-10-26 UTC**. This note distinguishes implemented observations from optional provider capabilities. It contains no credentials or private endpoint URLs.

## Current source and capability evidence

PHANTOM keeps the typed program-event observer separate from full-transaction enrichment. Typed observations do not establish complete transaction verification or authorize paper entries. RPC enrichment uses bounded queues and reports missing data, dropped work, reconnects, and backfill gaps. A low local processing latency is not a measurement of validator-to-client delivery or proof of first-block execution.

A bounded capability probe performed by the root chat against the existing Helius configuration on 2026-10-26 UTC returned JSON-RPC **-32600** with the provider message:

> transactionSubscribe is not available on the free plan

No paid plan upgrade, new account, or new credential was created. The full-transaction WebSocket adapter remains disabled; normal RPC fallback remains necessary. This observed denial establishes the current configuration's capability more directly than general product descriptions.

## Transaction version 1

The Solana Foundation documents a 4,096-byte maximum transaction size and v1 activation on mainnet in September 2026. Transaction readers must request numeric `maxSupportedTransactionVersion: 1`; a v1 transaction requested with a lower supported version can fail with **-32015**. This error is distinct from rate limiting or an absent transaction.

The implementation now reads v1 **RPC JSON** responses and preserves their transaction configuration. A real v1 transaction fixture was captured and exact raw amounts were verified. The root validation checkpoint reports **355 Vitest tests across 18 files, 23 Python tests, and TypeScript checks passing**, including PostgreSQL-enabled checks.

This does not establish raw-wire v1 decoding, signing, or broadcast support in the installed legacy SDK. The Foundation lists web3.js 1.99.0 as its first 1.x read-only v1 release. V1 resource limits and priority fees belong to `transactionConfig`; legacy ComputeBudget instruction assumptions must not be applied to them.

## Optional future full-push adapter

Current Helius documentation describes `transactionSubscribe` on its unified WebSocket service for Developer, Business, or Professional plans. Its full-detail options include commitment, `jsonParsed` or base64 encoding, and supported transaction version 1. A future adapter needs confirmed account eligibility; availability must not be inferred from key possession.

Parsed transaction keys already include lookup-table accounts, while `loadedAddresses` is omitted. Parsed and partially decoded instructions require explicit normalization before pinned protocol-IDL decoding. Missing metadata, unknown variants, or unverified instruction bytes must fail closed. Keep subscription acknowledgements, commitment, deduplication, bounded buffers, reconnects, and gap reporting explicit. Retain RPC backfill; do not assume WebSocket historical replay.

Yellowstone integration still requires an actual configured endpoint and runtime validation. Neither optional stream has demonstrated a speed improvement here. Live spending remains separately gated and was not exercised.

## Official references

- [Helius WebSocket capabilities and access](https://www.helius.dev/docs/rpc/websocket)
- [Helius transactionSubscribe wire contract](https://www.helius.dev/docs/api-reference/rpc/websocket/transactionsubscribe)
- [Solana Foundation v1 migration and SDK support](https://solana.com/upgrades/larger-transaction-sizes)
- [Solana RPC JSON and parsed transaction structures](https://solana.com/docs/rpc/json-structures)

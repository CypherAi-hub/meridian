# Omni live activity contract

This is the observer for the existing rule-based paper engines. It does not implement on-chain launch decoding, a wallet graph, or a trained AI model. Keep separate PHANTOM work under its own package. The two read APIs below distinguish simulated execution from public blockchain account activity.

## Persisted paper activity

`GET /api/sniper?view=live` returns the latest 150 recorded events, ordered by numeric event ID ascending, plus current strategy/worker summaries. `GET /api/sniper?view=live&after=CURSOR` returns the next 150 events after that cursor. IDs and cursors are decimal strings; preserve 64-bit precision. `hasMore: true` means request the returned cursor again to catch up. Empty pages preserve the cursor. Initial pages show a recent window rather than all historical events.

The response fields are:

```text
mode: "PAPER"
engine: "RULE_BASED"
serverAt: Unix milliseconds
cursor: decimal string
hasMore: boolean
recordingStartedAt: Unix milliseconds | null
events: [
  { id, key, session, at, kind, mint?, symbol?, detail }
]
books: [
  { id, name, enabled, initialized, updatedAt, ticks,
    metrics, orderUsd, maxPositions, lastCheckAt,
    recentChecks, eligible, reasons: [{code,count}], trades }
]
worker: {status,lastTickAt,error,host}
sources: [{id,status,detail}]
```

The event kinds are `WATCH`, `SKIP`, `ELIGIBLE`, `SIGNAL`, `BUY`, `EXIT_SIGNAL`, `SELL`, `EXPIRED`, `QUOTE_ISSUE`, `SCAN`, and `CONTROL`. Every event comes from a persisted engine transition or completed scan. `BUY` and `SELL` describe indicative quote-based paper fills. They are never blockchain transactions. Manual QA account activity is separate and is not added to this automatic feed.

`detail` may include `reasons` (original check codes), `checked`, `eligible`, `equityUsd`, `netUsd`, `costUsd`, `proceedsUsd`, `pnlUsd`, `rawQty` (decimal string), `reason`, `enabled`, and `tradeId`. Entry signals precede delayed quote fills. Exit signals are also distinct from closed trades. Failed/stale quotes do not become fills. `SKIP` records changed rejection decisions; unchanged rejections are not repeatedly appended. `SCAN` summaries are emitted at minute boundaries while the engine is receiving tokens. `ELIGIBLE` means the current data checks passed, not that a trade was filled.

Events live in the additive `0016_sniper_activity.sql` table and are written within the same transaction/lock as the corresponding paper book. Retried event keys use `ON CONFLICT DO NOTHING`. Reads do not advance the engine, activate it, call a swap, or change the book. Browser refresh is every three seconds. Pausing the browser feed does not pause collection. New activity starts with this migration; earlier historical fills are not reconstructed.

Each paper account keeps its independent 1,000-USDC starting balance. `recentChecks` counts distinct candidates seen within 90 seconds per strategy; repeated observations of the same candidate in that window count once. It is not a transaction count. The three book IDs remain `paper-sniper-v1`, `paper-flow-10k-v1`, and `paper-confirmed-10k-v1`. Existing rejection codes and frozen validation rules are unchanged. Open or pending exposure remains visible even when older than the recent closed-trade window.

## Read-only Solana pool transactions

`GET /api/terminal?view=chain&pair=POOL_ADDRESS` returns a recent public RPC sample:

```text
network: "solana-mainnet"
readOnly: true
classification: "UNDECODED_ACCOUNT_ACTIVITY"
pair: pool address
fetchedAt: Unix milliseconds
source: "Solana public RPC · getSignaturesForAddress"
transactions: [
  {signature, slot, blockTime, status, confirmation, error}
]
```

`blockTime` is Unix **seconds**, or null. `status` is `succeeded`, `failed`, or `unknown`; missing error information is not silently treated as success. `confirmation` is `confirmed`, `finalized`, or `unknown`. Failed transactions remain visible. Unknown block times remain unknown.

This uses the public mainnet `getSignaturesForAddress` method with confirmed commitment and a limit of 20. It returns transactions that reference the selected pool, not decoded swaps. No buy/sell direction, amount, wallet attribution, launch creation, or profitable action is inferred from the signature. The 30-second cached/polled sample is not a complete transaction stream, and busy pools can have gaps. No additional RPC request is made when this view is closed. Requests are coalesced per pool and have a process-level cooldown. No paid key is required or added.

See the [official RPC contract](https://solana.com/docs/rpc/http/getsignaturesforaddress). A complete verified launch/transaction pipeline can later provide a separate adapter; it must preserve these labels and must not turn paper events into chain transactions.

## Integration and access

The UI implementation lives under `src/components/omni`; the existing paper engines remain in `src/lib/desk/sniper.ts`. Windows integration should merge the supplied UI Git bundle into its existing branch, preserving `packages/phantom` and any root workspace/dependency changes. Do not replace an independent Windows branch with a ZIP checkout.

The running private viewer permits GET/HEAD only. It can display both feeds, charts and summaries, while POST controls remain blocked. It does not provide a real-money execution path. All future-capital preferences and activation locks remain in place.

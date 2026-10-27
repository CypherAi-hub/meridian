# Actorless CPMM enrichment hints

Raydium's pinned [SwapEvent source][event] contains pool and input/output mint
addresses, but no trader address. A finalized [Solana log notification][logs]
contains signature, slot and logs rather than transaction account metadata.
These fields cannot establish a wallet identity or independent buyer.

The decoder therefore keeps these events out of the actor-bearing ChainEvent
and TradeObservation paths. It emits a separate, exact-schema
`ENRICHMENT_PRIORITY_ONLY` callback hint. SOL-paired swaps can receive ordinary
SOL-activity priority, or watched-mint priority when already watched. Hints never
receive launch/pool priority, create wallet demand, trigger quote research,
authorize trades, or change ledger/risk state. Full transaction enrichment and
its existing validation remain required for those facts.

The stream accepts hints only when their scope, source, program, schema,
non-execution flag, trade kind, signature, slot, receipt time, addresses, distinct
mint pair, SOL orientation and log index match the current envelope. Failed
program calls, ancestor rollbacks, spoofed data, unknown trailing bytes and
malformed hints retain the background full-fetch fallback. Queue size, provider
rate limits, FIFO ties and all entry rules are unchanged.

`priorityHints` counts decoded hints used for enrichment scheduling; it is not a
trade or buyer count. Existing callbacks returning ordinary event arrays remain
supported. The saved public-RPC CPMM fixture is a non-SOL pair from the previously
fixed activity window. Its source attribution, byte hash and line-ending rule
are included. It establishes decoder coverage, not provider authenticity,
reviewed deployment identity, attainable fills or profitability. Synthetic
fixtures cover SOL directions and queue behavior without provider calls.

## Separate unresolved historical-cache timing issue

Independent read-only audit reproduced unsafe historical reconstruction from
the mutable assembled Engine trade cache: full-only fields use notification
receipt as observedAt, and later full materialization can advance a matching
typed row's apparent availability. A complete correction needs timestamped
economic revisions and order-independent restart reconciliation, not a blanket
timestamp substitution. That correction is outside this component.

The audit found no current path that retroactively rewrites earlier persisted
numeric replay snapshots, quotes or fills. Live features are computed after
insertion. Do not confuse that limited finding with certification of arbitrary
featuresAt(oldAsOf) reconstruction from the assembled cache. Preserve receipt,
decode availability and strategy admission as distinct evidence concepts.

## Runtime setup

PHANTOM uses Node 24 in CI and has been validated on Node 24.22.1. The pinned
Pump SDK dependency import fails on Node 22. Package metadata, installation
instructions and the package PowerShell launcher now require Node 24+. The
native Windows supervisor already required 24. Meridian's separate root runtime
requirement is unchanged. No active worker is restarted for this source update.

[event]: https://github.com/raydium-io/raydium-cp-swap/blob/f4b9b26342afe9122d5ff67cd7a4f19ded4ac0a5/programs/cp-swap/src/states/events.rs
[logs]: https://solana.com/docs/rpc/websocket/logssubscribe

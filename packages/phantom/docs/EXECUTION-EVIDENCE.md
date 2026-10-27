# Quote and signal evidence boundaries

This source change corrects two paper/replay evidence defects. It does not
activate funded execution, relax the strict token policy, or rewrite an active
forward cohort. Tests and prospective data must identify the exact source version.

## Signal time survives capture

`flattenReplayFeatures` now records `featuresObservedAt` from `SignalFeatures.asOf`
and stores assembly time separately as `snapshotCapturedAt`. The earlier code
replaced the source time with the current capture clock. Consequently an old
momentum or launch-age signal could pass a replay freshness check when only its
quotes and security data were new.

Source, security and capture timestamps must be nonnegative safe integers. Source
and security times cannot exceed capture time. When a capture time is supplied,
both the exporter and direct strategy guard require it not to exceed the
observation/decision availability time. The replay admission guard keeps
using `featuresObservedAt`, so serialization does not renew a signal's lifetime.
The regression deliberately supplies an old signal alongside otherwise fresh,
passing quotes and security evidence and requires rejection.

This preserves computation/source time; it does not prove every underlying
wallet observation has complete coverage. Historical captures that discarded the
original source time cannot be back-certified by the new serializer. Their
uncertainty remains, and existing journals are not relabeled.

## RFQ pricing is currently unsupported

Jupiter's [current order contract][order] distinguishes routing families and
identifies `quoteId`, `maker` and `expireAt` as RFQ fields. It describes the expiry
as a string timestamp without specifying its encoding. The client previously
dropped these fields and assigned every response a locally fresh `observedAt`.
That could admit an expired maker quote into a paper model that had no expiry
check at later settlement.

The bounded correction requests `excludeRouters=jupiterz`, validates the response
even if the provider ignores that exclusion, and rejects JupiterZ or any response
with populated RFQ metadata or an RFQ/mixed `swapType`. The fixed public error is
`JUPITER_RFQ_EXECUTION_UNSUPPORTED`; raw provider bodies are not exposed. This
deliberately rejects future-dated RFQ prices too, because checking expiry only at
receipt would leave the modeled-settlement gap open. No seconds/milliseconds
guess or incomplete timestamp parser is introduced.

The current supported routing families are `metis`, `dflow` and `okx`, as named
by the provider contract. Missing or unreviewed routing families reject with
`JUPITER_ROUTER_UNSUPPORTED`, even if a route label is present. Accepted quotes
retain the provider's router identity and existing request ID. Original
baseline/horizon payloads store the complete quote; their reduced forward/replay
projections still do not prove historical routing identity or RFQ validity.

A future RFQ implementation must bind a documented or independently captured
wire format, preserve the original deadline, and recheck it at every admission,
mark, delayed entry and exit settlement, including restore and independent replay.
That future support must have its own source-bound prospective evidence before
RFQ pricing is admitted again.

Omitting `taker` produces a quote without a transaction according to the same
contract. A supported routing family and fresh quote are observable pricing
evidence, not a signed transaction, successful simulation, inclusion, or a
guarantee of future liquidity. Existing frozen quote counters mean their timing
and journal contract only. They must not be promoted into executable-route proof.

The active 150 bps budget, strict safety requirements, existing balances, and
unresolved outcomes are unchanged. A separate research paper experiment may
declare different admission assumptions prospectively; it must retain their
uncertainty and cannot claim compliance with the strict associated-supply rule.

[order]: https://developers.jup.ag/docs/api-reference/swap/order

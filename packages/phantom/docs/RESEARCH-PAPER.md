# Research paper admission and the next runner

This document describes the **offline admission boundary**. A separate local
runner now shares the paper accounting and persists prospective entries, cash
reservations, positions and exits; see [RESEARCH-PAPER-RUNNER.md](RESEARCH-PAPER-RUNNER.md).
Actual Engine scheduling, discovery enrollment, dashboard integration and a
prospective market-quote lifecycle remain required. Passing these functions or
synthetic runner tests is not evidence of profitability. The current strict
account and frozen quote cohort do not import this module.

## A deliberate research exception

The strict producer currently cannot establish complete creator associations.
Its false/null association evidence vetoes every strict entry. The research
policy preserves that strict verdict and declares a different PAPER assumption:

```
associationScope: UNKNOWN_ASSOCIATIONS_ACCEPTED_FOR_PAPER
unverifiedAssociatedSupplyUpperBps: 10000
strictPolicyEligible: false
liveApproved: false
```

Unknown wallets could control all unclassified supply. This exception does not
satisfy the strict 10% associated-supply rule or certify a token. Known excessive
direct creator holdings, known excessive associated holdings, top-ten exposure,
authorities, restrictions, fees, malicious configurations and other hazards still
veto. Unknown association coverage alone is not converted into verified coverage.

`ResearchPaperAdmission` has `allowedForResearch` and deliberately has no outer
`allowed` property. It is structurally incompatible with `SafetyVerdict`; even a
runtime cast is rejected by the existing strict governor. The local research
runner uses a distinct paper-only authorization path sharing the economic risk
and accounting primitives. It never synthesizes `SafetyVerdict.allowed=true`.

## What the module actually verifies

`freezeResearchPaperPolicy({sourceHash, frozenAt})` continues to create the exact
deeply immutable, hashed **V1** manifest. Its body and validation remain readable
without adding a mint capture to old evidence. V1 remains legacy SPL only.
`freezeResearchPaperPolicyV2({sourceHash, frozenAt})` creates a **separate V2**
manifest with a different kind, source universe and hash. It admits legacy SPL
and a restricted metadata-only Token-2022 universe, requiring original mint
account bytes for every V2 decision. This is a protocol-coverage revision, not
selection using observed returns or evidence of an eligible/profitable population.

`ResearchPaperPolicy` is the V1/V2 union. `validateResearchPaperPolicy` recognizes
only the exact kind/version pairs and reconstructs the entire corresponding fixed
body. Edited parameters, extra fields, source mismatch or hash changes reject.
There is no parameter search. Both versions retain these engineering settings:

| Setting                                   | Value                                                            |
| ----------------------------------------- | ---------------------------------------------------------------- |
| Strategy                                  | Existing `momentum_breakout` rules                               |
| Initial simulated capital / entry         | 1 SOL / 0.01 SOL                                                 |
| Simultaneous occupied slots               | One, including pending entries                                   |
| Net liquidity floor / paired cost ceiling | 20 SOL / 150 bps                                                 |
| Requested slippage per leg                | 25 bps, below the existing 100 bps maximum                       |
| Minimum entry delay / quote freshness     | Two seconds / five seconds                                       |
| Quote routing                             | SOL pairs, supported non-RFQ Jupiter aggregators                 |
| Network cost model                        | 10,000 lamports per leg, explicitly modeled rather than measured |

Tighter slippage does not make the market cheaper. It increases the chance that
a submitted order would fail. Under ideal flat-price linear zero-venue-fee
arithmetic, two 25-bps stresses plus the 20,000-lamport network model cost about
70 bps on this entry size; actual fresh quotes must still satisfy 150 bps. This
is a fill-model hypothesis, not a demonstrated fill rate.

`evaluateResearchPaperAdmission` checks policy/source identity, post-freeze
source availability, decision/request/receipt/capture chronology, capacity and
freshness. It independently evaluates the original decision-time feature vector.
A new delayed buy and exact-quantity paired sell must have canonical u64 amounts,
correct mints, valid minimum outputs under the 25-bps limit, supported source and
router identity, and no contradictory RFQ metadata. Security's sell-route time
must match the supplied sell quote. Legacy SPL requires an empty extension list
and actual Boolean evidence, so truthy strings or impossible extension claims
cannot pass in V1. V2 retains exact Boolean and extension-schema validation and
adds the independently decoded raw mint controls described below.

The delayed paired cost is recomputed from the raw proceeds and frozen fee model.
It is a separate final pricing check, not a replacement for the earlier signal:
an original 149-bps signal followed by a 150-bps pair may pass; an original
151-bps signal rejects even if the later pair costs 150; an original 1-bps signal
rejects if the later pair costs 151. Both values and their separate timestamps
remain in the result. Sequential quote movement is not simultaneous venue
friction, a realized execution cost, or proof of attainability.

The returned expiration is the earliest security, source, decision, request and
quote deadline. Evidence is detached and immutable. Caller-supplied source and
capture identifiers are preserved, not cryptographically authenticated. A valid
decision must still undergo final cash, inventory, fee, drawdown, reservation and
idempotency checks in the future paper runner.

## V2 original mint-account evidence

Every V2 decision requires:

```ts
mintAccountCapture: {
  address: string;
  owner: string;
  dataBase64: string;
  slot: number;
  requestedAt: number;
  observedAt: number;
  publishedAt: number;
}
```

The policy calls `verifyResearchMintCapture` on these original bytes, with the
security mint and the original raw response time as exact expected identities.
The three clocks are distinct: `requestedAt` is the actual mint RPC start,
`observedAt` is its original response completion, and `publishedAt` is the later
completed full security snapshot's availability time. `publishedAt` must equal
`security.observedAt`; the raw response is never retimestamped after holder or
other security inspection. The policy requires exact agreement with the decoded token program, mint
and freeze authorities, extension set, transfer fee, permanent delegate and
transfer restrictions. `extensionsVerified:true` alone cannot substitute for a
capture, contradict it, or make an unsupported layout acceptable. Active
authorities remain actual active authorities and retain their strict vetoes.

Legacy SPL requires its exact mint layout and no extensions. For Token-2022,
only mint `MetadataPointer` and `TokenMetadata` extensions are in scope; a mint
with no extensions is also supported. Token metadata requires its metadata
pointer and matching embedded mint identity. Account-only `ImmutableOwner`,
unknown types, transfer hooks, permanent delegates, transfer-fee configurations
**even with zero rates**, and every other extension reject. These restrictions
are narrower than the shared strict checker's general extension allowlist.

All three raw anchors must be after the new policy freeze, with
`requestedAt <= observedAt <= publishedAt <= capturedAt <= now`. The maximum age
is 30 seconds from the **earliest raw request**, matching the existing security
evidence limit without hiding time spent in RPC or later inspection. That request
time plus the limit participates in admission expiration, alongside all original
source, decision, quote-request, quote-observation and security deadlines.

The derived controls and raw/capture hashes remain attached to a V2 admission
with `CALLER_SUPPLIED_RAW_ACCOUNT_NOT_ATTESTED` provenance. Decoding supplied
bytes does not authenticate a provider, prove a same-bank relationship to holder
or liquidity evidence, certify deployed program behavior, or establish future
sellability. The unknown-association PAPER exception and all strict/funded
exclusions remain unchanged.

V2 requires a newly frozen epoch and policy identity before its first prospective
decision. Restore V1 as V1; do not edit its manifest, relabel its historical data,
carry earlier quotes into V2 entries, or turn a conditional capture into a strict
certificate. No strategy, cost, liquidity, capacity, delay or capital threshold
was changed to fit observed winners.

## Required next integration

The local accounting/runner implementation is now described in
[RESEARCH-PAPER-RUNNER.md](RESEARCH-PAPER-RUNNER.md). Its synthetic durable
lifecycles do not complete the actual Engine, provider, UI or performance
integration described below.

Use the repaired native paper accounting, not a second incompatible fill model.
Implement an explicitly separate research account/namespace and persisted
experiment manifest. Bind policy hash, exact source, population, enrollment
window and engineering acceptance criteria before the first new decision.
Existing historical quotes must never be imported as fills.

Persist each new decision and pending reservation before provider work. The
research authorization must be a distinct type, bound to this paper account and
policy; the strict/funded path must reject it. Share the existing economic
limits and final synchronous settlement logic without forging a strict verdict.
New transactions and fully decoded economic availability must remain separate
from earlier notification receipt. Do not repair historical mutable-cache
reconstruction by globally changing receipt timestamps.

Debits, exact simulated token inventory, entry fees, pending exits, partial exits,
failed attempts, account-rent lockup/refund assumptions and unresolved inventory
need durable records. A quote failure before modeled submission is different
from a failed submitted attempt and must not be assigned an invented chain fee.
The current network-fee model alone does not establish actual priority or rent
costs; freeze their treatment before a position lifecycle is run.

Pending reservations reduce available cash without being counted as already
spent. Independent reconciliation must account for opening capital, actual
paper cash, remaining allocated cost and fees, realized P&L, locked rent, failed
attempt costs and other overhead. Missing marks yield unknown equity. Missing
exits retain inventory and contribute zero proceeds to a separately labeled
conservative bound; they cannot disappear from results.

Ready exits take provider priority. Reserve enough capacity for prospective
entry and exit requests before enrollment. Do not displace the current frozen
cohort's reserved turns. A new source deployment requires explicit retirement of
an interrupted epoch and a separately frozen replacement; preserve the original
journal, original cutoff and incomplete status rather than resetting history.

The first operating acceptance is an actual prospective PAPER lifecycle under
real observable quotes: durable delayed entry, exact inventory, forced-restart
preservation, autonomous exact-quantity exit, costs counted once, and independent
reconciliation. Negative, missing-route and duplicate-request cases are required.
Ten prospective entered tokens can exercise operation; neither ten trades nor
one profitable round trip establishes an edge. A separately frozen untouched
performance cohort, including every entered token and unresolved exposure,
remains necessary before any positive-expectancy claim.

In Omni, a future research account needs an explicit experimental label and
ownership-uncertainty status, separate cash/positions/P&L and all missing outcomes.
Its trades must not appear as strict strategy validation or wallet earnings.
Funded activation, deposits, signing and transfers remain disabled.

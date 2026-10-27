# Prospective post-probe quote cohort

This is an instrumented forward research experiment. It never creates a paper order, changes the paper ledger, loads a wallet, signs, submits or transfers anything. A positive report can only nominate a hypothesis for a later separately frozen, balance-aware paper-strategy experiment. Profitability remains unproven.

The existing baseline/horizon observations remain descriptive. Their earlier buy quote cannot become an entry selected using the subsequently completed buy/sell probe. Existing strategies, the 150 bps cost cap and capital protections are unchanged.

## Frozen question and timing

The first question is: after a complete sequential quote probe qualifies under the existing conservative cap, does a NEW delayed entry show positive conservative 60-second quoted expectancy relative to holding no inventory?

| Default | Value |
| --- | --- |
| Scope | `FORWARD_QUOTE_COHORT_NOT_TRADES` |
| Selection | First prospectively observed completed probe per mint |
| Probe cap | Exact cost <=150 bps, without flooring fractions |
| Exact input | 10,000,000 lamports |
| Slippage stress | 100 bps per leg |
| Modeled network charge | 10,000 lamports per leg; a model, not measured transaction fees |
| Shared research turn spacing | 30,000 ms |
| Entry minimum delay | **32,000 ms after the completed eligibility decision** |
| Entry completion grace | 5,000 ms after entry due time |
| Primary exit target | 60,000 ms after the NEW entry quote's observation |
| Exit completion grace | 5,000 ms |
| Maximum concurrent research episodes | One |
| Enrollment window | Fixed 72 hours, beginning after protocol freeze |
| Minimum candidate review | 100 distinct entered tokens, three UTC entry days and a closed enrollment window |
| Control | Paired no-trade result of zero |
| Token security | `UNASSESSED_NOT_TRADABLE`; this cohort cannot authorize execution |

This is explicitly a **delayed post-probe cohort**. It does not measure a two-second entry or creation-slot sniping. The 32-second default follows the measured existing 30-second research turn budget; a faster experiment requires its own measured/reserved request budget and a new frozen manifest.

The manifest binds runtime source version, source commit, experiment ID, times, economics, timing and analysis limits through a canonical SHA-256 configuration hash. Freeze and persist it before enrolling data. Source changes must not overwrite the original manifest or historical records.

## Cost interpretation

The current sequential probe sells the first quote's minimum token quantity and evaluates the second quote's minimum SOL output. Under an unchanged, frictionless, linear price, two 1% reductions plus 20,000 modeled lamports cost **219 bps** at the default amount, above the unchanged 150 bps cap. Favorable price movement between requests can offset that conditional floor. Passing the cap therefore does not isolate cheap venue friction.

`forwardCostAudit` reports this contradiction and the exact break-even exit proceeds of 10,020,000 lamports. No threshold is raised automatically. The reported statistic is named sequential minimum-output quote stress with temporal drift. Nominal and stressed quantities cannot be linearly rescaled into interchangeable exact-size quotes.

Jupiter's [order response](https://developers.jup.ag/docs/api-reference/swap/order) distinguishes expected output, minimum threshold, platform fees and network-fee fields. The collector retains quote amounts, applies the frozen minimum-output bound, and charges only the separately identified network model. Real payer, inclusion, priority, rent and failure costs remain unmeasured. Pump's [fee program](https://github.com/pump-fun/pump-public-docs/blob/main/docs/FEE_PROGRAM_README.md) is dynamic; this module does not impose a second generic venue fee.

## Worker integration contract

The new files do not start an additional worker or open a port. Integrate them into the existing sole leased PHANTOM worker:

1. Construct `ForwardSqlJournal(existingStore)`. It creates only additive `phantom_forward_protocols` and `phantom_forward_records` tables through the existing Store's worker-fenced SQL path. The manifest and each `(experiment,mint,phase)` record are immutable; identical repeats deduplicate and conflicting payloads fail closed.
2. Persist one `freezeForwardProtocol({now,runtimeSourceVersion,sourceCommit})` manifest before its future enrollment start. Reuse that exact manifest after restart. `ForwardCohortCollector(protocol,journal,currentRuntimeVersion)` rejects a different source fingerprint. Keep older cohorts/exportable history when a new source version starts a separate experiment; never relabel old data.
3. After the original baseline probe is durably written, call `considerProbe` with its canonical event/probe ID, mint, signature, slot, protocol, kind, source receipt time, probe start/completion, exact amount, buy and sell quotes. Do not retrospectively enroll a historical backlog. Missing/invalid/over-cap probes are recorded; later favorable probes cannot replace the mint's first observation.
4. Use `nextQuoteWindow()` to reserve the next entry or exit turn. Call `tick(existingProvider,permit)` through the shared budget. Paper protective exits have priority. In particular, an old 30-second descriptive horizon must not consume the turn reserved for the new 32-second entry. Deferrals, provider backoff and missed observations stay visible; never backdate them or reuse the probe buy. A per-process lane cannot guarantee an account-wide quota shared with Omni or other clients.
5. The journal stores request intent before I/O. Actual provider-call time is measured AFTER that durable write and appears in the result's `requestedAt`. If persistence consumes the deadline, no provider call occurs. A quote must be observed after the actual request, have the exact requested identity/size, satisfy the frozen slippage bound, and complete by the deadline.
6. Exit quantity comes only from the validated NEW entry minimum output. Restart validates the full enrollment/request/result graph before deriving any inventory. Interrupted requests become explicit unknowns without a second provider call. Ambiguous append acknowledgements force a durable reload before any further quote decision.
7. Export `await collector.export()` through a fixed GET-only local endpoint and include its original `exportedAt`. Await `idle()` during owned shutdown. Preserve ledger, manual QA, original research records and capital settings independently.

The default provider API is structurally compatible with the existing quote-only provider. It never accepts a taker or transaction bytes. Only amount/mint/observation fields are journaled; arbitrary provider URLs, routes, credentials and error text are excluded.

## Native integration and delivery audit

The existing worker now creates a deterministic experiment ID from its startup source fingerprint. Same-source restarts reuse the original manifest and enrollment window; changed sources retain the older cohorts and create a distinct manifest. Archived deployments must supply their public 40-character `PHANTOM_SOURCE_COMMIT`; Git checkouts read their local commit. The runtime fingerprint identifies actual startup source bytes independently of that reference.

Only probes whose source receipt and probe start are at or after enrollment start are tagged for forward delivery. Historical backlog stays in descriptive research without consuming the mint's first prospective slot. The original durable baseline row contains the delivery packet; restart reconciles tagged packets before accepting later probes. If recovery is too late, the first probe is rejected with its original timestamps, never given a retrospective entry.

The shared collector reserves 30-second research turns for forward windows and labels new descriptive episodes `FORWARD_BUDGET_RESERVED_V3`. Old horizons can be delayed by those reservations and retain their measured times. Ready paper exits run before marks and entry work; protective quote requests have the highest local queue priority. Forward and legacy research use the research tier, below paper entries and above ordinary analysis.

Fixed GET-only endpoints are `/forward-cohort` (current export), `/forward-cohort?experiment=ID` (historical export), and `/forward-cohorts` (manifest metadata). Every native full export includes a cutoff-bound `probeDeliveryAudit`: first tagged baseline intents are compared with enrollment records, exposing missing delivery, displaced first probes and unmatched enrollments. Closed or retired cohorts are never silently repaired by historical GETs. Python blocks candidate classification if this inventory is missing, incomplete or inconsistent. This audit covers explicitly tagged baseline probes only; it cannot attest provider authenticity or complete launch coverage.

The Jupiter quote client now uses a bounded, serialized local queue with a conservative 1-second start interval, total queue/request deadlines and documented reset-header backoff. It never retries or substitutes a cached quote. Provider-reported network starts are retained separately from invocation-only/legacy timing. The [provider's limits](https://developers.jup.ag/docs/portal/rate-limits) apply across an organisation, so this client cannot guarantee quota availability shared with Omni or other processes. No plan upgrade or quota acceleration was performed.

The current strict SecurityReader still always reports creator associations unverified and associated concentration unknown. That implementation/coverage gap blocks every strategy entry independently of market selection. This forward collector remains explicitly `UNASSESSED_NOT_TRADABLE`; it does not bypass that blocker or count as paper positions. Scoped point-in-time security evidence remains a separate milestone.

Keep the active deployed source frozen while its 72-hour cohort collects. Develop subsequent noncritical changes in an isolated checkout; source changes create a new experiment rather than extending or resetting an old window. An actual 72-hour soak is not yet proven. Windows AC sleep policy is 900 seconds and DC is 600 seconds; the supported Codex keep-awake setting must remain active with the app open. Current power-request inspection requires administrator privileges and was unavailable. A separate helper was previously rejected by automatic approval and was not retried; no global power policy was changed.

## Independent evaluation

The standard-library Python evaluator joins canonical enrollment, request and result records and recomputes eligibility, chronological capacity, timing, slippage and exact integer accounting. It does not trust embedded cost or P&L assertions.

```sh
node --experimental-strip-types --test research/forward_cohort*.test.ts
python3 -B -m unittest discover -s research -p 'test_forward_cohort.py'
python3 -B research/forward_cohort.py --input forward-export.json --output forward-analysis.json
```

The Node SQL test uses a dedicated temporary PGlite database and verifies persistence across a real close/reopen. Existing actual PostgreSQL worker-lease tests and native budget-contention/recovery checks remain separate requirements.

The report exposes complete on-time outcomes, an all-entered conservative bound assigning zero token proceeds to pending/missing/late exits, and admitted-opportunity coverage with unfilled opportunities at zero. Two modeled network charges remain in the conservative entered bound. Exact raw sums and rational means preserve atomic accounting. Pending counts are separately visible.

Candidate review additionally requires positive conservative totals, positive descriptive token/day cluster lower bounds, and a positive sum after removing the three largest winners. It still returns `profitabilityConclusion: UNPROVEN` and `liveApproved: false`. The paired no-trade control does not establish superiority to a matched random-entry strategy, real attainable fills, independence, market impact or regime stability. A later paper-strategy validation needs those additional controls and actual durable paper positions.

Synthetic exports must set `fixtureKind: "SYNTHETIC_CONTRACT_FIXTURE_ONLY"`; they cannot qualify as market evidence. Unit/SQL fixtures and an offline collector-to-Python cross-check are tests, not research profits.

## Verification before native integration

The integrated Windows source passed 449 Vitest cases (including four actual PostgreSQL cases), 30 separate Node collector/SQL cases, 86 Python cases and TypeScript checking. Native process recovery and first actual cohort records are verified separately at deployment; these passing checks alone do not prove a completed 72-hour experiment or any profit.

- 20 synthetic Node collector/recovery tests passed, including exact 150/150.001 bps boundaries, stale cached quotes, changed entry quantities, missed deadlines, lost acknowledgements, malformed saved inventory, slow durable intent and frozen-source conflicts.
- One isolated real PGlite persistence/restart test passed.
- 41 independent Python evaluator tests passed.
- Targeted TypeScript check passed. A collector-generated synthetic five-record episode passed the independent parser/hash/accounting contract and remained unproven.
- Native full-suite, shared-budget contention, actual-source fingerprint, owned restart and live first-probe verification are required at the integration checkpoint. These are not implied by the isolated tests above.

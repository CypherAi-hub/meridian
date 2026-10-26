# PHANTOM continuation record

The complete original specification remains in `PHANTOM-SPEC.md`. The active objective also asks for continued bug fixing, actual testing, research, and Python analysis while the user is away. The goal is **active**, not complete; observed profitability remains unproven.

## Current operation

- Windows worker: `http://127.0.0.1:8790/state`; local Next monitor: `http://127.0.0.1:8791`.
- Real Helius RPC/WebSocket and Jupiter V2 quote-only credentials were supplied by the user and verified. They are in an ignored, user-restricted `.env`; never print, export, commit, or send them to another chat.
- Finalized typed-event observation and full transaction enrichment are distinct. The first has run at about 1 ms local receipt-to-processing p95 with no callback drops in sampled checks; full enrichment is rate/coverage constrained and reports degraded status.
- Research samples actual quotes without placing orders. Baseline observations and 30/60/180-second hypothetical quote horizons are distinct from paper fills. Horizon watches are persisted, bounded, deduplicated on restart, and given priority over new baselines within a shared quote budget.
- The user’s existing Mac chat **Check Meridian access** continues work on the original Omni UI and paper activity feed. Its host is `remote-control:env_e_6a17b9c9f9e083288b4ce14389d632b8`, thread `01a178f4-4b09-7ac0-8569-5e6fbbf4e7aa`. Do not overlap its root UI edits or transmit credentials. PHANTOM code is isolated under `packages/phantom`.
- An hourly thread heartbeat named **PHANTOM paper research and validation** is active. Quiet for unchanged/non-actionable state; notify meaningful progress, failures, completion, or required user action.
- Windows app's supported **Keep this PC awake** was inspected and already enabled with remote access on. A separate helper launch was rejected by automatic approval with only “blocked by policy”; that approach was removed. Do not retry the blocked helper or change system security settings.

## Verified fixes

1. Official current, historical, and SDK-shipped IDLs are pinned. A captured finalized Pump transaction uses the historical instruction layout and current SDK event layout. Unknown layouts or unverified instruction/event label correlations remain execution vetoes.
2. Stream cursors advance after durable receipt, not enqueue. Reconnect/replay gaps and overload remain explicit; memory is bounded. Failed CPI/ancestor logs cannot supply committed trade-event evidence.
3. Typed observations cannot authorize orders. Economic fast/full observations are counted without duplication across repeat callbacks and restart, including identical-leg multiplicity. Unsupported full decoding does not erase valid typed research history.
4. Paper entry/exit quotes must be exact-size, fresh, and obtained after execution delay. Every settlement passes the final governor. Partial exits retain exact cost and fee attribution.
5. Settled fills and exits are checkpointed before replay/log writes or the next provider call. An audit failure cannot falsely report “no fill” after creating a position. Database/audit suspensions persist as a review gate across restart.
6. Protective ticks are single-flight and are not queued indefinitely behind slow analysis. Ledger writes are serialized. Trailing high-water marks are checkpointed before waiting for another provider.
7. Wallet funding analysis accepts committed top-level transfers; caught failed inner transfers cannot create relationships. Cache version 2 retains raw reviewed candidates and reapplies the current related-wallet set without refreshing old evidence timestamps.
8. Completed-position metrics aggregate full leg history before pagination. A profitable partial followed by a larger final loss is one losing position; incomplete legacy attribution stays unknown. Python uses the full authoritative aggregates, not a truncated exit-leg list.
9. Creator-associated concentration is explicitly unverified until evidence exists. Direct creator balances are a lower bound, not a complete association check. Neither safety rules nor research outputs are loosened to manufacture trades.
10. Enrichment admission now prioritizes SOL launches above SOL pools and watched SOL trades. Unsupported non-SOL pools cannot fill the same priority tier and block a supported launch. Empty/unknown layouts still receive full-fetch fallback; eviction and coverage gaps remain explicit.
11. Python compares validated baseline costs with the actual exposed strategy cost policy. The original 150-bps budget remains unchanged; missing policy evidence is unavailable, and horizon outcomes never enter this comparison. Typical observed quoted costs have exceeded that budget, explaining another rejection gate without implying profitability at a higher budget.
12. Actual PostgreSQL backend-termination tests exposed and verify the fix for advisory-lock session loss. All worker SQL now uses the same retained session that owns its lock, never another pool session after failure. Startup/shutdown cleanup covers lock contention, connection errors, migration failure, and concurrent close. The paper engine rechecks known lease health after provider work, suspends settlement on loss, and still closes its server without attempting an unauthorized final ledger write. The dedicated test cluster is separate from the running research warehouse.

## Validation and next steps

The latest recorded full check passed **307 TypeScript/Vitest tests across 18 files (including four actual PostgreSQL tests) and 23 Python tests**, plus TypeScript checking. The dashboard's production build passed. Re-run relevant checks after additional code changes; do not treat these numbers as certification of the full objective.

Actual collection produced dozens of real baseline quote pairs and real horizon quotes, but **zero completed paper positions** at the last review. The Python report says `INSUFFICIENT_OUT_OF_SAMPLE_EVIDENCE` and `UNPROVEN`. Preserve that distinction. A positive quote-only round trip is not profit.

Next work should inspect actual source/process versions, verify new horizon data and replay exports, continue diagnosing coverage and protocol-label mapping from official evidence, and evaluate frozen token-disjoint strategies only when sufficient recorded data exists. Production PostgreSQL deployment, a real Yellowstone endpoint, complete risk evidence, sustained recovery/soak validation, and Stage 5 execution certification remain incomplete. The CLI must continue to refuse live trading.

Run `python research/analyze.py --output data/python-research.json` for a current read-only report. Save user-facing reports/artifacts only in the thread's `outputs` folder. Keep the full objective active until its requirement-by-requirement completion audit succeeds. Never mark success because unit tests pass or because a run is ending.

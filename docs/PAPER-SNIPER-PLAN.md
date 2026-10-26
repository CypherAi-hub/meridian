# Paper sniper research plan

Objective: develop a sniper strategy with credible positive net returns. Paper execution only. A running bot or a green test suite does not establish profitability.

## Current experiment

`paper-sniper-v1` is a separate $1,000 paper account. It evaluates pools discovered through public API polling, not first-block chain events. Each $25 entry requires a known pool age below 15 minutes, fresh observations, $35,000 liquidity, $5,000 five-minute volume, at least 60% buy share, top-ten holder share at most 35%, and known disabled mint/freeze authorities. Unknowns reject entry. These thresholds are an unvalidated hypothesis.

Decisions preserve the complete observed snapshot. A minimum two-second delay separates signal from a quote request. The entry requests exactly 25 USDC of tokens. The exit requests the actual integer token quantity received after adverse slippage. Quotes must match the requested tokens and input amount and arrive after the order is due. No mid-price fallback is allowed. Quotes are indicative; they are not evidence that a transaction would have landed.

Model: 1% adverse slippage, 0.25% additional fee and $0.02 network charge on each side. Route impact is already reflected in quote output. A +15% net take-profit, -8% net stop-loss, or five-minute holding period schedules a delayed exit. Missing routes stay open with zero conservative valuation. Fees are assumptions; failed on-chain transactions and inclusion probability are not measured because no transactions are submitted.

Three positions maximum, cash reserved for pending orders, and a $50 realized-session-loss entry gate. These controls cannot guarantee a maximum loss: liquidity can disappear, stops can gap, and existing positions remain exposed. Pausing entries requests liquidation but still needs a running worker and valid sell quotes. Stopping the collector stops exits too.

## Evidence needed to call a strategy successful

1. Reliable prospective discovery and quote coverage, with observed latency, source provenance, missing data and rejected candidates retained.
2. A frozen strategy/configuration and untouched later validation period. Do not tune thresholds using the validation results and still call them untouched.
3. Enough completed, token-distinct trades to estimate expectancy and uncertainty; 100 closes is only an initial review threshold, never an automatic profitability certificate.
4. Positive net performance after costs, with sensitivity to slower fills, larger fees, failed fills, missing exits and a few extreme losses. Include unresolved exposure and infrastructure cost.
5. Repeat the forward result in another market period; compare against simple baselines using the same discovery universe and accounting.
6. Independent review of ledger/accounting and event-time availability before any profitability claim.

## Remaining work

- Complete live smoke tests and verify ongoing public discovery, security fields and exact quote coverage.
- Add replay/export tooling and a cost/delay sensitivity evaluator without using future information.
- Add token-distinct chronological evaluation windows, baseline comparison and uncertainty estimates.
- Evaluate whether faster on-chain pool-creation detection is affordable and improves net results. Polling is not competitive first-block sniping.
- Obtain meaningful forward results, diagnose losses, and revise hypotheses with new versioned sessions. Keep failed experiments.
- Verify installation and unattended collection on the Windows PC when available.

No wallet, private key, signing, swap construction or transaction broadcast is part of the paper sniper. The paper implementation does not unlock Meridian's separate training gates.

Official quote API reference: https://developers.jup.ag/docs/api-reference/swap/v1/quote
Keyless rate-limit documentation: https://developers.jup.ag/docs/portal/setup

## Automated comparison and research

The software now runs the original strict account plus `paper-flow-10k-v1` and `paper-confirmed-10k-v1` as separate development experiments. The latter two use $10,000 minimum liquidity; the confirmed arm additionally requires an earlier observed price window. No prior book is reset. Quote capacity is reserved when experiment positions/orders exist, with exit-bearing books prioritized and equal-priority books rotated.

`GET /api/sniper?view=experiments` exports all books. `GET /api/sniper?view=coverage` reports an auditable rejection funnel and near misses from prospectively archived snapshots; older rejected snapshots are not invented. Report-time marks expire even if collection stops.

Read `SNIPER-RESEARCH-2026-10-26.md` for research-agent sources and the four-hour Codex heartbeat. This is hands-off local paper iteration while the host and app are available; it is not a guaranteed profit service. Existing modeled extra fees are additional cost stress because quote output already includes venue fees.

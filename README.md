# Meridian

Editorial paper-only research desk for Solana meme-coin tape.

Real data. Paper fills only. No wallet. No live broadcast. No autonomous trading. No ML yet.

V3.3A.2 manufactures new training-grade experience going forward. Historical sparse rows stay historical. Collection epochs isolate preview/legacy from production.

Fast path (≈3s) writes price/liquidity path samples. Slow enrichment (holders, security, Jupiter) is budgeted and prioritized. Quote-only Jupiter is PASS for paper; timeout is never a fake no-route.

`MERIDIAN_EXECUTION_MODE` is locked to `PAPER`. Production refuses PGLite as the canonical warehouse.

## Research acceptance

The Research tab exposes `/api/research?view=training-readiness`. It evaluates the full collection epoch; a healthy worker or a good recent window does not unlock training. Requirements remain 500 unique tokens, 65% HIGH/MEDIUM labels, 90% route checks frozen at decision time, 80% holder coverage at decision, 50% Grade A/B, zero detected decision-time audit violations, and 72 hours of production collection. The report additionally identifies tokens with completed v2 paths. Missing evidence fails closed.

`labels_v2` serializes fast and slow saves and recomputes outcomes from the frozen decision plus the complete observation path. Durable raw polls can recover missed v2 updates. Completed labels are immutable; historical v1 labels are not backfilled. Polling samples are observations, not proof of distinct market trades.

Training stays locked even when collection gates pass. A frozen, audited dataset, chronological token-disjoint splits, a fitted probability baseline, calibration/Brier evaluation, and shadow validation are still required. Current prediction formulas and descriptive replay reports are not trained-model results.

## Validation

- `npm ci`
- `npm run typecheck`
- `npm run test:desk`
- `node scripts/with-app-env.mjs node_modules/.bin/vite build` builds the web application without running production migrations.

GitHub Actions runs these checks on Linux. The worker deploy uses `npm run worker` and one replica. The web application is a separate Vercel build; deploying the Railway worker does not publish its UI. `npm run build` also runs database migrations and should only be used with the intended database environment.

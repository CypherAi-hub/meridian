# Omni

Solana market terminal with real pool charts, contract search, manual paper orders, and automated paper research. Formerly Meridian.

Real market data. Simulated fills only. The three automated paper experiments and the manual account keep separate balances and histories. Wallet signing and funded execution remain locked. No trained model or profitability is claimed.

Double-click `Run-Omni.cmd` on Windows after installing Node.js 22+ and Docker Desktop. Open `http://localhost:8080`. See [the Omni terminal guide](docs/OMNI-TERMINAL.md) for charts and paper orders and [Windows setup](docs/WINDOWS-SELFHOST.md) for the persistent local database.

The repository name, database, Docker project, environment variables, and older launcher filenames retain Meridian identifiers so existing installations keep their data. There is no need to rename a working installation or reset its warehouse.

The default **Live bot** screen shows persisted automatic paper decisions, current open exposure and independent strategy accounts. Its separate **On-chain pool** view shows a recent public Solana transaction-signature sample. Paper fills and blockchain transactions keep distinct labels. See [the feed contract](docs/OMNI-LIVE-API.md). Windows installations can use `Enable-Omni-Autostart.cmd` for start after user sign-in; actual Windows startup must be verified on that PC.

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

## Independent corpus audit

`/api/research?view=corpus-audit` audits a consistent read-only snapshot of the complete epoch. It refuses oversized epochs (50,000 rows or 250,000 path points) instead of silently truncating them. For an offline consistent export shaped as `{epoch, asOf, records:[{epoch, decision, outcome}]}`, run:

```
node --experimental-strip-types scripts/audit-corpus.mjs input.json new-audit.json
```

Each record must contain its immutable frozen decision and full outcome path separately. The audit independently checks the one-hour path including leading/trailing gaps, first +10%/-10% hit, source timestamps, and source values for seven explicitly listed inputs. It excludes legacy labels and never rewrites the warehouse. It emits both source and accepted-dataset SHA-256 hashes. This is a path/input audit, not complete production certification or a training authorization.

This branch adds no fitting function or model execution path. The separate preview already contains V3.4 split, embargo, grading, baseline, and model-lock modules; those must be reconciled before model work. This audit does not check Grade A/B, route coverage, or all collection gates, and its accepted rows must never be treated as a certified training set. The existing gates and 72-hour soak remain required.

## Run on your own Windows PC

See [Windows self-host instructions](docs/WINDOWS-SELFHOST.md). The Docker Compose setup runs PostgreSQL and the built web app locally, with an optional paper-only worker and persistent storage.

## Future funded-mode preparation

The local capital policy stores public payout preferences and previews distributions of net realized paper profit while protecting principal. Live actions remain locked. See [funding preparation](docs/FUTURE-FUNDING.md).

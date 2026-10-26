# PHANTOM

An additive Solana transaction observer, deterministic research engine, and paper-trading package inside Meridian. The existing Meridian/Omni application is retained. This package uses Node.js/TypeScript, official Pump SDKs, PostgreSQL-compatible persistence, Vitest, and a separate Next.js monitoring UI.

**Research software. Paper execution by default and the only execution mode wired to the CLI. No profitability claim. No wallet key is needed to run it.**

## Install and run

Use Node.js **22.12+ or 24+**, with npm. From this directory:

```sh
npm ci --ignore-scripts
cp .env.example .env
npm run paper
```

In a second terminal:

```sh
npm run dashboard
```

Open **http://127.0.0.1:8791**. The worker's read-only state API listens at **http://127.0.0.1:8790/state**. Both bind only to loopback. On Windows, `Copy-Item .env.example .env` replaces `cp`, and `./Start-Phantom.ps1 install` / `./Start-Phantom.ps1 all` support installations where Codex supplies Node and pnpm but not a standalone npm executable. The launcher starts background services with hidden windows. Starting an already occupied port does not create a second service.

Dependency install scripts are deliberately skipped. The optional `bigint-buffer` native extension is not built; its JavaScript fallback works with these SDKs. The upstream native-extension advisory remains recorded in `docs/STATUS.md`; this is not a claim that the dependency graph is production certified.

### Data connections

- **Default public RPC:** actual finalized transaction notifications and raw transaction retrieval. Subject to strict provider rate limits. A bounded processing queue, 429 backoff, reconnection, and durable backfill are implemented, but the public endpoint cannot keep up with all Pump/PumpSwap traffic. The UI reports gaps, queue depth, stale data, and degraded status. This is not first-block detection.
- **Dedicated RPC:** set `SOLANA_RPC_URL` and `SOLANA_WS_URL` in `.env`. Never paste credentials into chat or commit `.env`.
- **Yellowstone:** set `PHANTOM_SOURCE=yellowstone`, `YELLOWSTONE_ENDPOINT`, and `YELLOWSTONE_TOKEN`. The client uses finalized subscriptions and a persisted slot checkpoint with inclusive replay. If the provider cannot replay a missing interval, the connection is explicitly unsupported. A real Yellowstone provider is required to validate actual throughput and end-to-end detection latency.
- **Quotes:** `JUPITER_API_KEY` enables the current Jupiter Swap V2 quote-only API. Without it, the worker can obtain native-SOL Pump reserve quotes from actual on-chain accounts using the official SDK. Unknown, migrated, unsupported extension, cashback, or unverified routes reject. PumpSwap reserve quote math and unsigned trade builders exist, but unattended pool discovery-to-verified-state routing is not fully connected. Raydium direct execution is unsupported; its verified CPMM transactions are observable.
- **Wallet history:** bounded finalized wallet transaction reads run off the event decoder path. `PHANTOM_WALLET_HISTORY=false` disables these extra provider reads on overloaded public RPC. Missing history is not proof that wallets are independent. Shared services can be declared with `PHANTOM_SHARED_SERVICE_WALLETS=address,address`.

The dashboard keeps real external-wallet blockchain transactions separate from this bot's paper orders and fills. Every transaction row links to its actual signature. All monitoring values come from the worker. Unknown token amounts and unknown portfolio marks stay unknown.

The fast observation path decodes actual IDL/Borsh program-event bytes from finalized notifications, with successful invocation/ancestor checks. It does not guess event identities from human-readable log labels. Full transaction instruction/account validation follows asynchronously, prioritizing launches and watched tokens. The UI explicitly distinguishes typed observations awaiting full verification. A fast observation can inform research but cannot authorize a fill. Its processing timer starts at local receipt; finalized commitment includes chain-finality delay.

### Persistence

For local research, a durable PGlite warehouse is created at `PHANTOM_DATA_DIR` (default `./data/warehouse`). This is an embedded PostgreSQL-compatible development database, not a remote production PostgreSQL server.

For a deployed canonical warehouse, set `PHANTOM_DATABASE_URL` to your PostgreSQL connection string. `NODE_ENV=production` refuses embedded PGlite. Apply migrations with:

```sh
npm run migrate
```

SQL is in `migrations/0001_phantom.sql`. It stores raw transactions, idempotent decoded events, evaluation markers, decisions, paper-ledger state, replay observations, and stream cursors. A single-worker lease prevents concurrent writers: a dedicated PostgreSQL advisory-lock connection, or a local process lease before opening PGlite. Events commit before stream cursors advance. Unprocessed events are recovered on startup. Ledger state is saved after order queuing and settlement. Persistence failures suspend entries.

Stop the local worker before opening its embedded database with maintenance commands. For replay export while it is running, use its read-only `/replay` endpoint via the command below.

### Shutdown and risk controls

```sh
npm run kill
```

This creates `data/KILL`; the worker checks it again immediately before filling an entry. Protective quote-based exits remain possible. Review state before deliberately removing that file. `PHANTOM_KILL_SWITCH=true` is also supported. Database/audit failures also persist a separate suspension reason; removing a file alone does not clear that review gate. Ctrl+C stops a foreground worker and saves state. Keep the host awake using supported app/system settings. In the current Windows app, Settings > Connections > Control this PC > Keep this PC awake was already enabled; it applies while plugged in with remote access enabled. This package does not modify the operating-system power plan or install an auto-start task.

The governor enforces exact bigint lamport limits, per-trade capital limits, reserved funds, simultaneous positions, daily realized loss, drawdown, exposure, liquidity, price impact, reserve, fees, stale quotes, repeated failures, and a kill switch. Unknown safety evidence vetoes an entry. Every fill must obtain the governor's final approval. Exits have independent protective authorization so the entry kill switch cannot trap inventory. Paper orders use a minimum two-second delay and a fresh exact-size quote obtained after that delay. Venue fees are already in quote output; additional modeled network/priority expenses are charged once. They are assumptions, not measured live transaction costs.

### Replay and research

The running worker records actual quote/feature/security snapshots when enough observed evidence permits analysis. It never manufactures missing historical quotes from token prices or raw transactions.

```sh
npm run export:replay -- data/replay-input.json
npm run replay -- data/replay-input.json data/replay-report.json
```

An early export may contain zero quote snapshots because transaction schemas, data coverage, or routes remain unverified. A zero-trade report is valid missing evidence, not proof that a strategy works. The worker saves a frozen research configuration before collection begins. Replay rejects configurations frozen after the observations, future quotes, missing safety evidence, and exact-size mismatches.

For fixed-configuration token-disjoint walk-forward evaluation, add `windows: [{trainEnd: <Unix milliseconds>, testEnd: <Unix milliseconds>}, ...]` and `embargoMs` to the replay input, then run:

```sh
npm run walk-forward -- data/replay-input.json data/walk-forward-report.json
```

The library also exposes a training callback that only receives frozen earlier rows. The default CLI evaluates a fixed research configuration; it does not optimize it on the test sample. Adaptive selection remains locked unless approved configurations contain chronologically disjoint, past validation artifacts and hashes. Historical smart-wallet success is never inferred from the current token's future outcome.

The worker also samples a bounded number of actual sequential Jupiter/reserve round-trip quotes for cost research. They are observations, never fills or reported returns. Inspect them at `/quote-research` or in the dashboard. Run read-only Python analysis with:

```sh
python research/analyze.py --output data/python-research.json
python -m unittest discover -s research -p 'test_*.py'
```

The report groups realized exit legs by completed position, treats unattributed legacy records as unknown, and refuses a profitability conclusion from sparse data. Descriptive token-grouped bootstrap intervals require at least 30 completed distinct tokens and still do not replace walk-forward validation. No trading parameters are changed automatically by this analysis.

### Validation

```sh
npm test
npm run typecheck
npm run build
```

Tests cover current and official historical instruction layouts, a captured finalized mainnet transaction, malformed input, fake log attribution, failed CPIs, durable cursor boundaries, reconnection, throttling, bounded overload, wallet graph evidence, future-data exclusion, strategy decisions, token safety, governor reservations, delayed quote fills, partial exits, fees, restart recovery, replay, walk-forward partitions, and the dashboard proxy. Synthetic fixtures are labeled synthetic. Tests never load a real wallet or submit a live transaction.

See `docs/STATUS.md` for measured evidence, unsupported integrations, and remaining stages. `docs/PHANTOM-SPEC.md` preserves the full original requirements; it is not narrowed to the implemented slice. `vendor/*source.json` pins official IDL provenance. `docs/execution.md` documents the unsigned execution builders and guarded submission primitive, which is deliberately not invoked by the paper worker.

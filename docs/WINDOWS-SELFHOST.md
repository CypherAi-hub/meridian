# Run Meridian on your Windows PC

This runs the Meridian web app, PostgreSQL database, and optional research worker on your own computer. Railway, Neon, and Vercel are not required. Collection still uses outside market-data services; missing provider keys mean reduced coverage, and provider limits still apply. No paid provider credentials are bundled.

## First run

1. Install Docker Desktop with its WSL 2 Linux-container backend and Node.js 22 or newer. Complete any Windows restart Docker requests, then open Docker Desktop and wait for its engine to be ready.
2. Extract the Meridian folder somewhere permanent, such as `C:\Meridian`. Open PowerShell in that folder.
3. Double-click `Start-Meridian.cmd`, or run:

```powershell
node scripts/selfhost.mjs init
node scripts/selfhost.mjs up
```

The first build downloads dependencies and can take several minutes. Open http://localhost:8080 on the PC. `up` starts the database and interface; it does not start collection on a fresh installation. If a worker was already running, `up` leaves it running; use `pause` to stop collection.

The UI and warehouse are separate processes. The database uses a persistent Docker volume. The web app runs a built Node server, not the development preview. Database migrations finish before the interface starts.

The included `Collect-Meridian.cmd`, `Pause-Collection.cmd`, `Stop-Meridian.cmd`, and `Backup-Meridian.cmd` launch the corresponding commands without opening PowerShell manually.

## Collect continuously

```powershell
node scripts/selfhost.mjs collect
```

This starts one paper-only collector alongside the interface. It uses a 60-second universe interval, a 10-second active interval, and at most 10 active watches. These settings reduce work, but are not a hard network-usage cap. The lower sampling cadence can reduce path quality; existing research and model-readiness gates remain in force. This installation starts a new, empty warehouse; it does not import or certify old cloud data.

```powershell
node scripts/selfhost.mjs pause
node scripts/selfhost.mjs status
node scripts/selfhost.mjs logs
```

`pause` stops only collection. `status` shows containers. `logs` follows recent logs; Ctrl+C exits the log viewer without stopping containers. Log rotation limits each container to three 10 MB log files. Database storage can keep growing: monitor Docker disk use and back up regularly.

## Stop, restart, and backups

```powershell
node scripts/selfhost.mjs backup
node scripts/selfhost.mjs stop
node scripts/selfhost.mjs up
```

The database must be running for backup. A binary PostgreSQL backup is saved in `backups`. Copy backups to another drive. `stop` removes containers but retains the warehouse volume. Never use `docker compose down -v` or delete Docker's storage unless you intend to erase the database. Keep `.env.selfhost`: its randomly generated password must continue to match the existing database. Re-running `init` preserves it.

To restore a backup, start the database, pause collection, stop the web app, and restore into the existing schema:

```powershell
node scripts/selfhost.mjs pause
docker compose --env-file .env.selfhost stop web
docker compose --env-file .env.selfhost cp .\backups\YOUR-BACKUP.dump db:/tmp/meridian-restore.dump
docker compose --env-file .env.selfhost exec -T db pg_restore -U meridian -d meridian --clean --if-exists --exit-on-error /tmp/meridian-restore.dump
node scripts/selfhost.mjs up
```

Restoring replaces matching database objects and data. Take a fresh backup first. Collection remains paused until `collect` is run again.

Containers restart when Docker's engine restarts if they were left running. Enable Docker Desktop's start-at-sign-in setting if desired. This is not proof of unattended boot before Windows login. The PC must remain awake, powered, and connected to collect continuously.

## Access and provider settings

The website binds to `127.0.0.1:8080`; the database has no published port. This is a single-user local installation. The existing desk endpoints are not suitable for direct public exposure. Do not forward router ports or change the bind address to expose it publicly. Remote desktop can show the PC's local browser. Private access from another computer requires a separate access setup and verification.

Optional data-provider keys can be added under the worker service's environment in `compose.yaml` using Docker Compose interpolation, with actual values kept in `.env.selfhost`. Supported settings include `BIRDEYE_API_KEY`, `HELIUS_API_KEY`, `HELIUS_RPC_URL`, `SOLANA_RPC_URL`, and `JUPITER_API_KEY`. Do not paste credentials into source files. Leave them unset initially. Hosting locally does not eliminate third-party market-data charges if you later enable paid credentials.

The internal driver name still says `neon` in some UI/health output. This is a legacy name for the standard PostgreSQL path: in this setup the actual connection points to the `db` container on your PC.

## Troubleshooting

- Docker connection error: open Docker Desktop, verify Linux containers are enabled, and wait for the engine.
- Port 8080 in use: stop the other local service before starting Meridian.
- No live data: run `collect`, inspect logs, and check internet/provider availability. Missing holder/quote sources are not successful research evidence.
- Startup fails: run `status` and `logs`; do not erase the database volume to fix an unexplained error.

## Paper sniper experiment

The dashboard now includes a separate paper-sniper panel. Starting collection advances the experiment; it cannot submit real transactions. Its $1,000 paper balance and results are separate from Meridian's older paper book. The panel shows net equity, open/pending/closed trades, missing exit quotes and rejection reasons. Pause new entries still permits exits while the worker runs. Stopping collection stops all quote processing, including exits.

Export the current evidence and an extra-cost sensitivity review:

```powershell
node scripts/sniper-report.mjs
```

Files appear under `artifacts/paper-sniper`. See `docs/PAPER-SNIPER-PLAN.md` for the frozen hypothesis, modeled costs and evidence still required. The current implementation is unproven and does not promise positive returns.

## Future funding and earnings destination

The current release remains paper-only. Copy your separate capital-plan.json into the Meridian folder and run Configure-Payout.cmd after starting the app. The new panel displays your recipient and profit token and the requirements for a later funded release. It provides no deposit address, signing, real token conversion or transfer. See FUTURE-FUNDING.md before configuring a future funded adapter.

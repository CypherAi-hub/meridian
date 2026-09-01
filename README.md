# Meridian

**V3.2.5 — Persistent Research Engine**

An editorial, paper-only Solana meme-coin research desk. Models score. The governor decides. Nothing here places a live order.

The browser is a dashboard. A backend worker owns ingest, feature extraction, candidate consideration, frozen decision snapshots, paper fills, and outcome labeling. Closing the UI does not stop collection.

Paper only. No wallet. No autonomous strategy generation.

## What it records

Every consideration — veto, ignore, or paper take — is written once as an immutable snapshot, then labeled asynchronously:

- Horizon prices at 1m / 5m / 15m / 30m / 1h
- Max favorable / adverse excursion
- Hit +10 before −10, hit +20 before −10
- Liquidity collapse, lost sell route, rug
- Execution-adjusted hypothetical return

Labels freeze. They are never rewritten. `UNKNOWN` is not `PASS`. Pause stops new entries; labeling continues. Reset book clears paper inventory only — the research corpus stays.

Research universe is **new launch / early / emerging**. Established and mature names stay on the tape but off the candidate set.

## Stack

- TanStack Start + React 19 + Tailwind v4
- Postgres warehouse (Neon when `DATABASE_URL` is set; embedded PGLite in local preview)
- Live tape: DexScreener, GeckoTerminal, Jupiter, Solana RPC
- Auth off. Rows are unowned. Do not store personal data.

## Run locally

```bash
npm install
npm run dev
```

The desk listens on port 8080. The worker ticks on `/api/tick` (also invoked on a one-minute cron when deployed).

```bash
npm run typecheck
npm run build
```

Without `DATABASE_URL`, the warehouse is local PGLite (reset on process restart unless a snapshot dump is restored). With `DATABASE_URL`, Neon is the source of truth.

## Controls

| Action | Effect |
|---|---|
| Pause | Stop new entries. Keep labeling. |
| Reset book | Clear paper positions and cash. Keep research. |
| JSON / CSV | Export the ledger (features, provenance, gates, labels). |

There is no delete-all for the corpus.

## Honest gaps

- Holder concentration is often `UNKNOWN` (the large-account RPC method is blocked). New/early names are correctly vetoed until that is verified.
- One provider failing does not stop the tick; missing fields stay unknown.
- This is a research collector, not a live trading system.

## License

See [LICENSE](LICENSE).

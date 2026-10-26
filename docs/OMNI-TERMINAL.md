# Omni terminal

Omni is the new name and trading interface for the existing Meridian project. It remains paper-only. The existing warehouse, automatic experiments, original research desk, and future payout preferences remain intact.

## Open it

With Node.js 22+ and Docker Desktop running on Windows, double-click `Run-Omni.cmd` and open `http://localhost:8080`. This starts the built interface, PostgreSQL, and the paper worker. The older Meridian launchers remain compatible. See `WINDOWS-SELFHOST.md` for backups and updating an existing installation.

A temporary read-only remote viewer can display the same interface and data, but its order controls are disabled. Manual orders work on the local installation where the paper worker is running. A standalone preview without a worker can browse markets but cannot settle orders.

## Markets and charts

- Search a ticker or paste the full Solana mint/contract address. Ctrl+K on Windows, or Command+K on Mac, focuses search. Search results include the shortened mint to help distinguish tokens with similar names; open Solscan for the complete address.
- Select a result to open its most liquid indexed DEX Screener pool. The star manages the watchlist. Discover shows the collector's current universe, which is not a recommendation or a verified-token list.
- Charts use actual GeckoTerminal pool OHLCV data rendered with TradingView Lightweight Charts. Select 1m, 5m, 15m, 1h or 4h, switch candles/line, scroll and zoom, or expand the chart. Time axes are UTC. Volume is reported pool volume, not the bot's order size.
- Price/liquidity/pool metadata refresh about every 15 seconds, while chart history refreshes about every 30 seconds. Provider caches, indexing delays and rate limits can cause lag. These are polled public data, not a first-block feed. Some mints or pools are not indexed. Missing data stays unavailable; no synthetic candles or fabricated trade stream is added.
- DEX Screener spot prices and GeckoTerminal candles can differ because they are independently sampled. They are for watching markets; manual fills use a separate exact-size quote.

## Manual paper buys and sells

The manual account starts with 1,000 simulated USDC and stays separate from the three automated experiment accounts. Its cash, positions, orders, fills, watchlist and quote evidence persist in the local PostgreSQL database.

Buy orders accept 1–250 USDC. Sell orders accept 1–100% of an existing paper position. A token can have one pending order at a time, with at most ten positions. Pending buy amounts reserve paper cash, including modeled costs. Failed network retries reuse the request ID for the same submitted order within the current page session.

The worker waits at least two seconds and requests a fresh exact-size Jupiter indicative quote. Actual wait time can be longer because the worker and shared provider budget run on a polling schedule. Orders expire after 90 seconds without a valid quote. No chart-midpoint fallback fills are used. Unsupported mint layouts/programs are rejected.

Each side applies 1% adverse output slippage plus an additional 0.25% cost and 0.02 USDC network-cost assumption. Venue fees already reflected in a quote remain reflected there; the additional costs are conservative stress assumptions, not a promise of live fees. Partial sells allocate entry cost in proportion to the exact raw token quantity sold. Positions without a fresh full-size exit quote contribute zero to conservative account equity.

Positions, Orders, and Paper trades show the stored account activity. A paper fill is not an on-chain transaction or evidence that a real swap would succeed. The small SOL round trip used during local interface verification is manual QA activity, separate from strategy-validation results.

## Automations and future funds

Automations exposes the existing three frozen paper hypotheses. Manual orders do not become strategy-validation trades. Research retains the older diagnostics and collection-quality views.

Funding and settings displays the saved recipient and profit-token preferences from the local capital policy. This interface creates no deposit wallet and contains no signer, real swap executor, conversion, or payout sender. All funded actions remain locked. No paper result can unlock them automatically. See `FUTURE-FUNDING.md`.

## Data sources

- DEX Screener API: https://docs.dexscreener.com/api/reference
- GeckoTerminal public API: https://api.geckoterminal.com/docs/index.html
- TradingView Lightweight Charts: https://tradingview.github.io/lightweight-charts/

No paid provider subscription is required by this UI. Public service availability and usage limits still apply.

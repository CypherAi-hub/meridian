# Research-agent findings — October 26, 2026

Two read-only research agents reviewed primary papers, official protocol documentation and authors' published code. Neither ran a profitability benchmark. Source findings inform hypotheses; they are not our trading results.

## What we should test

Keep creation-stage sniping, confirmed migration continuation and early-pool momentum separate. They use different information and delays. Public minute-level pool polling cannot establish a creation-slot edge. The current desktop prototype can test early-pool hypotheses while event discovery is built and measured.

The first comparison runs three independent development accounts: the original strict launch flow ($35,000 minimum liquidity), an early-pool flow arm ($10,000 liquidity), and the same early-pool arm requiring 1–12% price growth from an observation 20–120 seconds earlier. The numbers are proposed hypotheses, not researched profitable thresholds. All require known mint behavior and retain other safety/quote gates. Results from each arm remain separate, including failed experiments. This comparison does not yet constitute a randomized control or untouched validation.

## Profitability claims need methodological checks

The academic sniper study found profitable individual operations but unsuccessful operations on average in its historical Ethereum/BSC sample. It does not establish a current Solana advantage. [Ready, Aim, Snipe](https://massimolamorgia.com/assets/pdf/Sniper_bots___CAAW_23.pdf).

Bitquery distinguishes creator-linked bundles and recurring early buyers. Valuing unsold inventory at zero materially changes its reported sniper-wallet results; wallet classification and hidden relationships limit what an outsider can infer. [First-party analysis](https://bitquery.io/investigations/pump-fun-snipers-bundles).

A 2026 graduation paper supports studying curve state and strictly-prior participant histories. Graduation is not executable net return. Its breakeven excludes fees and some successful-trader/creator labels use broader observation periods; such labels must be reconstructed using only prior information for an online system. [Paper](https://arxiv.org/html/2602.14860v1).

Published launch-study code reports negative results for 48 tested T+30-second rules in a selected segment, while disclosing sampling and decoding limitations. That does not disprove lower-latency strategies, but warns against transferring deployment-slot economics to late entrants. [Findings](https://raw.githubusercontent.com/Chrisymcsoup/solana-launch-study/main/FINDINGS.md).

A positive-looking reverse-engineering backtest uses later candle outcomes and an outcome/execution proxy, plus test-period quantiles. It is not an online executable exit model. Strictly-prior deployer cadence is a hypothesis worth testing; its reported proxy PnL is not our profit evidence. [Backtest code](https://raw.githubusercontent.com/Sorghobrayan-dotcom/solana-sniper-reverse-engineering/main/src/part3_backtest.py).

## Execution and software findings

Public Solana RPC/WebSockets are suitable for a measured prototype, with reconnect backoff, deduplication, gap reporting and confirmation handling. Shared endpoints have no production reliability guarantee. Use separate logsSubscribe filters for each program; preserve signature, slot, local receipt time and invocation attribution. [RPC limits](https://solana.com/docs/references/clusters), [logsSubscribe](https://solana.com/docs/rpc/websocket/logssubscribe).

Pump creation and migration should be decoded from official program IDLs, not log keyword matches. Completing the curve does not prove a tradable AMM exists: synthetic migration can leave an interval before migration. Measure event receipt → actual pool availability → first valid exact-size buy quote → full-position sell quote. [Pump IDL](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/pump.json), [PumpSwap IDL](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/pump_amm.json), [synthetic migration](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/docs/SYNTHETIC_MIGRATION.md).

Do not implement pool math from raw vault balances alone: PumpSwap includes signed virtual quote reserves, and fee logic can change with market cap. Use pinned official SDK/IDL logic if locally simulating a venue. [Pool math](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_SWAP_README.md), [fees](https://github.com/pump-fun/pump-public-docs/blob/main/docs/FEE_PROGRAM_README.md).

Jupiter documents 0.5 requests/second without a key. Quote output already reflects route venue fees and impact; the simulator's extra 25 bps is an additional cost assumption. Reserve quote capacity for existing experimental positions, rotate equal-priority books and report rate limits. [Access](https://developers.jup.ag/docs/portal/setup), [quote semantics](https://developers.jup.ag/docs/api-reference/swap/v1/quote).

Mint/freeze permissions alone do not cover Token-2022 behavior. Transfer hooks and permanent delegates can materially affect transfers. The first supported mint path verifies the legacy token program, initialized state and exact layout; unsupported programs/extensions remain rejected. Token-2022 support requires a separate extension audit. [Transfer hooks](https://solana.com/docs/tokens/extensions/transfer-hook), [permanent delegates](https://solana.com/docs/tokens/extensions/permanent-delegate).

Jito tips and priority fees belong in inclusion/cost stress assumptions. Its auction and submission docs do not establish that a home-PC bot wins competitive blockspace. No transaction submission was added. [Jito](https://docs.jito.wtf/lowlatencytxnsend/).

## Autonomous iteration

A Codex heartbeat named Meridian paper trading research runs every four hours on this chat. It is instructed to inspect real process state and ledgers, use up to two read-only research agents when needed, preserve prior runs, test changes, and keep new hypotheses separate from frozen validation. It uses the existing Codex account and depends on the app/host being available; the Windows Docker collector does not itself contain a standalone hosted AI service. No paid data service, new AI API key, real trading or external publishing is authorized.

The worker automatically advances the versioned paper books while Docker and the host remain running. The heartbeat stays quiet for unchanged/non-actionable state and reports material findings, improvements, losses, failures or needed user action.

Still required: event-driven discovery and gap metrics; a matched/random-entry baseline; frozen code/configuration hashes and chronological validation; after-cost confidence/stress analysis; enough prospective closed trades and multiple market periods. Do not promote a hypothesis from its development results alone.

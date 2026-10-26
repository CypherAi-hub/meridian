# PROJECT: PHANTOM — Autonomous Solana Meme Coin Sniper

You are a principal quantitative trading engineer, Solana protocol specialist, low-latency systems architect, and algorithmic trading researcher.

Your mission is to engineer **PHANTOM**, an unconventional, high-performance, autonomous Solana meme coin sniper system.

This must be a real, functional software engineering project—not a prototype full of placeholders, simulated market intelligence, or hardcoded trading signals.

## PRIMARY OBJECTIVE

Design and implement a trading system that can:

1. Discover newly created Solana meme coins in real time.
2. Detect unusual early buying activity before momentum becomes widely apparent.
3. Identify suspicious creators, coordinated wallet activity, manipulation, and rug-pull indicators.
4. Evaluate opportunities using real-time, quantitative signals.
5. Execute purchases efficiently through supported Solana protocols.
6. Automatically manage positions, take profits, and exit deteriorating trades.
7. Continuously evaluate and improve strategies using historical replay and paper-trading results.

The optimization objective is **positive net realized risk-adjusted returns after fees, slippage, failed transactions, and losses**, not maximum trade count or artificially inflated win rates.

Never claim guaranteed profitability.

## TECHNOLOGY

Use:

- TypeScript and Node.js for the primary system.
- Solana RPC and Yellowstone gRPC for blockchain data.
- Official Pump SDK and PumpSwap SDK for supported direct trading.
- Jupiter Swap API V2 for supported routed transactions.
- PostgreSQL for transaction history and performance analytics.
- Redis where useful for low-latency state and deduplication.
- Next.js for a local monitoring dashboard.
- Vitest for automated testing.

Verify current official API documentation, instruction layouts, package versions, and program addresses before implementation. Do not invent endpoints or reuse deprecated APIs.

## ENGINE 1: ULTRA-FAST LAUNCH DETECTION

Develop a continuously running service that subscribes to Solana transaction and account streams.

Detect new token creation, bonding-curve initialization, first purchases, and relevant pool creation events.

Support Pump.fun launches, PumpSwap pools, and Raydium pools through separately implemented, protocol-specific adapters.

Requirements:

- Minimize event detection latency.
- Deduplicate transactions and token events.
- Handle reconnects, dropped streams, and chain reorganizations.
- Track token creation slot and transaction signature.
- Record event receipt and processing timestamps.
- Cache frequently accessed accounts and metadata.
- Avoid slow external API requests in the critical execution path.

Use deterministic event parsing instead of guessing from transaction logs.

## ENGINE 2: UNCONVENTIONAL WALLET INTELLIGENCE

Build a wallet-analysis engine that attempts to distinguish genuine early buying activity from coordinated manipulation.

Analyze:

- Creator wallet launch history.
- Historical outcomes of previously launched tokens.
- Wallet funding relationships.
- Repeated buyer clusters.
- Holder concentration and controlled-supply estimates.
- Early independent buyer growth.
- Large-wallet accumulation and selling.
- Unusual transaction sequences.
- Changes in unique-buyer velocity.

Build a graph-based wallet relationship model.

Generate a **Cluster-Adjusted Organic Demand Score** that discounts suspected coordinated wallet activity.

Avoid assuming wallets are related solely because they purchased the same token or used the same exchange.

Use confidence levels and explainable evidence.

## ENGINE 3: MOMENTUM AND OPPORTUNITY DETECTION

Develop an event-driven statistical signal engine.

Calculate features including:

- Buy/sell volume imbalance.
- Unique buyer acceleration.
- Price velocity and acceleration.
- Bonding-curve progress.
- Liquidity and price impact.
- Net capital inflow.
- Seller concentration.
- Creator-associated wallet activity.
- Organic demand score.
- Execution cost relative to expected opportunity.

Implement multiple independent strategies:

A. **Launch Sniper** — evaluates tokens immediately after verified launch events.

B. **Momentum Breakout** — enters when independent buying pressure and liquidity strengthen.

C. **Early Reversal** — evaluates sharp early selloffs followed by measurable demand recovery.

D. **Smart Wallet Confirmation** — detects participation from historically successful wallets without blindly copying them.

E. **Adaptive Strategy Selector** — compares strategy performance across market regimes and selects among prevalidated configurations.

All strategies must generate explainable entry and rejection decisions.

Do not use future data when constructing historical signals.

## ENGINE 4: TOKEN SECURITY AND RUG DETECTION

Before any purchase, evaluate:

- Mint and freeze authorities.
- Token-2022 extension risks.
- Transfer restrictions and unexpected fees.
- Permanent delegates.
- Creator-associated token concentration.
- Known malicious program or account configurations.
- Sell-route availability.
- Liquidity accessibility.
- Abnormal creator or wallet behavior.
- Excessive price impact.

Reject tokens that violate configurable hard safety rules.

A successful sell simulation must not be treated as a guarantee of future sellability.

## ENGINE 5: HIGH-PERFORMANCE EXECUTION

Implement a reliable trade-execution system.

Use official Pump bonding-curve instructions where appropriate, including current V3 instructions when supported.

Support PumpSwap execution for migrated pools and Jupiter Swap V2 for compatible routed markets.

Implement:

- Exact integer token-amount arithmetic.
- Slippage limits.
- Priority-fee controls and maximum fee budgets.
- Transaction simulation where supported.
- Transaction signing.
- Blockhash expiration handling.
- Confirmation tracking.
- Retry and duplicate-order protection.
- Partial and failed execution reconciliation.
- Realized execution price accounting.

Measure latency across detection, analysis, transaction creation, signing, submission, and confirmation.

Never fabricate transaction success.

## ENGINE 6: AUTONOMOUS EXIT MANAGEMENT

Implement configurable position management:

- Partial profit-taking.
- Trailing-stop triggers.
- Stop-loss triggers.
- Maximum holding periods.
- Momentum deterioration exits.
- Abnormal concentrated selling detection.
- Emergency risk shutdown.
- Portfolio-level exposure limits.

Use executable sell quotes and confirmed balances rather than relying only on displayed token prices.

Model transaction fees, slippage, priority fees, and other trading expenses in P&L.

## ENGINE 7: CAPITAL PROTECTION

Implement a deterministic risk governor that has final authority over every proposed trade.

Include:

- Maximum SOL per trade.
- Maximum percentage of trading capital per trade.
- Maximum simultaneous positions.
- Daily realized-loss limit.
- Maximum portfolio drawdown.
- Liquidity and price-impact limits.
- Minimum SOL reserve for transaction expenses.
- Automatic suspension after repeated transaction failures.
- Global kill switch.

The trading strategy must never be allowed to override the risk governor.

## ENGINE 8: STRATEGY RESEARCH

Build a replay and evaluation framework that can test strategies using historical on-chain events and executable-price approximations.

Track:

- Net realized P&L.
- Win rate.
- Average winning and losing trade.
- Profit factor.
- Maximum drawdown.
- Fees and slippage.
- Entry and exit latency.
- Rejected trade outcomes.
- Performance segmented by strategy and market conditions.

Use out-of-sample and walk-forward testing to reduce overfitting.

Paper trading must use actual observable market data and realistic execution assumptions. Clearly label synthetic fixtures.

Never optimize a strategy solely on its training sample.

## ENGINE 9: OPERATIONS DASHBOARD

Create a functional monitoring dashboard showing:

- Newly detected token launches.
- Opportunity scores and rejection reasons.
- Wallet intelligence summaries.
- Active paper positions.
- Completed trades.
- Equity curve and drawdown.
- Strategy performance.
- System health and latency.
- Risk-governor decisions.

All displayed values must come from actual system state.

## IMPLEMENTATION RULES

1. Inspect the existing repository before making changes. Reuse an existing trading architecture, if one is present and suitable.
2. Implement real source files, working interfaces, database migrations, tests, and configuration.
3. Use environment variables for credentials. Never hardcode or print wallet private keys.
4. Run in **PAPER_MODE by default**.
5. Any live trading implementation must require separate explicit enablement, configuration validation, and a dedicated limited-funds wallet.
6. Do not perform live transactions during development or testing.
7. Keep AI models out of the critical execution path. Use deterministic algorithms for time-sensitive decisions; optional AI may analyze results asynchronously.
8. No wash trading, fake volume, coordinated market manipulation, or automated deceptive promotion.
9. Handle external API outages, malformed responses, rate limits, and transaction failures.
10. If an integration cannot be verified, mark it unsupported rather than presenting mocked functionality as real.

## EXECUTION PLAN

Implement the project in progressive stages:

**Stage 1:** Working Solana launch detector, real event decoding, and database persistence.

**Stage 2:** Token safety filters, wallet analysis, and quantitative signal engine.

**Stage 3:** Real-time paper execution, quote-based position management, and P&L tracking.

**Stage 4:** Historical replay, performance metrics, and a functional dashboard.

**Stage 5:** Production-hardened execution adapters, wallet security, failure recovery, and explicit live-mode safeguards.

Prioritize a completely working vertical slice over partially implementing every advanced feature.

## ACCEPTANCE CRITERIA

Before describing any feature as complete, demonstrate it through tests or verifiable runtime output.

Deliver:

- Full source code.
- Installation and configuration instructions.
- `.env.example`.
- Working paper-trading command.
- Automated unit and integration tests.
- Historical replay command.
- Database schema and migrations.
- Dashboard launch instructions.
- Measured performance metrics.
- Explicit list of incomplete features and external dependencies.

Do not stop after producing an architectural plan. Write and test the code.

**FINAL MISSION:** Build an exceptionally fast, evidence-driven Solana meme coin trading system that competes through intelligent signal selection, reliable execution, and disciplined risk management—not through blindly purchasing every new launch.

Begin by auditing the repository, verifying the current Solana and trading SDK documentation, and implementing the first working end-to-end paper-trading pipeline.
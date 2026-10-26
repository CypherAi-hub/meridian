# Future funded trading and earnings delivery

Current state: PAPER_ACTIVE_LIVE_LOCKED. Paper collection and the three experimental books continue. No wallet secret, signer, transaction builder, deposit service, token conversion or transfer executor is configured. This is preparation for future funded operation, not a live-ready custody service.

## User's selected payout behavior

The user selected 100% of distributable realized net profit to be converted into their specified Solana token, then delivered to their specified Solana recipient. The user-provided label is YN; token identity is the exact mint, not its symbol. Public addresses are stored in the local database and the separate capital-plan.json handoff. They are not hardcoded into application source or committed to Git.

The earnings recipient is not the bot's deposit address. A dedicated trading wallet must be linked and verified later. Its private key or seed phrase must not be pasted into chat or stored in the policy database. The existing paper account balances do not represent funds in either wallet.

## Import on Windows

1. Start Meridian using the existing Docker setup.
2. Place your separately supplied capital-plan.json beside the launchers.
3. Run Configure-Payout.cmd, or `node scripts/import-capital-plan.mjs capital-plan.json`.
4. Open the Future funding & profit destination panel and verify both complete addresses.

The importer preserves an existing matching policy and refuses to overwrite different destinations silently. Initial import is a policy revision recorded in the local audit table. Configuration survives container restarts through PostgreSQL. The JSON contains public preferences, not a signing key. Keep it private if you do not want to publish your association with those addresses.

## Profit planning semantics

Only net realized PnL after losses and costs is potentially distributable. Deposits, gross winning trades and unrealized inventory gains are not earnings. The planner subtracts previously distributed and reserved profit, then caps the result by free USDC above protected principal and operating reserves. Integer atomic-unit arithmetic avoids floating-point overpayment. Principal and reserves remain in the trading wallet.

The $1 minimum in the current import is a paper-planning default, not a reviewed live execution limit. Each paper book receives an independent preview; these accounts must not be combined into fictitious real funds. A preview does not reserve, swap or transfer money. The production ledger, confirmed transaction reconciliation and idempotent settlement executor still need implementation and audit before real operation.

## Required funded-mode work

- Credible positive untouched forward validation, cost/delay stress and independent accounting/execution audit.
- User-selected dedicated trading wallet, ownership proof and user-controlled signer integration.
- Confirmed deposits/principal withdrawals and cost accounting; reconcile chain state and protect against duplicate/partial settlement.
- User-approved maximum capital, exposure, daily loss, slippage, transaction fee and gas reserve limits; durable emergency stop and authenticated funded controls.
- Revalidate the exact profit mint, token program/extensions, current route and recipient on the intended network.
- Derive/verify the correct recipient associated token account for the wallet/mint/program; account for creation costs and maintain sufficient SOL for fees.
- Build, simulate, authorize and confirm an explicitly limited live execution adapter; verify transaction settlement and balances before recording a payout as complete.
- Explicit final activation. Paper metrics never activate signing, deposits or automatic transfers themselves.

Even if readiness facts are supplied as true, the current build still exposes no deposit address or enabled executor. The capital API rejects deposit, activate-live, swap, transfer, withdraw and payout actions. Policy configuration accepts PAPER only.

## Public checks

The Check public addresses action reads Solana account existence, owner/layout/initialization, mint/freeze permissions and an indicative USDC-to-mint quote. These do not prove wallet ownership, exact token name, future liquidity, successful execution or token delivery. A quote is not a transaction. Old check timestamps remain visible and do not unlock anything.

Official references: [Solana accounts](https://solana.com/docs/core/accounts), [associated token accounts](https://solana.com/docs/tokens/basics/create-token-account), [Jupiter quote semantics](https://developers.jup.ag/docs/api-reference/swap/v1/quote).

# Execution adapters and verified boundaries

Verified against the installed official packages on 2026-10-26:

- `@pump-fun/pump-sdk` 4.3.1: `getBuyExactQuoteInV3InstructionRaw`, `getSellV3InstructionRaw`, `getBuyV3TokenAmountFromQuoteAmount`, and `getSellSolAmountFromTokenAmount`.
- `@pump-fun/pump-swap-sdk` 2.2.0: exact-quote-in V2 and sell V2 instruction builders; official reserve/fee quote functions.
- Jupiter Swap V2 [`GET /order`](https://developers.jup.ag/docs/api-reference/swap/order). Omitting `taker` returns a quote without a transaction. The client never calls `/execute`. Price impact comes from the current `priceImpact` field, in percentage points; the deprecated `priceImpactPct` is not used. A provider minimum output weaker than the configured cap is rejected.
- Pump's [V3 instruction reference](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/TRADE_V3.md). V3 does not support cashback coins. These wrappers reject them and never silently switch instruction families.

## Paper quote behavior

`PumpQuoteClient` fetches the global account, dynamic fee configuration, curve, mint, and curve vault in one confirmed RPC context. It verifies owning programs and uses the SDK's integer fee calculations. Only SOL-paired curves with supported mint extensions are accepted. Migrated curves, crossing/synthetic-migration buys, cashback V3 curves, taxed/restricted base-token extensions, and missing account evidence are unsupported.

`quotePumpSwapSnapshot` takes an already verified `SwapSolanaState` from the protocol account reader. It includes dynamic fee tiers, custom creator fees, virtual quote reserves in pricing, accrued fee buckets in sell-liquidity checks, and the SDK's transfer-fee information. Only SOL pairs are enabled here. This function does not establish state provenance: its caller must verify account owners, vault mint/authority, mint extensions, and the supplied observation slot. Do not present an arbitrary object as verified on-chain state.

Both direct routes are reserve-based **paper approximations**, not transaction simulations or guarantees of execution. Current venue fees and price impact are already included in quote output. Add separate modeled network/priority expenses; do not subtract venue fees again. The paper ledger must still enforce delay, stale-quote rejection, adverse slippage, and risk checks.

## Live execution boundary

The paper CLI does not construct `GuardedLiveExecutor`. No real wallet was loaded and no live transaction was broadcast during development or testing.

The direct live primitive requires explicit LIVE mode, an enable flag, a risk acknowledgement, a matching dedicated wallet, a limited-wallet-balance cap, trade/fee/reserve limits, an instruction-program allowlist, a debit-audit callback, a mandatory risk-governor callback, and successful signed simulation. Signed bytes and their unique signature are saved before broadcast. Repeated order IDs only reconcile that signature; ambiguous submissions never create a new transaction. Unresolved debits block further orders. Blockhash expiry is recorded, and confirmed transactions are reconciled from actual native/token balance deltas, including fees on failed transactions.

Use one durable store and one executor per wallet. Deployments still need a secured signing boundary, instruction/debit auditor, RPC qualification, wallet-wide process ownership, balances and rent modeling, and operational approval before enabling live operation. The primitive is not a claim that unattended mainnet execution is certified. Jupiter managed live `/execute`, Solana transaction v1 signing, automatic replacement transactions, automatic rebroadcast, and production wallet key custody are not wired to the normal commands. They remain explicitly unsupported.

## Validation

Creator-associated supply is a strict entry gate. Production `SecurityReader` reports only directly owned/delegated creator balances and marks broader associations unverified. `checkTokenSafety` therefore vetoes entries until explicit verified association coverage and a finite associated concentration within the policy cap are supplied. A bounded graph of observed relationships cannot prove complete hidden ownership; its absence is not a zero-risk estimate. Replay preserves missing coverage as unknown and applies the same veto. Synthetic tests that exercise successful settlement explicitly supply synthetic complete coverage and are not production certifications.

Run `npm test -- test/execution.test.ts` from `packages/phantom`. Fixtures are labeled synthetic. Tests cover exact amounts beyond JavaScript's safe-integer range, malformed/outage/timeout responses, no signing or sending from the quote client, official V3 discriminator/account layouts, dynamic reserve fees and loss-making same-state round trips, account ownership checks, live safeguards, duplicate/restarted orders, ambiguous submission, expiry, risk veto, simulation failure, and confirmed accounting. These tests establish deterministic behavior; they are not evidence of live fill quality or profitability.

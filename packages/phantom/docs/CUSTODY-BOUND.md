# Conditional CPMM custody research

This component measures a possible conservative supply bound. It does not grant
entry permission, verify hidden wallet identities, change a paper ledger, or
submit a transaction. The live frozen forward cohort does not import it. A
passing arithmetic example is neither a certified pool nor a profitable trade.

The existing SecurityReader leaves creator associations unverified. Bounded
funding graphs cannot prove that unknown wallets are independent. A different
proof can conservatively assign **all supply outside defensibly excluded
custody** to the creator, without guessing wallet independence. That proof needs
an explicit policy scope and reviewed deployed-program semantics before use.

## Exact model

Use raw integers, with fixed creator cap 1,000 bps and minimum net WSOL liquidity
20,000,000,000 lamports. These limits are not parameters to fit on observed wins.

```
S = actual base mint supply
B = actual base vault amount
F = base protocol fees + fund fees + creator fees
T = B - F
D = pool.lp_supply (internal accounting denominator)
M = actual LP mint supply (all outstanding LP, regardless of holder)

maximum unpaid LP redemption = floor(T * M / D)
excluded principal lower bound C = T - floor(T * M / D)
creator-associated supply upper bound U = S - C

creator cap passes iff 10000 * U <= 1000 * S
displayed upper concentration = ceil(10000 * U / S)
net quote liquidity = quote vault amount - all three quote fee buckets
```

Require positive S and D; canonical u64 inputs; B <= S; M <= D; and each fee sum
no greater than its vault. Products use wider integers, never Number arithmetic.
Do not clamp invalid values into apparently valid evidence.

The reviewed [CPMM withdrawal implementation][withdraw] prices a redemption
against internal D and rounds reserve outputs down. After redeeming l shares,
the residual reserve is `ceil(T * (D-l) / D)`. Repeated floor-rounded withdrawals
cannot redeem more than `floor(T * M / D)` from the original state: successive
residual rounding leaves at least the corresponding aggregate residual.
The independent Python tests exhaust all ordered partitions for 810 small
reserve/share configurations (15,330 partitions).

This bound concerns **current principal claims without new consideration**.
Paid swaps, later deposits, fees, migrations, and upgrades require new evidence.
It does not mean excluded tokens can never move or that future sale is assured.

[Initialization][initialize] records D but mints D-100 LP. The never-minted 100
already appears in D-M; do not add it a second time. An actual external SPL burn
reduces M without reducing D. Sending LP to an address, locking it, farming it,
or calling a UI action "burn" does not establish a mint-supply reduction. Count
all surviving LP in M, including LP in Burn & Earn escrows. Count all fee buckets
against the creator, even when some fees actually belong to independent parties.

An internally consistent synthetic example starts with S=1,000,000,000,000,000,
B=950,000,000,000,000 and 20 SOL net quote. D is
`isqrt(B*quote)=4,358,898,943,540`; initial minted LP is D-100. Burning
4,140,953,996,263 LP leaves M=217,944,947,177. With no accrued fees, C is
902,500,000,000,000 and U/S is 9.75%. This proves the limits have a nonempty
conjunction within the reviewed model. **No actual pool satisfying it has been
observed by this component.**

For standard Pump curve examples, ordinary no-donation, negligible-rounding
invariant arithmetic is much less favorable. Initial virtual reserves 1.073*S
and 30 SOL imply roughly 42.92% sold at 20 SOL real inflow. That illustration
does not prove all possible integer histories impossible. Actual ATA custody,
reserved migration inventory, modes, fees and source/deployment proof matter.
Pump, PumpSwap, Token-2022, lock-program claims, migration transitions and custom
quote assets remain unsupported by this CPMM account checker.

## Coherent account evidence

`captureCpmmSnapshot` makes three read requests: mainnet genesis, discovery pool
account, then one finalized `getMultipleAccounts` response containing ten
accounts in fixed roles: pool, base mint, WSOL mint, LP mint, base vault, quote
vault, fee configuration, Program, ProgramData and Clock sysvar. There are no retries, signing,
ledger calls or Engine imports. A caller must use its existing read budget.

Save the complete returned capture **before** inspecting it, including missing
accounts or invalid final mappings. Retain discovery/request errors as failed
attempts in any population study; do not discard failures and report only passes.
Discovery is not the economic snapshot. The checker rederives every mapping from
the final batch. [`minContextSlot` is a lower bound][rpc], not an exact historical
bank selector. Separate responses with matching or adjacent slot labels do not
become one coherent snapshot.

The checker requires the canonical CPMM program, exact pinned account lengths and
discriminators, zero unreviewed padding, legacy SPL mints/vaults, sorted base/WSOL
pair, PDA-derived vaults/LP mint/config/authority, correct token relationships,
revoked base mint/freeze authority, expected LP mint authority, and no vault
delegate/close authority. WSOL liquidity uses the account's token amount net of
fees; rent and unsynced lamport donations do not count. New layouts fail closed.
The source lineage additionally requires D-M >=100. A paused withdrawal does
not create an LP-burn exclusion. Swap status and open time are checked separately.

Requested/received/decision times must be ordered, with at most 30 seconds from
request to decision. Recent HTTP receipt alone does not prove a recent bank.
The same-batch Clock must have the canonical sysvar owner, exact 40-byte layout
and a slot equal to the response context. Its approximate bank timestamp must
be at most 30 seconds behind, or two seconds ahead of, the decision clock.
These are explicit local acceptance tolerances, not network accuracy guarantees.
Pool opening is evaluated against that bank clock. Evidence received later
cannot certify an earlier decision.
An offline checker validates the supplied response's structure and relationships;
it does not cryptographically authenticate a provider's assertion of chain state.

## Deployed implementation remains unverified

Reviewed Rust source is [raydium-cp-swap f4b9b263][source]. The existing vendored
IDL comes from [raydium-idl e7e0c96f][idl], a different repository. An IDL or source
pin is not a reproducible deployed-byte match. The IDL also omits newer Rust
entrypoints; its usable state fields do not certify those other instructions.

`inspectCpmmProgramIdentity` checks the upgradeable loader Program pointer and
derived ProgramData address, state tags, deployment slot and authority. Deployment
must precede the economic snapshot slot. It records the raw account/payload hashes
and the [Solana Verify normalization][verify-hash]: remove the 45-byte loader-v3
metadata, trim trailing executable zero bytes, then SHA-256. Raw payload hashes
including allocated padding are kept separately.

A bounded public mainnet read on 2026-10-26 observed finalized slot 461847755,
deployment slot 452376460 and normalized executable hash
`93cad2458ac72435c94b8ac89faa686987f4e29d2f0e862d546fbc5aa814a0d2`.
This matched the [verifier service's cached hash][status]. The captured service
status was unverified and its [hash lookup][resolve] returned no matching builds.
No reviewed-source build attestation was obtained. Service build completion or a
cached hash alone would not supply that proof. The original service retrieval
timestamps were not recorded; the independent mainnet read has request/receive
timestamps and a saved raw-response digest. These are dated observations.

Consequently every snapshot result explicitly has:

```
reviewedBuildMatchVerified: false
appliedExcludedPrincipalRaw: "0"
appliedCreatorSupplyUpperRaw: S
creatorAssociationsVerified: false
tradable: false
liveApproved: false
```

Even a conditional candidate must not be fed into legacy verified-association
fields. Future integration requires a reviewed reproducible build matching the
active bytes, explicit provider provenance and freshness, and a separately
versioned policy that understands this proof scope. Continue to enforce all
other strategy, route, cost, liquidity, capital and evidence gates. Never
silently alter the active frozen research epoch to apply this component.

## Offline verification

Use Node 24, matching the PHANTOM CI and existing Pump SDK runtime. Node 22's
CommonJS named-export handling fails the existing agent-payments SDK BN import.
The pure arithmetic tests themselves can run without that SDK.

From `packages/phantom`:

```sh
npm run research:custody:test
npx vitest run test/custody-snapshot.test.ts test/security.test.ts
npm run typecheck
python3 -B -m unittest discover -s research -p test_custody_bound.py -v
python3 -B research/custody_bound.py --input saved-arithmetic-input.json
```

The Python CLI accepts only saved arithmetic input. It rejects duplicate JSON
keys, nonstandard constants, unsupported fields and malformed amounts, returning
nonzero with no success JSON. TypeScript arithmetic is independently compared
against Python on 1,536 deterministic inputs. Synthetic fixtures are labeled and
are never served as market observations or profit evidence.

The accompanying SecurityReader fix rounds creator and top-ten concentration
upward. Previously, one raw token over a limit could be floored into a passing
integer basis-point value. This correction does not verify missing associations
or relax any cap. Its source change is offline until an explicit future release.

[source]: https://github.com/raydium-io/raydium-cp-swap/tree/f4b9b26342afe9122d5ff67cd7a4f19ded4ac0a5
[withdraw]: https://github.com/raydium-io/raydium-cp-swap/blob/f4b9b26342afe9122d5ff67cd7a4f19ded4ac0a5/programs/cp-swap/src/instructions/withdraw.rs#L99
[initialize]: https://github.com/raydium-io/raydium-cp-swap/blob/f4b9b26342afe9122d5ff67cd7a4f19ded4ac0a5/programs/cp-swap/src/instructions/initialize.rs#L294
[idl]: https://github.com/raydium-io/raydium-idl/blob/e7e0c96fe77bcf6a020b84a44c47a722aac8e359/raydium_cpmm/raydium_cp_swap.json
[rpc]: https://solana.com/docs/rpc/http/getmultipleaccounts
[verify-hash]: https://github.com/solana-foundation/solana-verifiable-build/blob/26ba8211eddbfab49d30826d15a2408332b89543/src/main.rs#L768
[status]: https://verify.osec.io/status/CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C
[resolve]: https://verify.osec.io/resolve-hash/93cad2458ac72435c94b8ac89faa686987f4e29d2f0e862d546fbc5aa814a0d2

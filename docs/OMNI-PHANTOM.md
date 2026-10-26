# Omni launch engine integration

Omni's Live bot screen can read PHANTOM's actual local monitoring state. **Launch engine** presents recent chain observations, recorded decisions, paper inventory and completed positions. **Strategy books** retains the three independent Omni USDC experiments and the raw pool-signature view. The manual USDC account remains separate from both.

The launch-engine view is selected automatically after the first compatible local paper state is received. If the engine is unavailable, Omni keeps the strategy books as its default. Either view can be selected explicitly. After an established connection fails, the launch view retains its last snapshot with an explicit disconnected/stale indication. Pausing a feed freezes its rows, not the worker.

## Local connection

The browser uses **GET `/api/sniper?view=phantom`** on Omni's own origin. The server requests only **GET `http://127.0.0.1:8790/state`**, without a wallet, credential, request body or write capability. POST to this monitoring view is rejected with 405. No new PHANTOM write endpoint is added.

Run the PHANTOM paper worker and Omni on the same Windows computer. Native Node defaults need no bridge setting. With Omni in Docker Desktop and PHANTOM running on the host, the web service may set server-only `OMNI_PHANTOM_ORIGIN=http://host.docker.internal:8790`; host reachability must be tested on that installation. This does not change PHANTOM's loopback binding or expose a public port. The bridge permits only the local host names and port 8790. It refuses credentials, URL queries/fragments, other paths, HTTPS redirects and arbitrary hosts. The client cannot supply a destination URL.

The bridge has a 4.5-second request timeout, four-MiB response limit, two-second server cache and shared in-flight request. The client polls every three seconds. A dead or incompatible source produces a readable unavailable state rather than a fabricated feed. Endpoint errors do not forward provider URLs, credentials or response bodies.

`state.now` preserves the upstream clock and `state.sampledAt` records Omni's server receipt time. Failed polling never renews the last successful snapshot timestamp. Retained observations keep aging while the source is disconnected.

The root integration has no dependency on `packages/phantom` or its Node modules. Its code and dependency lifecycle remain owned by the PHANTOM package. The package can be merged beside this UI without replacing the root app, private `.env`, research data, or existing paper histories.

## Evidence and display semantics

- `application: PHANTOM` and `mode: PAPER` are required. Other modes are refused.
- Chain activity is external-wallet activity, not the bot's simulated execution. The displayed stream is a recent sample of at most 200 returned observations, not complete launch coverage.
- `TYPED_PROGRAM_EVENT` stays visibly pending full verification. A contradictory verification label with `fullTransactionVerified: false` is downgraded. Missing verification remains unknown.
- Each event links its actual signature to Solscan. Unsupported/malformed/future event rows are omitted and counted. Duplicate event IDs are collapsed.
- Quantities remain exact integer strings. Quote quantities are shown as SOL only when the quote mint is wrapped SOL. Other quote assets retain their raw units and explicit mint.
- Decisions are distinct from fills. Accepted evaluation is not an executed paper entry. Wallet-demand scores remain descriptive evidence.
- Paper inventory and completed positions belong to PHANTOM's SOL account. They are not merged with the manual USDC account or the three Omni books. Completed positions group partial exits; malformed or duplicated position groups cannot inflate the reported completed net.
- Missing completed-position evidence stays unknown. Zero is displayed only when an explicit valid empty completed list is returned. Missing/stale equity stays unavailable.
- Queue depth, coverage gaps, decode/provider errors, typed-processing p95 and full-verification p95 remain separate. Timers start at local receipt and exclude chain finality. Fast typed processing is not first-block execution.
- Only a whitelist of monitoring fields crosses the bridge. Raw credentials, configuration, transaction bytes and unreviewed upstream fields are discarded. Free-text provider URLs and labeled secrets are redacted.

The contract was implemented against published PHANTOM source and an actual redacted Windows state sample. Native end-to-end validation must use the installed Windows worker; synthetic contract fixtures are never served as a live market feed.

## Checks

`npm run test:desk` includes bridge tests for non-paper refusal, attribution, stale/unknown values, exact lamports, duplicate groups, local-only URL selection, GET-only transport, payload limits and error redaction. `npm run typecheck` and the production build cover the root integration. Native Windows launch and startup instructions are in `WINDOWS-NATIVE.md` when that launcher package is installed.

Real deposits, signing, swaps, conversions and payouts remain disabled. This monitoring integration neither authorizes trades nor modifies frozen strategy settings.

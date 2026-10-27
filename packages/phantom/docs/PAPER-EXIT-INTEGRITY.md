# Paper valuation and protective exit integrity

This change corrects three independently reproduced accounting and execution
faults. It is future source under review; the frozen forward collector is not
restarted or upgraded as part of this work.

An exact-size quote with missing or excessive price impact could previously
increase paper equity and trailing peaks even though the governor rejected that
same quote for exit settlement. Marks now require the same exit authorization
limits. An inadmissible replacement leaves valuation unknown, preserves earlier
valid peaks, and is checkpointed before optional decision logging. It never
becomes a fabricated zero-price execution or realized loss.

Emergency shutdown and maximum holding time now create durable exit intent
without requiring a current mark. The worker checkpoints all such intents in a
provider-free pass before processing any position's quote. An earlier slow
provider response cannot delay a later position's intent. Unavailable quotes
retain the original order and ready time. A pending profit slice is superseded
by a full required exit, with a new full execution delay; the superseded partial
quote cannot settle. An existing full exit retains its original delay clock.
Fresh exact-size, post-delay quotes and the governor remain mandatory for
settlement, including under the kill switch. An intent is not a fill.

Replay now records history and equity once for every observation, including
rejected fill guards, insufficient-cash entries, and unfunded exits. Unknown
inventory valuations remain visible in the equity series and its missing-value
count. A rejected settlement cannot queue a replacement on the same observation;
an unfunded exit retains its pending order.

Regressions use synthetic balances, quotes, clocks and provider failures. They
check invalid-impact peaks, durable unknown marks despite audit failures,
multi-position intent ordering, quote outage/recovery, partial-to-full escalation,
replacement rollback, original execution delays and replay bookkeeping. None of
these test returns is market evidence. Risk caps and fee budgets are unchanged.

From `packages/phantom`, run the full suite and type checker:

```powershell
node node_modules/vitest/vitest.mjs run
node node_modules/typescript/bin/tsc --noEmit
```

The real PostgreSQL suite additionally uses the documented loopback-only
`PHANTOM_TEST_DATABASE_URL` and creates/drops its own isolated UUID test database.
Never use the live paper database as a disposable test database.

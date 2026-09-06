# V3.5 Participant Intelligence + Shadow Sniper

Price is the scoreboard. Participant behavior is part of the game.

## What it is

A **SHADOW** research layer that:

- detects unusual flow / wallet / liquidity events
- promotes an instrument to high-attention observation
- freezes point-in-time participant features
- labels what happened later

A sniper activation means: **watch this more closely**. It does **not** mean BUY.

## What it is not

- not a trader
- not paper_orders / fills / positions
- not Jupiter / signing / broadcasting
- not `trainModel()`
- not a production Railway change
- not historical fake backfill of wallet "smartness"

## Point-in-time

At time T only rows with `event_time <= T` **and** `ingested_at <= T` are visible.

A wallet that becomes profitable tomorrow is UNKNOWN in today's profile.

## Modes

`SNIPER_MODE=SHADOW` or `DISABLED`. Anything else (LIVE, PAPER, AUTO, EXECUTE) fails closed.

## Replay

Warehouse events + virtual clock only. No live provider APIs.

## Next (do not auto-start)

1. Prospective participant collection on a **non-production** worker
2. Longer shadow-sniper soak
3. Participant data-quality certification
4. Hypothesis preregistration through existing PREP.3 gates
5. Only then ML evaluation — `trainModel()` still locked

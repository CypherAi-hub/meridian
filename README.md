# Meridian

Editorial paper-only research desk for Solana meme-coin tape.

Real data. Paper fills only. No wallet. No live broadcast. No autonomous trading. No ML yet.

The worker writes a durable warehouse:

- `market_observations` — what the market looked like
- `feature_vectors` — scores at that observation
- `candidate_considerations` — what a strategy thought
- `decision_snapshots` — frozen, never rewritten
- `consideration_paths` / `outcome_labels` — dense future path and 1h labels

A decision at T may only use fields with `ingested_at <= T`. Replay reconstructs that state from the raw tape so a later strategy can be scored against old observations.

## Status

V3.3 replay engine. Holder concentration is UNKNOWN without Birdeye/Helius keys; new/early names are vetoed until that is real. That is honest, not a silent pass.

## Paper only

`MERIDIAN_EXECUTION_MODE` is locked to `PAPER`.

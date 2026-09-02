# Meridian

Editorial paper-only research desk for Solana meme-coin tape.

Real data. Paper fills only. No wallet. No live broadcast. No autonomous trading. No ML yet.

The worker writes a durable warehouse:

- `market_observations` — what the market looked like, with observation fingerprints
- `token_path_samples` — shared high-resolution price/liquidity/route path (not duplicated per consideration)
- `feature_vectors` — scores at that observation
- `candidate_considerations` — what a strategy thought
- `decision_snapshots` — frozen, never rewritten
- `consideration_paths` / `outcome_labels` — dense future path and 1h labels

A decision at T may only use fields with `ingested_at <= T`. Replay reconstructs that state from the raw tape so a later strategy can be scored against old observations.

## Status

V3.3A.1 training-grade memory. Holder concentration uses Birdeye → Helius → Solana RPC → Rugcheck, then honest UNKNOWN. Quote-only Jupiter responses are PASS for paper, never a fake no-route. Research health can be DEGRADED while the worker is LIVE.

Ready for baseline ML only when GO gates pass. They currently do not.

## Paper only

`MERIDIAN_EXECUTION_MODE` is locked to `PAPER`.

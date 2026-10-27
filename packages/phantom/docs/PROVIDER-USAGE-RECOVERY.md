# Provider usage exhaustion and temporary public-source research

A bounded probe of the existing configured Helius endpoint returned HTTP 429 with the exact body `max usage reached`. This is stronger evidence than the older generic WebSocket error. No account upgrade or new subscription was performed.

The RPC lane now distinguishes that exact hard usage denial from transient 429 throttling. It latches exhaustion for that client instance, rejects queued/later calls without another provider request and pauses the owning log stream's reconnect/backfill work. Queued transaction work resolves unsuccessful; existing durable cursors and coverage gaps are retained. Normal transient 429 responses still honor the existing Retry-After cooldown. Restore provider access and deliberately restart or reconfigure the owning worker to recover; the code never clears this latch on its own or resets any paper balance. The monitoring response preserves `RPC_PROVIDER_USAGE_EXHAUSTED` even when later socket errors would otherwise obscure it.

The official public mainnet endpoint `https://api.mainnet.solana.com` and matching WebSocket endpoint passed a bounded probe: HTTP health succeeded, a finalized Pump log subscription was acknowledged and three real notifications arrived. This verifies a minimal connection, not complete coverage, sustained throughput or adequate trade latency. It is a temporary research option only. No real order is needed to read this feed. Solana explicitly warns that public RPC is rate-limited and not intended for production applications.

A source/provider transition must preserve the existing runtime directory, private credentials, warehouses, books and histories. Retire the old source epoch explicitly as INCOMPLETE using its original journal and cutoff; do not relabel old rows as observations of the replacement source or retry missing old outcomes. Label any replacement collection with its actual source and provider profile. A stale/error-free screen alone is not evidence of a viable strategy.

Official references:

- https://solana.com/docs/references/clusters
- https://www.helius.dev/pricing

The pricing page lists a Free tier with 1M monthly credits and a Developer tier at $49/month with 10M credits at the time checked. The correct account allowance and reset time must be read from the user's dashboard. No paid action is implied by those published prices or by a hardware budget.

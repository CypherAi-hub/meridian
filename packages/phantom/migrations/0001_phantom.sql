CREATE TABLE IF NOT EXISTS phantom_events (
 id TEXT PRIMARY KEY, signature TEXT NOT NULL, slot BIGINT NOT NULL,
 protocol TEXT NOT NULL, kind TEXT NOT NULL, mint TEXT NOT NULL,
 received_at BIGINT NOT NULL, processed_at BIGINT NOT NULL,
 commitment TEXT NOT NULL, orphaned BOOLEAN NOT NULL DEFAULT false, payload JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS phantom_events_mint_slot ON phantom_events(mint,slot);
CREATE INDEX IF NOT EXISTS phantom_events_received ON phantom_events(received_at DESC);
ALTER TABLE phantom_events ADD COLUMN IF NOT EXISTS evaluated BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS phantom_decisions(id BIGSERIAL PRIMARY KEY, at BIGINT NOT NULL, payload JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS phantom_state(id TEXT PRIMARY KEY, payload JSONB NOT NULL, updated_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS phantom_transactions(signature TEXT PRIMARY KEY, slot BIGINT NOT NULL, payload JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS phantom_cursor(program TEXT PRIMARY KEY, signature TEXT NOT NULL, updated_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS phantom_replay_observations(id TEXT PRIMARY KEY, at BIGINT NOT NULL, payload JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS phantom_quote_research(id TEXT PRIMARY KEY, at BIGINT NOT NULL, payload JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS phantom_observed_events(id TEXT PRIMARY KEY, signature TEXT NOT NULL, slot BIGINT NOT NULL, received_at BIGINT NOT NULL, payload JSONB NOT NULL);
CREATE INDEX IF NOT EXISTS phantom_observed_events_received ON phantom_observed_events(received_at DESC);

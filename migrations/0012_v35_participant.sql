-- V3.5 Participant Intelligence + Shadow Sniper. Additive only.
-- Not part of frozen v33b collection. Does not mutate paper/governor tables.

create table if not exists participant_events (
  id text primary key,
  instrument_id text not null,
  token_mint text,
  event_time_ms bigint not null,
  ingested_at_ms bigint not null,
  provider_id text not null,
  provider_event_id text,
  event_type text not null,
  wallet_id text not null,
  counterparty_id text,
  usd_notional double precision,
  observed_price double precision,
  transaction_signature text,
  data_status text not null,
  collection_epoch text,
  schema_version text not null,
  created_at_ms bigint not null
);
create index if not exists participant_events_instrument_time on participant_events (instrument_id, event_time_ms);
create index if not exists participant_events_wallet_time on participant_events (wallet_id, event_time_ms);
create unique index if not exists participant_events_fingerprint
  on participant_events (instrument_id, event_time_ms, wallet_id, event_type, coalesce(provider_event_id, id));

create table if not exists wallet_point_in_time_profiles (
  id text primary key,
  wallet_id text not null,
  instrument_id text,
  as_of_event_time_ms bigint not null,
  ingested_at_ms bigint not null,
  wallet_first_seen_at_ms bigint,
  wallet_age_seconds double precision,
  historical_tokens_seen int,
  historical_buy_count int,
  historical_sell_count int,
  cohort_id text not null,
  feature_version text not null,
  data_status text not null,
  provenance_json jsonb
);
create index if not exists wallet_pit_wallet_time on wallet_point_in_time_profiles (wallet_id, as_of_event_time_ms);

create table if not exists participant_feature_vectors (
  id text primary key,
  instrument_id text not null,
  feature_time_ms bigint not null,
  ingested_at_ms bigint not null,
  feature_version text not null,
  windows_json jsonb not null,
  data_status text not null,
  collection_epoch text
);
create index if not exists participant_fv_instrument_time on participant_feature_vectors (instrument_id, feature_time_ms);

create table if not exists sniper_trigger_versions (
  version text primary key,
  definition_json jsonb not null,
  created_at_ms bigint not null,
  enabled_for_shadow boolean not null default true
);

create table if not exists sniper_sessions (
  id text primary key,
  instrument_id text not null,
  token_mint text,
  trigger_version text not null,
  trigger_time_ms bigint not null,
  trigger_ingested_at_ms bigint not null,
  trigger_reason_codes jsonb not null,
  family text not null,
  session_state text not null,
  fingerprint text not null,
  priority int not null default 0,
  collection_epoch text,
  commit_sha text,
  started_at_ms bigint not null,
  ended_at_ms bigint
);
create unique index if not exists sniper_sessions_fingerprint on sniper_sessions (fingerprint);
create index if not exists sniper_sessions_instrument_time on sniper_sessions (instrument_id, trigger_time_ms);

create table if not exists sniper_snapshots (
  id text primary key,
  sniper_session_id text not null,
  instrument_id text not null,
  event_time_ms bigint not null,
  ingested_at_ms bigint not null,
  market_observation_id text,
  participant_feature_vector_id text,
  snapshot_json jsonb not null,
  snapshot_version text not null
);
create unique index if not exists sniper_snapshots_immutable on sniper_snapshots (id);

create table if not exists sniper_counterfactuals (
  id text primary key,
  sniper_session_id text not null,
  instrument_id text not null,
  reference_time_ms bigint not null,
  reference_price double precision not null,
  hypothetical_entry_basis text not null,
  execution_assumption_version text not null
);

create table if not exists sniper_outcome_labels (
  id text primary key,
  sniper_session_id text not null,
  instrument_id text not null,
  label_definition_version text not null,
  trigger_time_ms bigint not null,
  max_return_30s double precision,
  max_return_60s double precision,
  max_return_5m double precision,
  max_return_15m double precision,
  upper_10_before_lower_10 text,
  outcome_status text not null,
  completed_at_ms bigint
);

create table if not exists wallet_cohort_versions (
  version text primary key,
  definition_json jsonb not null,
  created_at_ms bigint not null
);

create table if not exists wallet_cohort_memberships (
  wallet_id text not null,
  cohort_version text not null,
  cohort_id text not null,
  effective_event_time_ms bigint not null,
  ingested_at_ms bigint not null,
  data_status text not null,
  primary key (wallet_id, cohort_version, effective_event_time_ms)
);

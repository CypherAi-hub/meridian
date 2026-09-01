-- Meridian V3.25 durable research warehouse. Additive. Do not rewrite 0002.
-- Observations stay append-only. Snapshots stay freeze-only. Labels coalesce.

create table if not exists pools (
  id bigserial primary key,
  pool_address text not null unique,
  token_mint text not null,
  dex text,
  quote_mint text,
  first_seen_at_ms bigint not null,
  created_at_ms bigint not null
);

alter table market_observations add column if not exists event_time_ms bigint;
alter table market_observations add column if not exists ingested_at_ms bigint;
alter table market_observations add column if not exists provider text;
alter table market_observations add column if not exists pool_address text;
alter table market_observations add column if not exists market_cap_usd double precision;
alter table market_observations add column if not exists fdv_usd double precision;
alter table market_observations add column if not exists volume_1m double precision;
alter table market_observations add column if not exists volume_15m double precision;
alter table market_observations add column if not exists volume_1h double precision;
alter table market_observations add column if not exists buys_1m integer;
alter table market_observations add column if not exists sells_1m integer;
alter table market_observations add column if not exists buys_5m integer;
alter table market_observations add column if not exists sells_5m integer;
alter table market_observations add column if not exists unique_buyers_5m integer;
alter table market_observations add column if not exists unique_sellers_5m integer;
alter table market_observations add column if not exists holder_count integer;
alter table market_observations add column if not exists top_10_holder_pct double precision;
alter table market_observations add column if not exists mint_authority_active boolean;
alter table market_observations add column if not exists freeze_authority_active boolean;
alter table market_observations add column if not exists jupiter_buy_route boolean;
alter table market_observations add column if not exists jupiter_sell_route boolean;
alter table market_observations add column if not exists estimated_entry_impact_bps double precision;
alter table market_observations add column if not exists estimated_exit_impact_bps double precision;

update market_observations
set
  event_time_ms = coalesce(event_time_ms, observed_at_ms),
  ingested_at_ms = coalesce(ingested_at_ms, observed_at_ms)
where event_time_ms is null or ingested_at_ms is null;

create index if not exists market_obs_event_idx on market_observations (mint, event_time_ms desc);
create index if not exists market_obs_ingested_idx on market_observations (ingested_at_ms desc);

create table if not exists feature_vectors (
  id bigserial primary key,
  observation_id bigint,
  token_mint text not null,
  event_time_ms bigint not null,
  computed_at_ms bigint not null,
  return_1m double precision,
  return_5m double precision,
  volume_accel_5m double precision,
  buy_sell_imbalance double precision,
  holder_growth_5m double precision,
  liquidity_growth_5m double precision,
  volatility_5m double precision,
  liquidity_to_mcap double precision,
  token_age_seconds bigint,
  momentum_score double precision,
  flow_score double precision,
  safety_score double precision,
  edge_score double precision,
  regime text,
  feature_sources jsonb not null default '{}'::jsonb
);
create index if not exists feature_vectors_mint_idx on feature_vectors (token_mint, event_time_ms desc);
create unique index if not exists feature_vectors_obs_idx on feature_vectors (observation_id) where observation_id is not null;

create table if not exists consideration_paths (
  id bigserial primary key,
  consideration_id text not null,
  observed_at_ms bigint not null,
  price double precision,
  liquidity double precision,
  jupiter_sell_route boolean,
  entry_quote double precision,
  exit_quote double precision,
  provider_state jsonb,
  unique (consideration_id, observed_at_ms)
);
create index if not exists consideration_paths_idx on consideration_paths (consideration_id, observed_at_ms);

create table if not exists worker_heartbeat (
  worker_name text primary key,
  last_tick_ms bigint not null,
  tick_number bigint not null default 0,
  uptime_ms bigint not null default 0,
  status text not null,
  last_tick_duration_ms integer,
  observations_written bigint not null default 0,
  considerations_written bigint not null default 0,
  considerations_dropped bigint not null default 0,
  last_error text
);

create table if not exists provider_health (
  provider text primary key,
  status text not null,
  last_success_at_ms bigint,
  last_failure_at_ms bigint,
  avg_latency_ms double precision,
  failures_last_hour integer not null default 0,
  updated_at_ms bigint not null
);

alter table candidate_considerations add column if not exists observation_id bigint;
alter table candidate_considerations add column if not exists feature_vector_id bigint;

alter table governor_gate_results add column if not exists provider text;
alter table governor_gate_results add column if not exists event_time_ms bigint;
alter table governor_gate_results add column if not exists ingested_at_ms bigint;
alter table governor_gate_results add column if not exists value jsonb;

alter table outcome_labels add column if not exists theoretical_return double precision;
alter table outcome_labels add column if not exists execution_adjusted_return double precision;
alter table outcome_labels add column if not exists mfe_1m double precision;
alter table outcome_labels add column if not exists mfe_30m double precision;
alter table outcome_labels add column if not exists mae_1m double precision;
alter table outcome_labels add column if not exists mae_30m double precision;
alter table outcome_labels add column if not exists first_sell_route_loss_at_ms bigint;
alter table outcome_labels add column if not exists sell_route_restored_at_ms bigint;
alter table outcome_labels add column if not exists completed_at_ms bigint;

alter table desk_state add column if not exists last_tick_duration_ms integer;
alter table desk_state add column if not exists observations_written bigint default 0;
alter table desk_state add column if not exists considerations_dropped bigint default 0;

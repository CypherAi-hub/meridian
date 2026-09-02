-- V3.3A.1 training-grade memory. Additive.

create table if not exists token_path_samples (
  id bigserial primary key,
  token_mint text not null,
  event_time_ms bigint not null,
  ingested_at_ms bigint not null,
  price_usd double precision,
  liquidity_usd double precision,
  sell_route_state text,
  exit_quote_out_amount numeric,
  chain_slot bigint,
  commitment text,
  provider_snapshot jsonb not null default '{}'::jsonb,
  sample_fingerprint text not null,
  created_at_ms bigint not null
);
create unique index if not exists token_path_samples_fp_idx on token_path_samples (sample_fingerprint);
create index if not exists token_path_samples_token_time_idx on token_path_samples (token_mint, event_time_ms);

alter table desk_state add column if not exists soak_started_at_ms bigint;
alter table desk_state add column if not exists code_version text;

alter table market_observations add column if not exists holder_source text;
alter table market_observations add column if not exists observation_fingerprint text;

create unique index if not exists market_obs_fingerprint_idx
  on market_observations (observation_fingerprint)
  where observation_fingerprint is not null;

alter table experiments add column if not exists status text;

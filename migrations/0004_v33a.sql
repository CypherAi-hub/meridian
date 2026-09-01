-- Meridian V3.3A coverage + high-resolution research. Additive.

create table if not exists feature_engine_versions (
  version text primary key,
  code_hash text not null,
  feature_schema jsonb not null,
  created_at_ms bigint not null
);

create table if not exists label_definition_versions (
  version text primary key,
  body jsonb not null,
  created_at_ms bigint not null
);

create table if not exists execution_assumption_versions (
  version text primary key,
  slippage_bps int not null,
  fee_bps double precision not null,
  extra_adverse_bps double precision not null,
  created_at_ms bigint not null
);

create table if not exists experiments (
  id text primary key,
  name text not null,
  experiment_type text not null,
  started_at_ms bigint not null,
  finished_at_ms bigint,
  feature_engine_version text,
  label_definition_version text,
  execution_assumption_version text,
  config jsonb not null default '{}'::jsonb,
  result_summary jsonb,
  code_version text,
  created_at_ms bigint not null
);

create table if not exists token_watch_state (
  token_mint text primary key,
  tier text not null,
  next_due_at_ms bigint not null,
  promoted_at_ms bigint,
  expires_at_ms bigint,
  reason text,
  updated_at_ms bigint not null
);

create table if not exists worker_ticks (
  tick_id text primary key,
  started_at_ms bigint not null,
  completed_at_ms bigint,
  status text not null,
  tokens_seen int not null default 0,
  observations_written int not null default 0,
  considerations_written int not null default 0,
  labels_updated int not null default 0,
  error_count int not null default 0
);

create table if not exists provider_payloads (
  id bigserial primary key,
  provider text not null,
  endpoint text not null,
  token_mint text,
  event_time_ms bigint,
  ingested_at_ms bigint not null,
  http_status int,
  latency_ms int,
  request_fingerprint text,
  payload jsonb,
  error_code text
);
create unique index if not exists provider_payloads_fp_idx on provider_payloads (request_fingerprint) where request_fingerprint is not null;

alter table market_observations add column if not exists route_status text;
alter table market_observations add column if not exists route_failure_reason text;
alter table market_observations add column if not exists route_latency_ms int;
alter table market_observations add column if not exists route_provider text;
alter table market_observations add column if not exists route_input_amount text;
alter table market_observations add column if not exists route_price_impact_bps double precision;
alter table market_observations add column if not exists top_20_holder_pct double precision;
alter table market_observations add column if not exists largest_holder_pct double precision;
alter table market_observations add column if not exists holder_status text;
alter table market_observations add column if not exists holder_provider text;
alter table market_observations add column if not exists provider_disagreement boolean;
alter table market_observations add column if not exists provider_spread_pct double precision;

alter table feature_vectors add column if not exists feature_engine_version text;
alter table feature_vectors add column if not exists feature_schema_hash text;

alter table candidate_considerations add column if not exists feature_engine_version text;
alter table candidate_considerations add column if not exists label_definition_version text;
alter table candidate_considerations add column if not exists research_quality_score double precision;
alter table candidate_considerations add column if not exists research_grade text;
alter table candidate_considerations add column if not exists veto_reason_code text;

alter table outcome_labels add column if not exists label_definition_version text;
alter table outcome_labels add column if not exists barrier_label_confidence text;
alter table outcome_labels add column if not exists barrier_10_outcome text;
alter table outcome_labels add column if not exists barrier_20_outcome text;
alter table outcome_labels add column if not exists max_path_gap_seconds double precision;
alter table outcome_labels add column if not exists avg_path_gap_seconds double precision;
alter table outcome_labels add column if not exists path_sample_count int;

create or replace function prevent_snapshot_mutation()
returns trigger as $$
begin
  raise exception 'decision_snapshots are immutable';
end;
$$ language plpgsql;

drop trigger if exists decision_snapshots_no_update on decision_snapshots;
create trigger decision_snapshots_no_update
  before update on decision_snapshots
  for each row execute function prevent_snapshot_mutation();

drop trigger if exists decision_snapshots_no_delete on decision_snapshots;
create trigger decision_snapshots_no_delete
  before delete on decision_snapshots
  for each row execute function prevent_snapshot_mutation();

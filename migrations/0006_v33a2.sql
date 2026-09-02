-- V3.3A.2 production data-quality factory. Additive. Do not rewrite historical rows.

create table if not exists collection_epochs (
  id text primary key,
  name text not null unique,
  started_at_ms bigint not null,
  ended_at_ms bigint,
  config jsonb not null default '{}'::jsonb,
  code_version text not null,
  notes text,
  created_at_ms bigint not null
);

create table if not exists warehouse_metadata (
  key text primary key,
  value jsonb not null,
  updated_at_ms bigint not null
);

create table if not exists worker_leases (
  lease_name text primary key,
  worker_instance_id text not null,
  acquired_at_ms bigint not null,
  renewed_at_ms bigint not null,
  expires_at_ms bigint not null
);

create table if not exists provider_field_comparisons (
  id bigserial primary key,
  token_mint text not null,
  field_name text not null,
  observed_at_ms bigint not null,
  provider_a text not null,
  value_a double precision,
  provider_b text not null,
  value_b double precision,
  relative_difference double precision,
  disagreement boolean not null,
  created_at_ms bigint not null
);
create index if not exists provider_field_comparisons_mint_idx
  on provider_field_comparisons (token_mint, observed_at_ms);

create table if not exists watch_execution_stats (
  id bigserial primary key,
  token_mint text not null,
  tier text not null,
  scheduled_at_ms bigint not null,
  started_at_ms bigint,
  completed_at_ms bigint,
  queue_delay_ms int,
  provider_delay_ms int,
  database_delay_ms int,
  total_delay_ms int,
  deadline_ms int not null,
  deadline_missed boolean not null,
  failure_reason text,
  created_at_ms bigint not null
);
create index if not exists watch_execution_stats_tier_time_idx
  on watch_execution_stats (tier, created_at_ms);

create table if not exists soak_incidents (
  id text primary key,
  occurred_at_ms bigint not null,
  severity text not null,
  incident_type text not null,
  duration_seconds int,
  metadata jsonb not null default '{}'::jsonb,
  resolved_at_ms bigint,
  created_at_ms bigint not null
);

create table if not exists archive_manifests (
  id text primary key,
  schema_version text not null,
  row_counts jsonb not null,
  max_timestamps jsonb not null,
  collection_epoch text,
  code_version text not null,
  checksum text not null,
  created_at_ms bigint not null
);

alter table market_observations add column if not exists collection_epoch_id text;
alter table feature_vectors add column if not exists collection_epoch_id text;
alter table candidate_considerations add column if not exists collection_epoch_id text;
alter table token_path_samples add column if not exists collection_epoch_id text;
alter table outcome_labels add column if not exists collection_epoch_id text;
alter table worker_ticks add column if not exists collection_epoch_id text;

alter table candidate_considerations add column if not exists input_quality_score double precision;
alter table candidate_considerations add column if not exists label_quality_score double precision;
alter table candidate_considerations add column if not exists research_quality_v2 double precision;
alter table candidate_considerations add column if not exists research_grade_v2 text;
alter table candidate_considerations add column if not exists holder_age_at_decision_ms bigint;
alter table candidate_considerations add column if not exists first_sample_delay_seconds double precision;

alter table outcome_labels add column if not exists sample_count int;
alter table outcome_labels add column if not exists max_gap_seconds double precision;
alter table outcome_labels add column if not exists median_gap_seconds double precision;
alter table outcome_labels add column if not exists p95_gap_seconds double precision;
alter table outcome_labels add column if not exists first_sample_delay_seconds double precision;

alter table token_watch_state add column if not exists phase text;
alter table token_watch_state add column if not exists urgency double precision;
alter table token_watch_state add column if not exists demotion_reason text;

alter table token_path_samples add column if not exists sample_kind text;

-- V3.3A.3 Neon cutover + adaptive budgets + deterministic replay runs. Additive.

create table if not exists rate_budget_snapshots (
  provider text primary key,
  rate double precision not null,
  tokens double precision not null,
  min_rate double precision not null,
  max_rate double precision not null,
  limited_until_ms bigint,
  last_429_at_ms bigint,
  last_ok_at_ms bigint,
  limited_count int not null default 0,
  taken int not null default 0,
  skipped int not null default 0,
  updated_at_ms bigint not null
);

create table if not exists replay_runs (
  id text primary key,
  tape_fingerprint text not null,
  strategy_id text not null,
  strategy_version text not null,
  from_ms bigint not null,
  to_ms bigint not null,
  step_ms bigint not null,
  observations int not null,
  unique_tokens int not null,
  considerations int not null,
  authorized int not null,
  labeled int not null,
  leakage_violations int not null,
  result_summary jsonb not null default '{}'::jsonb,
  created_at_ms bigint not null
);
create index if not exists replay_runs_fp_idx on replay_runs (tape_fingerprint, strategy_id);

alter table warehouse_metadata add column if not exists note text;

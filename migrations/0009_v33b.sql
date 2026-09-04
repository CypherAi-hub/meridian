-- V3.3B published warehouse replay experiments. Additive.

create table if not exists replay_experiments (
  id text primary key,
  name text not null,
  version text not null,
  seed int,
  tape_fingerprint text not null,
  hypothesis_index int not null,
  hypothesis_count int not null,
  live_wired boolean not null default false,
  result_summary jsonb not null default '{}'::jsonb,
  created_at_ms bigint not null
);
create index if not exists replay_experiments_fp_idx on replay_experiments (tape_fingerprint, name);

alter table replay_runs add column if not exists seed int;
alter table replay_runs add column if not exists hypothesis_index int;
alter table replay_runs add column if not exists mean_r double precision;
alter table replay_runs add column if not exists expectancy double precision;
alter table replay_runs add column if not exists profit_factor double precision;

-- V3.3A.3 additive: persist AIMD budget extras + replay vs-universe comparison.
-- Do not rewrite 0007. Preview PGLite applies this automatically; Neon via db:migrate.

alter table rate_budget_snapshots add column if not exists consecutive_ok int not null default 0;
alter table rate_budget_snapshots add column if not exists storm_count int not null default 0;

alter table replay_runs add column if not exists vs_universe_delta double precision;
alter table replay_runs add column if not exists live_wired boolean not null default false;
alter table replay_runs add column if not exists median_15m_token double precision;

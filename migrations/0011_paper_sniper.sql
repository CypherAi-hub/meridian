-- Independent, paper-only experiment. No legacy book or research labels rewritten.
create table if not exists paper_sniper_sessions (
  id text primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

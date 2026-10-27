-- Append-only observations of the existing paper engine. No historical fills are reconstructed.
create table if not exists paper_sniper_activity (
  id bigserial primary key,
  event_key text not null unique,
  session_id text not null,
  at_ms bigint not null,
  kind text not null,
  mint text,
  symbol text,
  detail jsonb not null default '{}'::jsonb,
  recorded_at timestamptz not null default now()
);
create index if not exists paper_sniper_activity_session_idx on paper_sniper_activity(session_id,id);

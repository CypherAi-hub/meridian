create table if not exists paper_sniper_quotes (
 id bigserial primary key,
 session_id text not null references paper_sniper_sessions(id),
 requested_at_ms bigint not null,
 completed_at_ms bigint not null,
 request jsonb not null,
 response jsonb,
 error text
);
create index if not exists paper_sniper_quotes_session_idx on paper_sniper_quotes(session_id,id);

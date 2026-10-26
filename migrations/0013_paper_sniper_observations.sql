-- Preserve rejected opportunities as well as selected trades. No retrospective fills.
create table if not exists paper_sniper_observations (
 id bigserial primary key,
 session_id text not null references paper_sniper_sessions(id),
 mint text not null,
 observed_at_ms bigint not null,
 snapshot jsonb not null,
 rejects jsonb not null,
 eligible boolean not null
);
create index if not exists paper_sniper_observations_session_time_idx
 on paper_sniper_observations(session_id,observed_at_ms);
create index if not exists paper_sniper_observations_mint_time_idx
 on paper_sniper_observations(session_id,mint,observed_at_ms);

create table if not exists omni_terminal_book (
 id text primary key,
 state jsonb not null,
 updated_at_ms bigint not null
);

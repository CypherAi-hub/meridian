-- V3.3B production-closure: freeze holder-at-decision onto considerations.
-- Additive. Do not rewrite historical rows.

alter table candidate_considerations add column if not exists holder_count integer;
alter table candidate_considerations add column if not exists holder_concentration double precision;
alter table candidate_considerations add column if not exists holder_status text;
alter table candidate_considerations add column if not exists holder_source text;
alter table candidate_considerations add column if not exists holder_event_time_ms bigint;
alter table candidate_considerations add column if not exists holder_ingested_at_ms bigint;

create index if not exists considerations_holder_status_idx
  on candidate_considerations (collection_epoch_id, holder_status);

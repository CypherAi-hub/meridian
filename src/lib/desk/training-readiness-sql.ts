export const TRAINING_AUDIT_SQL = `
  with audited as (
    select c.mint, o.labels_complete,
      (o.labels_complete and o.label_definition_version='labels_v2'
        and s.snapshot->>'label_definition_version'='labels_v2'
        and o.barrier_label_confidence in ('HIGH','MEDIUM')) as eligible,
      (s.snapshot is null or jsonb_typeof(s.snapshot->'feature_sources') is distinct from 'object'
        or s.snapshot->'feature_sources'='{}'::jsonb) as missing,
      (exists (
        select 1 from jsonb_each(case when jsonb_typeof(s.snapshot->'feature_sources')='object'
          then s.snapshot->'feature_sources' else '{}'::jsonb end) f
        where (f.value->>'ingestedAt')::numeric > c.decision_time_ms
           or (f.value->>'eventTime')::numeric > c.decision_time_ms
           or (f.value->>'ingestedAt')::numeric < 0
           or (f.value->>'eventTime')::numeric < 0
           or jsonb_typeof(f.value->'ingestedAt') is distinct from 'number'
           or jsonb_typeof(f.value->'eventTime') is distinct from 'number'
      ) or (
        s.snapshot->>'holder_concentration' is not null and (
          jsonb_typeof(s.snapshot->'holder_ingested_at') is distinct from 'number'
          or jsonb_typeof(s.snapshot->'holder_event_time') is distinct from 'number'
          or (s.snapshot->>'holder_ingested_at')::numeric > c.decision_time_ms
          or (s.snapshot->>'holder_event_time')::numeric > c.decision_time_ms
          or (s.snapshot->>'holder_ingested_at')::numeric < 0
          or (s.snapshot->>'holder_event_time')::numeric < 0
        )
      )) as leaked
    from candidate_considerations c
    left join decision_snapshots s using(decision_id)
    left join outcome_labels o using(decision_id)
    where c.collection_epoch_id=$1
  ) select count(*)::int as decisions,
      count(*) filter(where labels_complete)::int as completed,
      count(*) filter(where eligible and not leaked and not missing)::int as qualified,
      count(distinct mint) filter(where eligible and not leaked and not missing)::int as "qualifiedTokens",
      count(*) filter(where missing)::int as "missingSnapshots",
      count(*) filter(where leaked)::int as "leakageViolations"
    from audited`;

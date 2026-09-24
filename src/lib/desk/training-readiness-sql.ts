export const TRAINING_AUDIT_SQL = `
    select count(*)::int as decisions,
      count(*) filter(where o.labels_complete)::int as completed,
      count(*) filter(where o.labels_complete and o.label_definition_version='labels_v2'
        and s.snapshot->>'label_definition_version'='labels_v2'
        and o.barrier_label_confidence in ('HIGH','MEDIUM'))::int as qualified,
      count(distinct c.mint) filter(where o.labels_complete and o.label_definition_version='labels_v2'
        and s.snapshot->>'label_definition_version'='labels_v2'
        and o.barrier_label_confidence in ('HIGH','MEDIUM'))::int as "qualifiedTokens",
      count(*) filter(where s.snapshot is null or jsonb_typeof(s.snapshot->'feature_sources') is distinct from 'object'
        or s.snapshot->'feature_sources'='{}'::jsonb)::int as "missingSnapshots",
      count(*) filter(where exists (
        select 1 from jsonb_each(case when jsonb_typeof(s.snapshot->'feature_sources')='object'
          then s.snapshot->'feature_sources' else '{}'::jsonb end) f
        where (f.value->>'ingestedAt')::numeric > c.decision_time_ms
           or (f.value->>'eventTime')::numeric > c.decision_time_ms
           or (f.value->>'ingestedAt')::numeric < 0
           or (f.value->>'eventTime')::numeric < 0
           or jsonb_typeof(f.value->'ingestedAt') is distinct from 'number'
           or jsonb_typeof(f.value->'eventTime') is distinct from 'number'
      ))::int as "leakageViolations"
    from candidate_considerations c
    left join decision_snapshots s using(decision_id)
    left join outcome_labels o using(decision_id)
    where c.collection_epoch_id=$1`;

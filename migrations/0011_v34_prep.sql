-- V3.4 PREP intelligence tables. Additive only.
-- Does not change collection, labels, features, or the production worker hot path.
-- Training remains locked; these tables store manifests, shadow scores, and model cards.

create table if not exists dataset_manifests (
  id text primary key,
  request jsonb not null,
  row_count int not null default 0,
  unique_tokens int not null default 0,
  dropped jsonb not null default '{}'::jsonb,
  feature_engine_version text not null,
  label_definition_version text not null,
  training_allowed boolean not null default false,
  hash text not null,
  created_at_ms bigint not null
);

create table if not exists model_registry (
  model_id text not null,
  version text not null,
  feature_set text not null,
  feature_schema_hash text not null,
  training_window jsonb,
  dataset_hash text,
  metrics jsonb,
  status text not null,
  training_allowed boolean not null default false,
  created_at_ms bigint not null,
  primary key (model_id, version)
);

create table if not exists shadow_predictions (
  id bigserial primary key,
  model_id text not null,
  model_version text not null,
  decision_key text not null,
  predicted_at_ms bigint not null,
  p_up10 double precision not null,
  p_rug double precision not null,
  p_horizon_ret_positive double precision not null,
  used_for_capital boolean not null default false,
  actual_up10 smallint,
  created_at_ms bigint not null
);

create unique index if not exists shadow_predictions_model_decision
  on shadow_predictions (model_id, model_version, decision_key);

create table if not exists champion_challenger (
  seat text primary key,
  model_id text,
  version text,
  brier double precision,
  updated_at_ms bigint not null
);

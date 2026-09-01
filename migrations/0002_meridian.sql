-- Meridian V3.2.5 persistent research warehouse. Unowned (auth off).
-- Never rewrite decision_snapshots once inserted.

create table if not exists tokens (
  mint text primary key,
  symbol text not null,
  name text not null,
  decimals int not null default 6,
  pair_address text not null default '',
  created_at_ms bigint,
  last_seen_at_ms bigint not null,
  last_considered_at_ms bigint
);

create table if not exists providers (
  id text primary key,
  status text not null,
  lag_ms int,
  last_ok_at_ms bigint,
  error_count int not null default 0,
  ok_count int not null default 0,
  detail text not null default '',
  updated_at_ms bigint not null
);

create table if not exists market_observations (
  id bigserial primary key,
  mint text not null,
  observed_at_ms bigint not null,
  price double precision,
  liquidity double precision,
  volume_5m double precision,
  sell_route boolean,
  payload jsonb not null,
  unique (mint, observed_at_ms)
);
create index if not exists market_obs_mint_idx on market_observations (mint, observed_at_ms desc);

create table if not exists strategy_versions (
  version text primary key,
  body jsonb not null,
  created_at_ms bigint not null
);

create table if not exists candidate_considerations (
  decision_id text primary key,
  decision_time_ms bigint not null,
  mint text not null,
  symbol text not null,
  bucket text not null,
  regime text not null,
  strategy_id text not null,
  strategy_version text not null,
  governor_result text not null,
  trade_action text not null,
  trade_taken boolean not null,
  veto_reason text not null,
  proposed_size double precision not null,
  cooldown_key text not null,
  labels_complete boolean not null default false,
  unique (mint, strategy_version, cooldown_key)
);
create index if not exists considerations_time_idx on candidate_considerations (decision_time_ms desc);
create index if not exists considerations_pending_idx on candidate_considerations (labels_complete, decision_time_ms);

create table if not exists decision_snapshots (
  decision_id text primary key references candidate_considerations (decision_id),
  snapshot jsonb not null,
  created_at_ms bigint not null
);

create table if not exists governor_gate_results (
  id bigserial primary key,
  decision_id text not null references candidate_considerations (decision_id),
  gate_name text not null,
  status text not null,
  reason text not null
);
create index if not exists gates_decision_idx on governor_gate_results (decision_id);

create table if not exists strategy_decisions (
  decision_id text primary key references candidate_considerations (decision_id),
  matched boolean not null,
  strategy_id text not null,
  detail text not null default ''
);

create table if not exists paper_orders (
  id text primary key,
  decision_id text,
  side text not null,
  mint text not null,
  requested_notional double precision not null,
  status text not null,
  created_at_ms bigint not null
);

create table if not exists paper_fills (
  id text primary key,
  order_id text not null,
  decision_id text,
  side text not null,
  mint text not null,
  qty double precision not null,
  price double precision not null,
  notional double precision not null,
  fees double precision not null,
  impact double precision,
  slippage_bps int not null,
  provider text,
  created_at_ms bigint not null
);

create table if not exists paper_positions (
  mint text primary key,
  symbol text not null,
  strategy_id text not null,
  qty double precision not null,
  entry double precision not null,
  notional double precision not null,
  opened_at_ms bigint not null,
  peak double precision not null,
  remainder double precision not null,
  entry_impact double precision,
  exit_quote_impact double precision
);

create table if not exists portfolio_snapshots (
  id bigserial primary key,
  taken_at_ms bigint not null,
  cash double precision not null,
  equity double precision not null,
  day_pnl double precision not null,
  open_positions int not null,
  regime text not null
);

create table if not exists outcome_labels (
  decision_id text primary key references candidate_considerations (decision_id),
  path jsonb not null default '[]',
  price_after_1m double precision,
  price_after_5m double precision,
  price_after_15m double precision,
  price_after_30m double precision,
  price_after_1h double precision,
  max_gain_5m double precision,
  max_gain_15m double precision,
  max_gain_1h double precision,
  max_drawdown_5m double precision,
  max_drawdown_15m double precision,
  max_drawdown_1h double precision,
  hit_plus_10_before_minus_10 boolean,
  hit_plus_20_before_minus_10 boolean,
  liquidity_collapse boolean,
  sell_route_lost boolean,
  rug_detected boolean,
  simulated_entry double precision,
  simulated_exit double precision,
  net_execution_return double precision,
  labels_complete boolean not null default false,
  updated_at_ms bigint not null
);

create table if not exists regime_history (
  id bigserial primary key,
  at_ms bigint not null,
  regime text not null,
  p_mania double precision,
  p_trend double precision,
  p_chop double precision,
  p_risk_off double precision
);

create table if not exists system_events (
  id text primary key,
  at_ms bigint not null,
  kind text not null,
  title text not null,
  detail text not null default '',
  symbol text,
  pnl double precision
);
create index if not exists system_events_time_idx on system_events (at_ms desc);

create table if not exists desk_state (
  id int primary key default 1,
  running boolean not null default true,
  halted boolean not null default false,
  cash double precision not null,
  equity double precision not null,
  start_equity double precision not null,
  risk_bps int not null default 25,
  max_positions int not null default 4,
  slippage_bps int not null default 50,
  fills int not null default 0,
  win_count int not null default 0,
  loss_count int not null default 0,
  selected_mint text,
  worker_started_at_ms bigint,
  last_tick_at_ms bigint,
  last_market_event_at_ms bigint,
  last_error text,
  tick_count bigint not null default 0,
  pending_labels int not null default 0,
  oldest_pending_ms bigint,
  tape_json jsonb,
  journal_json jsonb,
  rejects_json jsonb,
  last_intent_json jsonb,
  last_considered_json jsonb,
  regime text not null default 'chop',
  regime_p_json jsonb,
  sol_price double precision not null default 0,
  sol_ret_5m double precision not null default 0
);

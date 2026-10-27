-- Public payout preferences only. Wallet secrets/signers do not belong here.
create table if not exists meridian_capital_policy (
 id text primary key,
 revision integer not null,
 policy jsonb not null,
 checks jsonb,
 updated_at_ms bigint not null
);
create table if not exists meridian_capital_policy_audit (
 id bigserial primary key,
 revision integer not null,
 policy jsonb not null,
 configured_at_ms bigint not null
);

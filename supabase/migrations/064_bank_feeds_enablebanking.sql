-- 064_bank_feeds_enablebanking.sql
-- Switch the bank-feed provider from GoCardless to Enable Banking (read-only AIS).
-- Additive only — the reconcile engine, RLS and the bank_transactions/match_rules tables
-- are provider-agnostic and unchanged. Enable Banking identifies a bank by the {name,country}
-- pair (no opaque institution_id) and an account by a STABLE identification_hash; the
-- per-session account handle (uid) used for data calls rotates on every re-auth, so we keep
-- gc_account_id as the stable anchor (= identification_hash) and track the live uid separately.

-- Connections: store the Enable Banking session id + the ASPSP country.
alter table public.bank_connections add column if not exists session_id text;
alter table public.bank_connections add column if not exists aspsp_country text default 'GB';

-- Accounts: account_uid = current session handle for /accounts/{uid}/* calls;
-- identification_hash = stable id (also mirrored into gc_account_id, the dedup/join anchor).
alter table public.bank_accounts add column if not exists account_uid text;
alter table public.bank_accounts add column if not exists identification_hash text;

comment on column public.bank_connections.session_id is 'Enable Banking /sessions id (re-readable/revocable).';
comment on column public.bank_connections.institution_id is 'Enable Banking ASPSP name (e.g. "Monzo"); paired with aspsp_country.';
comment on column public.bank_accounts.gc_account_id is 'Stable provider account id (Enable Banking identification_hash). Anchor for dedup + joins; survives re-auth.';
comment on column public.bank_accounts.account_uid is 'Enable Banking per-session account handle for /accounts/{uid}/* data calls; rotates on re-auth.';

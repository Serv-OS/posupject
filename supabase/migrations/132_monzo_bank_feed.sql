-- 132_monzo_bank_feed.sql (safe to run twice)
--
-- Peter, 25 Nov 2026: a live Monzo Business feed, so invoices can be matched to
-- the money that comes in and bills to the money that goes out.
--
-- 1. bank_tokens: the Monzo access and refresh tokens. A table of its own with
--    row level security on and NO policies, so only the edge functions (service
--    role) can read it. bank_connections is readable by every editor, so the
--    tokens never go there.
-- 2. bank_accounts.provider_account_id: Monzo's own account id (acc_...), so a
--    webhook can be tied to the account it is about.
-- 3. A sync every 30 minutes as a safety net. The Monzo webhook makes it live;
--    this catches anything a missed webhook would have dropped.

create table if not exists public.bank_tokens (
  connection_id uuid primary key references public.bank_connections(id) on delete cascade,
  access_token text not null,
  refresh_token text,
  expires_at timestamptz not null,
  provider_user_id text,
  updated_at timestamptz not null default now()
);
alter table public.bank_tokens enable row level security;
revoke all on public.bank_tokens from anon, authenticated;

alter table public.bank_accounts add column if not exists provider_account_id text;
create index if not exists bank_accounts_provider_account_id on public.bank_accounts (provider_account_id);

-- Money in is shown and matched now, so find unreconciled rows quickly.
create index if not exists bank_transactions_open on public.bank_transactions (reconciled, booking_date desc);

create extension if not exists pg_cron;
create extension if not exists pg_net;
do $$ begin perform cron.unschedule('bank-sync'); exception when others then null; end $$;
select cron.schedule('bank-sync', '*/30 * * * *', $$
  select net.http_post(
    url := 'https://yuevuqvldtmjwwzjrddo.supabase.co/functions/v1/bank-sync',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
$$);

-- Check: the table exists and nobody but the service role can read it.
select relname, relrowsecurity as rls_on,
       (select count(*) from pg_policies where tablename = 'bank_tokens') as policies
  from pg_class where relname = 'bank_tokens';

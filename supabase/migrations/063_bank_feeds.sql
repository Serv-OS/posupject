-- 063_bank_feeds.sql
-- Open Banking bank feeds via GoCardless Bank Account Data (read-only AIS).
-- Connections + accounts + transactions + payee->category match rules.
-- All financial data: read AND write restricted to editor/owner (reconciliation is an
-- admin/finance task, not staff self-service). Secrets (GOCARDLESS_SECRET_ID/KEY) live in
-- Edge Function env only — never in these tables or the client.

create table if not exists public.bank_connections (
  id uuid primary key default gen_random_uuid(),
  reference text unique not null,                 -- our correlation key == requisition reference
  requisition_id text,
  institution_id text not null,                   -- e.g. REVOLUT_REVOGB21
  institution_name text,
  agreement_id text,
  access_valid_days integer,
  consent_expires_at date,                        -- ~90-day PSD2 wall; warn before this
  status text not null default 'CR',              -- CR|GC|UA|SA|GA|LN|EX|RJ|SUSPENDED
  last_synced_at timestamptz,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bank_accounts (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.bank_connections(id) on delete cascade,
  gc_account_id text unique not null,             -- GoCardless account uuid
  iban text, owner_name text, currency text default 'GBP', name text,
  balance numeric, balance_at date,
  rl_remaining integer, rl_reset timestamptz,     -- transactions-scope rate-limit state
  last_synced_at timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bank_transactions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.bank_accounts(id) on delete cascade,
  gc_account_id text not null,
  dedup_key text not null,                         -- transactionId|internalTransactionId|content-hash
  status text not null default 'booked',           -- booked|pending
  booking_date date, value_date date,
  amount numeric not null,                          -- signed: negative = money out
  currency text default 'GBP',
  payee text,                                       -- creditorName/debtorName
  description text,                                 -- remittance info
  raw jsonb,
  -- reconciliation
  reconciled boolean not null default false,
  matched_type text,                               -- bill|expense|invoice|ignored
  matched_id uuid,
  category_id uuid references public.expense_categories(id) on delete set null,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (gc_account_id, dedup_key)
);
create index if not exists bank_txn_unreconciled_idx on public.bank_transactions(reconciled) where not reconciled;
create index if not exists bank_txn_account_idx on public.bank_transactions(account_id);

create table if not exists public.bank_match_rules (
  id uuid primary key default gen_random_uuid(),
  payee_pattern text not null,                      -- normalised payee substring
  supplier_id uuid references public.inv_suppliers(id) on delete set null,
  category_id uuid references public.expense_categories(id) on delete set null,
  cost_context text default 'ongoing',
  create_as text not null default 'bill',           -- bill|expense
  auto boolean not null default false,              -- auto-create vs just suggest
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- RLS: editor/owner only for everything (sensitive bank data).
do $$ declare t text;
begin
  foreach t in array array['bank_connections','bank_accounts','bank_transactions','bank_match_rules'] loop
    execute format('alter table public.%I enable row level security', t);
    begin execute format('create policy %I on public.%I for all to authenticated using (current_user_role() in (''editor'',''owner'')) with check (current_user_role() in (''editor'',''owner''))', t||'_rw', t); exception when duplicate_object then null; end;
  end loop;
end $$;

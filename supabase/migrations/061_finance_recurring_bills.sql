-- 061_finance_recurring_bills.sql
-- Phase 5: recurring supplier bills (rent, SaaS, etc). Clones recurring_invoices.
-- Generation is by the expense-recurring edge fn (daily cron) OR a user-triggered
-- "Generate due now" in the UI. Generated bills are created as 'to_pay' (never silently paid).
-- Table only here (clone-agnostic); the cron + edge-fn deploy are a separate per-clone step.

create table if not exists public.recurring_bills (
  id uuid primary key default gen_random_uuid(),
  label text,
  supplier_id uuid references public.inv_suppliers(id) on delete set null,
  category_id uuid references public.expense_categories(id) on delete set null,
  company_id uuid references public.companies(id) on delete set null,
  location_id uuid references public.locations(id) on delete set null,
  deal_id uuid references public.deals(id) on delete set null,
  cost_context text not null default 'ongoing',
  frequency text not null default 'monthly',     -- monthly | quarterly | annual
  day_of_month integer not null default 1,
  next_run date not null default current_date,
  due_days integer not null default 14,
  currency text not null default 'GBP',
  lines jsonb not null default '[]'::jsonb,       -- [{name,description,qty,unit_price,tax_rate,category_id}]
  notes text,
  active boolean not null default true,
  last_run_at timestamptz,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint recurring_bills_freq_chk check (frequency in ('monthly','quarterly','annual')),
  constraint recurring_bills_cost_chk check (cost_context in ('deal','ongoing'))
);
create index if not exists recurring_bills_next_idx on public.recurring_bills(next_run) where active;

alter table public.recurring_bills enable row level security;
do $$ begin
  begin create policy recurring_bills_read on public.recurring_bills for select to authenticated using (true); exception when duplicate_object then null; end;
  begin create policy recurring_bills_write on public.recurring_bills for all to authenticated using (current_user_role() in ('editor','owner')) with check (current_user_role() in ('editor','owner')); exception when duplicate_object then null; end;
end $$;

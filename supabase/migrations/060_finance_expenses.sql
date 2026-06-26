-- 060_finance_expenses.sql
-- Phase 4: staff expense + mileage claims with approval workflow + immutable audit log.
-- RLS is DELIBERATELY self-or-approver (NOT the house USING(true)) so staff see only
-- their own claims; editor/owner (Approver/Admin) see + manage all. profiles.id = auth.uid().

create sequence if not exists expense_number_seq start 1000;

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  expense_number integer not null default nextval('expense_number_seq'),
  type text not null default 'staff_claim',          -- staff_claim | mileage | other
  submitter_id uuid not null references public.profiles(id),
  reimburse_to_user_id uuid references public.profiles(id),   -- defaults to submitter
  category_id uuid references public.expense_categories(id) on delete set null,
  company_id uuid references public.companies(id) on delete set null,
  location_id uuid references public.locations(id) on delete set null,
  deal_id uuid references public.deals(id) on delete set null,
  cost_context text not null default 'ongoing',      -- deal | ongoing
  expense_date date not null default current_date,
  description text,
  currency text not null default 'GBP',
  subtotal numeric not null default 0,               -- net
  tax_amount numeric not null default 0,             -- VAT
  total numeric not null default 0,                  -- gross / claim amount
  vat_reclaimable boolean not null default false,
  vat_reclaim_amount numeric,
  has_vat_invoice boolean not null default false,
  -- mileage-specific (type='mileage')
  vehicle_type text,                                 -- car_van | motorcycle | bicycle
  journey_date date,
  from_location text,
  to_location text,
  purpose text,
  miles numeric,
  passengers integer not null default 0,
  ytd_miles_before numeric,                          -- snapshot of tax-year miles before this journey
  rate_pence numeric,                                -- snapshot first-tier rate used (audit)
  -- workflow
  status text not null default 'draft',              -- draft | submitted | approved | rejected | paid
  submitted_at timestamptz,
  approver_id uuid references public.profiles(id),
  approved_at timestamptz,
  rejection_reason text,
  paid_at timestamptz,
  payment_method text,
  payment_reference text,
  notes text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint expenses_type_chk check (type in ('staff_claim','mileage','other')),
  constraint expenses_status_chk check (status in ('draft','submitted','approved','rejected','paid')),
  constraint expenses_cost_context_chk check (cost_context in ('deal','ongoing'))
);
create index if not exists expenses_submitter_idx on public.expenses(submitter_id);
create index if not exists expenses_status_idx on public.expenses(status);
create index if not exists expenses_reimburse_idx on public.expenses(reimburse_to_user_id);

-- Immutable audit trail of every status transition (HMRC + trust).
create table if not exists public.expense_events (
  id uuid primary key default gen_random_uuid(),
  expense_id uuid not null references public.expenses(id) on delete cascade,
  actor_id uuid references public.profiles(id),
  from_status text,
  to_status text not null,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists expense_events_expense_idx on public.expense_events(expense_id);

alter table public.expenses enable row level security;
alter table public.expense_events enable row level security;
do $$ begin
  begin create policy expenses_read on public.expenses for select to authenticated
    using (submitter_id = auth.uid() or reimburse_to_user_id = auth.uid() or current_user_role() in ('editor','owner')); exception when duplicate_object then null; end;
  begin create policy expenses_insert on public.expenses for insert to authenticated
    with check (submitter_id = auth.uid() or current_user_role() in ('editor','owner')); exception when duplicate_object then null; end;
  begin create policy expenses_update on public.expenses for update to authenticated
    using (submitter_id = auth.uid() or current_user_role() in ('editor','owner'))
    with check (submitter_id = auth.uid() or current_user_role() in ('editor','owner')); exception when duplicate_object then null; end;
  begin create policy expenses_delete on public.expenses for delete to authenticated
    using (submitter_id = auth.uid() or current_user_role() = 'owner'); exception when duplicate_object then null; end;

  begin create policy expense_events_read on public.expense_events for select to authenticated
    using (exists (select 1 from public.expenses e where e.id = expense_id and (e.submitter_id = auth.uid() or current_user_role() in ('editor','owner')))); exception when duplicate_object then null; end;
  begin create policy expense_events_insert on public.expense_events for insert to authenticated
    with check (exists (select 1 from public.expenses e where e.id = expense_id and (e.submitter_id = auth.uid() or current_user_role() in ('editor','owner')))); exception when duplicate_object then null; end;
end $$;

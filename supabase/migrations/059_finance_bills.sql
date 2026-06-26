-- 059_finance_bills.sql
-- Phase 3: supplier bills (accounts payable), mirroring invoices. Reuses inv_suppliers
-- (extended below), companies/locations/deals, expense_categories. Idempotent.

-- Extend the shared suppliers table (reused from Inventory) with finance fields.
alter table public.inv_suppliers add column if not exists address text;
alter table public.inv_suppliers add column if not exists vat_number text;
alter table public.inv_suppliers add column if not exists payment_terms text;
alter table public.inv_suppliers add column if not exists default_category_id uuid references public.expense_categories(id) on delete set null;
alter table public.inv_suppliers add column if not exists bank_details text;             -- sensitive (§9)
alter table public.inv_suppliers add column if not exists default_currency text not null default 'GBP';
alter table public.inv_suppliers add column if not exists active boolean not null default true;

create sequence if not exists bill_number_seq start 1000;

create table if not exists public.bills (
  id uuid primary key default gen_random_uuid(),
  bill_number integer not null default nextval('bill_number_seq'),
  supplier_id uuid references public.inv_suppliers(id) on delete set null,
  category_id uuid references public.expense_categories(id) on delete set null,
  company_id uuid references public.companies(id) on delete set null,
  location_id uuid references public.locations(id) on delete set null,
  deal_id uuid references public.deals(id) on delete set null,
  cost_context text not null default 'ongoing',     -- deal | ongoing (winning/delivering vs servicing)
  status text not null default 'draft',             -- draft | to_pay | partially_paid | paid | void
  description text,
  supplier_ref text,                                -- supplier's own invoice number
  issue_date date not null default current_date,
  due_date date,
  currency text not null default 'GBP',
  subtotal numeric not null default 0,              -- net (pounds)
  tax_amount numeric not null default 0,            -- VAT charged
  total numeric not null default 0,                 -- gross
  vat_reclaimable boolean not null default true,    -- input VAT typically reclaimable?
  vat_reclaim_amount numeric,                       -- null = same as tax_amount; differs for partial/blocked
  has_vat_invoice boolean not null default false,   -- valid VAT invoice held? (HMRC reclaim condition)
  supplier_vat_number text,                         -- snapshot at entry
  amount_paid numeric not null default 0,
  paid_at timestamptz,
  payment_method text,
  payment_reference text,
  recurring_id uuid,                                -- set by Phase 5 recurring bills
  notes text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bills_cost_context_chk check (cost_context in ('deal','ongoing')),
  constraint bills_status_chk check (status in ('draft','to_pay','partially_paid','paid','void'))
);
create index if not exists bills_supplier_idx on public.bills(supplier_id);
create index if not exists bills_company_idx on public.bills(company_id);
create index if not exists bills_deal_idx on public.bills(deal_id);
create index if not exists bills_status_idx on public.bills(status);

create table if not exists public.bill_line_items (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references public.bills(id) on delete cascade,
  name text not null,
  description text,
  qty numeric not null default 1,
  unit_price numeric not null default 0,
  tax_rate numeric not null default 20,
  category_id uuid references public.expense_categories(id) on delete set null,
  line_total numeric not null default 0,
  sort integer not null default 0
);
create index if not exists bill_line_items_bill_idx on public.bill_line_items(bill_id);

-- RLS: read=authenticated; write=editor/owner (repo convention).
do $$
declare t text;
begin
  foreach t in array array['bills','bill_line_items'] loop
    execute format('alter table public.%I enable row level security', t);
    begin execute format('create policy %I on public.%I for select to authenticated using (true)', t||'_read', t); exception when duplicate_object then null; end;
    begin execute format('create policy %I on public.%I for all to authenticated using (current_user_role() in (''editor'',''owner'')) with check (current_user_role() in (''editor'',''owner''))', t||'_write', t); exception when duplicate_object then null; end;
  end loop;
end $$;

-- 058_finance_rates.sql
-- Phase 2: date-effective tax-rate tables + expense categories for the Finance module.
-- All rates VERIFIED against GOV.UK (June 2026) — source URLs commented per seed block.
-- Rates are EDITABLE config, not constants: each row has valid_from/valid_to; the app
-- resolves the row whose window contains the expense/journey date (see src/lib/rates.js).
-- Idempotent (IF NOT EXISTS + ON CONFLICT DO NOTHING). Paired rollback: 058_..._down.sql.

-- ── VAT bands ────────────────────────────────────────────────────────────────
create table if not exists public.tax_rates (
  id uuid primary key default gen_random_uuid(),
  code text not null,                       -- standard | reduced | zero | exempt | outside_scope | no_vat
  label text not null,
  rate numeric not null default 0,          -- percent, e.g. 20
  treatment text not null,                  -- standard | reduced | zero | exempt | outside_scope | no_vat
  valid_from date not null default '2011-01-04',
  valid_to date,                            -- null = currently in force
  source_url text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (code, valid_from)
);

-- Source: https://www.gov.uk/vat-rates (standard 20% since 2011-01-04; reduced 5%; zero 0%).
-- exempt/outside_scope are NOT 0% — they differ for input-tax recovery; modelled distinctly.
insert into public.tax_rates (code, label, rate, treatment, valid_from, source_url) values
  ('standard',      'Standard rate (20%)',    20, 'standard',      '2011-01-04', 'https://www.gov.uk/vat-rates'),
  ('reduced',       'Reduced rate (5%)',       5, 'reduced',       '2011-01-04', 'https://www.gov.uk/vat-rates'),
  ('zero',          'Zero rate (0%)',          0, 'zero',          '2011-01-04', 'https://www.gov.uk/vat-rates'),
  ('exempt',        'Exempt',                  0, 'exempt',        '2011-01-04', 'https://www.gov.uk/vat-rates'),
  ('outside_scope', 'Outside the scope',       0, 'outside_scope', '2011-01-04', 'https://www.gov.uk/vat-rates'),
  ('no_vat',        'No VAT',                  0, 'no_vat',        '2011-01-04', 'https://www.gov.uk/vat-rates')
on conflict (code, valid_from) do nothing;

-- ── AMAP mileage rates (employee's own vehicle), date-effective ──────────────
create table if not exists public.amap_rates (
  id uuid primary key default gen_random_uuid(),
  vehicle_type text not null,               -- car_van | motorcycle | bicycle | passenger
  tier text not null,                       -- first_10000 | above_10000 | all | per_passenger
  pence_per_mile numeric not null,
  threshold_miles integer,                  -- 10000 for car_van tiers; null otherwise
  valid_from date not null,
  valid_to date,                            -- null = in force
  source_url text,
  created_at timestamptz not null default now(),
  unique (vehicle_type, tier, valid_from)
);

-- Source: https://www.gov.uk/government/publications/rates-and-allowances-travel-mileage-and-fuel-allowances/travel-mileage-and-fuel-rates-and-allowances
-- Cars/vans first 10k: 45p to 5 Apr 2026, then 55p from 6 Apr 2026 (confirmed: gov.uk
-- 'Increasing mileage rates', pub 17 Jun 2026, retrospective to 6 Apr 2026). Over-10k 25p,
-- motorcycle 24p, bicycle 20p unchanged since 2011-04-06. Passenger +5p (gov.uk passenger-payments).
insert into public.amap_rates (vehicle_type, tier, pence_per_mile, threshold_miles, valid_from, valid_to, source_url) values
  ('car_van',    'first_10000',           45, 10000, '2011-04-06', '2026-04-05', 'https://www.gov.uk/government/publications/rates-and-allowances-travel-mileage-and-fuel-allowances/travel-mileage-and-fuel-rates-and-allowances'),
  ('car_van',    'first_10000',           55, 10000, '2026-04-06', null,         'https://www.gov.uk/government/publications/increase-to-approved-mileage-allowance-payments-amaps-and-self-employed-simplified-mileage-rates/increasing-mileage-rates'),
  ('car_van',    'above_10000',           25, 10000, '2011-04-06', null,         'https://www.gov.uk/government/publications/rates-and-allowances-travel-mileage-and-fuel-allowances/travel-mileage-and-fuel-rates-and-allowances'),
  ('motorcycle', 'all',                   24, null,  '2011-04-06', null,         'https://www.gov.uk/government/publications/rates-and-allowances-travel-mileage-and-fuel-allowances/travel-mileage-and-fuel-rates-and-allowances'),
  ('bicycle',    'all',                   20, null,  '2011-04-06', null,         'https://www.gov.uk/government/publications/rates-and-allowances-travel-mileage-and-fuel-allowances/travel-mileage-and-fuel-rates-and-allowances'),
  ('passenger',  'per_passenger',          5, null,  '2002-04-06', null,         'https://www.gov.uk/expenses-and-benefits-business-travel-mileage/passenger-payments')
on conflict (vehicle_type, tier, valid_from) do nothing;

-- ── Advisory Fuel Rates (company-car fuel element / VAT-on-mileage), quarterly ─
create table if not exists public.afr_rates (
  id uuid primary key default gen_random_uuid(),
  fuel text not null,                       -- petrol | diesel | lpg | electric
  engine_band text not null,               -- e.g. up_to_1400cc | 1401_2000cc | over_2000cc | home_charging | public_charging
  pence_per_mile numeric not null,
  valid_from date not null,
  valid_to date,
  source_url text,
  created_at timestamptz not null default now(),
  unique (fuel, engine_band, valid_from)
);

-- Source: https://www.gov.uk/guidance/advisory-fuel-rates — set 'from 1 June 2026'.
-- Changes quarterly (1 Mar/Jun/Sep/Dec); seed the next set when published. Electric is
-- split home 7p / public 15p; diesel uses different engine bands to petrol/LPG.
insert into public.afr_rates (fuel, engine_band, pence_per_mile, valid_from, source_url) values
  ('petrol',   'up_to_1400cc',    14, '2026-06-01', 'https://www.gov.uk/guidance/advisory-fuel-rates'),
  ('petrol',   '1401_2000cc',     17, '2026-06-01', 'https://www.gov.uk/guidance/advisory-fuel-rates'),
  ('petrol',   'over_2000cc',     26, '2026-06-01', 'https://www.gov.uk/guidance/advisory-fuel-rates'),
  ('lpg',      'up_to_1400cc',    11, '2026-06-01', 'https://www.gov.uk/guidance/advisory-fuel-rates'),
  ('lpg',      '1401_2000cc',     13, '2026-06-01', 'https://www.gov.uk/guidance/advisory-fuel-rates'),
  ('lpg',      'over_2000cc',     21, '2026-06-01', 'https://www.gov.uk/guidance/advisory-fuel-rates'),
  ('diesel',   'up_to_1600cc',    15, '2026-06-01', 'https://www.gov.uk/guidance/advisory-fuel-rates'),
  ('diesel',   '1601_2000cc',     17, '2026-06-01', 'https://www.gov.uk/guidance/advisory-fuel-rates'),
  ('diesel',   'over_2000cc',     23, '2026-06-01', 'https://www.gov.uk/guidance/advisory-fuel-rates'),
  ('electric', 'home_charging',    7, '2026-06-01', 'https://www.gov.uk/guidance/advisory-fuel-rates'),
  ('electric', 'public_charging', 15, '2026-06-01', 'https://www.gov.uk/guidance/advisory-fuel-rates')
on conflict (fuel, engine_band, valid_from) do nothing;

-- ── Expense categories (nominal codes + default VAT treatment), editable ──────
create table if not exists public.expense_categories (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  label text not null,
  parent_id uuid references public.expense_categories(id) on delete set null,
  vat_treatment text not null default 'standard',   -- standard | reduced | zero | exempt | no_vat
  default_tax_rate numeric,                          -- default % (null = use treatment lookup)
  reclaimable boolean not null default true,         -- is input VAT typically reclaimable?
  nominal_code text,                                 -- accounting export mapping
  sort integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Editable UK defaults. NOTE: entertainment input VAT is blocked (reclaimable=false);
-- mileage is no_vat (fuel-element VAT handled separately); insurance/bank/rent commonly exempt.
insert into public.expense_categories (code, label, vat_treatment, default_tax_rate, reclaimable, sort) values
  ('travel',         'Travel',                   'standard', 20, true,  10),
  ('subsistence',    'Subsistence',              'standard', 20, true,  20),
  ('fuel',           'Fuel',                     'standard', 20, true,  30),
  ('mileage',        'Mileage',                  'no_vat',    0, false, 40),
  ('software',       'Software & subscriptions', 'standard', 20, true,  50),
  ('professional',   'Professional fees',        'standard', 20, true,  60),
  ('office',         'Office supplies',          'standard', 20, true,  70),
  ('equipment',      'Equipment',                'standard', 20, true,  80),
  ('marketing',      'Marketing',                'standard', 20, true,  90),
  ('entertainment',  'Business entertainment',   'standard', 20, false, 100),
  ('telecoms',       'Telephone & internet',     'standard', 20, true,  110),
  ('rent',           'Rent',                     'exempt',    0, false, 120),
  ('utilities',      'Utilities',                'standard', 20, true,  130),
  ('insurance',      'Insurance',                'exempt',    0, false, 140),
  ('bank_charges',   'Bank charges',             'exempt',    0, false, 150),
  ('vehicle',        'Vehicle running costs',    'standard', 20, true,  160),
  ('other',          'Other',                    'standard', 20, true,  900)
on conflict (code) do nothing;

-- ── RLS: read = any authenticated; write = editor/owner (repo convention) ─────
do $$
declare t text;
begin
  foreach t in array array['tax_rates','amap_rates','afr_rates','expense_categories'] loop
    execute format('alter table public.%I enable row level security', t);
    begin execute format('create policy %I on public.%I for select to authenticated using (true)', t||'_read', t); exception when duplicate_object then null; end;
    begin execute format('create policy %I on public.%I for all to authenticated using (current_user_role() in (''editor'',''owner'')) with check (current_user_role() in (''editor'',''owner''))', t||'_write', t); exception when duplicate_object then null; end;
  end loop;
end $$;

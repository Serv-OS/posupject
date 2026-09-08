-- 108: card-processing cost templates, one per region.
--
-- What we PAY for card processing used to live in the code as constants
-- (BUY_PRESETS / BUY_TXN_PRESETS / CARD_SPLIT in PaymentsPanel.jsx), so
-- changing a buy cost meant a code change and a deploy, and there was no way
-- to hold a second set for the US.
--
-- A template is a region's cost base: per card type, what the transaction
-- costs us as a percentage and as a fixed fee, plus the share of volume that
-- card type usually carries. Rate cards seed their buy figures from it, then
-- the rep sets what we CHARGE on top. Margin, the customer's saving and the
-- deal's payments ARR all fall out of that.
--
-- Effective-dated on purpose: when a cost changes you add a new row rather
-- than editing the old one, so a quote priced last month still explains
-- itself. The reader takes the newest row whose effective_from has passed.
--
-- ROLLBACK: drop table public.processing_cost_templates;

create table if not exists public.processing_cost_templates (
  id             uuid primary key default gen_random_uuid(),
  region_code    text not null references public.support_regions(code) on delete cascade,
  effective_from date not null default current_date,
  -- { "<channel>_<scheme>": { buy_rate_pct, buy_txn_fee, split_pct } }
  -- e.g. { "cp_vm_debit": { "buy_rate_pct": 0.55, "buy_txn_fee": 6, "split_pct": 82 } }
  rows           jsonb not null default '{}'::jsonb,
  note           text,
  created_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  unique (region_code, effective_from)
);

create index if not exists processing_cost_templates_region_idx
  on public.processing_cost_templates (region_code, effective_from desc);

alter table public.processing_cost_templates enable row level security;

-- Same shape as the rest of the CRM: everyone signed in can read, owners and
-- editors can write. Buy rates are commercially sensitive, so anon gets nothing.
drop policy if exists cost_templates_read on public.processing_cost_templates;
create policy cost_templates_read on public.processing_cost_templates
  for select to authenticated using (true);

drop policy if exists cost_templates_write on public.processing_cost_templates;
create policy cost_templates_write on public.processing_cost_templates
  for all to authenticated
  using (public.current_user_role() in ('owner', 'editor'))
  with check (public.current_user_role() in ('owner', 'editor'));

-- Seed the UK with exactly what the code has been using, so nothing moves the
-- day this lands. The US is deliberately NOT seeded: nobody should be quoting
-- against invented US interchange. Create it in Payments once the real buy
-- rates are known, and until then US rate cards keep the current defaults.
insert into public.processing_cost_templates (region_code, effective_from, rows, note)
select 'UK', current_date, jsonb_build_object(
    'cp_vm_credit',  jsonb_build_object('buy_rate_pct', 0.65, 'buy_txn_fee', 6,  'split_pct', 15),
    'cp_vm_debit',   jsonb_build_object('buy_rate_pct', 0.55, 'buy_txn_fee', 6,  'split_pct', 82),
    'cp_amex',       jsonb_build_object('buy_rate_pct', 2.00, 'buy_txn_fee', 10, 'split_pct', 3),
    'cnp_vm_credit', jsonb_build_object('buy_rate_pct', 0.65, 'buy_txn_fee', 6,  'split_pct', 35),
    'cnp_vm_debit',  jsonb_build_object('buy_rate_pct', 0.55, 'buy_txn_fee', 6,  'split_pct', 60),
    'cnp_amex',      jsonb_build_object('buy_rate_pct', 2.00, 'buy_txn_fee', 10, 'split_pct', 5)
  ), 'Seeded from the rates the app had hardcoded. Card mix from UK Finance / BRC / Worldpay.'
where exists (select 1 from public.support_regions where code = 'UK')
  and not exists (select 1 from public.processing_cost_templates where region_code = 'UK');

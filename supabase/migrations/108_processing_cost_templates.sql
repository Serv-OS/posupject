-- 108: card-processing cost templates, one per region.
--
-- Our cost is INTERCHANGE + our acquirer's markup (0.10% + 5p at the time of
-- writing). Interchange is stored per card type because it varies by scheme,
-- card and country; the markup is stored once per template.
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
  -- Interchange per card type, which is the part that varies by scheme, card
  -- and region: { "<channel>_<scheme>": { ic_rate_pct, ic_txn_minor, split_pct } }
  -- e.g. { "cp_vm_debit": { "ic_rate_pct": 0.20, "ic_txn_minor": 0, "split_pct": 82 } }
  -- ic_txn_minor is in the region's minor unit: pence for the UK, cents for the US.
  rows           jsonb not null default '{}'::jsonb,
  -- What our acquirer adds on top of interchange, the same on every card type.
  -- { "rate_pct": 0.10, "txn_minor": 5 }  =  interchange + 0.10% + 5p
  markup         jsonb not null default '{"rate_pct": 0.10, "txn_minor": 5}'::jsonb,
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

-- Deliberately NOT seeded. The rates the app had hardcoded were not this
-- business's real costs, and interchange is not something to invent. Set both
-- regions in Card Processing, where the arithmetic is shown as you type.

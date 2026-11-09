-- 123_product_skus_bundles.sql (ADDITIVE, safe to run twice)
--
-- Products (Peter, 9 Nov 2026):
--   1. A UK SKU and a US SKU. The same item is a different part number in each
--      market. The existing sku column is the UK one.
--   2. Internal notes, staff only. Kept in their own table because products is
--      readable by the public quote pages, and a note must never reach them.
--   3. Bundles, e.g. "Kiosk - Counter mounted": a product with its own UK and
--      US price, made of parts that differ by market. A quote shows the bundle
--      as one line with its parts listed under it.

-- 1. SKUs per market, and the bundle flag.
alter table public.products
  add column if not exists sku_us    text,
  add column if not exists is_bundle boolean not null default false;
comment on column public.products.sku       is 'UK SKU.';
comment on column public.products.sku_us    is 'US SKU. Null = none set; never copied from the UK SKU.';
comment on column public.products.is_bundle is 'Made of other products (product_bundle_items). Priced on its own, not the sum of its parts.';

-- 2. Internal notes, staff only.
create table if not exists public.product_notes (
  product_id uuid primary key references public.products(id) on delete cascade,
  notes      text not null default '',
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);
comment on table public.product_notes is 'Internal notes on a product. Staff only, never shown on quotes or invoices.';

alter table public.product_notes enable row level security;
revoke all on public.product_notes from anon;
drop policy if exists product_notes_read on public.product_notes;
create policy product_notes_read on public.product_notes
  for select to authenticated using (public.current_user_role() in ('owner', 'editor', 'viewer'));
drop policy if exists product_notes_write on public.product_notes;
create policy product_notes_write on public.product_notes
  for all to authenticated
  using (public.current_user_role() in ('owner', 'editor'))
  with check (public.current_user_role() in ('owner', 'editor'));

-- 3. What a bundle is made of, per market (GBP = UK, USD = US).
create table if not exists public.product_bundle_items (
  id           uuid primary key default gen_random_uuid(),
  bundle_id    uuid not null references public.products(id) on delete cascade,
  component_id uuid not null references public.products(id) on delete restrict,
  region       text not null check (region in ('GBP', 'USD')),
  qty          integer not null default 1 check (qty > 0),
  sort         integer not null default 0,
  created_at   timestamptz not null default now(),
  check (bundle_id <> component_id),
  unique (bundle_id, region, component_id)
);
create index if not exists product_bundle_items_bundle on public.product_bundle_items (bundle_id, region, sort);
comment on table public.product_bundle_items is 'Parts of a bundle product, per market. A part cannot be deleted while a bundle uses it.';

alter table public.product_bundle_items enable row level security;
revoke all on public.product_bundle_items from anon;
drop policy if exists product_bundle_items_read on public.product_bundle_items;
create policy product_bundle_items_read on public.product_bundle_items
  for select to authenticated using (public.current_user_role() in ('owner', 'editor', 'viewer'));
drop policy if exists product_bundle_items_write on public.product_bundle_items;
create policy product_bundle_items_write on public.product_bundle_items
  for all to authenticated
  using (public.current_user_role() in ('owner', 'editor'))
  with check (public.current_user_role() in ('owner', 'editor'));

-- ROLLBACK
--   drop table public.product_bundle_items;
--   drop table public.product_notes;
--   alter table public.products drop column sku_us, drop column is_bundle;

-- 124_product_sold_separately.sql (ADDITIVE, safe to run twice)
--
-- Peter, 13 Nov 2026: some products are only parts. The Sunmi screen, stand
-- and bracket go into the kiosk bundles and are never sold on their own. A part
-- stays in stock, in purchasing and in bundles, but is not offered on quotes or
-- invoices.
alter table public.products
  add column if not exists sold_separately boolean not null default true;
comment on column public.products.sold_separately is
  'false = a part only: used in bundles and stock, never offered on quotes or invoices.';

-- ROLLBACK
--   alter table public.products drop column sold_separately;

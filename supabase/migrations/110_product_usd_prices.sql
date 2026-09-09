-- A US price is a different price, not a conversion.
--
-- The catalogue had one price column, in pounds. US quotes and invoices were
-- either copying the pound figure as if it were dollars, or (since v0.45.0)
-- landing the line at zero to be typed by hand. Items sell for more in the
-- US than the UK, so each product now carries its own dollar prices next to
-- its pound ones. A null dollar price means "not priced for the US yet", and
-- a US document must say so rather than fall back to the pound figure.
--
-- default_price / cost_price stay exactly as they are: they were always GBP.
alter table public.products
  add column if not exists default_price_usd numeric,
  add column if not exists cost_price_usd numeric;
comment on column public.products.default_price     is 'Selling price in GBP. The catalogue''s pound list price.';
comment on column public.products.default_price_usd is 'Selling price in USD. Null = not priced for the US yet; never derived from the GBP price.';
comment on column public.products.cost_price_usd    is 'Cost price in USD, for US margin. Null = unknown.';

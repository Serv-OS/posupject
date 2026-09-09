-- A product can now be priced for the US only. The pound price used to be
-- NOT NULL DEFAULT 0, so a US-only product was saved as £0 and every pound
-- document then treated it as PRICED at nothing, with no hint. Null means
-- "not priced for the UK yet", the same as the dollar column. Existing rows
-- keep their values, so UK-only products are unchanged.
alter table public.products alter column default_price drop not null;

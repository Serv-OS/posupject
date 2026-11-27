-- 136: each billing company carries its own registration (Peter, 27 Nov 2026:
-- "multi country invoices with different company details, bank details etc for
-- US and UK as they are different companies").
-- UK: company number + VAT number. US: state file number (optional) + EIN.
-- Printed under the company address on invoices, credit notes and quotes.
alter table public.support_regions add column if not exists company_number text;
alter table public.support_regions add column if not exists tax_number text;

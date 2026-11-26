-- 135_invoice_terms_per_company.sql (safe to run twice)
--
-- Peter, 25 Nov 2026: "all invoices need different footers, terms etc based
-- on which company is billing them, US or UK company". Each region (UK, US)
-- now carries its own invoice terms (with that company's bank details) and a
-- footer line (company number, VAT or EIN). The invoice currency picks the
-- company: GBP invoices use UK, USD invoices use US. Empty falls back to the
-- global settings, as the name and address already did.
alter table public.support_regions add column if not exists invoice_terms text;
alter table public.support_regions add column if not exists quote_terms text;
alter table public.support_regions add column if not exists invoice_footer text;

-- Check: both companies, what is set.
select code, currency, business_name, invoice_terms is not null as has_terms, invoice_footer
  from public.support_regions order by code;

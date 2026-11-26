-- 134_invoice_paid_into.sql (safe to run twice)
--
-- Peter, 25 Nov 2026: some ServOS customers paid into the POSUP bank account
-- (historic). "I just need a way to say this invoice was paid into the POSUP
-- account." paid_into = 'posup' marks it. Nothing else changes: the invoice is
-- still paid as normal, this only records where the money landed so it can be
-- totalled and sorted out between the companies later.
alter table public.invoices add column if not exists paid_into text;
do $$ begin
  alter table public.invoices add constraint invoices_paid_into_check check (paid_into is null or paid_into in ('posup'));
exception when duplicate_object then null; end $$;

-- Check: the column is there (0 marked so far).
select count(*) filter (where paid_into = 'posup') as paid_into_posup from public.invoices;

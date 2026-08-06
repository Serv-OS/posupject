-- 077_invoice_one_per_period_down.sql
-- Reverses 077. Dropping the column discards which period each recurring
-- invoice belongs to, so only run this if you also intend to lose that.

drop index if exists public.invoices_one_per_period;
alter table public.invoices drop column if exists recurring_period;

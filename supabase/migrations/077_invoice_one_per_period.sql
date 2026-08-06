-- 077_invoice_one_per_period.sql
-- Recurring invoices: one invoice per schedule per period, enforced by the database.
--
-- A schedule that had fallen behind was advanced by a single period on each run,
-- so it stayed due and the daily cron billed it again every morning until it
-- caught up (three duplicate drafts, 3-5 Aug 2026). invoice-recurring now
-- advances past today, and this index makes a repeat impossible even if that
-- logic is ever wrong again: the second insert fails with 23505, which the
-- function treats as "already billed for this period" and skips.
--
-- Void invoices are excluded so a period can be legitimately re-billed after a
-- mistake. Existing invoices have a null recurring_period and nulls are distinct
-- in a unique index, so history is untouched.
--
-- Already applied by hand to both live databases; idempotent, so re-running is
-- a no-op. Recorded here so the schema is reproducible.

alter table public.invoices add column if not exists recurring_period date;

create unique index if not exists invoices_one_per_period
  on public.invoices (recurring_id, recurring_period)
  where recurring_id is not null and status <> 'void';

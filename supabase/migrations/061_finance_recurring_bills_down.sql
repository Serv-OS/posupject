-- Rollback for 061_finance_recurring_bills.sql
-- (Also unschedule the cron if it was added per-clone: select cron.unschedule('expense-recurring-daily');)
drop table if exists public.recurring_bills cascade;

-- Rollback for 060_finance_expenses.sql
drop table if exists public.expense_events cascade;
drop table if exists public.expenses cascade;
drop sequence if exists expense_number_seq;

-- Rollback for 058_finance_rates.sql
drop table if exists public.expense_categories cascade;
drop table if exists public.afr_rates cascade;
drop table if exists public.amap_rates cascade;
drop table if exists public.tax_rates cascade;

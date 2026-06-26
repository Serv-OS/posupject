-- Rollback for 059_finance_bills.sql
drop table if exists public.bill_line_items cascade;
drop table if exists public.bills cascade;
drop sequence if exists bill_number_seq;
alter table public.inv_suppliers drop column if exists address;
alter table public.inv_suppliers drop column if exists vat_number;
alter table public.inv_suppliers drop column if exists payment_terms;
alter table public.inv_suppliers drop column if exists default_category_id;
alter table public.inv_suppliers drop column if exists bank_details;
alter table public.inv_suppliers drop column if exists default_currency;
alter table public.inv_suppliers drop column if exists active;

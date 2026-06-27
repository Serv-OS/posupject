-- Rollback for 063_bank_feeds.sql
drop table if exists public.bank_match_rules cascade;
drop table if exists public.bank_transactions cascade;
drop table if exists public.bank_accounts cascade;
drop table if exists public.bank_connections cascade;

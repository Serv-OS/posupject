-- 057_finance_foundations.sql
-- Phase 1 foundations for the Finance module (Expenses / Bills / Mileage / VAT reclaim).
-- ADDITIVE ONLY — no existing table is altered in a breaking way, no data is touched.
-- See EXPENSES_PLAN.md and TAX_NOTES.md.
--
-- Reversibility: this repo has no down-migration tooling, so a paired rollback lives
-- in 057_finance_foundations_down.sql. Apply forward files via the Supabase Management API.

-- Per-deployment tax regime flag. NULL = no special tax handling (default; non-UK clones).
-- The UK VAT-registered deployments (posupcrm, posupject) are set to 'UK_VAT' by a
-- separate per-deployment data step (NOT hardcoded here, so this migration stays safe to
-- run on non-UK clones like the USD instance).
alter table public.support_settings add column if not exists tax_regime text;

-- Expose tax_regime through the public_branding view so the SPA can gate UK-only
-- features (VAT reclaim, MTD export) at load time. CREATE OR REPLACE only appends a
-- trailing column, preserving the existing view shape.
create or replace view public.public_branding as
  select logo_url, logo_url_dark, app_name, business_name, primary_color, secondary_color, tax_regime
  from public.support_settings
  where id = 1;

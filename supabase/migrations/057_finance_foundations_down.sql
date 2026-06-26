-- Rollback for 057_finance_foundations.sql
-- Restores public_branding to its pre-057 shape, then drops the tax_regime column.

create or replace view public.public_branding as
  select logo_url, logo_url_dark, app_name, business_name, primary_color, secondary_color
  from public.support_settings
  where id = 1;

alter table public.support_settings drop column if exists tax_regime;

-- 071_location_company_optional.sql (ADDITIVE) — allow a location to be unlinked
-- from its company (ownership change). company_id becomes optional; no data change.
alter table public.locations alter column company_id drop not null;

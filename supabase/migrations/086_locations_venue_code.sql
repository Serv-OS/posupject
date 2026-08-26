-- 086_locations_venue_code.sql
--
-- Hold the POS venue code against the CRM venue it belongs to.
--
-- WHY: every POS venue now carries a short permanent ID (SV-1001), shown in the
-- ServOS admin portal. When a venue is set up, that code is copied into its CRM
-- record here. The support chat then sends the code and we know exactly which
-- customer is asking, whatever anyone renamed either side to.
--
-- This replaces matching on the name, which cannot work: the POS calls a site
-- "Leeds" while this CRM holds three Leeds venues under different brands.
--
-- Nullable and additive. A venue with no code behaves exactly as it does today
-- and the bot asks which site they are at.

begin;

alter table public.locations
  add column if not exists venue_code text;

comment on column public.locations.venue_code is
  'The ServOS POS venue code (SV-1001), copied from the ServOS admin portal when the venue is set up. How the support chat identifies which venue is asking. Never invent one: it must match the POS exactly.';

-- Unique where set: two venues sharing a code would send support to the wrong one.
create unique index if not exists locations_venue_code_key
  on public.locations (venue_code)
  where venue_code is not null;

commit;

-- Rollback:
-- begin;
--   drop index if exists public.locations_venue_code_key;
--   alter table public.locations drop column if exists venue_code;
-- commit;

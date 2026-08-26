-- 085_locations_pos_link.sql
--
-- Link a CRM venue to the POS venue it actually is.
--
-- WHY: the support chat can now say which venue it was opened from, but the NAME
-- is not enough to identify anyone. The POS calls a site "Leeds"; this CRM holds
-- "Coffee Boy - Leeds", "Cafe Brigante - Leeds" and "Doboy Donuts - Leeds". One
-- name, three customers. The POS location id is the only unambiguous handle, so
-- the chat now sends it and this column is where it maps to.
--
-- Nullable and additive: an unmapped venue simply behaves as it does today, and
-- the bot asks which site they are at.

begin;

alter table public.locations
  add column if not exists pos_location_id uuid;

comment on column public.locations.pos_location_id is
  'The venue id in the POS ops database (tbetcegmszzotrwdtqhi.locations.id). Lets the support chat identify the caller from what their till reports. Names cannot be matched: one POS name can belong to several CRM venues.';

create unique index if not exists locations_pos_location_id_key
  on public.locations (pos_location_id)
  where pos_location_id is not null;

commit;

-- Fill it in (one line per venue). The POS ids are listed in the chat handover
-- notes; a venue you leave unmapped just keeps today's behaviour.
--
--   update public.locations set pos_location_id = '<pos-uuid>' where name = 'Coffee Boy - Leeds';
--
-- Rollback:
-- begin;
--   drop index if exists public.locations_pos_location_id_key;
--   alter table public.locations drop column if exists pos_location_id;
-- commit;

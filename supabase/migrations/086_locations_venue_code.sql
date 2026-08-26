-- The venue's code in the POS platform, as a human reads it: SV-1007.
--
-- 085 added pos_location_id (a uuid, the ops database's own key) and the chat
-- already looks for a venue_code first — but that column was never created, so
-- that branch could never match. This is it.
--
-- Text and short, because that is what the POS issues and what someone can read
-- off a screen and repeat down the phone. Stored uppercase so 'sv-1007' typed in
-- a hurry still finds SV-1007.
alter table public.locations add column if not exists venue_code text;

comment on column public.locations.venue_code is
  'The venue code from the POS platform, e.g. SV-1007. Sent when a customer opens the support chat from their till, so the bot knows which venue without asking. Paste it in on the location record.';

-- Case-insensitive uniqueness: two venues must never claim one code, and
-- SV-1007 and sv-1007 are the same code.
--
-- Deliberately a NEW index name. An earlier plain-column index already held the
-- name locations_venue_code_key, so "create ... if not exists" under that name
-- silently did nothing and left the constraint case-SENSITIVE — sv-1007 and
-- SV-1007 both saved happily, which is exactly the collision this is for.
drop index if exists public.locations_venue_code_key;
create unique index if not exists locations_venue_code_ci_key
  on public.locations (upper(venue_code)) where venue_code is not null;

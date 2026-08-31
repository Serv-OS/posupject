-- Which site is this ticket about?
--
-- Support work is site-specific ("network cable needs running @ CSC"), but a
-- ticket only knew its COMPANY — and the big customers have 24 and 23 sites, so
-- the site could never be inferred. Time logged against a ticket therefore had
-- no site, which is most of the support hours missing from the site report.
alter table public.tickets add column if not exists location_id uuid
  references public.locations(id) on delete set null;
create index if not exists idx_tickets_location on public.tickets(location_id) where location_id is not null;

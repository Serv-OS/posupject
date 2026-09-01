-- Record WHO created a record, not just who it is assigned to.
--
-- Mike created the location "VSC - Bali Cafe" on 1 Sep. The activity monitor
-- could not show it, and neither could anything else, because the database
-- never captured who made it: locations, companies, contacts, deals and leads
-- all carry only owner_id, which is an ASSIGNMENT. Bali Cafe's owner_id is
-- NULL, so the row is genuinely anonymous.
--
-- That is why "owning a record" must never be read as "did some work": a
-- company assigned to someone months ago says nothing about today, and a
-- record created today by someone may be owned by nobody at all.
--
-- DEFAULT auth.uid() means PostgREST inserts from a logged-in browser are
-- attributed with no application change. Inserts from an edge function
-- (service_role, no JWT) land NULL, which is correct — those are not a person.
--
-- History cannot be recovered. Rows created before this migration stay NULL
-- rather than being guessed at.

alter table public.locations add column if not exists created_by uuid
  references public.profiles(id) on delete set null default auth.uid();
alter table public.companies add column if not exists created_by uuid
  references public.profiles(id) on delete set null default auth.uid();
alter table public.contacts  add column if not exists created_by uuid
  references public.profiles(id) on delete set null default auth.uid();
alter table public.deals     add column if not exists created_by uuid
  references public.profiles(id) on delete set null default auth.uid();
alter table public.leads     add column if not exists created_by uuid
  references public.profiles(id) on delete set null default auth.uid();

create index if not exists idx_locations_created_by on public.locations(created_by, created_at desc) where created_by is not null;
create index if not exists idx_companies_created_by on public.companies(created_by, created_at desc) where created_by is not null;
create index if not exists idx_contacts_created_by  on public.contacts(created_by, created_at desc)  where created_by is not null;

-- The onboarding pack: one request per customer, per location we are onboarding.
--
-- A request is the thing we send. It carries its own unguessable token so the
-- customer can fill it in without an account, and it is pinned to the location
-- from the moment it is created — that is what makes the answers and the files
-- land on the right venue instead of a generic pile.
--
-- (Numbered 081 here: 080 is the booking pages.)
-- in a stash, and reusing the number would collide if that is ever restored.)
create table if not exists public.onboarding_form_requests (
  id            uuid primary key default gen_random_uuid(),
  onboarding_id uuid references public.onboardings(id) on delete cascade,
  location_id   uuid references public.locations(id)   on delete set null,
  company_id    uuid references public.companies(id)   on delete set null,
  contact_id    uuid references public.contacts(id)    on delete set null,
  token         text not null unique,
  sent_to       text,
  sent_at       timestamptz,
  opened_at     timestamptz,
  submitted_at  timestamptz,
  answers       jsonb not null default '{}'::jsonb,
  created_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_onb_form_req_onboarding on public.onboarding_form_requests(onboarding_id);
create index if not exists idx_onb_form_req_location   on public.onboarding_form_requests(location_id);

alter table public.onboarding_form_requests enable row level security;

-- Staff read; owners/editors manage. The customer NEVER touches this table
-- directly: the public page goes through the onboarding-form edge function,
-- which holds the service role and only ever exposes one token's own row.
drop policy if exists onb_form_req_read on public.onboarding_form_requests;
create policy onb_form_req_read on public.onboarding_form_requests
  for select using (auth.uid() is not null);

drop policy if exists onb_form_req_write on public.onboarding_form_requests;
create policy onb_form_req_write on public.onboarding_form_requests
  for all using (exists (
    select 1 from public.profiles p
     where p.id = auth.uid() and p.role = any (array['owner','editor'])
  )) with check (exists (
    select 1 from public.profiles p
     where p.id = auth.uid() and p.role = any (array['owner','editor'])
  ));

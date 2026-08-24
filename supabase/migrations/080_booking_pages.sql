-- Calendly-style booking: a public page that reads the host's Google calendar,
-- offers real free slots, and books the meeting on both sides.
--
-- Everything instant is stored in UTC (timestamptz). Everything HUMAN is stored
-- as a wall-clock time plus the zone it belongs to: the host works 9 to 5 in
-- California regardless of what a booker in the UK sees, and the two only
-- reconcile at render time. Storing "09:00" as a timestamp would break twice a
-- year when the two countries change clocks on different dates.
create table if not exists public.booking_types (
  id             uuid primary key default gen_random_uuid(),
  slug           text not null unique,
  name           text not null default 'Onboarding call',
  description    text,
  host_user_id   uuid references public.profiles(id) on delete set null,
  host_email     text,                                   -- the Google calendar we read and write
  timezone       text not null default 'America/Los_Angeles',
  duration_mins  integer not null default 30,
  buffer_mins    integer not null default 15,            -- keep either side of an existing event
  min_notice_hrs integer not null default 12,            -- nothing bookable sooner than this
  max_days_ahead integer not null default 30,
  slot_step_mins integer not null default 30,            -- how the day is divided
  -- Working hours in the HOST's timezone: {"1":[["09:00","17:00"]], ...}
  -- keyed 0=Sunday..6=Saturday, so a split day (a lunch gap) is just two ranges.
  hours          jsonb not null default '{"1":[["09:00","17:00"]],"2":[["09:00","17:00"]],"3":[["09:00","17:00"]],"4":[["09:00","17:00"]],"5":[["09:00","17:00"]]}'::jsonb,
  questions      jsonb not null default '[]'::jsonb,     -- extra form fields
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists public.bookings (
  id               uuid primary key default gen_random_uuid(),
  booking_type_id  uuid references public.booking_types(id) on delete set null,
  host_user_id     uuid references public.profiles(id) on delete set null,
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,
  -- What the booker saw. Kept so a confirmation can be re-sent in their own
  -- zone months later without guessing where they were.
  booker_timezone  text,
  name             text not null,
  email            text not null,
  phone            text,
  company          text,
  notes            text,
  answers          jsonb not null default '{}'::jsonb,
  status           text not null default 'confirmed' check (status in ('confirmed','cancelled')),
  google_event_id  text,
  cancel_token     text not null,
  lead_id          uuid references public.leads(id) on delete set null,
  contact_id       uuid references public.contacts(id) on delete set null,
  company_id       uuid references public.companies(id) on delete set null,
  created_at       timestamptz not null default now(),
  cancelled_at     timestamptz
);

create index if not exists idx_bookings_starts on public.bookings (starts_at);
-- The conflict check reads "confirmed bookings overlapping this window", so the
-- partial index matches the query exactly.
create index if not exists idx_bookings_live on public.bookings (starts_at, ends_at)
  where status = 'confirmed';

alter table public.booking_types enable row level security;
alter table public.bookings enable row level security;

drop policy if exists booking_types_read on public.booking_types;
create policy booking_types_read on public.booking_types for select using (auth.uid() is not null);
drop policy if exists booking_types_write on public.booking_types;
create policy booking_types_write on public.booking_types for all
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = any (array['owner','editor'])))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = any (array['owner','editor'])));

drop policy if exists bookings_read on public.bookings;
create policy bookings_read on public.bookings for select using (auth.uid() is not null);
drop policy if exists bookings_write on public.bookings;
create policy bookings_write on public.bookings for all
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = any (array['owner','editor'])))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = any (array['owner','editor'])));

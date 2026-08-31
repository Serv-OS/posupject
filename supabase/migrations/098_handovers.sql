-- Handover: what the next person needs to know.
--
-- The gap this fills is the stuff that never belongs on a ticket — "the Devonshire
-- install is waiting on the landlord, don't chase them again", "Mike is off
-- Thursday, his tickets are covered by me", "the card reader for CSC is in the
-- boot of my car". Today that lives in someone's head or a WhatsApp message and
-- is gone by Monday.
--
-- Deliberately NOT a ticket: a handover is written to be READ ONCE by whoever
-- comes next, then it stops mattering. Tickets are the opposite — they persist
-- until resolved. Mixing them would clog the queue with things that need no
-- action at all.

create table if not exists public.handovers (
  id           uuid primary key default gen_random_uuid(),
  author_id    uuid not null references public.profiles(id) on delete set null,
  -- The shift/day this handover covers. Defaults to today in business time, so
  -- an evening write-up does not land on tomorrow.
  -- business_today() already resolves the company timezone; a subquery is not
  -- allowed in a DEFAULT, and a function call is.
  shift_date   date not null default public.business_today(),
  title        text,
  body         text not null,
  -- Anything that genuinely needs picking up, so it is visible without reading
  -- the prose. Free text on purpose: "call the landlord back before 10" is not
  -- a ticket and should not have to become one.
  actions      jsonb not null default '[]'::jsonb,   -- [{text, done}]
  -- Things this handover is about, so the reader can jump straight there.
  ticket_ids   uuid[] not null default '{}',
  company_ids  uuid[] not null default '{}',
  location_ids uuid[] not null default '{}',
  -- Who it is aimed at. Empty = the whole team.
  for_user_id  uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_handovers_date on public.handovers (shift_date desc, created_at desc);

-- Read receipts: the point of a handover is that someone actually picked it up.
create table if not exists public.handover_reads (
  handover_id uuid not null references public.handovers(id) on delete cascade,
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  read_at     timestamptz not null default now(),
  primary key (handover_id, profile_id)
);

alter table public.handovers enable row level security;
alter table public.handover_reads enable row level security;

-- The whole team reads handovers — that is the point of one.
do $$ begin
  create policy handovers_read on public.handovers for select to authenticated using (true);
exception when duplicate_object then null; end $$;

-- Anyone can write one; you may only edit or delete your OWN, unless you are
-- the owner. A handover you did not write is somebody else's account of a
-- shift, and quietly rewriting it destroys the point of having one.
do $$ begin
  create policy handovers_insert on public.handovers for insert to authenticated
    with check (author_id = auth.uid());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy handovers_update on public.handovers for update to authenticated
    using (author_id = auth.uid() or public.current_user_role() = 'owner')
    with check (author_id = auth.uid() or public.current_user_role() = 'owner');
exception when duplicate_object then null; end $$;
do $$ begin
  create policy handovers_delete on public.handovers for delete to authenticated
    using (author_id = auth.uid() or public.current_user_role() = 'owner');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy handover_reads_read on public.handover_reads for select to authenticated using (true);
exception when duplicate_object then null; end $$;
-- You can only mark it read as yourself.
do $$ begin
  create policy handover_reads_insert on public.handover_reads for insert to authenticated
    with check (profile_id = auth.uid());
exception when duplicate_object then null; end $$;

-- 085_shift_punches.sql (ADDITIVE) — staff clock in/out from their own phone.
--
-- WHY THIS IS NOT THE RPOS DESIGN
-- RPOS (possystem) clocks staff via `workforce-clock`, a service-role edge
-- function: the wall tablet signs in ANONYMOUSLY, so it has no identity and RLS
-- refuses every wf_timesheets write. A PIN is the identity substitute, matched
-- server-side against staff_members for the paired location. Trust is PHYSICAL —
-- you must be standing in the venue to touch the tablet.
--
-- posupcrm has no venue and no tablet. Every member of staff is already a real
-- auth.users row with a profiles row. auth.uid() IS the identity, so the PIN,
-- the pairing and the service-role function all disappear. What replaces the
-- tablet's physical trust is a visible, append-only audit plus weekly manager
-- approval — not a geofence (see docs / findings).
--
-- INVARIANTS
--  1. The client NEVER supplies a punch timestamp. Every instant is now() from
--     Postgres, stamped by the guard trigger below.
--  2. business_date is the SHIFT's date when a shift matched, else the date in
--     the business timezone. It is stamped once at clock-in and NEVER recomputed
--     at clock-out. This is what makes overnight shifts attribute correctly.
--  3. Staff may open and close their own punch. They may never move it, reassign
--     it, back-date it, or approve it. RLS fences WHO; the trigger freezes WHAT.
--  4. An auto-closed punch is never payroll-clean: it lands as 'auto_closed' and
--     requires a human.

-- ── Business clock ──────────────────────────────────────────────────────────
-- Never use current_date: this database runs in UTC, so at 00:30 London in
-- summer current_date is still YESTERDAY. Every day attribution goes through here.
create or replace function public.business_tz()
returns text language sql stable security definer set search_path = public as $$
  select coalesce(nullif((select business_timezone from public.support_settings limit 1), ''),
                  'Europe/London');
$$;

create or replace function public.business_today()
returns date language sql stable security definer set search_path = public as $$
  select (now() at time zone public.business_tz())::date;
$$;

-- Resolve a rota row's scheduled window to real instants. start_time/finish_time
-- are TEXT 'HH:MM'; a finish at or before the start means the shift runs overnight.
-- These are deliberately SCALAR, not a RETURNS TABLE pair: a set-returning
-- function cannot appear in a WHERE clause, and the shift-matching query below
-- needs exactly that.
create or replace function public.shift_start_at(p_date date, p_start text)
returns timestamptz language sql stable security definer set search_path = public as $$
  select (p_date::text || ' ' || p_start)::timestamp at time zone public.business_tz();
$$;

create or replace function public.shift_end_at(p_date date, p_start text, p_finish text)
returns timestamptz language sql stable security definer set search_path = public as $$
  select ((p_date::text || ' ' || p_finish)::timestamp at time zone public.business_tz())
       + case when p_finish <= p_start then interval '1 day' else interval '0' end;
$$;

-- ── Punches ─────────────────────────────────────────────────────────────────
create table if not exists public.shift_punches (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  -- The rota row this punch was matched to at clock-in. Nullable: working an
  -- unscheduled day is legitimate and must never be refused.
  shift_id          uuid references public.shifts(id) on delete set null,
  -- SNAPSHOT of what was scheduled, kept so the punch stays meaningful after the
  -- rota row is edited or deleted (the same reason RPOS snapshots effective_rate).
  scheduled_start_at  timestamptz,
  scheduled_finish_at timestamptz,
  -- Day attribution in the business timezone. Stamped once, at clock-in.
  business_date     date not null,

  clock_in          timestamptz not null default now(),
  clock_out         timestamptz,
  break_mins        int not null default 0 check (break_mins >= 0),
  break_open_at     timestamptz,                       -- non-null = on a break now
  breaks            jsonb not null default '[]'::jsonb, -- [{start,end}] segments
  worked_minutes    int check (worked_minutes is null or worked_minutes >= 0),

  -- Variance vs the rota. Positive = late in / late out. Computed, never enforced:
  -- refusing an out-of-window punch is how you train people not to punch at all.
  variance_start_mins  int,
  variance_finish_mins int,

  source            text not null default 'self'
                      check (source in ('self','manager','auto')),
  status            text not null default 'open'
                      check (status in ('open','complete','auto_closed','disputed','approved','voided')),

  -- Trust evidence. Deliberately one jsonb rather than lat/lng/ip columns: it
  -- collects whatever the client offers today (user agent, viewport timezone,
  -- x-forwarded-for) and can carry coordinates later WITHOUT a migration, so the
  -- honour-system build never blocks a future geofence.
  in_evidence       jsonb not null default '{}'::jsonb,
  out_evidence      jsonb not null default '{}'::jsonb,
  -- true when the finish time was asserted by a human rather than punched live
  out_asserted      boolean not null default false,

  note              text,                              -- staff's own ("late, train")
  edited_by         uuid references public.profiles(id) on delete set null,
  edited_at         timestamptz,
  edit_reason       text,
  approved_by       uuid references public.profiles(id) on delete set null,
  approved_at       timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint punch_out_after_in check (clock_out is null or clock_out >= clock_in),
  constraint punch_approved_is_closed check (approved_at is null or clock_out is not null)
);

-- One open punch per person, enforced by the DATABASE. RPOS does this with a
-- SELECT-then-INSERT inside the edge function, which a double-tap can race.
create unique index if not exists uniq_open_punch_per_user
  on public.shift_punches (user_id) where clock_out is null;

create index if not exists idx_punches_user_date on public.shift_punches (user_id, business_date desc);
create index if not exists idx_punches_date      on public.shift_punches (business_date desc);
create index if not exists idx_punches_shift     on public.shift_punches (shift_id);
create index if not exists idx_punches_review    on public.shift_punches (status, business_date desc)
  where status in ('auto_closed','disputed');

-- ── Append-only audit ───────────────────────────────────────────────────────
-- This is the thing that replaces the geofence. Deterrence by visibility.
create table if not exists public.shift_punch_audit (
  id         bigserial primary key,
  punch_id   uuid not null,
  user_id    uuid,                -- whose punch
  actor_id   uuid,                -- who did it (auth.uid() at the time)
  action     text not null,       -- in|break_start|break_end|out|edit|approve|auto_close|void
  at         timestamptz not null default now(),
  before     jsonb,
  after      jsonb,
  reason     text
);
create index if not exists idx_punch_audit_punch on public.shift_punch_audit (punch_id, at desc);

-- ── Guard: server time in, client assertions out ────────────────────────────
create or replace function public.shift_punch_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  tz     text    := public.business_tz();
  -- No JWT at all = the nightly cron / service_role, not a person. It must be
  -- allowed to write source='auto' and edit_reason, or punch_auto_close() below
  -- would be silently undone by the freeze block. This is not a hole: an
  -- unauthenticated caller never reaches this trigger, because every RLS policy
  -- on the table requires either user_id = auth.uid() or a manager role.
  is_sys boolean := auth.uid() is null;
  is_mgr boolean := coalesce(public.current_user_role() in ('owner','editor'), false);
  s      public.shifts%rowtype;
  w_start timestamptz; w_end timestamptz;
begin
  if tg_op = 'INSERT' then
    new.user_id := coalesce(new.user_id, auth.uid());
    -- Only a manager may assert a time (back-dated entry); it is flagged as such.
    if not is_mgr and not is_sys then
      new.clock_in   := now();
      new.clock_out  := null;
      new.status     := 'open';
      new.source     := 'self';
      new.out_asserted := false;
      new.approved_by := null; new.approved_at := null;
      new.edited_by := null;  new.edited_at := null;
    else
      new.clock_in := coalesce(new.clock_in, now());
      if new.source = 'self' then new.source := 'manager'; end if;
    end if;

    -- Match the nearest published shift whose window brackets the punch (±4h).
    -- The date pre-filter is what lets the (user_id, date) index do the work;
    -- ±1 day because an overnight shift's window spills into the next date.
    select sh.* into s from public.shifts sh
     where sh.user_id = new.user_id and sh.status = 'published'
       and sh.date between (new.clock_in at time zone tz)::date - 1
                       and (new.clock_in at time zone tz)::date + 1
       and new.clock_in >= public.shift_start_at(sh.date, sh.start_time) - interval '4 hours'
       and new.clock_in <= public.shift_end_at(sh.date, sh.start_time, sh.finish_time) + interval '4 hours'
     order by abs(extract(epoch from
       (new.clock_in - public.shift_start_at(sh.date, sh.start_time))))
     limit 1;

    if found then
      w_start := public.shift_start_at(s.date, s.start_time);
      w_end   := public.shift_end_at(s.date, s.start_time, s.finish_time);
      new.shift_id := coalesce(new.shift_id, s.id);
      new.scheduled_start_at  := w_start;
      new.scheduled_finish_at := w_end;
      new.variance_start_mins := round(extract(epoch from (new.clock_in - w_start)) / 60);
      -- INVARIANT: an overnight shift belongs to the day it STARTED, so the rota
      -- date wins over the clock-in date. Clocking in at 00:10 for a 22:00 shift
      -- must not land on tomorrow.
      new.business_date := s.date;
    else
      new.business_date := (new.clock_in at time zone tz)::date;
    end if;
    -- NOTE: no early return. A manager back-dating a completed entry inserts a
    -- row that already has clock_out set, and it must still get worked_minutes
    -- and variance from the shared close-out block at the bottom.

  -- UPDATE ------------------------------------------------------------------
  elsif not is_mgr and not is_sys then
    -- Freeze everything a member of staff must not be able to move. RLS says WHO
    -- may write the row; only a trigger can say WHICH COLUMNS, because RLS cannot
    -- compare OLD with NEW.
    new.user_id            := old.user_id;
    new.clock_in           := old.clock_in;
    new.business_date      := old.business_date;
    new.shift_id           := old.shift_id;
    new.scheduled_start_at := old.scheduled_start_at;
    new.scheduled_finish_at:= old.scheduled_finish_at;
    new.source             := old.source;
    new.approved_by        := old.approved_by;
    new.approved_at        := old.approved_at;
    new.edited_by          := old.edited_by;
    new.edited_at          := old.edited_at;
    new.edit_reason        := old.edit_reason;
    -- A live clock-out is always now(); a remembered one is flagged, never trusted.
    if old.clock_out is null and new.clock_out is not null and not new.out_asserted then
      new.clock_out := now();
    end if;
  else
    -- Row comparison, not `new.*` — plpgsql compares whole records, not star-lists.
    if new is distinct from old then
      new.edited_by := auth.uid(); new.edited_at := now();
    end if;
  end if;

  -- Close-out maths. Actual hours come from the two instants, never from the
  -- 'HH:MM' rota strings — that is what survives an overnight or a DST change.
  if new.clock_out is not null then
    if new.break_open_at is not null then
      new.break_mins := new.break_mins
        + greatest(0, round(extract(epoch from (new.clock_out - new.break_open_at)) / 60))::int;
      new.breaks := new.breaks || jsonb_build_array(
        jsonb_build_object('start', new.break_open_at, 'end', new.clock_out, 'auto', true));
      new.break_open_at := null;
    end if;
    new.worked_minutes := greatest(0,
      round(extract(epoch from (new.clock_out - new.clock_in)) / 60)::int - new.break_mins);
    if new.scheduled_finish_at is not null then
      new.variance_finish_mins := round(extract(epoch from (new.clock_out - new.scheduled_finish_at)) / 60);
    end if;
    if new.status = 'open' then new.status := 'complete'; end if;
  end if;

  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_shift_punch_guard on public.shift_punches;
create trigger trg_shift_punch_guard
  before insert or update on public.shift_punches
  for each row execute function public.shift_punch_guard();

create or replace function public.shift_punch_audit_write()
returns trigger language plpgsql security definer set search_path = public as $$
declare act text;
begin
  if tg_op = 'INSERT' then act := 'in';
  elsif old.approved_at is null and new.approved_at is not null then act := 'approve';
  elsif old.break_open_at is null and new.break_open_at is not null then act := 'break_start';
  elsif old.break_open_at is not null and new.break_open_at is null and new.clock_out is null then act := 'break_end';
  elsif old.clock_out is null and new.clock_out is not null then
    act := case when new.status = 'auto_closed' then 'auto_close' else 'out' end;
  elsif new.status = 'voided' then act := 'void';
  else act := 'edit';
  end if;
  insert into public.shift_punch_audit (punch_id, user_id, actor_id, action, before, after, reason)
  values (new.id, new.user_id, auth.uid(), act,
          case when tg_op = 'UPDATE' then to_jsonb(old) end, to_jsonb(new), new.edit_reason);
  return null;
end $$;

drop trigger if exists trg_shift_punch_audit on public.shift_punches;
create trigger trg_shift_punch_audit
  after insert or update on public.shift_punches
  for each row execute function public.shift_punch_audit_write();

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.shift_punches enable row level security;
alter table public.shift_punch_audit enable row level security;

drop policy if exists shift_punches_read on public.shift_punches;
create policy shift_punches_read on public.shift_punches for select
  using (user_id = auth.uid() or public.current_user_role() in ('owner','editor'));

-- You may only ever create a punch for yourself.
drop policy if exists shift_punches_insert_self on public.shift_punches;
create policy shift_punches_insert_self on public.shift_punches for insert
  with check (user_id = auth.uid());

-- You may only edit your OWN punch, only while it is unapproved and not voided.
drop policy if exists shift_punches_update_self on public.shift_punches;
create policy shift_punches_update_self on public.shift_punches for update
  using  (user_id = auth.uid() and approved_at is null and status in ('open','complete','auto_closed'))
  with check (user_id = auth.uid() and approved_at is null);

-- Managers: read/write everything. Note there is deliberately NO delete policy
-- for anyone — a punch is a record. Managers set status='voided' instead, which
-- leaves an audit row behind; a DELETE would not.
drop policy if exists shift_punches_manage on public.shift_punches;
create policy shift_punches_manage_ins on public.shift_punches for insert
  with check (public.current_user_role() in ('owner','editor'));
create policy shift_punches_manage_upd on public.shift_punches for update
  using  (public.current_user_role() in ('owner','editor'))
  with check (public.current_user_role() in ('owner','editor'));

-- Audit is readable (yours, or all for a manager) and writable by nobody:
-- the only INSERT path is the SECURITY DEFINER trigger, which bypasses RLS.
drop policy if exists shift_punch_audit_read on public.shift_punch_audit;
create policy shift_punch_audit_read on public.shift_punch_audit for select
  using (user_id = auth.uid() or public.current_user_role() in ('owner','editor'));

-- ── The one door: punch() ───────────────────────────────────────────────────
-- RLS is the fence, this is the door. All the state machine lives here so the
-- client cannot get it wrong, and a compromised client still cannot write
-- someone else's row (the policies above hold regardless).
create or replace function public.punch(p_action text, p_note text default null,
                                        p_evidence jsonb default '{}'::jsonb)
returns public.shift_punches
language plpgsql security invoker set search_path = public as $$
declare open_row public.shift_punches; out_row public.shift_punches;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  select * into open_row from public.shift_punches
   where user_id = auth.uid() and clock_out is null
   order by clock_in desc limit 1;

  if p_action = 'in' then
    if open_row.id is not null then raise exception 'already clocked in' using errcode = '23505'; end if;
    insert into public.shift_punches (user_id, note, in_evidence)
    values (auth.uid(), p_note, coalesce(p_evidence, '{}'::jsonb))
    returning * into out_row;

  elsif p_action = 'break_start' then
    if open_row.id is null then raise exception 'not clocked in'; end if;
    if open_row.break_open_at is not null then raise exception 'already on break'; end if;
    update public.shift_punches set break_open_at = now() where id = open_row.id returning * into out_row;

  elsif p_action = 'break_end' then
    if open_row.id is null then raise exception 'not clocked in'; end if;
    if open_row.break_open_at is null then raise exception 'not on break'; end if;
    update public.shift_punches
       set break_mins = break_mins + greatest(0, round(extract(epoch from (now() - break_open_at)) / 60))::int,
           breaks = breaks || jsonb_build_array(jsonb_build_object('start', break_open_at, 'end', now())),
           break_open_at = null
     where id = open_row.id returning * into out_row;

  elsif p_action = 'out' then
    if open_row.id is null then raise exception 'not clocked in'; end if;
    update public.shift_punches
       set clock_out = now(), out_evidence = coalesce(p_evidence, '{}'::jsonb),
           note = coalesce(p_note, note)
     where id = open_row.id returning * into out_row;

  else raise exception 'unknown action %', p_action;
  end if;
  return out_row;
end $$;

grant execute on function public.punch(text, text, jsonb) to authenticated;

-- ── Forgot to clock out ─────────────────────────────────────────────────────
-- Nightly sweep. Closes anything open beyond 16h at its scheduled finish (or
-- +8h if unscheduled) and marks it auto_closed, which is a REVIEW state, never
-- a payroll-clean one. Without this an open punch stays open for days and the
-- "are you clocked in?" state on everyone's phone is simply wrong.
create or replace function public.punch_auto_close()
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  with stale as (
    update public.shift_punches
       set clock_out = coalesce(scheduled_finish_at, clock_in + interval '8 hours'),
           status = 'auto_closed', out_asserted = true, source = 'auto',
           edit_reason = 'auto-closed: still open 16h after clock-in'
     where clock_out is null and clock_in < now() - interval '16 hours'
     returning 1)
  select count(*) into n from stale;
  return n;
end $$;

-- Idempotent: re-running the migration must not stack duplicate jobs.
-- 02:00 UTC (03:00 London in BST, 02:00 in GMT) — pg_cron schedules are UTC.
select cron.unschedule('punch-auto-close')
 where exists (select 1 from cron.job where jobname = 'punch-auto-close');
select cron.schedule('punch-auto-close', '0 2 * * *', $$select public.punch_auto_close();$$);

-- ── Attendance: what the parked columns become ──────────────────────────────
-- attendance/attendance_at/attendance_by are LIVE but empty (95 shifts, 0 marks)
-- and the attendance_by FK shows what they were for: a MANAGER marking a roll
-- call after the fact — precisely the model being replaced. They are not
-- dropped: absence of a punch is ambiguous (no-show vs forgot vs holiday) and
-- only a human can disambiguate it. So the column stops being the record and
-- becomes the manager's OVERRIDE. NULL now means "trust the punches".
alter table public.shifts drop constraint if exists shifts_attendance_check;
alter table public.shifts add constraint shifts_attendance_check
  check (attendance is null or attendance in ('attended','no_show','excused'));
comment on column public.shifts.attendance is
  'Manager OVERRIDE only. NULL = derive from shift_punches. Set when the punch record is wrong or absent.';

-- CUTOVER. Without this every one of the 95 rota rows already in the table
-- (June–July, all predating the clock) derives to 'no_show' the moment the view
-- ships, and the rota grid turns solid red on day one. Shifts before the cutover
-- are 'not_tracked' — there were never any punches to find.
alter table public.support_settings add column if not exists clock_in_live_from date;
update public.support_settings
   set clock_in_live_from = coalesce(clock_in_live_from, public.business_today());

-- Resolved attendance: the override if a human set one, else the punches.
-- security_invoker is MANDATORY here, not decoration: a view runs with its
-- OWNER's rights by default, and migrations run as the table owner — so without
-- it this view would happily hand every user everyone else's punches straight
-- through the RLS fence. (Matches the existing public.deal_trading view.)
create or replace view public.shift_attendance with (security_invoker = on) as
select s.id as shift_id, s.user_id, s.date, s.start_time, s.finish_time, s.area_id, s.status,
       coalesce(
         s.attendance,
         case when s.date < (select clock_in_live_from from public.support_settings limit 1)
                then 'not_tracked'
              when p.punches > 0 then 'attended'
              when public.shift_end_at(s.date, s.start_time, s.finish_time) < now() then 'no_show'
              else 'pending' end) as resolved_attendance,
       s.attendance is not null as is_override,
       s.attendance_by, s.attendance_at,
       p.punches, p.worked_minutes, p.first_in, p.last_out,
       p.variance_start_mins, p.needs_review
  from public.shifts s
  left join lateral (
    select count(*) as punches,
           sum(sp.worked_minutes) as worked_minutes,
           min(sp.clock_in) as first_in, max(sp.clock_out) as last_out,
           min(sp.variance_start_mins) as variance_start_mins,
           bool_or(sp.status in ('auto_closed','disputed')) as needs_review
      from public.shift_punches sp
     where sp.shift_id = s.id and sp.status <> 'voided') p on true;

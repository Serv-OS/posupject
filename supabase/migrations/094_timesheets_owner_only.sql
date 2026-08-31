-- Timesheets: owner-only, and the rota reads in each person's own timezone.
--
-- TWO PROBLEMS, both found in the first day of live use.
--
-- 1. WHO. 083 treated 'editor' as a manager because that is how the rest of
--    this CRM works. But hours are not customer records: Duncan and Mike are
--    both editors, so each could read the other's working pattern, approve
--    their own hours, and back-date their own clock-in (the guard trigger only
--    froze columns for NON-managers). Timesheets belong to the owner.
--
-- 2. WHEN. shifts stores 'HH:MM' with no timezone and every shift was read in
--    the company's zone. The owner works from California; he clocked in at
--    10:00 his time against a 10:00 shift and the system recorded him 481
--    minutes late — exactly the 8-hour London/California gap. Nobody was late.
--    A person's shift times now mean what they mean WHERE THAT PERSON IS.
--    NULL timezone keeps the company zone, so UK staff are unaffected.

alter table public.profiles add column if not exists timezone text;

-- The window helpers gain an explicit zone. The old 2/3-argument forms stay so
-- nothing that calls them breaks; they simply default to the company zone.
create or replace function public.shift_start_at(p_date date, p_start text, p_tz text)
returns timestamptz language sql stable security definer set search_path = public as $fn$
  select (p_date::text || ' ' || p_start)::timestamp
         at time zone coalesce(nullif(p_tz, ''), public.business_tz());
$fn$;

create or replace function public.shift_end_at(p_date date, p_start text, p_finish text, p_tz text)
returns timestamptz language sql stable security definer set search_path = public as $fn$
  select ((p_date::text || ' ' || p_finish)::timestamp
          at time zone coalesce(nullif(p_tz, ''), public.business_tz()))
       + case when p_finish <= p_start then interval '1 day' else interval '0' end;
$fn$;

-- ── Read: your own, or the owner's view of everyone ─────────────────────────
drop policy if exists shift_punches_read on public.shift_punches;
create policy shift_punches_read on public.shift_punches for select
  using (user_id = auth.uid() or public.current_user_role() = 'owner');

drop policy if exists shift_punch_audit_read on public.shift_punch_audit;
create policy shift_punch_audit_read on public.shift_punch_audit for select
  using (user_id = auth.uid() or public.current_user_role() = 'owner');

-- ── Writing on someone else's behalf, approving, editing: owner only ────────
drop policy if exists shift_punches_manage_ins on public.shift_punches;
create policy shift_punches_manage_ins on public.shift_punches for insert
  with check (public.current_user_role() = 'owner');

drop policy if exists shift_punches_manage_upd on public.shift_punches;
create policy shift_punches_manage_upd on public.shift_punches for update
  using  (public.current_user_role() = 'owner')
  with check (public.current_user_role() = 'owner');

-- ── The column freeze must agree with the policies ─────────────────────────
-- RLS says who may touch a row; the trigger says which COLUMNS survive. RLS
-- cannot compare OLD with NEW, so if the trigger still counted editors as
-- managers an editor's own UPDATE would skip the freeze entirely.
create or replace function public.shift_punch_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  -- The rota stores 'HH:MM' with no zone. Reading every person's shift in the
  -- company's timezone made a California-based owner 8 hours late every day
  -- (clocked in 10:00 PDT, shift read as 10:00 London => variance +481m).
  -- Each person's own timezone decides what their 10:00 means.
  tz     text    := coalesce(
                      (select nullif(p.timezone, '') from public.profiles p
                        where p.id = coalesce(new.user_id, auth.uid())),
                      public.business_tz());
  -- No JWT at all = the nightly cron / service_role, not a person. It must be
  -- allowed to write source='auto' and edit_reason, or punch_auto_close() below
  -- would be silently undone by the freeze block. This is not a hole: an
  -- unauthenticated caller never reaches this trigger, because every RLS policy
  -- on the table requires either user_id = auth.uid() or a manager role.
  is_sys boolean := auth.uid() is null;
  is_mgr boolean := coalesce(public.current_user_role() = 'owner', false);
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
       and new.clock_in >= public.shift_start_at(sh.date, sh.start_time, tz) - interval '4 hours'
       and new.clock_in <= public.shift_end_at(sh.date, sh.start_time, sh.finish_time, tz) + interval '4 hours'
     order by abs(extract(epoch from
       (new.clock_in - public.shift_start_at(sh.date, sh.start_time, tz))))
     limit 1;

    if found then
      w_start := public.shift_start_at(s.date, s.start_time, tz);
      w_end   := public.shift_end_at(s.date, s.start_time, s.finish_time, tz);
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

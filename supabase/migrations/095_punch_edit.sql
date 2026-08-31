-- Correcting a punch: someone forgot to clock out, or clocked in late because
-- they were on a call. The owner needs to fix it without the record quietly
-- becoming fiction.
--
-- Times are typed in the PERSON'S timezone (the owner in California editing a
-- UK colleague's Tuesday must not have to convert in their head), so the
-- conversion happens here where the zone is known, not in the browser.
--
-- SECURITY INVOKER on purpose: RLS still applies underneath, so only the owner
-- can write someone else's row. The RPC is the door; the policies are the fence.
create or replace function public.punch_edit(
  p_id       uuid,
  p_in_local text,          -- 'YYYY-MM-DD HH:MM' in the punch owner's timezone
  p_out_local text,         -- same, or null to leave the punch open
  p_reason   text
) returns public.shift_punches
language plpgsql security invoker set search_path = public as $$
declare
  row_out public.shift_punches;
  tz      text;
  new_in  timestamptz;
  new_out timestamptz;
begin
  select coalesce(nullif(p.timezone, ''), public.business_tz())
    into tz
    from public.shift_punches sp join public.profiles p on p.id = sp.user_id
   where sp.id = p_id;
  if tz is null then raise exception 'punch not found or not visible to you'; end if;

  new_in  := (p_in_local::timestamp) at time zone tz;
  new_out := case when coalesce(p_out_local, '') = '' then null
                  else (p_out_local::timestamp) at time zone tz end;
  if new_out is not null and new_out < new_in then
    raise exception 'the finish time is before the start time';
  end if;

  update public.shift_punches
     set clock_in     = new_in,
         clock_out    = new_out,
         -- Reopening a punch must clear the closed-out figures, or stale hours
         -- survive on a row that is running again.
         status       = case when new_out is null then 'open' else 'complete' end,
         worked_minutes = case when new_out is null then null else worked_minutes end,
         variance_start_mins = case
           when scheduled_start_at is null then null
           else round(extract(epoch from (new_in - scheduled_start_at)) / 60) end,
         out_asserted = true,        -- a typed time is never a live punch
         edited_by    = auth.uid(),
         edited_at    = now(),
         edit_reason  = nullif(p_reason, ''),
         -- An edit un-approves: hours change, so the sign-off has to be redone.
         approved_by  = null,
         approved_at  = null
   where id = p_id
   returning * into row_out;

  if row_out.id is null then raise exception 'punch not found or not editable by you'; end if;
  return row_out;
end $$;

grant execute on function public.punch_edit(uuid, text, text, text) to authenticated;

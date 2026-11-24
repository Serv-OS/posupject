-- 130_morning_task_digest.sql (safe to run twice)
--
-- Peter, 24 Nov 2026: make projects and tasks easier, "we are already losing
-- things". At 8am on weekdays, in each person's own time zone, everyone with
-- late or due-today tasks gets ONE alert listing them (bell + email/chat via
-- the normal notification delivery). Nobody with nothing due hears anything.

create or replace function public.task_digest(p_force boolean default false)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  r record;
  n int := 0;
  v_list text;
  v_one uuid;
  v_title text;
begin
  for r in
    select p.id as person,
           coalesce(nullif(p.timezone, ''), 'Europe/London') as tz,
           count(*) filter (where t.due_date < (now() at time zone coalesce(nullif(p.timezone, ''), 'Europe/London'))::date) as late,
           count(*) filter (where t.due_date = (now() at time zone coalesce(nullif(p.timezone, ''), 'Europe/London'))::date) as today
      from profiles p
      join tasks t on t.owner_id = p.id
      left join crm_projects cp on cp.id = t.project_id
     where t.status <> 'done'
       and t.due_date is not null
       and t.due_date <= (now() at time zone coalesce(nullif(p.timezone, ''), 'Europe/London'))::date
       and (t.project_id is null or cp.status = 'active')
     group by p.id, p.timezone
  loop
    -- 8am on a weekday where the person is, unless forced (testing).
    if not p_force then
      continue when extract(hour from now() at time zone r.tz) <> 8
                 or extract(isodow from now() at time zone r.tz) > 5;
    end if;
    -- Once a day.
    continue when exists (select 1 from notifications
                           where recipient_id = r.person and title like 'Your tasks today:%'
                             and created_at > now() - interval '20 hours');

    select string_agg(line, E'\n' order by late_first, due_date, title), min(id::text)::uuid
      into v_list, v_one
      from (
        select t.id, t.title, t.due_date, (t.due_date >= (now() at time zone r.tz)::date) as late_first,
               '- ' || t.title
               || coalesce(' (' || coalesce(c.name, l.name, cp.name) || ')', '')
               || case when t.due_date < (now() at time zone r.tz)::date
                       then ', ' || ((now() at time zone r.tz)::date - t.due_date) || ' days late'
                       else ', due today' end as line
          from tasks t
          left join crm_projects cp on cp.id = t.project_id
          left join onboardings o on cp.subject_type = 'onboarding' and o.id = cp.subject_id
          left join locations l on l.id = coalesce(o.location_id, case when cp.subject_type = 'location' then cp.subject_id end)
          left join companies c on c.id = coalesce(o.company_id, case when cp.subject_type = 'company' then cp.subject_id end)
         where t.owner_id = r.person and t.status <> 'done' and t.due_date is not null
           and t.due_date <= (now() at time zone r.tz)::date
           and (t.project_id is null or cp.status = 'active')
         order by (t.due_date >= (now() at time zone r.tz)::date), t.due_date, t.title
         limit 12
      ) x;

    v_title := 'Your tasks today: '
      || concat_ws(', ',
           case when r.late > 0 then r.late || ' late' end,
           case when r.today > 0 then r.today || ' due today' end);

    insert into notifications (recipient_id, actor_id, type, title, body, entity_type, link_id)
    values (r.person, null, 'assignment', v_title,
            v_list || case when r.late + r.today > 12 then E'\n...and ' || (r.late + r.today - 12) || ' more' else '' end,
            case when r.late + r.today = 1 then 'task' else 'task_list' end,
            case when r.late + r.today = 1 then v_one else r.person end);
    n := n + 1;
  end loop;
  return n;
end $$;

revoke all on function public.task_digest(boolean) from public, anon, authenticated;

-- Every hour at :05; the function itself picks 8am per person.
select cron.unschedule('task-digest') where exists (select 1 from cron.job where jobname = 'task-digest');
select cron.schedule('task-digest', '5 * * * *', $$select public.task_digest()$$);

-- Check: who would get one, and what it would say (sends nothing).
select coalesce(p.display_name, p.email) as person,
       count(*) filter (where t.due_date < current_date) as late,
       count(*) filter (where t.due_date = current_date) as due_today
  from tasks t join profiles p on p.id = t.owner_id
  left join crm_projects cp on cp.id = t.project_id
 where t.status <> 'done' and t.due_date <= current_date and (t.project_id is null or cp.status = 'active')
 group by 1 order by 2 desc;

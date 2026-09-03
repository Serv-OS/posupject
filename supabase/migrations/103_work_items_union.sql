-- work_items, build 2: tickets and onboardings join the union.
--
-- Statuses are NORMALISED to the four task values, because the point of the
-- view is that one row reads the same whatever module it came from. A ticket
-- "waiting on customer" and a task "blocked" are the same fact to whoever is
-- planning their day, and forcing the reader to learn three status vocabularies
-- is what made the modules feel disconnected in the first place.
--
-- ONE ROW PER ONBOARDING, at its current stage — deliberately not one per
-- onboarding task. There are around 250 of those, and putting them in Today
-- would bury the day's actual work under a checklist nobody asked to see.
--
-- due_at is whatever "when does this matter" means for that module: a task's
-- due date, a ticket's SLA resolution target, an onboarding's go-live.

drop view if exists public.work_items;
create view public.work_items as

-- Tasks
select
  'task'::text as type, 'tasks'::text as source_table, t.id as source_id,
  t.title as title,
  coalesce(p.name, c.name, l.name) as subtitle,
  t.owner_id, t.created_by,
  t.status as status,
  t.priority, t.blocked_reason,
  t.due_date::timestamptz as due_at,
  jsonb_build_object('view', 'task_detail', 'id', t.id) as link,
  t.updated_at
from public.tasks t
left join public.crm_projects p on p.id = t.project_id
left join public.companies    c on c.id = t.subject_id and t.subject_type = 'company'
left join public.locations    l on l.id = t.subject_id and t.subject_type = 'location'

union all

-- Tickets. Open ones only: a closed ticket is history, not work.
select
  'ticket', 'tickets', tk.id,
  coalesce(nullif(tk.subject, ''), 'Ticket #' || tk.ticket_number::text),
  coalesce(l.name, c.name),
  tk.owner_id, null::uuid,
  case tk.stage
    when 'new'                then 'todo'
    when 'in_progress'        then 'in_progress'
    when 'escalated'          then 'in_progress'
    -- Waiting on the customer is not idle: it is blocked on someone else,
    -- which is exactly what the Waiting rail on Today is for.
    when 'waiting_on_customer' then 'blocked'
    else 'todo'
  end,
  tk.priority, null::text,
  tk.resolution_due_at,
  jsonb_build_object('view', 'ticket_detail', 'id', tk.id),
  tk.updated_at
from public.tickets tk
left join public.companies c on c.id = tk.company_id
left join public.locations l on l.id = tk.location_id
where tk.stage not in ('resolved', 'closed')

union all

-- Onboardings, one row at the current stage.
select
  'onboarding', 'onboardings', o.id,
  coalesce(c.name, l.name, 'Onboarding') || ' — ' || replace(o.stage, '_', ' '),
  l.name,
  o.owner_id, null::uuid,
  case when o.stage in ('live', 'complete') then 'done' else 'in_progress' end,
  'P2',
  null::text,
  coalesce(o.target_go_live, o.expected_install_date)::timestamptz,
  jsonb_build_object('view', 'onboarding_detail', 'id', o.id),
  o.updated_at
from public.onboardings o
left join public.companies c on c.id = o.company_id
left join public.locations l on l.id = o.location_id
where o.stage not in ('live', 'complete');

comment on view public.work_items is
  'Read-only union of everything that can sit in someone''s day: tasks, open tickets, live onboardings. Statuses normalised to the four task values. A row is a pointer to its source — deleting the source removes it, with nothing to clean up.';

alter view public.work_items set (security_invoker = on);
grant select on public.work_items to authenticated;

-- ROLLBACK: re-run 102_work_layer.sql, which recreates the tasks-only view.

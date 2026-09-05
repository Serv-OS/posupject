-- 106: handover to support closes the onboarding loop.
--
-- Three things were leaving finished jobs on everyone's list:
--
-- 1. Nothing ever closed the project. Migration 076 stamps a project and its
--    tasks out of a template when an onboarding is created, but installs no
--    trigger on `stage`, so reaching the last stage changed nothing.
-- 2. The work_items view excluded onboardings at stage 'live' or 'complete'.
--    'complete' is not even a legal stage, and the real terminal stage is
--    'handover_to_support', so every handed-over job still read as in progress.
-- 3. Tasks stayed in work_items after their project was closed, because the
--    task branch joined crm_projects for the subtitle but never filtered on it.
--
-- Closing a job completes its PROJECT and leaves the task rows alone: those
-- tasks genuinely were not done, and marking them done would be a lie. They
-- simply stop counting as open work once the project is no longer active.
--
-- ROLLBACK: drop trigger trg_onboarding_close on public.onboardings;
--           drop function public.close_onboarding_work();
--           then re-run 105_work_items_request_contact.sql.

create or replace function public.close_onboarding_work()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.stage is distinct from old.stage then
    -- Delivered: the job is with support now, so its project is done.
    if new.stage in ('live', 'handover_to_support') then
      update public.crm_projects
         set status = 'completed', updated_at = now()
       where subject_type = 'onboarding' and subject_id = new.id and status = 'active';
    -- Pulled back into delivery: the project is live work again.
    elsif old.stage in ('live', 'handover_to_support') then
      update public.crm_projects
         set status = 'active', updated_at = now()
       where subject_type = 'onboarding' and subject_id = new.id and status = 'completed';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_onboarding_close on public.onboardings;
create trigger trg_onboarding_close
  after update of stage on public.onboardings
  for each row execute function public.close_onboarding_work();

-- Catch up everything already handed over.
update public.crm_projects p
   set status = 'completed', updated_at = now()
  from public.onboardings o
 where p.subject_type = 'onboarding' and p.subject_id = o.id
   and p.status = 'active' and o.stage in ('live', 'handover_to_support');


-- The view, with finished onboardings and closed projects excluded.
drop view if exists public.work_items;
create view public.work_items as

select 'task'::text as type, 'tasks'::text as source_table, t.id as source_id,
  t.title as title, coalesce(p.name, c.name, l.name) as subtitle,
  t.owner_id, t.created_by, t.status as status, t.priority, t.blocked_reason,
  t.due_date::timestamptz as due_at,
  jsonb_build_object('view', 'task_detail', 'id', t.id) as link, t.updated_at
from public.tasks t
left join public.crm_projects p on p.id = t.project_id
left join public.companies    c on c.id = t.subject_id and t.subject_type = 'company'
left join public.locations    l on l.id = t.subject_id and t.subject_type = 'location'
where t.parent_task_id is null
  and (t.project_id is null or coalesce(p.status, 'active') = 'active')

union all

select 'ticket', 'tickets', tk.id,
  coalesce(nullif(tk.subject, ''), 'Ticket #' || tk.ticket_number::text),
  coalesce(l.name, c.name),
  tk.owner_id, null::uuid,
  case tk.stage when 'new' then 'todo' when 'in_progress' then 'in_progress' when 'escalated' then 'in_progress'
    when 'waiting_on_customer' then 'blocked' else 'todo' end,
  tk.priority, null::text, tk.resolution_due_at,
  jsonb_build_object('view', 'ticket_detail', 'id', tk.id), tk.updated_at
from public.tickets tk
left join public.companies c on c.id = tk.company_id
left join public.locations l on l.id = tk.location_id
where tk.stage not in ('resolved', 'closed')

union all

select 'onboarding', 'onboardings', o.id,
  coalesce(c.name, l.name, 'Onboarding') || ' — ' || replace(o.stage, '_', ' '),
  l.name, o.owner_id, null::uuid,
  case when o.stage in ('live', 'handover_to_support') then 'done' else 'in_progress' end,
  'P2', null::text, coalesce(o.target_go_live, o.expected_install_date)::timestamptz,
  jsonb_build_object('view', 'onboarding_detail', 'id', o.id), o.updated_at
from public.onboardings o
left join public.companies c on c.id = o.company_id
left join public.locations l on l.id = o.location_id
where o.stage not in ('live', 'handover_to_support')

union all

-- Approvals: submitted expenses, with the amount in the title.
select 'approval', 'expenses', e.id,
  'Expense — ' || coalesce(nullif(e.description, ''), e.type) || ' · £' || to_char(coalesce(e.total, 0), 'FM999,999,990.00'),
  coalesce(pr.display_name, split_part(pr.email, '@', 1)),
  null::uuid, e.submitter_id, 'todo', 'P2', null::text,
  coalesce(e.submitted_at, e.created_at),
  jsonb_build_object('view', 'expense_detail', 'id', e.id), e.updated_at
from public.expenses e
left join public.profiles pr on pr.id = e.submitter_id
where e.status = 'submitted'

union all

-- Requests: feature requests awaiting triage.
select 'request', 'feature_requests', fr.id,
  fr.title, nullif(btrim(coalesce(ct.first_name, '') || ' ' || coalesce(ct.last_name, '')), ''),
  fr.owner_id, null::uuid, 'todo', coalesce(fr.priority, 'P3'), null::text,
  fr.created_at,
  jsonb_build_object('view', 'feature_request_detail', 'id', fr.id), fr.updated_at
from public.feature_requests fr
left join public.contacts ct on ct.id = fr.requested_by
where fr.status = 'new';

comment on view public.work_items is
  'Read-only union of everything that can sit in someone''s day: tasks, open tickets, live onboardings, submitted expenses (approval), new feature requests (request). Statuses normalised to the four task values. A row is a pointer to its source.';
alter view public.work_items set (security_invoker = on);
grant select on public.work_items to authenticated;

-- ROLLBACK: re-run 103_work_items_union.sql.

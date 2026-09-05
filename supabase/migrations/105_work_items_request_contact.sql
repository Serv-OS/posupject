-- 105: the request rows had no requester and could never be "asked for by me".
--
-- feature_requests.requested_by is a foreign key to CONTACTS (the customer who
-- asked), not to profiles. 104 joined profiles on it, so the join never matched:
-- every request row carried a null subtitle, and created_by held a contact id
-- that no profile id can equal, so the "Requested by me" lens was always empty
-- for requests. Name the contact in the subtitle and leave created_by null,
-- because a customer request has no internal requester.
--
-- ROLLBACK: re-run 104_work_items_approvals.sql.

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
  case when o.stage in ('live', 'complete') then 'done' else 'in_progress' end,
  'P2', null::text, coalesce(o.target_go_live, o.expected_install_date)::timestamptz,
  jsonb_build_object('view', 'onboarding_detail', 'id', o.id), o.updated_at
from public.onboardings o
left join public.companies c on c.id = o.company_id
left join public.locations l on l.id = o.location_id
where o.stage not in ('live', 'complete')

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

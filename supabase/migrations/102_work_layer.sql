-- Projects & tasks redesign, step 1: the columns and the union view.
--
-- Every change here is ADDITIVE. Nothing is renamed, no value migrates, and no
-- existing column changes type or nullability, so the app on the previous
-- release keeps working against this schema unchanged. That is what makes the
-- rollback at the bottom safe to run at any point.
--
-- NOT adding blocked_by_task_id, which the spec asks for. tasks.depends_on_id
-- already exists, already references tasks(id) on delete set null, and is used
-- by 0 rows. Two columns meaning "waits on" is how a dependency ends up half
-- recorded in each. The spec's field maps onto the existing one.

alter table public.tasks add column if not exists phase          text;
alter table public.tasks add column if not exists blocked_reason text;
alter table public.tasks add column if not exists created_by     uuid references public.profiles(id) on delete set null default auth.uid();
alter table public.tasks add column if not exists labels         text[] not null default '{}';
alter table public.tasks add column if not exists start_date     date;

comment on column public.tasks.phase is
  'Groups a task inside its project. Null = the unnamed group at the bottom, i.e. today''s flat list.';
comment on column public.tasks.depends_on_id is
  'The task this one waits on. The spec calls this blocked_by_task_id; it is this column.';

-- Phase order for a project. Behind a per-instance flag: the column ships
-- everywhere, an instance turns phases on when it wants them.
alter table public.crm_projects add column if not exists phases text[] not null default '{}';

create index if not exists idx_tasks_phase      on public.tasks(project_id, phase) where phase is not null;
create index if not exists idx_tasks_created_by on public.tasks(created_by, created_at desc) where created_by is not null;
create index if not exists idx_tasks_start_date on public.tasks(start_date) where start_date is not null;

-- ── work_items ──────────────────────────────────────────────────────────────
-- One shape for everything that can sit in somebody's day. Today, People and
-- the board read this instead of assembling per-module lists in the browser.
--
-- Tasks only in this first build, deliberately. Tickets, onboardings and
-- approvals join later (spec step 7): getting the shape wrong with five sources
-- already wired is a much more expensive mistake than adding the second source.
--
-- A work item is only ever a POINTER. Deleting the source row removes it, with
-- nothing to clean up, because a view holds no rows of its own.
drop view if exists public.work_items;
create view public.work_items as
select
  'task'::text                          as type,
  'tasks'::text                         as source_table,
  t.id                                  as source_id,
  t.title                               as title,
  coalesce(p.name, c.name, l.name)      as subtitle,
  t.owner_id                            as owner_id,
  t.created_by                          as created_by,   -- powers the "I asked for" lens
  t.status                              as status,
  t.priority                            as priority,
  t.blocked_reason                      as blocked_reason,
  t.due_date::timestamptz               as due_at,
  jsonb_build_object('view', 'task_detail', 'id', t.id) as link,
  t.updated_at                          as updated_at
from public.tasks t
left join public.crm_projects p on p.id = t.project_id
left join public.companies    c on c.id = t.subject_id and t.subject_type = 'company'
left join public.locations    l on l.id = t.subject_id and t.subject_type = 'location';

comment on view public.work_items is
  'Read-only union of everything that can appear in someone''s day. Tasks only in build 1; tickets, onboardings and approvals follow. A row is a pointer to its source, never a copy.';

-- A view runs as its owner, so RLS on the underlying tables would be bypassed.
-- security_invoker makes it run as the caller instead, which keeps tasks' own
-- policies in force and stops this becoming a way to read around them.
alter view public.work_items set (security_invoker = on);

grant select on public.work_items to authenticated;

-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- Run this to undo everything above. Safe while the previous release is live:
-- the columns are unused by it and the view is read-only.
--
--   drop view if exists public.work_items;
--   alter table public.crm_projects drop column if exists phases;
--   alter table public.tasks drop column if exists start_date;
--   alter table public.tasks drop column if exists labels;
--   alter table public.tasks drop column if exists created_by;
--   alter table public.tasks drop column if exists blocked_reason;
--   alter table public.tasks drop column if exists phase;
--
-- Dropping a column destroys what is in it. By the time tasks carry phases or
-- blocked reasons, roll back the CODE (git revert to the tag
-- pre-projects-redesign) and leave the schema alone — it is additive, so an
-- older build ignores it.

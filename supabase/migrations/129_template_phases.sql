-- 129_template_phases.sql (safe to run twice)
--
-- Peter, 24 Nov 2026: "do the phases in templates". A template now keeps its
-- phases (e.g. Account setup, Go live) and each task remembers its phase, so a
-- project made from it comes out split into the same phases.

alter table public.project_templates add column if not exists phases text[] not null default '{}';
alter table public.task_templates add column if not exists phase text;

create or replace function public.apply_project_template(
  p_template_id uuid,
  p_subject_type text,
  p_subject_id uuid,
  p_owner uuid default null,
  p_base_date date default current_date
) returns uuid
language plpgsql security definer set search_path = public as $fn$
declare
  v_tpl record;
  v_project_id uuid;
  v_t record;
  v_new_id uuid;
  v_map jsonb := '{}'::jsonb; -- template task id -> created task id
begin
  select * into v_tpl from project_templates where id = p_template_id;
  if not found then
    raise exception 'project template % not found', p_template_id;
  end if;

  -- Dedupe: never apply the same template twice to the same subject.
  select id into v_project_id from crm_projects
    where template_id = p_template_id
      and subject_type = p_subject_type and subject_id = p_subject_id
    limit 1;
  if v_project_id is not null then
    return v_project_id;
  end if;

  insert into crm_projects (name, description, status, subject_type, subject_id, template_id, owner_id, due_date, phases)
  values (
    v_tpl.name, v_tpl.description, 'active', p_subject_type, p_subject_id, p_template_id, p_owner,
    p_base_date + coalesce((select max(due_offset_days) from task_templates where project_template_id = p_template_id), 0),
    coalesce(v_tpl.phases, '{}')
  )
  returning id into v_project_id;

  -- Parents first, then children, so parent_task_id can be mapped.
  -- A sub-task with no phase of its own sits in its parent's phase.
  for v_t in
    select tt.*, coalesce(tt.phase, par.phase) as eff_phase
    from task_templates tt
    left join task_templates par on par.id = tt.parent_template_id
    where tt.project_template_id = p_template_id
    order by (tt.parent_template_id is not null), tt.sort_order, tt.title
  loop
    insert into tasks (title, description, status, priority, parent_task_id, project_id, phase,
                       subject_type, subject_id, owner_id, due_date, sort_order)
    values (
      v_t.title, v_t.description, 'todo', coalesce(v_t.priority, 'P2'),
      case when v_t.parent_template_id is not null then (v_map ->> v_t.parent_template_id::text)::uuid end,
      v_project_id,
      case when v_t.eff_phase = any(coalesce(v_tpl.phases, '{}')) then v_t.eff_phase end,
      p_subject_type, p_subject_id,
      case when v_t.default_assignee_role = 'owner' then p_owner end,
      p_base_date + coalesce(v_t.due_offset_days, 0),
      coalesce(v_t.sort_order, 0)
    )
    returning id into v_new_id;
    v_map := v_map || jsonb_build_object(v_t.id::text, v_new_id::text);
  end loop;

  return v_project_id;
end $fn$;

-- Check: both columns exist (should return 2 rows).
select table_name, column_name from information_schema.columns
 where table_schema = 'public'
   and ((table_name = 'project_templates' and column_name = 'phases') or (table_name = 'task_templates' and column_name = 'phase'));

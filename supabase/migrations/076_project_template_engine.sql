-- Project template engine: turns the dormant project_templates / task_templates /
-- automations schema (005) into a working system.
--
--  * onboardings.job_type — the "job type" a template rule can key on
--  * apply_project_template() — stamps a template into a real crm_project with
--    its full task tree (sub-tasks, due-date offsets, owner assignment).
--    Dedupes: the same template is never applied twice to the same subject.
--  * trg_onboarding_automations — on job creation (and when job_type is set or
--    changed) every enabled 'onboarding_created' automation whose condition
--    matches stamps out its template automatically.
--
-- Automations rows are managed from the Project templates screen (owner-only,
-- RLS from 005). condition = {} (every job) or {"job_type": "New venue"}.

alter table public.onboardings add column if not exists job_type text;

-- Stamp a template onto a subject. Returns the new project id, or the existing
-- project id if this template was already applied to this subject (dedupe).
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

  insert into crm_projects (name, description, status, subject_type, subject_id, template_id, owner_id, due_date)
  values (
    v_tpl.name, v_tpl.description, 'active', p_subject_type, p_subject_id, p_template_id, p_owner,
    p_base_date + coalesce((select max(due_offset_days) from task_templates where project_template_id = p_template_id), 0)
  )
  returning id into v_project_id;

  -- Parents first, then children, so parent_task_id can be mapped.
  for v_t in
    select * from task_templates
    where project_template_id = p_template_id
    order by (parent_template_id is not null), sort_order, title
  loop
    insert into tasks (title, description, status, priority, parent_task_id, project_id,
                       subject_type, subject_id, owner_id, due_date, sort_order)
    values (
      v_t.title, v_t.description, 'todo', coalesce(v_t.priority, 'P2'),
      case when v_t.parent_template_id is not null then (v_map ->> v_t.parent_template_id::text)::uuid end,
      v_project_id, p_subject_type, p_subject_id,
      case when v_t.default_assignee_role = 'owner' then p_owner end,
      p_base_date + coalesce(v_t.due_offset_days, 0),
      coalesce(v_t.sort_order, 0)
    )
    returning id into v_new_id;
    v_map := v_map || jsonb_build_object(v_t.id::text, v_new_id::text);
  end loop;

  return v_project_id;
end $fn$;

-- The UI calls this via RPC for the manual "From template" path; SECURITY
-- DEFINER bypasses RLS, so gate on the caller's CRM role explicitly.
create or replace function public.apply_project_template_rpc(
  p_template_id uuid,
  p_subject_type text,
  p_subject_id uuid,
  p_owner uuid default null,
  p_base_date date default current_date
) returns uuid
language plpgsql security definer set search_path = public as $fn$
begin
  if public.current_user_role() not in ('editor','owner') then
    raise exception 'not allowed';
  end if;
  return public.apply_project_template(p_template_id, p_subject_type, p_subject_id, p_owner, p_base_date);
end $fn$;
grant execute on function public.apply_project_template_rpc(uuid, text, uuid, uuid, date) to authenticated;

-- Auto-run matching automations when a job (onboarding) is created, and again
-- when its job_type is set or changed. apply_project_template dedupes, so a
-- type change only adds templates not already applied.
create or replace function public.run_onboarding_automations()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare
  v_a record;
begin
  for v_a in
    select a.* from automations a
    where a.enabled
      and a.event = 'onboarding_created'
      and (a.condition ->> 'job_type' is null or a.condition ->> 'job_type' = NEW.job_type)
  loop
    begin
      perform public.apply_project_template(v_a.template_id, 'onboarding', NEW.id, NEW.owner_id, current_date);
    exception when others then
      raise warning 'automation % failed: %', v_a.id, sqlerrm;
    end;
  end loop;
  return NEW;
end $fn$;

drop trigger if exists trg_onboarding_automations_ins on public.onboardings;
create trigger trg_onboarding_automations_ins after insert on public.onboardings
  for each row execute function run_onboarding_automations();

drop trigger if exists trg_onboarding_automations_type on public.onboardings;
create trigger trg_onboarding_automations_type after update of job_type on public.onboardings
  for each row when (NEW.job_type is distinct from OLD.job_type)
  execute function run_onboarding_automations();

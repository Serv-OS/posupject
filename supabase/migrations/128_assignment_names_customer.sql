-- 128_assignment_names_customer.sql (safe to run twice)
--
-- Peter, 24 Nov 2026: "when a project or an account goes onto onboarding ...
-- the message that goes out needs to say exactly which customer, we are
-- already losing things." Alerts said only "Assigned to you: Onboarding" or
-- "Assigned to you: ServOS onboarding": onboardings have no name and template
-- projects are named after the template.
--
-- Now an onboarding alert reads "NEW onboarding: <company> (<site>)" with the
-- deal in the body, and a project alert names the customer it belongs to.
-- Everything else is unchanged.

create or replace function public.notify_on_assignment() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  actor uuid := auth.uid();
  ent text := TG_ARGV[0];
  j jsonb := to_jsonb(NEW);
  title_text text;
  body_text text;
  cust text;
  site text;
  deal_name text;
  subj_type text;
  subj_id uuid;
begin
  if NEW.owner_id is null then return NEW; end if;
  if TG_OP = 'UPDATE' and NEW.owner_id is not distinct from OLD.owner_id then return NEW; end if;
  if actor is not null and NEW.owner_id = actor then return NEW; end if;  -- skip self-assignment

  title_text := coalesce(j->>'subject', j->>'name', j->>'title', initcap(ent));
  body_text := initcap(ent) || ' assigned to you';

  if ent = 'onboarding' then
    select c.name into cust from companies c where c.id = (j->>'company_id')::uuid;
    select l.name into site from locations l where l.id = (j->>'location_id')::uuid;
    select d.name into deal_name from deals d where d.id = (j->>'deal_id')::uuid;
    title_text := coalesce(cust, site, deal_name, 'a new customer')
      || case when cust is not null and site is not null and site <> cust then ' (' || site || ')' else '' end;
    if TG_OP = 'INSERT' then
      title_text := 'NEW onboarding: ' || title_text;
    else
      title_text := 'Onboarding: ' || title_text;
    end if;
    body_text := coalesce(nullif(deal_name, ''), 'Onboarding') || '. Assigned to you.';
    insert into notifications (recipient_id, actor_id, type, title, body, entity_type, link_id)
    values (NEW.owner_id, actor, 'assignment', title_text, body_text, ent, NEW.id);
    return NEW;
  end if;

  if ent = 'project' then
    subj_type := j->>'subject_type';
    subj_id := nullif(j->>'subject_id', '')::uuid;
    if subj_type = 'company' then
      select name into cust from companies where id = subj_id;
    elsif subj_type = 'location' then
      select l.name || coalesce(' (' || c.name || ')', '') into cust from locations l left join companies c on c.id = l.company_id where l.id = subj_id;
    elsif subj_type = 'deal' then
      select coalesce(c.name, d.name) into cust from deals d left join companies c on c.id = d.company_id where d.id = subj_id;
    elsif subj_type = 'onboarding' then
      select coalesce(c.name, l.name, d.name) into cust from onboardings o
        left join companies c on c.id = o.company_id left join locations l on l.id = o.location_id left join deals d on d.id = o.deal_id
        where o.id = subj_id;
    elsif subj_type = 'ticket' then
      select coalesce(c.name, t.subject) into cust from tickets t left join companies c on c.id = t.company_id where t.id = subj_id;
    end if;
    if cust is not null and position(lower(cust) in lower(title_text)) = 0 then
      title_text := title_text || ' for ' || cust;
    end if;
    if TG_OP = 'INSERT' then title_text := 'NEW project: ' || title_text; else title_text := 'Assigned to you: ' || title_text; end if;
    insert into notifications (recipient_id, actor_id, type, title, body, entity_type, link_id)
    values (NEW.owner_id, actor, 'assignment', title_text, 'Project assigned to you', ent, NEW.id);
    return NEW;
  end if;

  insert into notifications (recipient_id, actor_id, type, title, body, entity_type, link_id)
  values (NEW.owner_id, actor, 'assignment', 'Assigned to you: ' || title_text, body_text, ent, NEW.id);
  return NEW;
end $$;

-- What the last onboarding alerts would now say (check only).
select o.created_at::date,
       'NEW onboarding: ' || coalesce(c.name, l.name, d.name, 'a new customer') as would_read
  from onboardings o left join companies c on c.id = o.company_id
  left join locations l on l.id = o.location_id left join deals d on d.id = o.deal_id
 order by o.created_at desc limit 5;

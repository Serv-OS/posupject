-- Notify owners when a NEW lead is created — not only when one is assigned.
-- Website leads arrive unassigned (owner_id null), and notify_on_assignment
-- returns early for those, so nobody was alerted to a fresh lead. This fires on
-- every lead INSERT and raises a 'system' notification (which always delivers)
-- to each owner, so they get the alert (email/SMS per their notification prefs).
-- Skips the creator and the assignee (who gets the assignment notification).
-- Schema-safe: reads fields via to_jsonb so it works across the CRM variants.
create or replace function public.notify_on_new_lead()
returns trigger language plpgsql security definer as $fn$
declare
  actor uuid := auth.uid();
  j jsonb := to_jsonb(NEW);
  title_text text := coalesce(nullif(trim(j->>'name'), ''), nullif(trim(j->>'title'), ''), 'New lead');
  body_text  text := coalesce(j->>'source', 'New lead') || coalesce(' · ' || (j->>'venue_type'), '');
  owner uuid := (j->>'owner_id')::uuid;
  rec record;
begin
  for rec in select id from public.profiles where role = 'owner' loop
    if (actor is null or rec.id <> actor) and (owner is null or rec.id <> owner) then
      insert into public.notifications (recipient_id, actor_id, type, title, body, entity_type, link_id)
      values (rec.id, actor, 'system', 'New lead: ' || title_text, body_text, 'lead', NEW.id);
    end if;
  end loop;
  return NEW;
end $fn$;

drop trigger if exists trg_new_lead_notify on public.leads;
create trigger trg_new_lead_notify after insert on public.leads
  for each row execute function notify_on_new_lead();

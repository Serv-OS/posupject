-- New-lead alerts go to everyone who can work a lead, not only owners.
--
-- notify_on_new_lead() selected `role = 'owner'`, so an editor — a back-office
-- user with full lead access — never got a notification ROW, and therefore no
-- email, no SMS, no chat ping. Steve (editor, SEA) watched a lead arrive in
-- Peter's inbox and nothing in his own. Editors who don't want these can turn
-- them off per-channel in their notification preferences; being silently
-- excluded was not a preference.
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
  for rec in select id from public.profiles where role in ('owner', 'editor') loop
    if (actor is null or rec.id <> actor) and (owner is null or rec.id <> owner) then
      insert into public.notifications (recipient_id, actor_id, type, title, body, entity_type, link_id)
      values (rec.id, actor, 'system', 'New lead: ' || title_text, body_text, 'lead', NEW.id);
    end if;
  end loop;
  return NEW;
end $fn$;

-- Internal notes can be edited by the person who wrote them.
--
-- A note sent too early could only be fixed by adding another note. The table
-- has no edited stamp and its only write rule lets any editor change any row,
-- so this adds edited_at and a guard: only the author may change the text of
-- an internal note, the text of a customer email, SMS or chat cannot be
-- rewritten from the app at all, and clients cannot forge edited_at.
-- Service-role writes (edge functions: call recordings, voicemail, email
-- recipients) have no auth.uid() and pass straight through, and the phone bar
-- rewriting its own call row is untouched.

alter table public.crm_activities add column if not exists edited_at timestamptz;
comment on column public.crm_activities.edited_at is 'When the text of an internal note was last changed by its author. Null = never edited.';

create or replace function public.guard_activity_edit() returns trigger
language plpgsql as $fn$
begin
  if auth.uid() is null then return new; end if;
  new.edited_at := old.edited_at;
  if old.type = 'note' then
    if (new.body, new.subject, new.type, new.is_internal, new.actor_id, new.subject_type, new.subject_id)
       is distinct from (old.body, old.subject, old.type, old.is_internal, old.actor_id, old.subject_type, old.subject_id) then
      if not (coalesce(old.is_internal, false) and old.actor_id = auth.uid()) then
        raise exception 'Only the author can edit an internal note' using errcode = '42501';
      end if;
      if (new.type, new.is_internal, new.actor_id, new.subject_type, new.subject_id)
         is distinct from (old.type, old.is_internal, old.actor_id, old.subject_type, old.subject_id) then
        raise exception 'Only the text of a note can change' using errcode = '42501';
      end if;
      if (new.body, new.subject) is distinct from (old.body, old.subject) then new.edited_at := now(); end if;
    end if;
  elsif old.type in ('email', 'sms', 'chat', 'whatsapp')
        and (new.body, new.subject) is distinct from (old.body, old.subject) then
    raise exception 'Customer messages cannot be edited' using errcode = '42501';
  end if;
  return new;
end
$fn$;

drop trigger if exists trg_guard_activity_edit on public.crm_activities;
create trigger trg_guard_activity_edit before update on public.crm_activities
  for each row execute function public.guard_activity_edit();

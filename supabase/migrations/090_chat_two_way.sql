-- Two-way live chat. Raising the ticket no longer ends the conversation: the
-- session stays 'escalated' so the visitor and the support team talk through
-- the same widget, and it closes when a person ends it — by the End-chat
-- button, or automatically when the ticket is resolved or closed.
create or replace function public.close_chat_on_ticket_done() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.stage in ('resolved', 'closed') and new.stage is distinct from old.stage then
    update public.chat_sessions
       set status = 'closed', last_at = now()
     where ticket_id = new.id and status <> 'closed';
  end if;
  return new;
end $$;

drop trigger if exists trg_close_chat_on_ticket_done on public.tickets;
create trigger trg_close_chat_on_ticket_done
  after update of stage on public.tickets
  for each row execute function public.close_chat_on_ticket_done();

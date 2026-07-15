-- Optional auto-assignment for new leads. Website leads arrive unassigned; set
-- support_settings.default_lead_owner_id to a user's id and every new unassigned
-- lead is assigned to them on creation (which also fires their assignment alert).
-- Leave the setting NULL to keep leads unassigned (the previous behaviour).
-- The value is per-instance DATA, not shipped here — set it with:
--   update support_settings set default_lead_owner_id = '<user-id>' where id = 1;
alter table public.support_settings add column if not exists default_lead_owner_id uuid;

create or replace function public.apply_default_lead_owner()
returns trigger language plpgsql security definer as $fn$
begin
  if NEW.owner_id is null then
    NEW.owner_id := (select default_lead_owner_id from public.support_settings where id = 1);
  end if;
  return NEW;
end $fn$;

drop trigger if exists trg_default_lead_owner on public.leads;
create trigger trg_default_lead_owner before insert on public.leads
  for each row execute function apply_default_lead_owner();

-- 133_bank_feed_v2.sql (safe to run twice)
--
-- Peter, 25 Nov 2026, after connecting Monzo:
--  1. Only certain people may see the bank feed. profiles.bank_feed_access,
--     switched on per person by the owner in Users. The owner always sees it.
--     Every bank table is locked to those people, not just hidden in the menu.
--  4. An AI matcher: each unmatched line can carry ai_match, the likely
--     invoice, bill, expense or refund with a reason.
--  6. A refund and the payment it refunds are paired (pair_id), so both lines
--     are settled together instead of looking like an invoice.
--  7. Company card spend (Duncan's fuel): a line can be handed to the person
--     who spent it as a company card expense. assigned_to records who.
--     A rule can do this by itself for a payee (assign_to).

alter table public.profiles add column if not exists bank_feed_access boolean not null default false;

create or replace function public.can_see_bank() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles p
     where p.id = auth.uid()
       and (p.role = 'owner' or (p.role = 'editor' and p.bank_feed_access))
  );
$$;
grant execute on function public.can_see_bank() to authenticated;

do $$
declare t text;
begin
  foreach t in array array['bank_connections','bank_accounts','bank_transactions','bank_match_rules'] loop
    execute format('drop policy if exists %I on public.%I', t || '_rw', t);
    execute format('create policy %I on public.%I for all to authenticated using (public.can_see_bank()) with check (public.can_see_bank())', t || '_rw', t);
  end loop;
end $$;

-- Only the owner may give or take away bank feed access. Editors can update
-- their own profile row, so the column is guarded by a trigger.
create or replace function public.guard_bank_feed_access() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.bank_feed_access is distinct from old.bank_feed_access
     and auth.uid() is not null
     and coalesce((select role from profiles where id = auth.uid()), '') <> 'owner' then
    raise exception 'Only the owner can change bank feed access';
  end if;
  return new;
end $$;
drop trigger if exists guard_bank_feed_access on public.profiles;
create trigger guard_bank_feed_access before update on public.profiles
  for each row execute function public.guard_bank_feed_access();

alter table public.bank_transactions add column if not exists ai_match jsonb;
alter table public.bank_transactions add column if not exists ai_checked_at timestamptz;
alter table public.bank_transactions add column if not exists pair_id uuid references public.bank_transactions(id) on delete set null;
alter table public.bank_transactions add column if not exists assigned_to uuid references public.profiles(id) on delete set null;

alter table public.bank_match_rules add column if not exists assign_to uuid references public.profiles(id) on delete set null;

-- Check: who can see the bank feed now (the owner only, until switched on).
select display_name, role, bank_feed_access,
       role = 'owner' or (role = 'editor' and bank_feed_access) as sees_bank
  from public.profiles order by role, display_name;

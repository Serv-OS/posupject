-- 114: a locked box for the onboarding pack's bank and ID details.
--
-- The pack now asks for the bank account (sort code or routing number, account
-- number), the legal representative's date of birth and home address, and
-- photos of their ID. None of that can go where the rest of the pack lives:
--   onboarding_form_requests.answers  every logged in user can read it (081)
--   the attachments bucket            every logged in user can read, list and
--                                     delete every object in it (017)
--
-- So it gets its own table and its own private bucket, both readable by the
-- owner only. Nobody writes to either from the browser: the onboarding-form
-- edge function holds the service role, which bypasses RLS, stores the values
-- and signs each upload. That is why there is no insert policy on the table
-- and no insert or update policy on the bucket.
--
-- The pack itself only keeps answers._held, a list of which keys are held (and
-- the last 4 digits of the account number), so staff can see that the details
-- are there without seeing them.
--
-- Two guards come with it, because owner only is only as strong as the role:
--   profiles_guard_role     001 lets a user update their own profiles row with
--                           no column limit, so any editor or viewer could set
--                           their own role to owner from the browser console
--                           and read every sort code and passport here. Only an
--                           owner may now change anyone's role.
--   onb_form_req_keep_id    deleting a request cascades to its row here, but
--                           NOT to its files, and nothing would point at them
--                           again. A request (or the onboarding or company
--                           above it) cannot be deleted while its ID images
--                           are still in the bucket: the owner presses "Delete
--                           ID and bank details" on the pack first.
--
-- Idempotent: safe to run twice.
--
-- CHECK AFTER APPLYING, signed in as an editor (not with the service key):
--   update public.profiles set role = 'owner' where id = auth.uid();
-- must fail with "Only an owner can change a role."
--
-- ROLLBACK (in this order):
--   1. Empty the onboarding-secure bucket from the dashboard or the Storage API
--      (Supabase refuses a direct delete from storage.objects).
--   2. drop trigger if exists onb_form_req_keep_id on public.onboarding_form_requests;
--      drop function if exists public.onboarding_form_requests_keep_id();
--   3. drop policy if exists onboarding_secure_read on storage.objects;
--      drop policy if exists onboarding_secure_delete on storage.objects;
--   4. delete from storage.buckets where id = 'onboarding-secure';
--   5. drop table if exists public.onboarding_form_secure;
--      (drops its three policies with it)
--   6. Only if the role guard itself must go (it protects every owner only
--      rule, not just this table):
--      drop trigger if exists profiles_guard_role on public.profiles;
--      drop function if exists public.profiles_guard_role();

-- ── Only an owner changes a role ────────────────────────────────────────────
-- Checked for the API roles only (authenticated and anon, the roles PostgREST
-- runs a signed in or anonymous request as). The service role, the SQL editor
-- and the security definer handle_new_user() from 001, which makes the very
-- first user the owner, run as other roles and are not stopped. Not security
-- definer itself, so current_user is the caller. In a BEFORE trigger
-- current_user_role() still reads the row as it was, so nobody can pass the
-- check by being mid way through promoting themselves.
create or replace function public.profiles_guard_role() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.role is distinct from old.role
     and current_user in ('authenticated', 'anon')
     and public.current_user_role() is distinct from 'owner' then
    raise exception 'Only an owner can change a role.' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard_role on public.profiles;
create trigger profiles_guard_role
  before update on public.profiles
  for each row execute function public.profiles_guard_role();

create table if not exists public.onboarding_form_secure (
  request_id    uuid primary key references public.onboarding_form_requests(id) on delete cascade,
  secure_values jsonb not null default '{}'::jsonb,
  files         jsonb not null default '{}'::jsonb,
  updated_at    timestamptz not null default now(),
  purged_at     timestamptz,
  purged_by     uuid references public.profiles(id) on delete set null
);

comment on table public.onboarding_form_secure is
  'Bank and ID details from an onboarding pack. Owner-only; written only by the onboarding-form edge function (service role).';
comment on column public.onboarding_form_secure.secure_values is
  'Keyed ''section.field'', e.g. {"bank.sort_code": "123456", "representative.dob": "1990-04-21"}.';
comment on column public.onboarding_form_secure.files is
  'Keyed ''section.field'': {path, name, size, mime}. path is inside bucket onboarding-secure as <request_id>/<field_key>-<uuid>.<ext>.';
comment on column public.onboarding_form_secure.purged_at is
  'When an owner deleted the ID and bank details. secure_values and files are {} after that.';

alter table public.onboarding_form_secure enable row level security;

-- current_user_role() is the security definer helper from 001, so these read
-- the caller's role without needing read access to profiles themselves.
drop policy if exists onb_form_secure_select on public.onboarding_form_secure;
create policy onb_form_secure_select on public.onboarding_form_secure
  for select to authenticated
  using (public.current_user_role() = 'owner');

drop policy if exists onb_form_secure_update on public.onboarding_form_secure;
create policy onb_form_secure_update on public.onboarding_form_secure
  for update to authenticated
  using (public.current_user_role() = 'owner')
  with check (public.current_user_role() = 'owner');

drop policy if exists onb_form_secure_delete on public.onboarding_form_secure;
create policy onb_form_secure_delete on public.onboarding_form_secure
  for delete to authenticated
  using (public.current_user_role() = 'owner');

-- The bucket enforces the same type and size rules as the page and the
-- function, so a bypassed page still cannot store a 50MB video or an HTML file.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('onboarding-secure', 'onboarding-secure', false, 10485760, array['image/jpeg', 'image/png', 'application/pdf'])
on conflict (id) do nothing;

-- Owner can view (via a short signed URL) and delete. Written the way 017 and
-- 024 write their storage policies, which is what this project's storage
-- schema has accepted before.
do $$ begin
  create policy onboarding_secure_read on storage.objects for select to authenticated
    using (bucket_id = 'onboarding-secure' and public.current_user_role() = 'owner');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy onboarding_secure_delete on storage.objects for delete to authenticated
    using (bucket_id = 'onboarding-secure' and public.current_user_role() = 'owner');
exception when duplicate_object then null; end $$;

-- ── A request with ID images cannot be deleted ──────────────────────────────
-- Fires on a direct delete and on the cascades from onboardings and companies,
-- so a whole company delete stops too. Security definer so it can see
-- storage.objects, which the caller cannot. Every object in the folder counts,
-- including an upload that was never saved, since nothing else would ever find
-- it once the request is gone.
create or replace function public.onboarding_form_requests_keep_id() returns trigger
language plpgsql
security definer
set search_path = public, storage
as $$
begin
  if exists (
    select 1 from storage.objects o
     where o.bucket_id = 'onboarding-secure'
       and o.name like old.id::text || '/%'
  ) then
    raise exception 'This onboarding pack still holds ID images. The owner must press Delete ID and bank details on the pack before it can be deleted.'
      using errcode = '23503';
  end if;
  return old;
end;
$$;

drop trigger if exists onb_form_req_keep_id on public.onboarding_form_requests;
create trigger onb_form_req_keep_id
  before delete on public.onboarding_form_requests
  for each row execute function public.onboarding_form_requests_keep_id();

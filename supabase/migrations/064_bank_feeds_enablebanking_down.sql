-- 064_bank_feeds_enablebanking_down.sql — reverse of 064.
alter table public.bank_accounts drop column if exists account_uid;
alter table public.bank_accounts drop column if exists identification_hash;
alter table public.bank_connections drop column if exists session_id;
alter table public.bank_connections drop column if exists aspsp_country;
comment on column public.bank_accounts.gc_account_id is null;
comment on column public.bank_accounts.account_uid is null;
comment on column public.bank_connections.session_id is null;
comment on column public.bank_connections.institution_id is null;

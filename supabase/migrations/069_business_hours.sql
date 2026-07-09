-- 069_business_hours.sql (ADDITIVE) — opening hours drive phone routing
-- (out-of-hours calls → voicemail → ticket) and out-of-hours email auto-replies.
alter table public.support_settings add column if not exists business_hours_enabled boolean not null default false;
alter table public.support_settings add column if not exists business_timezone text;
alter table public.support_settings add column if not exists business_hours jsonb;
alter table public.support_settings add column if not exists after_hours_email_subject text;
alter table public.support_settings add column if not exists after_hours_email_message text;
alter table public.support_settings add column if not exists after_hours_voicemail_prompt text;

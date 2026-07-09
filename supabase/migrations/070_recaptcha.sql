-- 070_recaptcha.sql (ADDITIVE) — public site key for reCAPTCHA v2 on public forms.
-- The secret lives in the RECAPTCHA_SECRET_KEY edge secret (forms-public verifies).
alter table public.support_settings add column if not exists recaptcha_site_key text;

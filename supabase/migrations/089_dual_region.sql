-- Dual-region (UK + US) foundation.
--
-- The business now trades in both countries, which breaks three singletons:
--   * ONE phone number / hours / voice / auto-reply (support_settings id=1)
--   * ONE implicit currency (invoices and quotes had no currency column at all)
--   * ONE timezone for everything from quiet hours to recurring invoice dates
--
-- support_regions holds everything that varies by region. support_settings
-- stays as the global brand + the fallback: any region column left NULL falls
-- back to the settings row, so behaviour is byte-identical until a region is
-- actually configured. Inbound calls/texts pick their region by the Twilio
-- number that was dialled (the webhook's To field); outbound picks it by the
-- recipient's country prefix (+1 vs +44).

create table if not exists public.support_regions (
  code                          text primary key check (code in ('UK','US')),
  label                         text not null,
  country_code                  text not null,                -- 'GB' | 'US'
  currency                      text not null check (currency in ('GBP','USD')),
  tax_label                     text not null,                -- 'VAT' | 'Sales tax'
  default_tax_rate              numeric not null default 0,
  tax_regime                    text,                         -- 'UK_VAT' | 'US_SALES_TAX'
  -- The line. E.164, no spaces. NULL until a number exists for the region.
  twilio_number                 text,
  business_phone                text,                         -- display format for signatures/pages
  -- Hours, in this region's own clock. Same jsonb shape as support_settings so
  -- the shared isOpenNow() evaluator takes either row unchanged.
  business_timezone             text not null,
  business_hours_enabled        boolean not null default false,
  business_hours                jsonb not null default '{
    "mon":{"open":"09:00","close":"17:00","closed":false},
    "tue":{"open":"09:00","close":"17:00","closed":false},
    "wed":{"open":"09:00","close":"17:00","closed":false},
    "thu":{"open":"09:00","close":"17:00","closed":false},
    "fri":{"open":"09:00","close":"17:00","closed":false},
    "sat":{"closed":true},"sun":{"closed":true}}'::jsonb,
  -- Voice + copy. NULL = fall back to support_settings.
  voice_id                      text,
  voice_greeting                text,
  voicemail_prompt              text,
  after_hours_voicemail_prompt  text,
  auto_reply_sms_message        text,
  after_hours_sms_message       text,                         -- SMS had no after-hours variant anywhere
  -- Seller identity for documents raised in this region. NULL = global.
  business_name                 text,
  business_address              text,
  business_email                text,
  active                        boolean not null default true,
  updated_at                    timestamptz not null default now()
);

alter table public.support_regions enable row level security;
do $$ begin
  create policy support_regions_read on public.support_regions for select to authenticated using (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy support_regions_write on public.support_regions for all to authenticated
    using (public.current_user_role() = 'owner') with check (public.current_user_role() = 'owner');
exception when duplicate_object then null; end $$;

-- Seed UK from what the singleton already says (number stripped to E.164 —
-- the live value has spaces in it, which would break every digits comparison),
-- and a US region ready to receive its number.
insert into public.support_regions
  (code, label, country_code, currency, tax_label, default_tax_rate, tax_regime,
   twilio_number, business_phone, business_timezone, business_hours_enabled, business_hours)
select 'UK', 'United Kingdom', 'GB', 'GBP', 'VAT', 20, 'UK_VAT',
       nullif(replace(coalesce(s.twilio_number, ''), ' ', ''), ''),
       s.business_phone,
       coalesce(s.business_timezone, 'Europe/London'),
       coalesce(s.business_hours_enabled, false),
       coalesce(s.business_hours, '{"mon":{"open":"09:00","close":"17:00","closed":false},"tue":{"open":"09:00","close":"17:00","closed":false},"wed":{"open":"09:00","close":"17:00","closed":false},"thu":{"open":"09:00","close":"17:00","closed":false},"fri":{"open":"09:00","close":"17:00","closed":false},"sat":{"closed":true},"sun":{"closed":true}}'::jsonb)
  from public.support_settings s where s.id = 1
on conflict (code) do nothing;

insert into public.support_regions
  (code, label, country_code, currency, tax_label, default_tax_rate, tax_regime,
   business_timezone, voice_id)
values
  ('US', 'United States', 'US', 'USD', 'Sales tax', 0, 'US_SALES_TAX',
   'America/Los_Angeles', 'Polly.Joanna-Neural')
on conflict (code) do nothing;

-- ── Currency on money documents ─────────────────────────────────────────────
-- Until now GBP was implicit: a USD invoice would have stored bare numbers,
-- rendered as £, and charged the customer in GBP via Stripe without an error
-- anywhere. The column makes the currency a fact of the document.
alter table public.invoices           add column if not exists currency text not null default 'GBP' check (currency in ('GBP','USD'));
alter table public.quotes             add column if not exists currency text not null default 'GBP' check (currency in ('GBP','USD'));
alter table public.recurring_invoices add column if not exists currency text not null default 'GBP' check (currency in ('GBP','USD'));

-- ── Which line a conversation lives on ──────────────────────────────────────
-- The Twilio number a customer texted/called was only ever captured inside
-- crm_activities.channel_metadata, so replies had no way to go out from the
-- right number. Stamp it on the ticket.
alter table public.tickets add column if not exists service_number text;

-- ── Per-person timezone ─────────────────────────────────────────────────────
-- Quiet hours were evaluated hardcoded on Europe/London: a US agent's
-- 22:00-07:00 window muted their working afternoon. NULL = Europe/London,
-- exactly the old behaviour.
alter table public.profiles add column if not exists timezone text;

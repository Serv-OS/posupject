-- 120_adyen_payments.sql (ADDITIVE, safe to run twice)
--
-- ServOS takes its own quote and invoice payments on its own Adyen account
-- instead of Stripe. The money path does NOT change: record_invoice_payment
-- (115/116) still does the work, still under the same lock as credit notes,
-- and it is still handed one id per payment to recognise a repeat delivery by.
-- On Stripe that id was the checkout session; on Adyen it is the pspReference.
-- The column it keeps them in (invoices.stripe_paid_sessions) is private to
-- that function, so it is left alone rather than renamed: a rename would mean
-- rewriting a 90 line money function for cosmetics.
--
-- This migration only adds somewhere to put the link, and a log of every
-- notification Adyen sends us.

-- 1. The link we sent the customer, so it can be read back or expired.
alter table public.quotes   add column if not exists adyen_link_id text;
alter table public.invoices add column if not exists adyen_link_id text;

comment on column public.invoices.adyen_link_id is
  'The Adyen Pay by Link id (PL...) of the most recent payment link for this invoice. Adyen deletes link details after three months; the money itself is identified by the pspReference on adyen_events.';

-- 2. Every notification, verified or not, exactly once.
--    The unique index is what makes a repeat delivery harmless, and the row is
--    also the audit trail for the ones we deliberately do nothing with.
create table if not exists public.adyen_events (
  id                 uuid primary key default gen_random_uuid(),
  psp_reference      text not null,
  event_code         text not null,
  merchant_reference text,
  success            boolean not null default false,
  live               boolean not null default false,
  -- received | signature_failed
  state              text not null default 'received',
  payload            jsonb not null,
  result             jsonb,
  handled_at         timestamptz,
  created_at         timestamptz not null default now()
);

-- One row per (payment, event). Adyen retries for days, and every retry
-- carries the same pair, so this is the thing that stops a double count.
create unique index if not exists adyen_events_once on public.adyen_events (psp_reference, event_code);
create index if not exists adyen_events_reference on public.adyen_events (merchant_reference);
create index if not exists adyen_events_created on public.adyen_events (created_at desc);

-- 3. Only the service role writes these (the webhook), and only an owner reads
--    them: a payment log is not something an editor needs, and never a viewer.
alter table public.adyen_events enable row level security;

drop policy if exists adyen_events_read_owner on public.adyen_events;
create policy adyen_events_read_owner on public.adyen_events
  for select using (public.current_user_role() = 'owner');

-- No insert, update or delete policy on purpose: the webhook writes with the
-- service role, which bypasses RLS, and nobody else should be writing here.
revoke insert, update, delete, truncate on public.adyen_events from anon, authenticated;

-- ROLLBACK
--   drop table public.adyen_events;
--   alter table public.quotes   drop column adyen_link_id;
--   alter table public.invoices drop column adyen_link_id;

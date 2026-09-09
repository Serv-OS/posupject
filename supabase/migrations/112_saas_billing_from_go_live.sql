-- Software billing starts when the account goes live, not when the quote is signed.
--
-- Until now nothing in code ever billed a subscription: signing charged the
-- one-off lines and the SaaS lines were a sentence on the page. Now a quote
-- carries the delay it promised the customer, and the moment an onboarding is
-- set to live (or handed to support) a billing schedule is built from that
-- deal's won quote: monthly lines to a monthly schedule, annual to annual, in
-- the quote's currency, first bill on the go-live day plus the delay. Once
-- per quote and frequency, however many times the stage is bounced.

alter table public.quotes
  add column if not exists saas_start_days integer not null default 0
    check (saas_start_days >= 0 and saas_start_days <= 365);
comment on column public.quotes.saas_start_days is
  'Days after the account goes live before software billing starts. 0 = from the go-live day. Shown to the customer on the quote.';

alter table public.recurring_invoices
  add column if not exists quote_id uuid references public.quotes(id) on delete set null,
  add column if not exists source text;
comment on column public.recurring_invoices.quote_id is 'The quote whose software lines this schedule bills. Set when the schedule was built automatically at go-live.';
comment on column public.recurring_invoices.source   is '''go_live'' when built by the go-live trigger; null when made by hand.';
-- one live schedule per quote and frequency, so a stage that bounces cannot bill twice
create unique index if not exists recurring_invoices_one_per_quote_freq
  on public.recurring_invoices (quote_id, frequency) where quote_id is not null and active;

alter table public.onboardings
  add column if not exists went_live_at timestamptz;
comment on column public.onboardings.went_live_at is 'When the stage first reached live or handover. The ACTUAL go-live, unlike target_go_live.';

create or replace function public.start_saas_billing_on_live()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  q record;
  freq text;
  bt text;
  region_tz text;
  live_day date;
  first_bill date;
  line_rows jsonb;
  n_lines int;
  contact_email text;
  company_name text;
begin
  -- Only on the way IN to live/handover, and only once.
  if new.stage is not distinct from old.stage then return new; end if;
  if new.stage not in ('live','handover_to_support') then return new; end if;
  if old.stage in ('live','handover_to_support') then return new; end if;
  if new.went_live_at is null then
    update public.onboardings set went_live_at = now() where id = new.id;
  end if;
  if new.deal_id is null then return new; end if;

  -- The quote the customer signed: the most recently signed won quote on this deal.
  select qt.* into q
    from public.quotes qt
   where qt.deal_id = new.deal_id
     and qt.status in ('won','paid','signed')
   order by qt.signed_at desc nulls last, qt.accepted_at desc nulls last, qt.created_at desc
   limit 1;
  if not found then return new; end if;

  -- The customer's day, the same way invoice-recurring decides "today" for a schedule.
  region_tz := case when q.currency = 'USD' then 'America/Los_Angeles' else 'Europe/London' end;
  live_day  := (now() at time zone region_tz)::date;
  first_bill := live_day + coalesce(q.saas_start_days, 0);

  select c.email into contact_email from public.contacts c where c.id = q.contact_id;
  select co.name into company_name from public.companies co where co.id = q.company_id;

  -- One schedule per billing frequency. Only software: card-processing
  -- 'payments' lines are margin, not a subscription, and 'usage' has no
  -- fixed amount to schedule.
  for freq, bt in values ('monthly','monthly'), ('annual','annual') loop
    select jsonb_agg(jsonb_build_object(
             'name', li.name,
             'description', li.description,
             'qty', coalesce(li.qty, 1),
             -- the price the customer agreed, discount applied, per period
             'unit_price', round(coalesce(li.unit_price,0) * (1 - coalesce(li.discount,0)/100.0), 2),
             'tax_rate', li.tax_rate
           ) order by li.sort), count(*)
      into line_rows, n_lines
      from public.quote_line_items li
     where li.quote_id = q.id
       and li.billing_type = bt
       and coalesce(li.category,'saas') <> 'payments';
    if coalesce(n_lines,0) = 0 then continue; end if;
    if exists (select 1 from public.recurring_invoices r where r.quote_id = q.id and r.frequency = freq and r.active) then continue; end if;

    insert into public.recurring_invoices
      (label, company_id, location_id, contact_id, email_to, frequency, day_of_month, next_run, due_days,
       tax_rate, lines, terms, notes, auto_send, active, created_by, currency, quote_id, source)
    values
      ('Software · ' || coalesce(company_name, 'customer') || case when freq = 'annual' then ' (annual)' else '' end,
       q.company_id,
       coalesce(q.location_id, new.location_id),
       q.contact_id,
       contact_email,
       freq,
       least(extract(day from first_bill)::int, 28),
       first_bill,
       14,
       coalesce(q.tax_rate, case when q.currency = 'USD' then 0 else 20 end),
       line_rows,
       q.terms,
       'Started automatically when the account went live on ' || to_char(live_day, 'DD Mon YYYY')
         || case when coalesce(q.saas_start_days,0) > 0 then ', with ' || q.saas_start_days || ' days before the first bill' else '' end
         || '. From quote #' || q.quote_number || '.',
       -- with nobody to send to, an auto-sent invoice would sit as a draft and clog the daily send window
       contact_email is not null,
       true,
       q.created_by,
       coalesce(q.currency, 'GBP'),
       q.id,
       'go_live');
  end loop;
  return new;
end;
$$;

drop trigger if exists trg_onboarding_start_billing on public.onboardings;
create trigger trg_onboarding_start_billing
  after update of stage on public.onboardings
  for each row execute function public.start_saas_billing_on_live();

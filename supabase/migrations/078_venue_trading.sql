-- Venue trading figures — what the CUSTOMER turns over, not what we earn.
--
-- deals already carries our side of the commercials (hardware_value,
-- services_value, saas_arr, payments_arr). This is the other half: what the
-- venue itself expects to take, asked in discovery — "what do you expect to
-- turn over a month?", "what's your average transaction?" — so we can pitch
-- against it and, once won, know how much volume is running through our system.
--
-- Two sets of figures per site, deliberately:
--   est_*     what they told us during the sale
--   actual_*  what the venue really does, once live
-- Keeping both is the only way to find out whether prospects over-state their
-- turnover, and it separates forecast volume from volume actually under
-- management.
--
-- Transaction counts are generated, never typed: revenue ÷ average transaction.
-- A rep entering all three would eventually enter three numbers that disagree.

alter table public.locations
  add column if not exists est_monthly_revenue     numeric check (est_monthly_revenue is null or est_monthly_revenue >= 0),
  add column if not exists est_avg_transaction     numeric check (est_avg_transaction is null or est_avg_transaction >= 0),
  add column if not exists actual_monthly_revenue  numeric check (actual_monthly_revenue is null or actual_monthly_revenue >= 0),
  add column if not exists actual_avg_transaction  numeric check (actual_avg_transaction is null or actual_avg_transaction >= 0),
  add column if not exists trading_notes           text,
  add column if not exists trading_updated_at      timestamptz;

alter table public.locations
  add column if not exists est_monthly_transactions numeric
    generated always as (
      case when coalesce(est_avg_transaction, 0) > 0
           then round(est_monthly_revenue / est_avg_transaction) end
    ) stored,
  add column if not exists actual_monthly_transactions numeric
    generated always as (
      case when coalesce(actual_avg_transaction, 0) > 0
           then round(actual_monthly_revenue / actual_avg_transaction) end
    ) stored;

-- Deal-level override. A deal usually rolls up from the sites attached to it,
-- but early on there are no sites yet and a rep still needs somewhere to put
-- "they reckon about 40k a month". Set, it wins; blank, the roll-up shows.
alter table public.deals
  add column if not exists est_monthly_revenue numeric check (est_monthly_revenue is null or est_monthly_revenue >= 0),
  add column if not exists est_avg_transaction numeric check (est_avg_transaction is null or est_avg_transaction >= 0);

-- ── How likely each stage is to land ────────────────────────────────────────
-- Editable, because these are commercial judgements and will be argued about.
create table if not exists public.deal_stage_weights (
  stage       text primary key,
  probability numeric not null check (probability >= 0 and probability <= 1),
  sort        int not null default 0
);
insert into public.deal_stage_weights (stage, probability, sort) values
  ('new_lead',      0.05, 1),
  ('contacted',     0.10, 2),
  ('qualified',     0.25, 3),
  ('demo_booked',   0.40, 4),
  ('demo_done',     0.55, 5),
  ('proposal_sent', 0.70, 6),
  ('negotiation',   0.85, 7),
  ('closed_won',    1.00, 8),
  ('closed_lost',   0.00, 9)
on conflict (stage) do nothing;

alter table public.deal_stage_weights enable row level security;
drop policy if exists deal_stage_weights_read on public.deal_stage_weights;
create policy deal_stage_weights_read on public.deal_stage_weights
  for select using (auth.uid() is not null);
drop policy if exists deal_stage_weights_write on public.deal_stage_weights;
create policy deal_stage_weights_write on public.deal_stage_weights for all
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('owner','editor')))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('owner','editor')));

-- ── Deal roll-up ────────────────────────────────────────────────────────────
-- Average transaction across several sites is NOT the average of their averages
-- — a 40-cover restaurant and a coffee kiosk would weight equally. It is total
-- revenue ÷ total transactions, which is why the transaction counts matter.
create or replace view public.deal_trading
with (security_invoker = on) as
with sites as (
  select d.id as deal_id, l.*
  from public.deals d
  join public.associations a
    on (a.from_type = 'deal' and a.from_id = d.id and a.to_type   = 'location')
    or (a.to_type   = 'deal' and a.to_id   = d.id and a.from_type = 'location')
  join public.locations l
    on l.id = case when a.from_type = 'location' then a.from_id else a.to_id end
),
rolled as (
  select deal_id,
         count(distinct id)                        as site_count,
         sum(est_monthly_revenue)                  as est_rev,
         sum(est_monthly_transactions)             as est_txn,
         sum(actual_monthly_revenue)               as act_rev,
         sum(actual_monthly_transactions)          as act_txn
  from sites group by deal_id
),
eff as (
  select d.id as deal_id,
         coalesce(d.est_monthly_revenue, r.est_rev) as rev,
         coalesce(d.est_avg_transaction,
                  case when coalesce(r.est_txn, 0) > 0 then r.est_rev / r.est_txn end) as atv,
         r.act_rev,
         r.act_txn,
         coalesce(r.site_count, 0) as site_count,
         (d.est_monthly_revenue is not null or d.est_avg_transaction is not null) as is_override
  from public.deals d
  left join rolled r on r.deal_id = d.id
)
select d.id as deal_id, d.name, d.stage, d.owner_id, d.company_id, d.currency,
       d.expected_close_date, d.closed_at, d.created_at,
       e.site_count,
       e.is_override,
       e.rev as est_monthly_revenue,
       e.atv as est_avg_transaction,
       case when coalesce(e.atv, 0) > 0 then round(e.rev / e.atv) end as est_monthly_transactions,
       e.act_rev as actual_monthly_revenue,
       case when coalesce(e.act_txn, 0) > 0 then round(e.act_rev / e.act_txn, 2) end as actual_avg_transaction,
       e.act_txn as actual_monthly_transactions,
       coalesce(w.probability, 0) as probability,
       round(coalesce(e.rev, 0) * coalesce(w.probability, 0), 2) as weighted_monthly_revenue,
       (d.stage = 'closed_won')  as is_won,
       (d.stage in ('closed_won', 'closed_lost')) as is_closed
from public.deals d
join eff e on e.deal_id = d.id
left join public.deal_stage_weights w on w.stage = d.stage;

comment on view public.deal_trading is
  'Venue trading per deal: rolled up from linked locations, or the deal-level override when set. '
  'Average transaction is total revenue over total transactions, never an average of averages.';

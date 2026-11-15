-- 126_deal_stages_pos.sql (safe to run twice)
--
-- The deal pipeline for selling POS (Peter, 15 Nov 2026):
--   Discovery, Statement & Savings, Demo, Proposal Sent, Negotiation, Won, Lost.
-- New / Contacted / Qualified were lead steps (the Leads board does those), and
-- Demo Booked / Demo Done were one step. Won and Lost keep their keys
-- (closed_won / closed_lost): quotes, onboarding and reports key on them.
-- Stage history keeps the old names; the app still reads them as words.

begin;

alter table public.deals drop constraint if exists deals_stage_check;

update public.deals set stage = case stage
    when 'new_lead'    then 'discovery'
    when 'contacted'   then 'discovery'
    when 'qualified'   then 'discovery'
    when 'demo_booked' then 'demo'
    when 'demo_done'   then 'demo'
    else stage end
  where stage in ('new_lead', 'contacted', 'qualified', 'demo_booked', 'demo_done');

alter table public.deals alter column stage set default 'discovery';
alter table public.deals add constraint deals_stage_check check (stage in (
  'discovery', 'statement', 'demo', 'proposal_sent', 'negotiation', 'closed_won', 'closed_lost'));

-- The demo is one stage; its date sits on the deal.
alter table public.deals add column if not exists demo_date date;
comment on column public.deals.demo_date is 'When the demo is (or was). Demo is one stage since migration 126.';

-- Forecast odds for the new stages.
delete from public.deal_stage_weights
 where stage not in ('discovery', 'statement', 'demo', 'proposal_sent', 'negotiation', 'closed_won', 'closed_lost');
insert into public.deal_stage_weights (stage, probability, sort) values
  ('discovery', 0.10, 1), ('statement', 0.25, 2), ('demo', 0.45, 3), ('proposal_sent', 0.65, 4),
  ('negotiation', 0.85, 5), ('closed_won', 1.00, 6), ('closed_lost', 0.00, 7)
on conflict (stage) do update set probability = excluded.probability, sort = excluded.sort;

commit;

-- Check: every deal on a new stage.
select stage, count(*) from public.deals group by stage order by stage;

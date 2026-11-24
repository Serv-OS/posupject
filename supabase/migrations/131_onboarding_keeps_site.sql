-- 131_onboarding_keeps_site.sql (safe to run twice)
--
-- Peter, 24 Nov 2026: "throughout the signing process there is a location
-- attached but then when it goes to onboarding you need to re link the
-- location". execute_quote made the onboarding with company, deal and owner
-- only; the quote's site was never copied, so every onboarding started with
-- "No venue set".
--
-- Now the onboarding takes the site from, in order: the accepted quote, a
-- site linked to the deal, or the company's only site. An onboarding that
-- already exists without a site is filled in the same way. Old onboardings
-- with no site are back filled below.

create or replace function public.execute_quote(p_quote_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path = public
as $function$
declare
  q public.quotes%rowtype;
  d public.deals%rowtype;
  ob_id uuid;
  site uuid;
begin
  select * into q from public.quotes where id = p_quote_id;
  if q.id is null then return; end if;

  update public.quotes set status = 'won' where id = p_quote_id and status <> 'won';

  if q.deal_id is null then return; end if;
  select * into d from public.deals where id = q.deal_id;
  if d.id is null then return; end if;

  if d.stage <> 'closed_won' then
    update public.deals set stage = 'closed_won', closed_at = now() where id = d.id;
    insert into public.stage_history (object_type, object_id, from_stage, to_stage, changed_by)
      values ('deal', d.id, d.stage, 'closed_won', d.owner_id);
  end if;

  -- The site being installed: the quote's, else one linked to the deal,
  -- else the company's only site.
  site := q.location_id;
  if site is null then
    select a.to_id into site from public.associations a
     where a.from_type = 'deal' and a.from_id = d.id and a.to_type = 'location'
     order by a.created_at limit 1;
  end if;
  if site is null and d.company_id is not null then
    select min(l.id::text)::uuid into site from public.locations l
     where l.company_id = d.company_id
    having count(*) = 1;
  end if;

  -- Onboarding (one per deal)
  select id into ob_id from public.onboardings where deal_id = d.id limit 1;
  if ob_id is null then
    insert into public.onboardings (company_id, deal_id, owner_id, location_id, target_go_live, notes)
      values (d.company_id, d.id, d.owner_id, site, q.go_live_date, 'Auto-created from accepted quote #' || q.quote_number)
      returning id into ob_id;
    insert into public.stage_history (object_type, object_id, from_stage, to_stage, changed_by)
      values ('onboarding', ob_id, null, 'kickoff', d.owner_id);
    -- copy location + contact associations from the deal
    insert into public.associations (from_type, from_id, to_type, to_id, label)
      select 'onboarding', ob_id, 'location', a.to_id, coalesce(a.label, 'affected_location')
      from public.associations a where a.from_type = 'deal' and a.from_id = d.id and a.to_type = 'location';
    insert into public.associations (from_type, from_id, to_type, to_id, label)
      select 'onboarding', ob_id, 'contact', a.to_id, a.label
      from public.associations a where a.from_type = 'deal' and a.from_id = d.id and a.to_type = 'contact';
  elsif site is not null then
    update public.onboardings set location_id = site where id = ob_id and location_id is null;
  end if;
end;
$function$;

-- Back fill: onboardings that never got their site.
with pick as (
  select o.id,
         coalesce(
           (select q.location_id from public.quotes q
             where q.deal_id = o.deal_id and q.location_id is not null
             order by (q.status in ('won','paid','accepted')) desc, q.created_at desc limit 1),
           (select a.to_id from public.associations a
             where a.from_type = 'deal' and a.from_id = o.deal_id and a.to_type = 'location'
             order by a.created_at limit 1),
           (select a.to_id from public.associations a
             where a.from_type = 'onboarding' and a.from_id = o.id and a.to_type = 'location'
             order by a.created_at limit 1),
           (select min(l.id::text)::uuid from public.locations l
             where l.company_id = o.company_id having count(*) = 1)
         ) as site
    from public.onboardings o
   where o.location_id is null
)
update public.onboardings o set location_id = pick.site
  from pick where pick.id = o.id and pick.site is not null;

-- Check: onboardings still without a site (should be none, or only ones
-- where the company has several sites and nothing says which).
select o.created_at::date, c.name as company, o.notes
  from public.onboardings o left join public.companies c on c.id = o.company_id
 where o.location_id is null order by o.created_at desc;

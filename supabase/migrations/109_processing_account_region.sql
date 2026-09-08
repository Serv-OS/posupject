-- 109: a rate card knows which country's costs it is priced against.
--
-- The region was being derived from the COMPANY's country at render time. Two
-- problems with that: a company with no country silently read as UK, and a US
-- site under a UK parent (or a company trading in both) had no way to say so.
-- Mozz Pizza is the case in point: no country on the company, a US site, and
-- the rate card auto-filled with UK interchange and pound signs.
--
-- Storing it makes the choice explicit, visible on the card, and stable when
-- someone later edits the company.
--
-- ROLLBACK: alter table public.processing_accounts drop column region_code;

alter table public.processing_accounts
  add column if not exists region_code text
  references public.support_regions(code) on delete set null;

comment on column public.processing_accounts.region_code is
  'Which cost template this rate card is priced against. Defaults from the site''s country, then the company''s.';

-- Backfill from the best evidence we have: the site's country, else the company's.
update public.processing_accounts a
   set region_code = case
         when upper(coalesce(l.country, c.country, 'GB')) = 'US' then 'US' else 'UK' end
  from public.processing_accounts a2
  left join public.locations l on l.id = a2.location_id
  left join public.companies c on c.id = a2.company_id
 where a.id = a2.id and a.region_code is null;

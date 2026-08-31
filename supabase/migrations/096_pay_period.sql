-- The pay month is not the calendar month.
--
-- This business runs 27th to 26th, so a calendar-month timesheet splits a pay
-- run across two screens and totals hours that were never paid together. The
-- day is configurable rather than hardcoded, because the next business to use
-- this will have a different one — 1st, 15th and 25th are all common.
--
-- Capped at 28 for the same reason day_of_month is capped on recurring
-- invoices: a period starting on the 30th has no start in February.
alter table public.support_settings
  add column if not exists pay_period_start_day int not null default 1
    check (pay_period_start_day between 1 and 28);

comment on column public.support_settings.pay_period_start_day is
  'Day of month the pay period starts. 1 = calendar month. 27 means 27th to the 26th of the following month.';

update public.support_settings set pay_period_start_day = 27 where id = 1;

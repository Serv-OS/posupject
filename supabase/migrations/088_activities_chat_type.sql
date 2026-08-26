-- The chat bot mirrors every message of a handed-over conversation onto the
-- ticket so the team reads what was actually said. Those rows are type 'chat',
-- which this CHECK did not allow, so every insert was rejected and the ticket
-- opened with "0 messages" — the same failure as the channel check in 087, one
-- table along. posupcrm already allows it; this brings posupject level.
alter table public.crm_activities drop constraint if exists crm_activities_type_check;
alter table public.crm_activities add constraint crm_activities_type_check
  check (type = any (array['call','email','sms','note','meeting','whatsapp','chat']));

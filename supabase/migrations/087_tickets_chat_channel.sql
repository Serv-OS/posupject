-- Let a ticket say it came from the chat.
--
-- The chat function raises tickets with channel 'chat' — posupcrm's table has
-- allowed that for as long as the bot has existed, this one never did. Every
-- escalation therefore failed the check constraint: the bot told the customer
-- "I'll get someone onto this", marked the session escalated, and no ticket was
-- ever created. The error was logged, but nobody reads function logs.
alter table public.tickets drop constraint if exists tickets_channel_check;
alter table public.tickets add constraint tickets_channel_check
  check (channel = any (array['email','sms','whatsapp','phone','web','chat']));

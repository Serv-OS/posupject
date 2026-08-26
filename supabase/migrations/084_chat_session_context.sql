-- 084_chat_session_context.sql
--
-- Let a chat session record WHERE it was opened from.
--
-- WHY: a POS till already knows its venue, its terminal and its app version, but
-- the chat had no way to carry any of it, so every support conversation opened
-- with "which site are you?". chat.js now forwards a data-context blob and the
-- chat function stores it here.
--
-- This is CLIENT SUPPLIED and therefore a claim, not an identity. Nothing is
-- authorised from it. The chat function caps it at 12 keys of 200 chars, and the
-- escalated ticket prints it under "Reported by the device" so an agent can see
-- it is unverified. chat_sessions.location_id remains the only trusted venue link.
--
-- Additive and nullable: existing rows and the public website embed, which sends
-- no context, are unaffected.

begin;

alter table public.chat_sessions
  add column if not exists context jsonb;

comment on column public.chat_sessions.context is
  'Unverified context reported by the embedding page (venue, terminal, app version). A claim, never an identity. Capped by the chat function.';

commit;

-- Rollback:
-- begin;
--   alter table public.chat_sessions drop column if exists context;
-- commit;

-- 072_voice_id.sql (ADDITIVE) — configurable TTS voice for phone <Say> prompts.
-- Values are Amazon Polly voice ids (Twilio supports these natively), e.g.
-- 'Polly.Amy-Neural' (British F), 'Polly.Joanna-Neural' (US F). Replaces robotic 'alice'.
alter table public.support_settings add column if not exists voice_id text;

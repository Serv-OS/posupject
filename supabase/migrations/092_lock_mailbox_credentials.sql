-- gmail_connections held a LIVE Google refresh token behind a SELECT policy of
-- `true` — readable by every authenticated session via PostgREST. A refresh
-- token is worse than a data leak: it keeps working after that person's CRM
-- login is revoked, and it can read and send company email from outside the
-- app entirely.
--
-- The write policy was already owner-only, so the read was simply inconsistent
-- with it. Edge functions use the service role and bypass RLS, so nothing
-- server-side changes. The only client reader is SettingsPanel, whose mailbox
-- controls are already owner-gated — an editor now sees the section empty
-- instead of seeing the credential.
drop policy if exists gmail_conn_read on public.gmail_connections;
create policy gmail_conn_read on public.gmail_connections
  for select to authenticated
  using (public.current_user_role() = 'owner');

-- Same class of problem, smaller blast radius: support_settings is world-
-- readable to any session and carries google_client_id and the Twilio number.
-- The anon-facing public_branding view already exposes the handful of columns
-- the login screen and public pages genuinely need, so the base table does not
-- need to be readable by everyone.
drop policy if exists support_settings_read on public.support_settings;
create policy support_settings_read on public.support_settings
  for select to authenticated
  using (public.current_user_role() = any (array['editor','owner']));

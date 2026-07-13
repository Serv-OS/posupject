-- Make the conversation timeline auto-refresh when a new message (e.g. an
-- inbound email reply) lands. ConversationTimeline subscribes to postgres_changes
-- on crm_activities, but Realtime only broadcasts rows for tables in the
-- supabase_realtime publication. crm_activities was missing from it on some
-- instances, so replies never surfaced until a manual reload. RLS already gates
-- SELECT to authenticated staff, so adding it here is safe.
-- Idempotent: skips if the table is already published.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'crm_activities'
  ) then
    alter publication supabase_realtime add table public.crm_activities;
  end if;
end $$;

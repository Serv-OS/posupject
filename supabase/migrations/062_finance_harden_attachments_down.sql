-- Rollback for 062_finance_harden_attachments.sql — restore open read.
drop policy if exists attachments_meta_read on public.attachments;
create policy attachments_meta_read on public.attachments for select to authenticated using (true);

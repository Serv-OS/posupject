-- 062_finance_harden_attachments.sql
-- Phase 6: stop expense/bill RECEIPTS (financial PII) being readable by every authenticated
-- user. Non-financial attachments (tickets, invoices, etc.) keep the existing open read, so
-- nothing else changes. Replaces the blanket USING(true) read policy with a conditional one.
-- (Defence-in-depth note: the storage bucket itself is still signed-URL + bucket-scoped; this
-- gates who can SEE/locate a receipt row in the app, closing the realistic browsing leak.)

drop policy if exists attachments_meta_read on public.attachments;
create policy attachments_meta_read on public.attachments for select to authenticated
using (
  subject_type not in ('expense', 'bill')                       -- everything else: unchanged
  or current_user_role() in ('editor', 'owner')                 -- approvers/admin
  or uploaded_by = auth.uid()                                   -- the uploader
  or (subject_type = 'expense' and exists (                     -- the claim's submitter
        select 1 from public.expenses e
        where e.id::text = attachments.subject_id::text and e.submitter_id = auth.uid()))
);

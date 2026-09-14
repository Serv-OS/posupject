-- 116: applying credit from a credit note to another invoice.
--
-- A credit note on an invoice that was already paid leaves money owed back
-- (refund_due, "Refund owed" until now). The customer often does not want it
-- back: they want it off their next invoice, and pay 224 less. This records
-- that. A credit allocation takes part of a credit note's credit available and
-- applies it to another sent or viewed invoice, so the credit note shows Used
-- and the invoice shows "Credit applied CN-1001" above a smaller balance due.
--
-- An allocation is a settlement, NOT revenue and NOT cash. It never changes the
-- invoice's amount_paid, so revenue and Collected stay what they were. It goes
-- in a column of its own, invoices.amount_allocated, and
--   balance due = total - amount_paid - amount_credited - amount_allocated,
--                 never below 0, in pennies (the rounding rule in 115)
--   settled     = amount_paid + amount_allocated
-- Every refund sum (issue, cancel, a card payment) now compares SETTLED, not
-- just paid, with what the invoice asks for, so a later credit on an invoice
-- that credit helped to settle hands back the right amount.
--
-- On the credit note, refund_due stays all the money the note hands back. Of
-- that, amount_allocated has been applied to invoices and refunded_amount has
-- been refunded; what is left is its credit available:
--   credit available = refund_due - amount_allocated - refunded_amount,
--                      never below 0, only while refund_status is owed
-- refund_status gains 'allocated' (shown Used): nothing left, all of it applied.
-- Part applied stays owed. Mark refunded refunds only what is left, and a note
-- that was part used and then refunded is 'refunded'.
--
-- A credit note holds ONE refund: one amount, date, method and note, which the
-- reports take off Collected on that date. So Mark refunded is refused on a
-- note that already has a refund on it. That only happens when credit applied
-- from a refunded note is removed: the credit it gets back can be applied to
-- an invoice again, but not refunded a second time over the first refund.
--
-- When an allocation brings an invoice's balance to 0 it becomes paid (paid_at
-- now) and amount_paid is set to the cash actually received, 0 if none, so a
-- null never reads as "paid in full in cash". Removing an allocation (owner
-- only, with a reason) never deletes the row: it is marked removed, the credit
-- is available again and a paid invoice that now has a balance goes back to
-- sent. Its paid_at is kept as the day the earlier money came in, as
-- cancel_credit_note keeps it, so cash already received stays in Collected
-- for the month it arrived. invoices has no viewed_at, so it cannot know it had
-- been viewed; the customer's next look at the pay page marks it viewed again.
--
-- Nobody writes credit_allocations from the browser. As with credit notes,
-- every change goes through the security definer functions below, which check
-- the role and lock both invoices in the same order (lowest id first) so two
-- people applying or removing credit at once cannot pass each other.
-- src/lib/creditNotes.js makes the same checks, in the same order and with the
-- same words (allocationProblems, allocationEffect, removeAllocationEffect,
-- cancelCreditEffect, refundFor); keep them in step.
--
-- THE GUARDS
--   An invoice with credit applied to it keeps its totals, currency, customer
--   and lines, as a credited invoice does, until the credit is removed.
--   An invoice cannot be voided or deleted while credit is applied to it or
--   from one of its credit notes.
--   A credit note with credit applied from it cannot be cancelled.
--
-- Idempotent: safe to run twice. Apply after 115_credit_notes.sql.
--
-- CHECK AFTER APPLYING, signed in as an editor (not with the service key):
--   insert into public.credit_allocations (credit_note_id, invoice_id, amount)
--     select c.id, i.id, 1 from public.credit_notes c, public.invoices i limit 1;
-- must fail (permission denied), and
--   select public.remove_credit_allocation(gen_random_uuid(), 'test');
-- must fail with "Only an owner can remove applied credit."
--
-- ROLLBACK (roll the app back first: the invoice screens, the public pages and
-- stripe-webhook read these columns.) 115 has no applied credit, so each piece
-- of it becomes what 115 can show, both on the day it was applied: cash on the
-- invoice it went to (so that invoice still reads as paid) and a refund from
-- the note it came from (so Collected still balances). 115 also holds one
-- refund figure per note, all owed or all refunded, so a note that still has
-- credit left keeps only that left, as owed. List those first; what they
-- applied or refunded drops out of the refunds in the reports:
--   select credit_number, refund_due, amount_allocated, refunded_amount from public.credit_notes
--    where status = 'issued' and refund_status = 'owed' and (amount_allocated > 0 or refunded_amount > 0);
-- Then:
--   drop function if exists public.allocate_credit(uuid, uuid, numeric, text);
--   drop function if exists public.remove_credit_allocation(uuid, text);
--   update public.invoices i
--      set amount_paid = coalesce(i.amount_paid, case when i.status = 'paid' then greatest(0, i.total - a.sum) else 0 end) + a.sum,
--          paid_at = coalesce(i.paid_at, (a.last + time '12:00') at time zone 'UTC')
--     from (select invoice_id, sum(amount) as sum, max(allocated_on) as last from public.credit_allocations
--            where removed_at is null group by invoice_id) a
--    where a.invoice_id = i.id;
--   update public.credit_notes c
--      set refund_status = 'refunded', refund_method = coalesce(c.refund_method, 'Other'),
--          refunded_at = coalesce(c.refunded_at, (a.last + time '12:00') at time zone 'UTC')
--     from (select credit_note_id, max(allocated_on) as last from public.credit_allocations
--            where removed_at is null group by credit_note_id) a
--    where a.credit_note_id = c.id and c.refund_status = 'allocated';
--   update public.credit_notes set refund_due = refund_due - amount_allocated - refunded_amount
--    where status = 'issued' and refund_status = 'owed' and (amount_allocated > 0 or refunded_amount > 0);
--   drop table if exists public.credit_allocations;
--   alter table public.credit_notes drop constraint if exists credit_notes_refund_status_check;
--   alter table public.credit_notes add constraint credit_notes_refund_status_check
--     check (refund_status in ('none', 'owed', 'refunded'));
--   alter table public.credit_notes drop column if exists refunded_amount;
--   alter table public.credit_notes drop column if exists amount_allocated;
--   alter table public.invoices drop column if exists amount_allocated;
-- then run 115_credit_notes.sql again, which puts back its own versions of
-- issue_credit_note, cancel_credit_note, mark_credit_note_refunded,
-- record_invoice_payment and the two keep credited triggers.

-- ── Columns ─────────────────────────────────────────────────────────────────
alter table public.invoices add column if not exists amount_allocated numeric not null default 0 check (amount_allocated >= 0);
comment on column public.invoices.amount_allocated is
  'Credit applied to this invoice from other invoices'' credit notes (active credit_allocations). Not cash and not revenue. Written only by allocate_credit and remove_credit_allocation.';

alter table public.credit_notes add column if not exists amount_allocated numeric not null default 0 check (amount_allocated >= 0);
alter table public.credit_notes add column if not exists refunded_amount numeric not null default 0 check (refunded_amount >= 0);
comment on column public.credit_notes.amount_allocated is
  'Part of refund_due applied to other invoices (active credit_allocations from this note). Written only by allocate_credit and remove_credit_allocation.';
comment on column public.credit_notes.refunded_amount is
  'Part of refund_due refunded to the customer. Written only by mark_credit_note_refunded.';
comment on column public.credit_notes.refund_due is
  'All the money this note hands back: taken on the invoice beyond what it asks for after this credit, capped at this credit''s total. Of it, amount_allocated is applied to invoices, refunded_amount is refunded and the rest is credit available.';

-- The check 115 wrote inline on refund_status is named by Postgres
-- (credit_notes_refund_status_check). Every check on that column is dropped
-- whatever its name, then the one with 'allocated' is added.
do $$
declare
  v_name text;
begin
  for v_name in
    select conname from pg_constraint
     where conrelid = 'public.credit_notes'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) like '%refund_status%'
  loop
    execute format('alter table public.credit_notes drop constraint %I', v_name);
  end loop;
end $$;
alter table public.credit_notes add constraint credit_notes_refund_status_check
  check (refund_status in ('none', 'owed', 'allocated', 'refunded'));

-- A refund marked before this migration refunded the whole refund_due.
update public.credit_notes
   set refunded_amount = refund_due
 where refund_status = 'refunded' and refunded_amount is distinct from refund_due and amount_allocated = 0;

-- ── The allocations ─────────────────────────────────────────────────────────
create table if not exists public.credit_allocations (
  id             uuid primary key default gen_random_uuid(),
  -- restrict both ways: neither side can be deleted while it has a history.
  credit_note_id uuid not null references public.credit_notes(id) on delete restrict,
  invoice_id     uuid not null references public.invoices(id) on delete restrict,
  -- Whole pennies, checked by allocate_credit.
  amount         numeric not null check (amount > 0),
  allocated_on   date not null default current_date,
  note           text,
  created_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  -- Removed, never deleted: the row stays so the history reads right.
  removed_at     timestamptz,
  removed_by     uuid references public.profiles(id) on delete set null,
  remove_reason  text
);
create index if not exists idx_credit_allocations_note on public.credit_allocations(credit_note_id);
create index if not exists idx_credit_allocations_invoice on public.credit_allocations(invoice_id);

comment on table public.credit_allocations is
  'Credit from a credit note applied to another invoice. Active while removed_at is null. Read by any signed in user; written only through allocate_credit and remove_credit_allocation (or the service role).';

-- Read like credit_notes (115); no insert, update or delete policy on purpose.
alter table public.credit_allocations enable row level security;
drop policy if exists credit_allocations_read on public.credit_allocations;
create policy credit_allocations_read on public.credit_allocations
  for select to authenticated using (true);
-- RLS does not stop a TRUNCATE, and Supabase grants every table to anon and
-- authenticated by default. The service role keeps its own grants.
revoke insert, update, delete, truncate on public.credit_allocations from anon, authenticated;

-- ── Apply credit ────────────────────────────────────────────────────────────
-- Owner or editor. Checks run in the same order, with the same words, as
-- allocationProblems in src/lib/creditNotes.js.
create or replace function public.allocate_credit(
  p_credit_note_id uuid,
  p_invoice_id     uuid,
  p_amount         numeric,
  p_note           text default null
) returns public.credit_allocations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source_id uuid;
  v_note      public.credit_notes;
  v_inv       public.invoices;
  v_row       public.credit_allocations;
  v_note_txt  text := nullif(regexp_replace(coalesce(p_note, ''), '^\s+|\s+$', '', 'g'), '');
  v_used      numeric;   -- applied from this note so far
  v_available numeric;   -- this note's credit available
  v_credited  numeric;   -- credit notes on the target invoice
  v_applied   numeric;   -- credit applied to the target invoice so far
  v_cash      numeric;
  v_balance   numeric;
  v_amount    numeric;
  v_after     numeric;   -- the target's balance once this is applied
begin
  if coalesce(public.current_user_role(), '') not in ('owner', 'editor') then
    raise exception 'Only an owner or editor can apply credit.' using errcode = '42501';
  end if;

  select invoice_id into v_source_id from public.credit_notes where id = p_credit_note_id;
  if not found then
    raise exception 'Credit note not found.' using errcode = 'P0002';
  end if;

  -- Both invoices, lowest id first, then the note: remove_credit_allocation
  -- locks in the same order, and every function in 115 locks an invoice before
  -- its notes, so none of them can wait on another.
  perform 1 from public.invoices where id = least(v_source_id, p_invoice_id) for update;
  perform 1 from public.invoices where id = greatest(v_source_id, p_invoice_id) for update;
  select * into v_inv from public.invoices where id = p_invoice_id;
  if not found then
    raise exception 'Invoice not found.' using errcode = 'P0002';
  end if;
  select * into v_note from public.credit_notes where id = p_credit_note_id for update;

  if v_note.status <> 'issued' then
    raise exception 'This credit note is cancelled.';
  end if;
  select coalesce(sum(amount), 0) into v_used
    from public.credit_allocations where credit_note_id = p_credit_note_id and removed_at is null;
  v_available := case when v_note.refund_status = 'owed'
                      then greatest(0, v_note.refund_due - v_used - v_note.refunded_amount) else 0 end;
  if v_available <= 0 then
    raise exception 'There is no credit left to use on this credit note.';
  end if;

  if p_invoice_id = v_source_id then
    raise exception 'Credit cannot be applied to the invoice it was raised on.';
  end if;
  if v_inv.status not in ('sent', 'viewed') then
    raise exception 'Credit can only be applied to a sent or viewed invoice.';
  end if;
  if v_inv.currency is distinct from v_note.currency then
    raise exception 'This invoice is in a different currency from the credit note.';
  end if;

  -- Summed from the rows rather than trusting the invoice's columns, which an
  -- editor can write through the API. Sent or viewed, so a null amount_paid is
  -- no cash at all.
  select coalesce(sum(total), 0) into v_credited
    from public.credit_notes where invoice_id = p_invoice_id and status = 'issued';
  select coalesce(sum(amount), 0) into v_applied
    from public.credit_allocations where invoice_id = p_invoice_id and removed_at is null;
  v_cash := coalesce(v_inv.amount_paid, 0);
  v_balance := greatest(0, round(round(v_inv.total - v_cash - v_credited - v_applied, 6), 2));
  if v_balance <= 0 then
    raise exception 'This invoice has nothing left to pay.';
  end if;

  -- numeric takes 'NaN', which counts as more than 0, and 'Infinity'; the
  -- browser cannot send either (JSON has neither), so both are simply refused.
  if p_amount is null or p_amount::text in ('NaN', 'Infinity', '-Infinity') or p_amount <= 0 then
    raise exception 'The amount must be more than 0.';
  end if;
  -- Whole pennies, after the 6 place float wash of the rounding rule.
  if round(p_amount, 6) <> round(round(p_amount, 6), 2) then
    raise exception 'The amount can have at most 2 decimal places.';
  end if;
  v_amount := round(round(p_amount, 6), 2);
  if v_amount > v_available then
    raise exception 'This is more than the credit left on this credit note.';
  end if;
  if v_amount > v_balance then
    raise exception 'This is more than is left to pay on this invoice.';
  end if;
  if char_length(coalesce(v_note_txt, '')) > 500 then
    raise exception 'Keep the note to 500 characters or fewer.';
  end if;

  insert into public.credit_allocations (credit_note_id, invoice_id, amount, note, created_by)
  values (p_credit_note_id, p_invoice_id, v_amount, v_note_txt, auth.uid())
  returning * into v_row;

  -- Used once nothing is left; Refunded if part of it had been refunded.
  update public.credit_notes
     set amount_allocated = v_used + v_amount,
         refund_status = case when v_available - v_amount > 0 then 'owed'
                              when refunded_amount > 0 then 'refunded'
                              else 'allocated' end
   where id = p_credit_note_id;

  -- Settled once nothing is left to pay. amount_paid is written out as the
  -- cash received so a paid invoice with a null amount_paid (paid in full in
  -- cash, on every screen) can never come from credit.
  v_after := greatest(0, round(round(v_inv.total - v_cash - v_credited - v_applied - v_amount, 6), 2));
  update public.invoices
     set amount_allocated = v_applied + v_amount,
         status      = case when v_after = 0 then 'paid' else status end,
         paid_at     = case when v_after = 0 then now() else paid_at end,
         amount_paid = case when v_after = 0 then v_cash else amount_paid end,
         updated_at  = now()
   where id = p_invoice_id;

  return v_row;
end;
$$;

-- ── Remove applied credit ───────────────────────────────────────────────────
-- Owner only, with a reason. removeAllocationEffect in src/lib/creditNotes.js
-- does the same sums, in the same order.
--   The credit goes back on its credit note.
--   The invoice it was applied to has less settling it. If it was paid and now
--   has a balance, it reopens. If one of ITS credit notes had credit available
--   worked out from that settlement, that shrinks as it does when a credit
--   note is cancelled (newest first), and the removal is refused when refunds
--   already paid, or credit already applied, from those notes would then be
--   more than the customer overpaid.
create or replace function public.remove_credit_allocation(p_allocation_id uuid, p_reason text)
returns public.credit_allocations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row       public.credit_allocations;
  v_source_id uuid;
  v_inv       public.invoices;
  v_other     public.credit_notes;
  v_reason    text := regexp_replace(coalesce(p_reason, ''), '^\s+|\s+$', '', 'g');
  v_applied   numeric;   -- credit applied to the invoice once this is removed
  v_credited  numeric;
  v_cash      numeric;
  v_balance   numeric;
  v_allowed   numeric;   -- what the invoice's own notes may hand back afterwards
  v_refunded  numeric;
  v_fixed     numeric;
  v_budget    numeric;
  v_held      numeric;
  v_extra     numeric;
  v_keep      numeric;
begin
  if public.current_user_role() is distinct from 'owner' then
    raise exception 'Only an owner can remove applied credit.' using errcode = '42501';
  end if;

  select * into v_row from public.credit_allocations where id = p_allocation_id;
  if not found then
    raise exception 'Applied credit not found.' using errcode = 'P0002';
  end if;
  select invoice_id into v_source_id from public.credit_notes where id = v_row.credit_note_id;

  -- The order allocate_credit locks in: both invoices lowest id first, then
  -- the note, then this row.
  perform 1 from public.invoices where id = least(v_source_id, v_row.invoice_id) for update;
  perform 1 from public.invoices where id = greatest(v_source_id, v_row.invoice_id) for update;
  perform 1 from public.credit_notes where id = v_row.credit_note_id for update;
  select * into v_row from public.credit_allocations where id = p_allocation_id for update;
  select * into v_inv from public.invoices where id = v_row.invoice_id;

  if v_row.removed_at is not null then
    raise exception 'This applied credit has already been removed.';
  end if;
  if char_length(v_reason) not between 3 and 500 then
    raise exception 'Give a reason of 3 to 500 characters.';
  end if;

  -- The invoice once this credit is off it. The cash is read with the credit
  -- still on it, so a paid invoice with no amount_paid keeps the cash it was
  -- taken to have (and it is written out below if the invoice reopens).
  select coalesce(sum(total), 0) into v_credited
    from public.credit_notes where invoice_id = v_inv.id and status = 'issued';
  select coalesce(sum(amount), 0) - v_row.amount into v_applied
    from public.credit_allocations where invoice_id = v_inv.id and removed_at is null;
  v_cash := coalesce(v_inv.amount_paid,
                     case when v_inv.status = 'paid' then greatest(0, v_inv.total - (v_applied + v_row.amount)) else 0 end);
  v_balance := greatest(0, round(round(v_inv.total - v_cash - v_credited - v_applied, 6), 2));

  -- What the invoice's own credit notes may still hand back, in pennies, as
  -- cancel_credit_note works it out.
  v_allowed := greatest(0, round(round(v_cash, 6), 2) + v_applied - greatest(0, round(round(v_inv.total - v_credited, 6), 2)));
  select coalesce(sum(refunded_amount), 0), coalesce(sum(refunded_amount + amount_allocated), 0)
    into v_refunded, v_fixed
    from public.credit_notes where invoice_id = v_inv.id and status = 'issued';
  if v_refunded > v_allowed then
    raise exception 'A refund has already been paid on a credit note of this invoice. Without the credit applied it would be more than the customer overpaid, so the credit cannot be removed.';
  end if;
  if v_fixed > v_allowed then
    raise exception 'Credit from a credit note of this invoice has already been used on an invoice. Without the credit applied it would be more than the customer overpaid, so the credit cannot be removed.';
  end if;

  update public.credit_allocations
     set removed_at = now(), removed_by = auth.uid(), remove_reason = v_reason
   where id = p_allocation_id
  returning * into v_row;

  -- The credit is available again, so a note that was Used, or Used and then
  -- refunded, owes it again. A note with a refund on it can apply that credit
  -- again but not refund it (mark_credit_note_refunded holds one refund).
  update public.credit_notes c
     set amount_allocated = a.used,
         refund_status = case when c.refund_due - a.used - c.refunded_amount > 0 then 'owed' else c.refund_status end
    from (select coalesce(sum(amount), 0) as used from public.credit_allocations
           where credit_note_id = v_row.credit_note_id and removed_at is null) a
   where c.id = v_row.credit_note_id;

  -- The invoice's own notes: credit available beyond what may still be handed
  -- back comes off, newest first, as in cancel_credit_note.
  v_budget := v_allowed - v_fixed;
  for v_other in
    select * from public.credit_notes
     where invoice_id = v_inv.id and status = 'issued' and refund_status = 'owed'
     order by credit_number
       for update
  loop
    v_held  := v_other.amount_allocated + v_other.refunded_amount;
    v_extra := v_other.refund_due - v_held;
    v_keep  := least(v_extra, greatest(v_budget, 0));
    v_budget := v_budget - v_keep;
    if v_keep <> v_extra then
      update public.credit_notes
         set refund_due = v_held + v_keep,
             refund_status = case when v_keep > 0 then 'owed'
                                  when v_other.refunded_amount > 0 then 'refunded'
                                  when v_other.amount_allocated > 0 then 'allocated'
                                  else 'none' end
       where id = v_other.id;
    end if;
  end loop;

  -- A paid invoice that now has a balance is not paid any more. paid_at is
  -- kept as the day the earlier money came in, as cancel_credit_note keeps it:
  -- the reports count amount_paid on that day, and clearing it would drop cash
  -- already received out of Collected until the rest was paid.
  update public.invoices i
     set amount_allocated = v_applied,
         status      = case when i.status = 'paid' and v_balance > 0 then 'sent' else i.status end,
         amount_paid = case when i.status = 'paid' and v_balance > 0 then v_cash else i.amount_paid end,
         updated_at  = now()
   where i.id = v_inv.id;

  return v_row;
end;
$$;

-- ── Issue (115, with settled = paid + applied) ──────────────────────────────
-- p_lines is [{invoice_line_id?, name, description?, qty, unit_price, tax_rate}].
-- Checks run in the same order, with the same words, as validateCredit in
-- src/lib/creditNotes.js, so the raise screen can show either.
create or replace function public.issue_credit_note(
  p_invoice_id uuid,
  p_reason     text,
  p_lines      jsonb,
  p_issue_date date default current_date
) returns public.credit_notes
language plpgsql
security definer
set search_path = public
as $$
declare
  -- The number shapes validateCredit accepts. Checked before any cast, so a
  -- bad value gets a plain message instead of a cast error, and 'NaN' (which
  -- numeric would accept, and which counts as more than 0) is refused.
  c_number   constant text := '^\s*[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]{1,3})?\s*$';
  c_uuid     constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_inv      public.invoices;
  v_note     public.credit_notes;
  v_reason   text := regexp_replace(coalesce(p_reason, ''), '^\s+|\s+$', '', 'g');
  v_line     jsonb;
  v_no       bigint;
  v_qty      numeric;
  v_price    numeric;
  v_rate     numeric;
  v_src_rate numeric;
  v_src_id   uuid;
  v_src_net  numeric;
  v_charged  numeric;
  v_done     numeric;
  v_this     numeric;
  v_rates    numeric[];
  v_count    bigint;
  v_net      numeric := 0;   -- unrounded, as on an invoice
  v_tax      numeric := 0;   -- unrounded, as on an invoice
  v_tax_amt  numeric;
  v_total    numeric;
  v_credited numeric;
  v_applied  numeric;
  v_left     numeric;
  v_excess   numeric;
  v_refund   numeric := 0;
begin
  if coalesce(public.current_user_role(), '') not in ('owner', 'editor') then
    raise exception 'Only an owner or editor can raise a credit note.' using errcode = '42501';
  end if;

  -- Held until this call ends. A second credit on the same invoice waits here,
  -- then sees this one in the sum of issued credit notes below.
  select * into v_inv from public.invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'Invoice not found.' using errcode = 'P0002';
  end if;
  if v_inv.status = 'draft' then
    raise exception 'A draft invoice cannot be credited. Edit the invoice instead.';
  elsif v_inv.status not in ('sent', 'viewed', 'paid') then
    raise exception 'Only a sent, viewed or paid invoice can be credited.';
  end if;

  -- Reports take a credit off in the period of its own date, so a stray date
  -- would change a VAT quarter already filed. A day of slack for the future,
  -- as for a refund date: the caller's today can be ahead of ours in UTC.
  if coalesce(p_issue_date, current_date) < v_inv.issue_date then
    raise exception 'A credit note cannot be dated before the invoice it credits.';
  elsif coalesce(p_issue_date, current_date) > current_date + 1 then
    raise exception 'A credit note cannot be dated in the future.';
  end if;

  if char_length(v_reason) not between 3 and 500 then
    raise exception 'Give a reason of 3 to 500 characters.';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Add at least one line to credit.';
  end if;
  if jsonb_array_length(p_lines) > 100 then
    raise exception 'A credit note can have at most 100 lines.';
  end if;

  -- The rates the invoice charged. A free line may use any of them or 0; an
  -- invoice with no lines at all falls back to its header rate. Crediting tax
  -- the invoice never charged would hand back VAT that was never paid.
  select coalesce(array_agg(distinct coalesce(tax_rate, 0)), '{}'), count(*)
    into v_rates, v_count
    from public.invoice_line_items where invoice_id = p_invoice_id;
  if v_count = 0 then
    v_rates := array[coalesce(v_inv.tax_rate, 0)];
  end if;

  for v_line, v_no in
    select e.value, e.ordinality from jsonb_array_elements(p_lines) with ordinality as e
  loop
    if jsonb_typeof(v_line) <> 'object'
       or regexp_replace(coalesce(v_line->>'name', ''), '^\s+|\s+$', '', 'g') = '' then
      raise exception 'Line % needs a name.', v_no;
    end if;

    v_qty := case when v_line->>'qty' ~ c_number then (v_line->>'qty')::numeric end;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Line %: the quantity must be more than 0.', v_no;
    end if;

    v_price := case when v_line->>'unit_price' ~ c_number then (v_line->>'unit_price')::numeric end;
    if v_price is null or v_price < 0 then
      raise exception 'Line %: the unit price must be 0 or more.', v_no;
    end if;

    -- A missing rate is 0, as on an invoice line.
    v_rate := case when coalesce(v_line->>'tax_rate', '0') ~ c_number then coalesce(v_line->>'tax_rate', '0')::numeric end;
    if v_rate is null or v_rate < 0 then
      raise exception 'Line %: the tax rate must be 0 or more.', v_no;
    end if;

    v_src_id := null;
    if coalesce(v_line->>'invoice_line_id', '') <> '' then
      v_src_rate := null;
      if v_line->>'invoice_line_id' ~ c_uuid then
        select id, coalesce(tax_rate, 0), qty * unit_price into v_src_id, v_src_rate, v_src_net
          from public.invoice_line_items
         where id = (v_line->>'invoice_line_id')::uuid and invoice_id = p_invoice_id;
      end if;
      -- coalesce above means a found line never has a null rate.
      if v_src_rate is null then
        raise exception 'Line % is not on this invoice.', v_no;
      end if;
      if v_rate <> 0 and v_rate <> v_src_rate then
        raise exception 'Line %: the tax rate can only be 0 or the rate on the invoice.', v_no;
      end if;
    elsif v_rate <> 0 and not (v_rate = any (v_rates)) then
      raise exception 'Line %: the tax rate can only be 0 or the rate on the invoice.', v_no;
    end if;

    -- One line, one credit (the guards at the top of 115). What this note uses
    -- is added up over its lines so far, which have all passed the checks
    -- above. The case keeps the casts off the lines not checked yet (a where
    -- clause may test its conditions in any order). Compared at 6 places, the
    -- same float wash as the rounding rule.
    if v_src_id is not null then
      select coalesce(sum(l.qty * l.unit_price), 0) into v_done
        from public.credit_note_lines l
        join public.credit_notes c on c.id = l.credit_note_id
       where c.invoice_id = p_invoice_id and c.status = 'issued' and l.invoice_line_id = v_src_id;
      select coalesce(sum((e.value->>'qty')::numeric * (e.value->>'unit_price')::numeric), 0) into v_this
        from jsonb_array_elements(p_lines) with ordinality as e
       where case when e.ordinality <= v_no then nullif(e.value->>'invoice_line_id', '')::uuid end = v_src_id;
      if round(v_done + v_this, 6) > round(v_src_net, 6) then
        raise exception 'Line %: more than is left to credit on this line.', v_no;
      end if;
    end if;

    -- An invoice with no lines only has its header rate, and the total limit.
    if v_rate > 0 and v_count > 0 then
      select coalesce(sum(qty * unit_price), 0) into v_charged
        from public.invoice_line_items where invoice_id = p_invoice_id and coalesce(tax_rate, 0) = v_rate;
      select coalesce(sum(l.qty * l.unit_price), 0) into v_done
        from public.credit_note_lines l
        join public.credit_notes c on c.id = l.credit_note_id
       where c.invoice_id = p_invoice_id and c.status = 'issued' and l.tax_rate = v_rate;
      select coalesce(sum((e.value->>'qty')::numeric * (e.value->>'unit_price')::numeric), 0) into v_this
        from jsonb_array_elements(p_lines) with ordinality as e
       where case when e.ordinality <= v_no then coalesce(e.value->>'tax_rate', '0')::numeric end = v_rate;
      if round(v_done + v_this, 6) > round(v_charged, 6) then
        -- The rate as the screen writes it: 20 not 20.00, 5.5 not 5.50.
        raise exception 'Line %: more than is left to credit at %.', v_no,
          (case when v_rate::text like '%.%' then rtrim(rtrim(v_rate::text, '0'), '.') else v_rate::text end) || '%';
      end if;
    end if;

    -- x 0.01 rather than / 100: numeric division rounds to a chosen number of
    -- places, multiplication is exact.
    v_net := v_net + v_qty * v_price;
    v_tax := v_tax + v_qty * v_price * v_rate * 0.01;
  end loop;

  -- The rounding rule at the top of 115.
  v_tax_amt := round(round(v_tax, 6), 2);
  v_total   := round(round(v_net + v_tax, 6), 2);
  if v_total <= 0 then
    raise exception 'The credit must be more than 0.';
  end if;

  -- Summed from the notes themselves rather than trusting amount_credited, so
  -- the limit is right even if that column were ever edited by hand.
  select coalesce(sum(total), 0) into v_credited
    from public.credit_notes where invoice_id = p_invoice_id and status = 'issued';
  -- Both sides are whole pennies, so this is the same test as
  -- "total <= invoice total - credited, within half a penny".
  v_left := round(round(v_inv.total - v_credited, 6), 2);
  if v_total > v_left then
    raise exception 'This credit is more than is left on the invoice.';
  end if;

  -- After this credit the invoice asks for total - credited - v_total. What
  -- has already settled it beyond that is credit available on this note, but
  -- never more than this credit. Settled is the cash taken plus credit applied
  -- to it from other invoices (the same rows summed, not the column). A paid
  -- invoice with no amount_paid was paid in full: the invoice screens already
  -- show it that way (amount_paid ?? total), and whatever credit was applied
  -- to it did not settle, cash did. Both sides are made pennies first, what is
  -- asked never below 0: the total is stored unrounded, so a full credit of
  -- 682.63 on 682.625 left would otherwise leave half a penny that rounds into
  -- a refund of 0.01 on an invoice nobody paid.
  select coalesce(sum(amount), 0) into v_applied
    from public.credit_allocations where invoice_id = p_invoice_id and removed_at is null;
  v_excess := round(round(coalesce(v_inv.amount_paid, case when v_inv.status = 'paid' then greatest(0, v_inv.total - v_applied) else 0 end), 6), 2)
    + v_applied
    - greatest(0, round(round(v_inv.total - v_credited - v_total, 6), 2));
  if v_excess > 0 then
    v_refund := least(v_excess, v_total);
  end if;

  insert into public.credit_notes (
    invoice_id, company_id, location_id, contact_id, status, issue_date, reason,
    subtotal, tax_amount, total, currency, refund_status, refund_due, email_to, created_by
  ) values (
    v_inv.id, v_inv.company_id, v_inv.location_id, v_inv.contact_id, 'issued',
    coalesce(p_issue_date, current_date), v_reason,
    v_total - v_tax_amt, v_tax_amt, v_total, v_inv.currency,
    case when v_refund > 0 then 'owed' else 'none' end, v_refund, v_inv.email_to, auth.uid()
  ) returning * into v_note;

  -- Every value was checked in the loop above, so these casts cannot fail.
  insert into public.credit_note_lines (credit_note_id, invoice_line_id, name, description, qty, unit_price, tax_rate, sort)
  select v_note.id,
         nullif(e.value->>'invoice_line_id', '')::uuid,
         regexp_replace(e.value->>'name', '^\s+|\s+$', '', 'g'),
         nullif(regexp_replace(coalesce(e.value->>'description', ''), '^\s+|\s+$', '', 'g'), ''),
         (e.value->>'qty')::numeric,
         (e.value->>'unit_price')::numeric,
         coalesce(e.value->>'tax_rate', '0')::numeric,
         (e.ordinality - 1)::integer
    from jsonb_array_elements(p_lines) with ordinality as e;

  update public.invoices
     set amount_credited = v_credited + v_total, updated_at = now()
   where id = v_inv.id;

  return v_note;
end;
$$;

-- ── Cancel (115, with settled = paid + applied) ─────────────────────────────
-- Owner only. The note stays, keeps its number and is left out of every total.
-- cancelCreditEffect in src/lib/creditNotes.js does the same sums, in the same
-- order, so the Cancel screen can say what will happen first.
create or replace function public.cancel_credit_note(p_id uuid, p_reason text)
returns public.credit_notes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice_id uuid;
  v_inv        public.invoices;
  v_note       public.credit_notes;
  v_other      public.credit_notes;
  v_reason     text := regexp_replace(coalesce(p_reason, ''), '^\s+|\s+$', '', 'g');
  v_credited   numeric;   -- the invoice's credit once this note is gone
  v_applied    numeric;   -- credit applied to the invoice from other invoices
  v_cash       numeric;
  v_allowed    numeric;   -- what may be handed back once this note is gone
  v_refunded   numeric;   -- refunds already paid on the other notes
  v_fixed      numeric;   -- those, plus credit the other notes have applied
  v_budget     numeric;
  v_held       numeric;
  v_extra      numeric;
  v_keep       numeric;
begin
  if public.current_user_role() is distinct from 'owner' then
    raise exception 'Only an owner can cancel a credit note.' using errcode = '42501';
  end if;

  select invoice_id into v_invoice_id from public.credit_notes where id = p_id;
  if not found then
    raise exception 'Credit note not found.' using errcode = 'P0002';
  end if;
  -- The invoice first, then the notes: the order every function here locks
  -- in, so none of them can wait on another.
  select * into v_inv from public.invoices where id = v_invoice_id for update;
  select * into v_note from public.credit_notes where id = p_id for update;

  if v_note.status = 'cancelled' then
    raise exception 'This credit note is already cancelled.';
  end if;
  -- The money has gone back to the customer; cancelling the paperwork would
  -- put the credit back on the invoice as if it had not.
  if v_note.refund_status = 'refunded' or v_note.refunded_amount > 0 then
    raise exception 'This credit has already been refunded.';
  end if;
  -- Likewise credit it has applied to another invoice: that invoice's balance
  -- rests on it.
  if exists (select 1 from public.credit_allocations where credit_note_id = p_id and removed_at is null) then
    raise exception 'Remove the credit applied from this note first.';
  end if;
  if char_length(v_reason) not between 3 and 500 then
    raise exception 'Give a reason of 3 to 500 characters.';
  end if;

  -- With less credit the invoice asks for more, so less of what settled it is
  -- owed back. A refund already paid, or credit already applied to another
  -- invoice, cannot be taken back here, so if those alone would be more than
  -- is now owed back, the cancel is refused rather than leave the customer's
  -- balance wrong. A paid invoice with no amount_paid was paid in full
  -- (amount_paid ?? total on every screen).
  select coalesce(sum(total), 0) into v_credited
    from public.credit_notes where invoice_id = v_invoice_id and status = 'issued' and id <> p_id;
  select coalesce(sum(amount), 0) into v_applied
    from public.credit_allocations where invoice_id = v_invoice_id and removed_at is null;
  v_cash := coalesce(v_inv.amount_paid, case when v_inv.status = 'paid' then greatest(0, v_inv.total - v_applied) else 0 end);
  -- In pennies on both sides, as issue_credit_note works out a refund.
  v_allowed := greatest(0, round(round(v_cash, 6), 2) + v_applied - greatest(0, round(round(v_inv.total - v_credited, 6), 2)));
  select coalesce(sum(refunded_amount), 0), coalesce(sum(refunded_amount + amount_allocated), 0)
    into v_refunded, v_fixed
    from public.credit_notes
   where invoice_id = v_invoice_id and status = 'issued' and id <> p_id;
  if v_refunded > v_allowed then
    raise exception 'A refund has already been paid on this invoice. Without this credit it would be more than the customer overpaid, so this credit cannot be cancelled.';
  end if;
  if v_fixed > v_allowed then
    raise exception 'Credit from another credit note on this invoice has already been used on an invoice. Without this credit it would be more than the customer overpaid, so this credit cannot be cancelled.';
  end if;

  update public.credit_notes
     set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = v_reason,
         refund_status = 'none', refund_due = 0
   where id = p_id
  returning * into v_note;

  -- The credit available on the other notes comes down to what is left of
  -- that, oldest keeping theirs first, so the newest lose theirs first. What a
  -- note has applied or refunded stays in its refund_due. Without this a
  -- duplicate note could go on saying a refund is owed that is not.
  v_budget := v_allowed - v_fixed;
  for v_other in
    select * from public.credit_notes
     where invoice_id = v_invoice_id and status = 'issued' and refund_status = 'owed'
     order by credit_number
       for update
  loop
    v_held  := v_other.amount_allocated + v_other.refunded_amount;
    v_extra := v_other.refund_due - v_held;
    v_keep  := least(v_extra, greatest(v_budget, 0));
    v_budget := v_budget - v_keep;
    if v_keep <> v_extra then
      update public.credit_notes
         set refund_due = v_held + v_keep,
             refund_status = case when v_keep > 0 then 'owed'
                                  when v_other.refunded_amount > 0 then 'refunded'
                                  when v_other.amount_allocated > 0 then 'allocated'
                                  else 'none' end
       where id = v_other.id;
    end if;
  end loop;

  -- Recomputed from the notes still issued, which puts the column right if it
  -- had ever drifted. A paid invoice that now asks for more than has settled
  -- it is not paid any more: it goes back to sent, so the rest counts as
  -- outstanding, can be chased, and its pay link charges it. paid_at is kept
  -- as the day the earlier money came in.
  update public.invoices i
     set amount_credited = v_credited,
         status = case when i.status = 'paid' and round(round(i.total - v_cash - v_credited - v_applied, 6), 2) > 0
                       then 'sent' else i.status end,
         updated_at = now()
   where i.id = v_invoice_id;

  return v_note;
end;
$$;

-- ── Mark refunded (115, refunding only what is left) ────────────────────────
-- Records a refund made outside the app (bank transfer, a refund on the card
-- machine). Nothing is sent to Stripe. Only the credit still available is
-- refunded; what was applied to invoices stays applied. A note is refunded
-- once: its refund date, method and note are single fields.
create or replace function public.mark_credit_note_refunded(
  p_id          uuid,
  p_method      text,
  p_note        text default null,
  p_refunded_on date default current_date
) returns public.credit_notes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice_id uuid;
  v_note       public.credit_notes;
  v_note_txt   text := nullif(regexp_replace(coalesce(p_note, ''), '^\s+|\s+$', '', 'g'), '');
  v_left       numeric;
begin
  if coalesce(public.current_user_role(), '') not in ('owner', 'editor') then
    raise exception 'Only an owner or editor can mark a refund.' using errcode = '42501';
  end if;

  select invoice_id into v_invoice_id from public.credit_notes where id = p_id;
  if not found then
    raise exception 'Credit note not found.' using errcode = 'P0002';
  end if;
  -- The invoice first, as cancel_credit_note does: a cancel working out the
  -- refunds owed must not have one turn into refunded under it, and credit
  -- cannot be applied from the note while this runs.
  perform 1 from public.invoices where id = v_invoice_id for update;
  select * into v_note from public.credit_notes where id = p_id for update;
  if v_note.status <> 'issued' then
    raise exception 'This credit note is cancelled.';
  end if;
  if v_note.refund_status = 'refunded' then
    raise exception 'This refund is already marked as refunded.';
  end if;
  if v_note.refund_status = 'allocated' then
    raise exception 'All of this credit has been used on invoices, so there is nothing left to refund.';
  end if;
  -- One refund per note (its amount, date and method are single fields that
  -- the reports read by date). A note owes again with a refund already on it
  -- only once credit applied from it is removed; that credit can be applied
  -- to an invoice again instead.
  if v_note.refunded_amount > 0 then
    raise exception 'A refund has already been marked on this credit note, and a second one cannot be recorded. Apply the credit left to an invoice instead.';
  end if;
  v_left := v_note.refund_due - v_note.amount_allocated - v_note.refunded_amount;
  if v_note.refund_status <> 'owed' or v_left <= 0 then
    raise exception 'There is no refund owed on this credit note.';
  end if;
  if p_method is null or p_method not in ('Bank transfer', 'Card refund', 'Other') then
    raise exception 'Choose how it was refunded: Bank transfer, Card refund or Other.';
  end if;
  -- A day of slack: the caller's today can be ahead of the database's in UTC.
  if p_refunded_on > current_date + 1 then
    raise exception 'The refund date cannot be in the future.';
  end if;
  if char_length(coalesce(v_note_txt, '')) > 500 then
    raise exception 'Keep the refund note to 500 characters or fewer.';
  end if;

  update public.credit_notes
     set refund_status   = 'refunded',
         refunded_amount = refunded_amount + v_left,
         -- Noon UTC falls on the same calendar day from London to Los Angeles,
         -- so the day picked is the day every screen shows.
         refunded_at     = (coalesce(p_refunded_on, current_date) + time '12:00') at time zone 'UTC',
         refund_method   = p_method,
         refund_note     = v_note_txt
   where id = p_id
  returning * into v_note;

  return v_note;
end;
$$;

-- ── Record a card payment (115, with settled = paid + applied) ──────────────
-- Called by stripe-webhook (service role only) when a Checkout session for an
-- invoice completes. It locks the invoice as issue_credit_note does, so a
-- payment and a credit note can never pass each other half way.
--   A session already recorded is a repeat delivery: nothing changes.
--   An invoice already paid is left alone (a second tab, or paid by bank
--   first); the webhook logs it so the charge can be refunded in Stripe.
--   Otherwise the payment is added to amount_paid, and the invoice is paid
--   once the cash plus credit applied to it covers what it asks for. Money
--   beyond that (the pay page was open while a credit note was issued or
--   credit was applied) is written as credit available on the newest issued
--   credit notes, up to each note's total, so it shows on the invoice.
-- Returns what happened as jsonb for the webhook's log.
create or replace function public.record_invoice_payment(
  p_invoice_id uuid,
  p_amount     numeric,
  p_session_id text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inv      public.invoices;
  v_note     public.credit_notes;
  v_paid     numeric;
  v_credited numeric;
  v_applied  numeric;
  v_settled  numeric;
  v_asked    numeric;
  v_status   text;
  v_more     numeric := 0;
  v_add      numeric;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'The payment must be more than 0.';
  end if;

  select * into v_inv from public.invoices where id = p_invoice_id for update;
  if not found then
    return jsonb_build_object('recorded', false, 'reason', 'not_found');
  end if;
  if p_session_id is not null and p_session_id = any (v_inv.stripe_paid_sessions) then
    return jsonb_build_object('recorded', false, 'reason', 'repeat', 'invoice_number', v_inv.invoice_number);
  end if;
  if v_inv.status = 'paid' then
    return jsonb_build_object('recorded', false, 'reason', 'already_paid', 'invoice_number', v_inv.invoice_number);
  end if;

  -- Pennies, by the rounding rule at the top of 115.
  v_paid := round(round(coalesce(v_inv.amount_paid, 0) + p_amount, 6), 2);
  select coalesce(sum(total), 0) into v_credited
    from public.credit_notes where invoice_id = p_invoice_id and status = 'issued';
  select coalesce(sum(amount), 0) into v_applied
    from public.credit_allocations where invoice_id = p_invoice_id and removed_at is null;
  v_settled := v_paid + v_applied;
  v_asked := greatest(0, round(round(v_inv.total - v_credited, 6), 2));
  v_status := case when v_settled >= v_asked then 'paid' else v_inv.status end;

  update public.invoices
     set amount_paid = v_paid,
         status = v_status,
         paid_at = case when v_status = 'paid' then now() else paid_at end,
         stripe_paid_sessions = case when p_session_id is null then stripe_paid_sessions
                                     else array_append(stripe_paid_sessions, p_session_id) end
   where id = p_invoice_id;

  -- Settled beyond what the invoice asks for, less what the notes already
  -- hand back (owed, applied to invoices or refunded). A Used note takes more
  -- and owes it again.
  if v_settled > v_asked then
    select v_settled - v_asked - coalesce(sum(refund_due), 0) into v_more
      from public.credit_notes
     where invoice_id = p_invoice_id and status = 'issued' and refund_status in ('owed', 'allocated', 'refunded');
    for v_note in
      select * from public.credit_notes
       where invoice_id = p_invoice_id and status = 'issued' and refund_status in ('none', 'owed', 'allocated')
       order by credit_number desc
         for update
    loop
      exit when v_more <= 0;
      v_add := least(v_more, v_note.total - v_note.refund_due);
      continue when v_add <= 0;
      update public.credit_notes set refund_status = 'owed', refund_due = refund_due + v_add where id = v_note.id;
      v_more := v_more - v_add;
    end loop;
  end if;

  return jsonb_build_object(
    'recorded', true, 'invoice_number', v_inv.invoice_number, 'status', v_status,
    'amount_paid', v_paid, 'amount_allocated', v_applied,
    'balance_due', greatest(v_asked - v_settled, 0),
    'overpaid', greatest(v_settled - v_asked, 0),
    -- Left over when there were no credit notes to hold it (paid twice).
    'not_on_a_credit_note', greatest(v_more, 0));
end;
$$;

-- ── An invoice with credit on it keeps its figures ──────────────────────────
-- 115 locks the totals, currency, customer and lines of an invoice with an
-- issued credit note. Credit applied TO an invoice was checked against its
-- balance the same way, so it locks them too until the credit is removed. And
-- an invoice cannot be voided or deleted while credit is applied to it or from
-- one of its credit notes: the other side's balance rests on it. Removing the
-- applied credit first unlocks it. The columns the functions and screens write
-- (amount_allocated, amount_paid, status other than void, dates, email, notes)
-- are untouched. A company or site going to null is allowed, as in 115.
create or replace function public.invoices_keep_credited() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.credit_allocations a
                where a.removed_at is null
                  and (a.invoice_id = old.id
                       or a.credit_note_id in (select c.id from public.credit_notes c where c.invoice_id = old.id))) then
      raise exception 'Credit has been applied to or from this invoice, so it cannot be deleted. Remove the credit applied first.'
        using errcode = '55000';
    end if;
    return old;
  end if;

  if (new.subtotal, new.tax_amount, new.total, new.currency) is distinct from (old.subtotal, old.tax_amount, old.total, old.currency)
     or (new.company_id is distinct from old.company_id and new.company_id is not null)
     or (new.location_id is distinct from old.location_id and new.location_id is not null) then
    if exists (select 1 from public.credit_notes where invoice_id = old.id and status = 'issued') then
      raise exception 'This invoice has a credit note issued against it, so its totals and customer cannot change. Raise another credit note instead.'
        using errcode = '55000';
    end if;
    if exists (select 1 from public.credit_allocations where invoice_id = old.id and removed_at is null) then
      raise exception 'Credit has been applied to this invoice, so its totals and customer cannot change. Remove the credit applied first.'
        using errcode = '55000';
    end if;
  end if;

  if new.status = 'void' and old.status is distinct from 'void'
     and exists (select 1 from public.credit_allocations a
                  where a.removed_at is null
                    and (a.invoice_id = old.id
                         or a.credit_note_id in (select c.id from public.credit_notes c where c.invoice_id = old.id))) then
    raise exception 'Credit has been applied to or from this invoice, so it cannot be voided. Remove the credit applied first.'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_invoices_keep_credited on public.invoices;
create trigger trg_invoices_keep_credited
  before update of subtotal, tax_amount, total, currency, company_id, location_id, status or delete on public.invoices
  for each row execute function public.invoices_keep_credited();

-- The lines likewise: re-saving them gives them new ids and can change what
-- each line charged. A change to a line's name or description only, or a
-- product going to null, is fine.
create or replace function public.invoice_lines_keep_credited() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
     and (new.invoice_id, new.qty, new.unit_price, new.tax_rate) is not distinct from (old.invoice_id, old.qty, old.unit_price, old.tax_rate) then
    return new;
  end if;
  if exists (
    select 1 from public.credit_notes
     where status = 'issued'
       and invoice_id in (case when tg_op = 'INSERT' then null else old.invoice_id end,
                          case when tg_op = 'DELETE' then null else new.invoice_id end)
  ) then
    raise exception 'This invoice has a credit note issued against it, so its lines cannot change. Raise another credit note instead.'
      using errcode = '55000';
  end if;
  if exists (
    select 1 from public.credit_allocations
     where removed_at is null
       and invoice_id in (case when tg_op = 'INSERT' then null else old.invoice_id end,
                          case when tg_op = 'DELETE' then null else new.invoice_id end)
  ) then
    raise exception 'Credit has been applied to this invoice, so its lines cannot change. Remove the credit applied first.'
      using errcode = '55000';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists trg_invoice_lines_keep_credited on public.invoice_line_items;
create trigger trg_invoice_lines_keep_credited
  before insert or update or delete on public.invoice_line_items
  for each row execute function public.invoice_lines_keep_credited();

-- ── Who may call them ───────────────────────────────────────────────────────
-- Signed in users only; each function checks the role itself. The replaced
-- functions keep the grants 115 gave them; they are stated again so this file
-- alone leaves them right.
revoke all on function public.allocate_credit(uuid, uuid, numeric, text) from public, anon;
revoke all on function public.remove_credit_allocation(uuid, text) from public, anon;
grant execute on function public.allocate_credit(uuid, uuid, numeric, text) to authenticated;
grant execute on function public.remove_credit_allocation(uuid, text) to authenticated;

revoke all on function public.issue_credit_note(uuid, text, jsonb, date) from public, anon;
revoke all on function public.cancel_credit_note(uuid, text) from public, anon;
revoke all on function public.mark_credit_note_refunded(uuid, text, text, date) from public, anon;
revoke all on function public.record_invoice_payment(uuid, numeric, text) from public, anon, authenticated;
grant execute on function public.issue_credit_note(uuid, text, jsonb, date) to authenticated;
grant execute on function public.cancel_credit_note(uuid, text) to authenticated;
grant execute on function public.mark_credit_note_refunded(uuid, text, text, date) to authenticated;
grant execute on function public.record_invoice_payment(uuid, numeric, text) to service_role;

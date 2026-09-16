-- 117: correcting the amount received on an invoice.
--
-- Until now the only ways cash got onto an invoice were a card payment
-- (record_invoice_payment, from stripe-webhook) and Mark paid, which wrote
-- amount_paid straight from the browser as "whatever the balance is". On 14 Sep
-- that went wrong: INV-1036 (1,344) had CN-1001 (224) raised, then Mark paid
-- recorded 1,120 although the customer had sent 1,344. No overpayment was
-- recorded, so CN-1001 had no credit to use, and nothing in the app could put
-- the amount received right.
--
-- set_invoice_amount_received does both jobs under one set of rules:
--   Change (a correction): "How much has the customer paid in total on this
--   invoice?" The caller passes the TOTAL cash received, with a reason.
--   Mark paid (a payment): "How much did they pay?" The screen adds that to
--   the cash already received (markPaymentTotal in src/lib/creditNotes.js) and
--   passes the total, with p_kind 'payment'. The reason may be left blank and
--   is then "Payment received". A payment is refused on an invoice that is
--   already paid or has nothing left to pay: two people recording the same
--   bank transfer would otherwise record it twice. Change corrects those.
--   Both pass p_expected_from, the amount received the screen worked from. A
--   card payment or a colleague's change that lands after the screen read the
--   invoice makes the total it worked out wrong (a payment would silently
--   swallow the one that landed), so the call is refused and the screen reads
--   the invoice again.
-- Card payments are unchanged: they still go through record_invoice_payment.
--
-- THE RULES (amountReceivedEffect in src/lib/creditNotes.js makes the same
-- checks, in the same order, with the same words; keep them in step)
--   settled = amount received + credit applied TO this invoice (116)
--   asked   = total - credit notes on it, in pennies, never below 0
--   Settled covers asked: the invoice is paid. Otherwise a paid invoice goes
--   back to sent; a sent or viewed one keeps its status.
--   paid_at is the day the money came in, which the reports count Collected
--   on. It is kept while there is cash on the invoice, including when a
--   correction takes a paid invoice back to sent (as remove_credit_allocation
--   and cancel_credit_note keep it: clearing it would drop cash already
--   received out of Collected). It is set to now when the first cash comes in
--   (a part payment counts in Collected straight away) or the invoice becomes
--   paid, and cleared only when the invoice is left with no cash and unpaid.
--   overpaid = settled - asked. The invoice's credit notes hold overpayment as
--   refund_due, newest first, each up to its own total, exactly as
--   record_invoice_payment adds it. When the overpayment rises the extra is
--   added the same way (the note owes it, shown as credit to use). When it
--   falls it comes off the notes' credit still to use, newest first. Credit
--   already applied to other invoices or refunded cannot come off, so a
--   correction that would need it to is refused, naming the lowest amount
--   received allowed. A note left with nothing owed, used or refunded goes
--   back to none.
--   Overpayment no credit note can hold (none raised, or all full) is allowed
--   and returned as not_on_a_credit_note. The screen says what to do with it
--   (overpaidAdvice): when it is no more than credit applied to the invoice,
--   the customer paid without using that credit, so an owner removes the
--   credit applied; otherwise raise a credit note to use or refund it.
-- Every change writes a row to invoice_payment_adjustments (from, to, reason,
-- who, when), which the invoice shows as its Payment history.
--
-- Nobody writes invoice_payment_adjustments from the browser: no insert,
-- update or delete policy, and the write grants are taken back. The function
-- is security definer, checks the role, and locks the invoice, the invoices
-- its credit notes' credit was applied to (lowest id first, as 116 locks) and
-- then the invoice's credit notes, so it cannot pass a credit note, a card
-- payment or applied credit half way. It adds no trigger or check to
-- invoices, so stripe-webhook, record_invoice_payment and invoice-send go on
-- writing amount_paid and status as before.
--
-- Idempotent: safe to run twice. Apply after 115_credit_notes.sql and
-- 116_credit_allocations.sql.
--
-- CHECK AFTER APPLYING, signed in as an editor (not with the service key):
--   insert into public.invoice_payment_adjustments (invoice_id, from_amount, to_amount, reason, kind)
--     select id, 0, 1, 'test', 'correction' from public.invoices limit 1;
-- must fail (permission denied), and
--   select public.set_invoice_amount_received('<a draft invoice id>', 1, 'test');
-- must fail with "The amount received can only be changed on a sent, viewed or paid invoice."
-- Signed in as a viewer, any call must fail with
-- "Only an owner or editor can change the amount received."
--
-- ROLLBACK (roll the app back first: Mark paid and Change call this function
-- and the invoice screen reads the history.) The amounts received, statuses,
-- paid dates and credit note refunds it wrote are ordinary 115 and 116 columns
-- and stay as they are; only the history of changes is lost.
--   drop function if exists public.set_invoice_amount_received(uuid, numeric, text, text, numeric);
--   drop function if exists public.set_invoice_amount_received(uuid, numeric, text, text);
--   drop table if exists public.invoice_payment_adjustments;   (drops its policy)

-- ── The history ─────────────────────────────────────────────────────────────
create table if not exists public.invoice_payment_adjustments (
  id          uuid primary key default gen_random_uuid(),
  -- restrict: an invoice with a payment history cannot be deleted.
  invoice_id  uuid not null references public.invoices(id) on delete restrict,
  -- Both in pennies. from_amount is the cash the invoice was taken to have (a
  -- paid invoice with no amount_paid was paid in full).
  from_amount numeric not null,
  to_amount   numeric not null check (to_amount >= 0),
  reason      text not null,
  kind        text not null check (kind in ('correction', 'payment')),
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists idx_invoice_payment_adjustments_invoice on public.invoice_payment_adjustments(invoice_id, created_at);

comment on table public.invoice_payment_adjustments is
  'Every change to an invoice''s amount received made through set_invoice_amount_received: a correction (Change) or a payment (Mark paid). Read by any signed in user; written only by that function (or the service role).';

-- Read like invoices (038: FOR SELECT TO authenticated USING (true)); no
-- insert, update or delete policy on purpose.
alter table public.invoice_payment_adjustments enable row level security;
drop policy if exists invoice_payment_adjustments_read on public.invoice_payment_adjustments;
create policy invoice_payment_adjustments_read on public.invoice_payment_adjustments
  for select to authenticated using (true);
-- Supabase grants every table to anon and authenticated by default, TRUNCATE
-- included, and RLS does not stop a TRUNCATE. Take the writes back, and
-- everything from anon, which has no reason to see it. The service role keeps
-- its own grants.
revoke all on public.invoice_payment_adjustments from anon;
revoke insert, update, delete, truncate on public.invoice_payment_adjustments from authenticated;

-- ── Set the amount received ─────────────────────────────────────────────────
-- p_amount is the TOTAL cash received on the invoice, never the change.
-- p_kind is 'correction' (Change, the default) or 'payment' (Mark paid).
-- p_expected_from is the amount received the screen worked from; when it is
-- passed and the invoice no longer has it, nothing is written.
-- Returns { status, amount_paid, balance_due, overpaid,
--           credit_moved: [{ credit_number, refund_due, refund_status }],
--           not_on_a_credit_note }.
-- An earlier draft of this migration had no p_expected_from. A different
-- argument list is a second function rather than a replacement, and the API
-- could not tell the two apart, so that one goes first.
drop function if exists public.set_invoice_amount_received(uuid, numeric, text, text);

create or replace function public.set_invoice_amount_received(
  p_invoice_id    uuid,
  p_amount        numeric,
  p_reason        text,
  p_kind          text default 'correction',
  p_expected_from numeric default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind      text := coalesce(p_kind, 'correction');
  v_what      text;      -- how the amount is named in a message
  v_name      text;      -- INV-1036
  v_reason    text := regexp_replace(coalesce(p_reason, ''), '^\s+|\s+$', '', 'g');
  v_inv       public.invoices;
  v_note      public.credit_notes;
  v_ids       uuid[];
  v_id        uuid;
  v_sym       text;
  v_applied   numeric;   -- credit applied to this invoice from other invoices
  v_from      numeric;   -- the cash received before, in pennies
  v_amount    numeric;   -- the cash received after, in pennies
  v_credited  numeric;
  v_asked     numeric;
  v_settled   numeric;
  v_target    numeric;   -- what the notes should hold: the overpayment
  v_held      numeric;   -- what the notes hold now
  v_fixed     numeric;   -- of that, applied to invoices or refunded
  v_used      numeric;
  v_more      numeric := 0;
  v_step      numeric;
  v_due       numeric;
  v_status    text;
  v_nstatus   text;
  v_moved     jsonb := '[]';
begin
  if coalesce(public.current_user_role(), '') not in ('owner', 'editor') then
    raise exception 'Only an owner or editor can change the amount received.' using errcode = '42501';
  end if;
  if v_kind not in ('correction', 'payment') then
    raise exception 'Choose correction or payment.';
  end if;
  v_what := case when v_kind = 'payment' then 'The payment' else 'The amount received' end;

  -- The invoice and the invoices its credit notes' credit was applied to,
  -- lowest id first (the order allocate_credit and remove_credit_allocation
  -- take them in), then its credit notes. Those are read again once the
  -- invoice is held: credit applied from its notes in the moment before is
  -- then locked too, and nothing new can be applied from them after.
  select array_agg(distinct a.invoice_id) into v_ids
    from public.credit_allocations a
    join public.credit_notes c on c.id = a.credit_note_id
   where c.invoice_id = p_invoice_id and a.removed_at is null;
  for v_id in
    select x from unnest(array_append(coalesce(v_ids, '{}'), p_invoice_id)) as x group by x order by x
  loop
    perform 1 from public.invoices where id = v_id for update;
  end loop;
  for v_id in
    select distinct a.invoice_id
      from public.credit_allocations a
      join public.credit_notes c on c.id = a.credit_note_id
     where c.invoice_id = p_invoice_id and a.removed_at is null
       and a.invoice_id <> all (coalesce(v_ids, '{}'))
     order by 1
  loop
    perform 1 from public.invoices where id = v_id for update;
  end loop;

  select * into v_inv from public.invoices where id = p_invoice_id;
  if not found then
    raise exception 'Invoice not found.' using errcode = 'P0002';
  end if;
  perform 1 from public.credit_notes where invoice_id = p_invoice_id order by credit_number for update;

  if v_inv.status not in ('sent', 'viewed', 'paid') then
    raise exception 'The amount received can only be changed on a sent, viewed or paid invoice.';
  end if;

  -- Summed from the rows rather than trusting the invoice's columns, which an
  -- editor can write through the API. A paid invoice with no amount_paid was
  -- paid in full (amount_paid ?? total on every screen), less any credit
  -- applied to it, which did not settle it in cash.
  select coalesce(sum(amount), 0) into v_applied
    from public.credit_allocations where invoice_id = p_invoice_id and removed_at is null;
  v_from := round(round(coalesce(v_inv.amount_paid,
                                 case when v_inv.status = 'paid' then greatest(0, v_inv.total - v_applied) else 0 end), 6), 2);

  -- The screen worked out its total from the amount received it read. If a
  -- card payment, a colleague's payment or a correction has landed since, that
  -- total is wrong: a payment built on the old figure would swallow the one
  -- that landed. Refused, so the screen reads the invoice again.
  if p_expected_from is not null
     and (p_expected_from::text in ('NaN', 'Infinity', '-Infinity')
          or round(round(p_expected_from, 6), 2) <> v_from) then
    raise exception 'The amount received on this invoice changed while this was open. Check the figures and save again.';
  end if;

  select coalesce(sum(total), 0) into v_credited
    from public.credit_notes where invoice_id = p_invoice_id and status = 'issued';
  v_asked := greatest(0, round(round(v_inv.total - v_credited, 6), 2));

  -- A payment goes on an invoice with something left to pay. On a paid one it
  -- is almost always the same money recorded twice (two people with the
  -- invoice open); money that really did come in on top is a correction.
  if v_kind = 'payment' then
    v_name := coalesce('INV-' || v_inv.invoice_number, 'This invoice');
    if v_inv.status = 'paid' then
      raise exception '% has already been paid. Use Change to correct the amount received.', v_name;
    elsif v_from + v_applied >= v_asked then
      raise exception '% has nothing left to pay. Use Change to correct the amount received.', v_name;
    end if;
  end if;

  -- numeric takes 'NaN', which counts as more than 0, and 'Infinity'; the
  -- browser cannot send either (JSON has neither), so both are simply refused.
  if p_amount is null or p_amount::text in ('NaN', 'Infinity', '-Infinity') or (v_kind = 'correction' and p_amount < 0) then
    raise exception '%', case when v_kind = 'payment' then 'The payment must be more than 0.' else 'The amount received must be 0 or more.' end;
  end if;
  -- Whole pennies, after the 6 place float wash of the rounding rule (115).
  -- The cash already received is pennies, so a payment added to it has more
  -- places only when the payment itself does.
  if round(p_amount, 6) <> round(round(p_amount, 6), 2) then
    raise exception '% can have at most 2 decimal places.', v_what;
  end if;
  v_amount := round(round(p_amount, 6), 2);
  if v_kind = 'payment' and v_amount <= v_from then
    raise exception 'The payment must be more than 0.';
  elsif v_kind = 'correction' and v_amount = v_from then
    raise exception 'That is already the amount received on this invoice.';
  end if;

  if v_kind = 'payment' and v_reason = '' then
    v_reason := 'Payment received';
  end if;
  if char_length(v_reason) not between 3 and 500 then
    raise exception 'Give a reason of 3 to 500 characters.';
  end if;

  v_settled := v_amount + v_applied;
  v_target  := greatest(0, v_settled - v_asked);

  -- What the notes hold (owed, applied or refunded: all of it is refund_due),
  -- and the part of that already applied to invoices or refunded, which
  -- cannot come back. Applied credit is summed from the rows.
  select coalesce(sum(c.refund_due) filter (where c.refund_status in ('owed', 'allocated', 'refunded')), 0),
         coalesce(sum(c.refunded_amount + coalesce(u.used, 0)), 0)
    into v_held, v_fixed
    from public.credit_notes c
    left join (select credit_note_id, sum(amount) as used
                 from public.credit_allocations where removed_at is null
                group by credit_note_id) u on u.credit_note_id = c.id
   where c.invoice_id = p_invoice_id and c.status = 'issued';
  if v_target < v_fixed then
    v_sym := case when v_inv.currency = 'USD' then '$' else '£' end;
    raise exception '% of the credit from this invoice has already been used or refunded, so the amount received cannot go below %.',
      v_sym || to_char(v_fixed, 'FM999,999,999,990.00'),
      v_sym || to_char(v_asked + v_fixed - v_applied, 'FM999,999,999,990.00');
  end if;

  v_status := case when v_settled >= v_asked then 'paid'
                   when v_inv.status = 'paid' then 'sent'
                   else v_inv.status end;
  -- paid_at, the day the money came in (see THE RULES): as it was on an
  -- invoice that stays paid; kept, or now if it has none, while there is cash
  -- on it or it becomes paid; cleared once it has no cash and is not paid.
  update public.invoices i
     set amount_paid = v_amount,
         status      = v_status,
         paid_at     = case when v_status = 'paid' and v_inv.status = 'paid' then i.paid_at
                            when v_status = 'paid' or v_amount > 0 then coalesce(i.paid_at, now())
                            else null end,
         updated_at  = now()
   where i.id = p_invoice_id;

  if v_target > v_held then
    -- More overpaid: added newest first, each note up to its total, as
    -- record_invoice_payment adds a card payment beyond the balance.
    v_more := v_target - v_held;
    for v_note in
      select * from public.credit_notes
       where invoice_id = p_invoice_id and status = 'issued' and refund_status in ('none', 'owed', 'allocated')
       order by credit_number desc
    loop
      exit when v_more <= 0;
      v_step := least(v_more, v_note.total - v_note.refund_due);
      continue when v_step <= 0;
      update public.credit_notes
         set refund_status = 'owed', refund_due = refund_due + v_step
       where id = v_note.id
      returning refund_due into v_due;
      v_moved := v_moved || jsonb_build_array(jsonb_build_object(
        'credit_number', v_note.credit_number, 'refund_due', v_due, 'refund_status', 'owed'));
      v_more := v_more - v_step;
    end loop;
  elsif v_target < v_held then
    -- Less overpaid: off the credit still to use, newest first. The check
    -- above means it always fits.
    v_more := v_held - v_target;
    for v_note in
      select * from public.credit_notes
       where invoice_id = p_invoice_id and status = 'issued' and refund_status = 'owed'
       order by credit_number desc
    loop
      exit when v_more <= 0;
      select coalesce(sum(amount), 0) into v_used
        from public.credit_allocations where credit_note_id = v_note.id and removed_at is null;
      v_step := least(v_more, greatest(0, v_note.refund_due - v_used - v_note.refunded_amount));
      continue when v_step <= 0;
      v_due := v_note.refund_due - v_step;
      v_nstatus := case when v_due - v_used - v_note.refunded_amount > 0 then 'owed'
                        when v_note.refunded_amount > 0 then 'refunded'
                        when v_used > 0 then 'allocated'
                        else 'none' end;
      update public.credit_notes set refund_due = v_due, refund_status = v_nstatus where id = v_note.id;
      v_moved := v_moved || jsonb_build_array(jsonb_build_object(
        'credit_number', v_note.credit_number, 'refund_due', v_due, 'refund_status', v_nstatus));
      v_more := v_more - v_step;
    end loop;
    v_more := 0;
  end if;

  insert into public.invoice_payment_adjustments (invoice_id, from_amount, to_amount, reason, kind, created_by)
  values (p_invoice_id, v_from, v_amount, v_reason, v_kind, auth.uid());

  return jsonb_build_object(
    'status', v_status,
    'amount_paid', v_amount,
    'balance_due', greatest(v_asked - v_settled, 0),
    'overpaid', v_target,
    'credit_moved', v_moved,
    -- Overpaid, but no credit note (or no room on one) to hold it.
    'not_on_a_credit_note', greatest(v_more, 0));
end;
$$;

-- ── Who may call it ─────────────────────────────────────────────────────────
-- Signed in users only; the function checks the role itself.
revoke all on function public.set_invoice_amount_received(uuid, numeric, text, text, numeric) from public, anon;
grant execute on function public.set_invoice_amount_received(uuid, numeric, text, text, numeric) to authenticated;

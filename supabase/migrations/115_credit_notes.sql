-- 115: credit notes.
--
-- A credit note is how an invoice that has already gone out is reduced: a
-- returned terminal, a wrong quantity, a goodwill gesture. The invoice itself
-- is never edited once sent, so the credit sits beside it with its own number
-- (CN-1001 on) and the invoice carries the running total in amount_credited.
-- Issuing a credit never touches the invoice's status column; "Credited" and
-- "Part credited" are worked out from amount_credited on screen
-- (src/lib/creditNotes.js). Only a cancel can change it, putting a paid
-- invoice back to sent when it then asks for more than was paid.
--
-- Nobody writes these tables from the browser. There are no insert, update or
-- delete policies: every change goes through the security definer functions
-- below, which check the role, lock the invoice so two people
-- crediting it at once cannot both pass the "is there enough left" test, and
-- keep invoices.amount_credited equal to the sum of the invoice's issued
-- credit notes. That is what keeps an issued credit note unchangeable apart
-- from its refund and cancel fields. Edge functions that stamp sent_at use the
-- service role, which is not held back by RLS.
--
-- THE ROUNDING RULE (src/lib/creditNotes.js does exactly the same; keep them
-- in step). An invoice never rounds a line: InvoiceBuilder and
-- invoice-recurring add up qty x unit_price for the subtotal and
-- qty x unit_price x tax_rate / 100 for the tax, and store the sums as they
-- come (3 x 33.33 at 20% is saved as 119.988 and shown as 119.99). A credit
-- note is stored in pennies, so it does the same sums and rounds ONCE, at the
-- end:
--   tax_amount = round(sum of line tax)
--   total      = round(sum of line net + sum of line tax)
--   subtotal   = total - tax_amount
-- where round is round(round(x, 6), 2): 6 places first to wash out the float
-- noise the browser leaves in figures it stored (1.5 x 100.01 was saved as
-- 150.01500000000001), then the penny, half up. Rounding each line first would
-- make a credit for a whole invoice come out more than the invoice (three
-- lines of 1 x 0.03 at 20% are 0.11 on the invoice but 0.12 line by line) and
-- the full credit would be refused. What is left to credit,
-- round(total - credited), uses the same round, so crediting every line of an
-- invoice always comes to exactly what is left.
--
-- THE GUARDS THAT KEEP THE MONEY RIGHT (src/lib/creditNotes.js mirrors them)
--   One line, one credit. The net (qty x unit_price) credited against an
--   invoice line, over every issued note, never passes that line's own net,
--   and at each tax rate above 0 the net credited never passes the net the
--   invoice charged at that rate. So a second note cannot credit the same
--   terminal, and its VAT, again while its total still fits what is left.
--   A credit note is dated no earlier than its invoice and no later than
--   tomorrow, so it cannot land in a VAT quarter already filed.
--   Refunds follow the money. Across the invoice's issued notes, refund owed
--   plus refunded is what the customer paid beyond what the invoice now asks
--   for. Cancelling a note lowers the refunds owed on the others (newest
--   first) and is refused if refunds already paid would then be more. A paid
--   invoice that asks for more once a credit is cancelled goes back to sent,
--   so the rest shows as owed and its pay link charges it.
--   A card payment is recorded by record_invoice_payment, under the same lock
--   as issuing a credit, once per Stripe session. Money it takes beyond the
--   balance (a pay page left open while a credit was issued) is written as a
--   refund owed on the newest credit notes, where staff will see it.
--   A credited invoice keeps its figures. While an issued note stands, the
--   database refuses changes to the invoice's totals, currency and customer
--   and to its lines, whoever writes them. The credit was checked against
--   those, so the screen's own check is not enough on its own.
--
-- Idempotent: safe to run twice.
--
-- CHECK AFTER APPLYING, signed in as an editor (not with the service key):
--   insert into public.credit_notes (invoice_id, reason, subtotal, tax_amount, total)
--     select id, 'test', 1, 0, 1 from public.invoices limit 1;
-- must fail (row level security), and
--   select public.issue_credit_note('<a draft invoice id>', 'test', '[]');
-- must fail with "A draft invoice cannot be credited. Edit the invoice instead.", and
--   select public.record_invoice_payment('<any invoice id>', 1, 'test');
-- must fail with "permission denied".
--
-- ROLLBACK (roll the app back first: the invoice screens read amount_credited,
-- and stripe-webhook calls record_invoice_payment. This deletes every credit
-- note.)
--   drop trigger if exists trg_invoices_keep_credited on public.invoices;
--   drop trigger if exists trg_invoice_lines_keep_credited on public.invoice_line_items;
--   drop function if exists public.invoices_keep_credited();
--   drop function if exists public.invoice_lines_keep_credited();
--   drop function if exists public.record_invoice_payment(uuid, numeric, text);
--   drop function if exists public.issue_credit_note(uuid, text, jsonb, date);
--   drop function if exists public.cancel_credit_note(uuid, text);
--   drop function if exists public.mark_credit_note_refunded(uuid, text, text, date);
--   drop table if exists public.credit_note_lines;
--   drop table if exists public.credit_notes;   (drops its trigger and policies)
--   drop sequence if exists public.credit_note_number_seq;
--   alter table public.invoices drop column if exists stripe_paid_sessions;
--   alter table public.invoices drop column if exists amount_credited;

-- ── The invoice's running credit ────────────────────────────────────────────
alter table public.invoices add column if not exists amount_credited numeric not null default 0;
comment on column public.invoices.amount_credited is
  'Sum of the totals of this invoice''s issued (not cancelled) credit notes. Written only by issue_credit_note and cancel_credit_note.';

-- The Stripe Checkout sessions already recorded on the invoice. Stripe can
-- send the same event more than once, and the customer can have the pay page
-- open in two tabs, so the last session stamped (stripe_checkout_id) is not
-- enough to tell a repeat from a new payment.
alter table public.invoices add column if not exists stripe_paid_sessions text[] not null default '{}';
comment on column public.invoices.stripe_paid_sessions is
  'Stripe Checkout session ids whose payment is already in amount_paid. Written only by record_invoice_payment.';

-- Its own series, never reused: a cancelled credit note keeps its number.
create sequence if not exists public.credit_note_number_seq start 1001;

create table if not exists public.credit_notes (
  id             uuid primary key default gen_random_uuid(),
  credit_number  integer not null unique default nextval('public.credit_note_number_seq'),
  -- restrict: an invoice with credit notes against it cannot be deleted.
  invoice_id     uuid not null references public.invoices(id) on delete restrict,
  company_id     uuid references public.companies(id) on delete set null,
  location_id    uuid references public.locations(id) on delete set null,
  contact_id     uuid references public.contacts(id) on delete set null,
  status         text not null default 'issued' check (status in ('issued', 'cancelled')),
  issue_date     date not null default current_date,
  reason         text not null,
  subtotal       numeric not null,
  tax_amount     numeric not null,
  total          numeric not null check (total > 0),
  -- Always the invoice's own currency, copied by issue_credit_note.
  currency       text not null default 'GBP' check (currency in ('GBP', 'USD')),
  refund_status  text not null default 'none' check (refund_status in ('none', 'owed', 'refunded')),
  refund_due     numeric not null default 0,
  refunded_at    timestamptz,
  refund_method  text check (refund_method in ('Bank transfer', 'Card refund', 'Other')),
  refund_note    text,
  email_to       text,
  sent_at        timestamptz,
  -- Made the way 038 makes invoices.public_token: gen_random_uuid() is built
  -- into Postgres, so no pgcrypto is needed.
  public_token   text not null unique default replace(gen_random_uuid()::text, '-', ''),
  cancelled_at   timestamptz,
  cancelled_by   uuid references public.profiles(id) on delete set null,
  cancel_reason  text,
  created_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_credit_notes_invoice on public.credit_notes(invoice_id);
create index if not exists idx_credit_notes_company on public.credit_notes(company_id);

comment on table public.credit_notes is
  'Credit notes raised from sent, viewed or paid invoices. Read by any signed in user; written only through issue_credit_note, cancel_credit_note and mark_credit_note_refunded (or the service role).';
comment on column public.credit_notes.refund_due is
  'Money already taken on the invoice beyond what it asks for after this credit, capped at this credit''s total. 0 unless refund_status is owed or refunded.';

create table if not exists public.credit_note_lines (
  id               uuid primary key default gen_random_uuid(),
  credit_note_id   uuid not null references public.credit_notes(id) on delete cascade,
  -- Null for a free line (a goodwill credit). Also goes null if the invoice's
  -- lines are ever re-saved, which is why the name, qty and prices are copied.
  invoice_line_id  uuid references public.invoice_line_items(id) on delete set null,
  name             text not null,
  description      text,
  qty              numeric not null check (qty > 0),
  unit_price       numeric not null check (unit_price >= 0),
  tax_rate         numeric not null default 0 check (tax_rate >= 0),
  sort             integer not null default 0
);
create index if not exists idx_credit_note_lines_note on public.credit_note_lines(credit_note_id);

-- ── RLS: read like invoices, write through the functions only ──────────────
-- invoices_read (038) is FOR SELECT TO authenticated USING (true); the same
-- here. No insert, update or delete policy on purpose.
alter table public.credit_notes enable row level security;
alter table public.credit_note_lines enable row level security;

drop policy if exists credit_notes_read on public.credit_notes;
create policy credit_notes_read on public.credit_notes
  for select to authenticated using (true);

drop policy if exists credit_note_lines_read on public.credit_note_lines;
create policy credit_note_lines_read on public.credit_note_lines
  for select to authenticated using (true);

-- Supabase grants every table to anon and authenticated by default, TRUNCATE
-- included, and RLS does not stop a TRUNCATE. Take the write grants back so
-- the only way in is the functions. The service role keeps its own grants.
revoke insert, update, delete, truncate on public.credit_notes from anon, authenticated;
revoke insert, update, delete, truncate on public.credit_note_lines from anon, authenticated;

drop trigger if exists trg_credit_notes_touch on public.credit_notes;
create trigger trg_credit_notes_touch before update on public.credit_notes
  for each row execute function public.touch_updated_at();

-- ── Issue ───────────────────────────────────────────────────────────────────
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

    -- One line, one credit (the guards at the top of this file). What this
    -- note uses is added up over its lines so far, which have all passed the
    -- checks above. The case keeps the casts off the lines not checked yet (a
    -- where clause may test its conditions in any order). Compared at 6
    -- places, the same float wash as the rounding rule.
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

  -- The rounding rule at the top of this file.
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

  -- After this credit the invoice asks for total - credited - v_total. Money
  -- already taken beyond that is owed back, but never more than this credit.
  -- A paid invoice with no amount_paid was paid in full: the invoice screens
  -- already show it that way (amount_paid ?? total). Both sides are made
  -- pennies first, what is asked never below 0: the total is stored unrounded,
  -- so a full credit of 682.63 on 682.625 left would otherwise leave half a
  -- penny that rounds into a refund of 0.01 on an invoice nobody paid.
  v_excess := round(round(coalesce(v_inv.amount_paid, case when v_inv.status = 'paid' then v_inv.total else 0 end), 6), 2)
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

-- ── Cancel ──────────────────────────────────────────────────────────────────
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
  v_paid       numeric;
  v_allowed    numeric;   -- what may be owed back once this note is gone
  v_refunded   numeric;
  v_budget     numeric;
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
  if v_note.refund_status = 'refunded' then
    raise exception 'This credit has already been refunded.';
  end if;
  if char_length(v_reason) not between 3 and 500 then
    raise exception 'Give a reason of 3 to 500 characters.';
  end if;

  -- With less credit the invoice asks for more, so less of what was paid is
  -- owed back. A refund already paid cannot be taken back here, so if those
  -- alone would be more than is now owed back, the cancel is refused rather
  -- than leave the customer's balance wrong. A paid invoice with no
  -- amount_paid was paid in full (amount_paid ?? total on every screen).
  select coalesce(sum(total), 0) into v_credited
    from public.credit_notes where invoice_id = v_invoice_id and status = 'issued' and id <> p_id;
  v_paid := coalesce(v_inv.amount_paid, case when v_inv.status = 'paid' then v_inv.total else 0 end);
  -- In pennies on both sides, as issue_credit_note works out a refund.
  v_allowed := greatest(0, round(round(v_paid, 6), 2) - greatest(0, round(round(v_inv.total - v_credited, 6), 2)));
  select coalesce(sum(refund_due), 0) into v_refunded
    from public.credit_notes
   where invoice_id = v_invoice_id and status = 'issued' and id <> p_id and refund_status = 'refunded';
  if v_refunded > v_allowed then
    raise exception 'A refund has already been paid on this invoice. Without this credit it would be more than the customer overpaid, so this credit cannot be cancelled.';
  end if;

  update public.credit_notes
     set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = v_reason,
         refund_status = 'none', refund_due = 0
   where id = p_id
  returning * into v_note;

  -- The refunds owed on the other notes come down to what is left of that,
  -- oldest keeping theirs first, so the newest lose theirs first. Without
  -- this a duplicate note could go on saying a refund is owed that is not.
  v_budget := v_allowed - v_refunded;
  for v_other in
    select * from public.credit_notes
     where invoice_id = v_invoice_id and status = 'issued' and refund_status = 'owed'
     order by credit_number
       for update
  loop
    v_keep := least(v_other.refund_due, greatest(v_budget, 0));
    v_budget := v_budget - v_keep;
    if v_keep <> v_other.refund_due then
      update public.credit_notes
         set refund_due = v_keep, refund_status = case when v_keep > 0 then 'owed' else 'none' end
       where id = v_other.id;
    end if;
  end loop;

  -- Recomputed from the notes still issued, which puts the column right if it
  -- had ever drifted. A paid invoice that now asks for more than was paid is
  -- not paid any more: it goes back to sent, so the rest counts as
  -- outstanding, can be chased, and its pay link charges it. paid_at is kept
  -- as the day the earlier money came in.
  update public.invoices i
     set amount_credited = v_credited,
         status = case when i.status = 'paid' and round(round(i.total - v_paid - v_credited, 6), 2) > 0
                       then 'sent' else i.status end,
         updated_at = now()
   where i.id = v_invoice_id;

  return v_note;
end;
$$;

-- ── Mark refunded ───────────────────────────────────────────────────────────
-- Records a refund made outside the app (bank transfer, a refund on the card
-- machine). Nothing is sent to Stripe.
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
begin
  if coalesce(public.current_user_role(), '') not in ('owner', 'editor') then
    raise exception 'Only an owner or editor can mark a refund.' using errcode = '42501';
  end if;

  select invoice_id into v_invoice_id from public.credit_notes where id = p_id;
  if not found then
    raise exception 'Credit note not found.' using errcode = 'P0002';
  end if;
  -- The invoice first, as cancel_credit_note does: a cancel working out the
  -- refunds owed must not have one turn into refunded under it.
  perform 1 from public.invoices where id = v_invoice_id for update;
  select * into v_note from public.credit_notes where id = p_id for update;
  if v_note.status <> 'issued' then
    raise exception 'This credit note is cancelled.';
  end if;
  if v_note.refund_status = 'refunded' then
    raise exception 'This refund is already marked as refunded.';
  end if;
  if v_note.refund_status <> 'owed' then
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
     set refund_status = 'refunded',
         -- Noon UTC falls on the same calendar day from London to Los Angeles,
         -- so the day picked is the day every screen shows.
         refunded_at   = (coalesce(p_refunded_on, current_date) + time '12:00') at time zone 'UTC',
         refund_method = p_method,
         refund_note   = v_note_txt
   where id = p_id
  returning * into v_note;

  return v_note;
end;
$$;

-- ── Record a card payment ───────────────────────────────────────────────────
-- Called by stripe-webhook (service role only) when a Checkout session for an
-- invoice completes. It locks the invoice as issue_credit_note does, so a
-- payment and a credit note can never pass each other half way.
--   A session already recorded is a repeat delivery: nothing changes.
--   An invoice already paid is left alone (a second tab, or paid by bank
--   first); the webhook logs it so the charge can be refunded in Stripe.
--   Otherwise the payment is added to amount_paid, and the invoice is paid
--   once nothing is left to pay. Money beyond that (the pay page was open
--   while a credit note was issued) is written as a refund owed on the newest
--   issued credit notes, up to each note's total, so it shows as Refund owed.
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

  -- Pennies, by the rounding rule at the top of this file.
  v_paid := round(round(coalesce(v_inv.amount_paid, 0) + p_amount, 6), 2);
  select coalesce(sum(total), 0) into v_credited
    from public.credit_notes where invoice_id = p_invoice_id and status = 'issued';
  v_asked := greatest(0, round(round(v_inv.total - v_credited, 6), 2));
  v_status := case when v_paid >= v_asked then 'paid' else v_inv.status end;

  update public.invoices
     set amount_paid = v_paid,
         status = v_status,
         paid_at = case when v_status = 'paid' then now() else paid_at end,
         stripe_paid_sessions = case when p_session_id is null then stripe_paid_sessions
                                     else array_append(stripe_paid_sessions, p_session_id) end
   where id = p_invoice_id;

  -- Paid beyond what the invoice asks for, less what the notes already say is
  -- owed back or has been refunded.
  if v_paid > v_asked then
    select v_paid - v_asked - coalesce(sum(refund_due), 0) into v_more
      from public.credit_notes
     where invoice_id = p_invoice_id and status = 'issued' and refund_status in ('owed', 'refunded');
    for v_note in
      select * from public.credit_notes
       where invoice_id = p_invoice_id and status = 'issued' and refund_status in ('none', 'owed')
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
    'amount_paid', v_paid, 'balance_due', greatest(v_asked - v_paid, 0),
    'overpaid', greatest(v_paid - v_asked, 0),
    -- Left over when there were no credit notes to hold it (paid twice).
    'not_on_a_credit_note', greatest(v_more, 0));
end;
$$;

-- ── A credited invoice keeps its figures ────────────────────────────────────
-- issue_credit_note checked each credit against the invoice's total, lines and
-- customer. The screens stop anyone changing those once a note is issued, but
-- invoices_write (038) lets any editor write them straight through the API,
-- and a save that started before the credit could land after it. So the
-- database refuses it. The columns the functions and screens write for a
-- credited invoice (amount_credited, amount_paid, status, dates, email, notes)
-- are untouched. A company or site going to null is allowed: that is the
-- foreign key unlinking a deleted or merged company, which every other record
-- goes through too. To correct a credited invoice on purpose, cancel its
-- credit notes first.
create or replace function public.invoices_keep_credited() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (new.subtotal, new.tax_amount, new.total, new.currency) is distinct from (old.subtotal, old.tax_amount, old.total, old.currency)
     or (new.company_id is distinct from old.company_id and new.company_id is not null)
     or (new.location_id is distinct from old.location_id and new.location_id is not null) then
    if exists (select 1 from public.credit_notes where invoice_id = old.id and status = 'issued') then
      raise exception 'This invoice has a credit note issued against it, so its totals and customer cannot change. Raise another credit note instead.'
        using errcode = '55000';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_invoices_keep_credited on public.invoices;
create trigger trg_invoices_keep_credited
  before update of subtotal, tax_amount, total, currency, company_id, location_id on public.invoices
  for each row execute function public.invoices_keep_credited();

-- The lines likewise: re-saving them gives them new ids (cutting the credit
-- note lines' links) and can change what each line and rate charged. A change
-- to a line's name or description only, or a product going to null, is fine.
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
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists trg_invoice_lines_keep_credited on public.invoice_line_items;
create trigger trg_invoice_lines_keep_credited
  before insert or update or delete on public.invoice_line_items
  for each row execute function public.invoice_lines_keep_credited();

-- ── Who may call them ───────────────────────────────────────────────────────
-- Signed in users only; each function checks the role itself. Recording a
-- payment is for the webhook alone, so only the service role may call it.
revoke all on function public.issue_credit_note(uuid, text, jsonb, date) from public, anon;
revoke all on function public.cancel_credit_note(uuid, text) from public, anon;
revoke all on function public.mark_credit_note_refunded(uuid, text, text, date) from public, anon;
revoke all on function public.record_invoice_payment(uuid, numeric, text) from public, anon, authenticated;
grant execute on function public.issue_credit_note(uuid, text, jsonb, date) to authenticated;
grant execute on function public.cancel_credit_note(uuid, text) to authenticated;
grant execute on function public.mark_credit_note_refunded(uuid, text, text, date) to authenticated;
grant execute on function public.record_invoice_payment(uuid, numeric, text) to service_role;

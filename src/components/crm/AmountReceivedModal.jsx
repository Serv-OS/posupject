import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { fmtMoney, currencySymbol } from '../../lib/money';
import { plainError } from './CreditNoteModal.jsx';
import {
  amountReceivedEffect, markPaymentTotal, amountPaid, balanceDue, canRaiseCredit, creditAvailable, creditNoteLabel,
  overpaidAdvice, PAYMENT_REASON, REASON_MIN, REASON_MAX,
} from '../../lib/creditNotes';

// As plainError, but the failure that is new here gets its own words: the
// amount received migration not applied yet (set_invoice_amount_received or
// its history table missing).
export function receivedError(error) {
  const msg = String(error?.message || error || '');
  if (error?.code === 'PGRST202' || error?.code === '42883'
      || (/set_invoice_amount_received|invoice_payment_adjustments/.test(msg) && /could not find|does not exist|schema cache/i.test(msg))) {
    return 'Changing the amount received is not set up on this database yet. The amount received migration needs applying first.';
  }
  return plainError(error);
}

/**
 * What the sheet works from, read fresh: the invoice, its credit notes (newest
 * first) and the credit applied FROM those notes, which the database sums row
 * by row. allocs is undefined when that table cannot be read, and the notes'
 * own amount_allocated is used instead. { invoice, notes, allocs } or { error }.
 */
export async function loadReceivedBasis(invoiceId) {
  const [i, cn] = await Promise.all([
    supabase.from('invoices').select('*').eq('id', invoiceId).single(),
    supabase.from('credit_notes').select('*').eq('invoice_id', invoiceId).order('credit_number', { ascending: false }),
  ]);
  if (i.error || !i.data) return { error: i.error || 'Invoice not found.' };
  const notes = cn.error ? [] : (cn.data || []);
  let allocs;
  if (notes.length) {
    const a = await supabase.from('credit_allocations').select('*').in('credit_note_id', notes.map((c) => c.id));
    if (!a.error) allocs = a.data || [];
  }
  return { invoice: i.data, notes, allocs };
}

const cleanAmount = (v) => String(v ?? '').replace(/[\s,£$]/g, '');
const amountText = (v) => (Number(v) || 0).toFixed(2);
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
// The figures the preview and the database both start from. When any of them
// moved while the sheet was open, a total typed against the old ones would be
// wrong, so it is read again before anything is sent.
const moved = (a, b) => amountPaid(a) !== amountPaid(b) || a?.status !== b?.status
  || round2(a?.total) !== round2(b?.total) || round2(a?.amount_credited) !== round2(b?.amount_credited)
  || round2(a?.amount_allocated) !== round2(b?.amount_allocated);

/**
 * The amount received sheet (spec Behaviour 1 and 2), on one invoice.
 *   kind 'correction'  Change: "How much has the customer paid in total on
 *                      this invoice?" starts at the amount received now, and
 *                      needs a reason.
 *   kind 'payment'     Mark paid: "How much did they pay?" starts at the
 *                      balance due; that payment is added to the cash already
 *                      received (markPaymentTotal). The reason may be blank.
 * Both call set_invoice_amount_received with the TOTAL cash received, and
 * amountReceivedEffect shows what it will do first with the same words. The
 * call carries p_expected_from, the amount received the sheet worked from, so
 * a card payment or a colleague's payment landing in the moment before the
 * save is refused rather than swallowed, and the sheet reads the invoice
 * again. A payment on an invoice that is already paid, or has nothing left to
 * pay, is refused too (the same bank transfer recorded twice).
 * onSaved(result, { kind, payment, invoice }) once it has gone through.
 */
export default function AmountReceivedModal({ invoice: invoiceProp, kind = 'correction', onClose, onSaved }) {
  const payment = kind === 'payment';
  const [basis, setBasis] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [amount, setAmount] = useState(() => amountText(payment ? balanceDue(invoiceProp) : amountPaid(invoiceProp)));
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const started = useRef(false);
  const typedRef = useRef(false);

  const refresh = useCallback(async () => {
    const got = await loadReceivedBasis(invoiceProp.id);
    if (got.error) { setLoadError(receivedError(got.error)); return null; }
    setLoadError('');
    setBasis(got);
    return got;
  }, [invoiceProp.id]);

  // The first read replaces the starting amount, unless someone has typed.
  useEffect(() => {
    let live = true;
    refresh().then((got) => {
      if (!live || !got || started.current) return;
      started.current = true;
      if (!typedRef.current) setAmount(amountText(payment ? balanceDue(got.invoice) : amountPaid(got.invoice)));
    });
    return () => { live = false; };
  }, [refresh, payment]);

  const inv = basis?.invoice || invoiceProp;
  const notes = basis?.notes || [];
  const allocs = basis?.allocs;
  const cur = inv?.currency || 'GBP';
  const m = (v) => fmtMoney(v, cur);
  const invLbl = `INV-${inv?.invoice_number}`;

  const typed = cleanAmount(amount);
  // Mark paid sends this payment plus the cash already in; Change sends the
  // total as typed. A blank or unreadable payment is null, which is refused.
  const total = payment ? markPaymentTotal(inv, typed) : typed;
  const args = { invoice: inv, notes, allocationsFromNotes: allocs, amount: total, kind };
  const effect = amountReceivedEffect(args);
  const reasonLen = [...reason.trim()].length;
  const reasonProblem = (payment && reasonLen === 0) || (reasonLen >= REASON_MIN && reasonLen <= REASON_MAX)
    ? null : `Give a reason of ${REASON_MIN} to ${REASON_MAX} characters.`;
  const cash = amountPaid(inv);
  // The sheet opens on the amount received as it is, which is not a change
  // yet: that says what to do rather than showing a refusal in red.
  const untouchedSame = !payment && !touched && !tried && effect.problem === 'That is already the amount received on this invoice.';
  // Mark paid on an invoice someone has just paid (or that has nothing left to
  // pay): say so straight away rather than wait for an amount.
  const nothingToPay = payment && !!basis && (inv.status === 'paid' || balanceDue(inv) <= 0);
  const showProblem = effect.problem && !untouchedSame && (touched || tried || nothingToPay);

  // The credit available on a note now, reading credit applied from the rows
  // when there are any, as the database does.
  const availableNow = (c) => {
    if (!allocs) return creditAvailable(c);
    const used = allocs.filter((a) => a.credit_note_id === c.id && !a.removed_at).reduce((s, a) => s + (Number(a.amount) || 0), 0);
    return creditAvailable({ ...c, amount_allocated: round2(used) });
  };
  const moveText = (mv) => {
    const note = notes.find((c) => c.id === mv.id) || mv;
    const lbl = creditNoteLabel(note);
    const delta = round2(mv.credit_available - availableNow(note));
    if (delta > 0) return `${m(delta)} becomes credit on ${lbl} to use on another invoice.`;
    if (delta < 0) {
      return mv.credit_available > 0
        ? `${m(-delta)} of the credit to use on ${lbl} comes off, leaving ${m(mv.credit_available)}.`
        : `${m(-delta)} of the credit to use on ${lbl} comes off, so it has none left to use.`;
    }
    return null;
  };

  // An amount nobody typed was only the starting figure, so once the figures
  // are read again it starts again from the new ones.
  const restart = (got) => {
    if (got && !typedRef.current) setAmount(amountText(payment ? balanceDue(got.invoice) : amountPaid(got.invoice)));
  };

  const save = async () => {
    setTried(true);
    setError('');
    if (!basis) { setError(loadError || 'Still reading the invoice. Try again in a moment.'); return; }
    const full = amountReceivedEffect({ ...args, reason });
    // A reason problem is shown under the reason box already.
    if (full.problem) { if (full.problem !== reasonProblem) setError(full.problem); return; }
    setBusy(true);
    // Read again just before sending: a card payment or credit applied while
    // this was open would make the total typed here wrong.
    const fresh = await loadReceivedBasis(inv.id);
    if (fresh.error) { setBusy(false); setError(receivedError(fresh.error)); return; }
    if (moved(inv, fresh.invoice)) {
      setBasis(fresh);
      restart(fresh);
      setBusy(false);
      setError(`${invLbl} changed while this was open, so the figures are read again. Check them and save again.`);
      return;
    }
    const { data, error: rpcError } = await supabase.rpc('set_invoice_amount_received', {
      p_invoice_id: inv.id,
      p_amount: full.amount_paid,
      p_reason: reason.trim(),
      p_kind: kind,
      // The amount received the total was worked out from: if a card payment
      // lands in the moment before this arrives, nothing is written.
      p_expected_from: full.from_amount,
    });
    setBusy(false);
    if (rpcError) {
      setError(receivedError(rpcError));
      // What was on screen may be out of date (a payment that landed just
      // before), so it is read again.
      refresh().then(restart);
      return;
    }
    onSaved?.(data, { kind, payment: payment ? round2(full.amount_paid - full.from_amount) : null, invoice: inv });
  };

  const title = payment ? 'Record a payment' : 'Change amount received';
  const credited = Number(inv?.amount_credited) || 0;
  const applied = Number(inv?.amount_allocated) || 0;
  const field = 'w-full r-field !text-[16px] sm:!text-sm disabled:opacity-60';
  const label = 'text-sm font-semibold text-paper block mb-1';
  const row = 'flex justify-between gap-3';

  return createPortal(
    // Portalled to <body> like the raise and apply screens: full screen on a
    // phone, a centred dialog from sm up.
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-stretch sm:items-center justify-center sm:p-6"
      onClick={(e) => e.target === e.currentTarget && !busy && onClose?.()}>
      <div role="dialog" aria-modal="true" aria-label={title}
        style={{ background: 'var(--scene)' }}
        className="sm:rounded-2xl shadow-2xl w-full sm:max-w-md flex flex-col max-h-full sm:max-h-[92vh] min-h-0">

        <div className="px-4 sm:px-5 py-3 border-b border-bdr flex items-center gap-3 shrink-0">
          <div className="min-w-0">
            <div className="text-base font-bold text-paper truncate">{title}</div>
            <div className="text-[11px] text-muted">{invLbl} · {payment ? `${m(balanceDue(inv))} to pay` : `${m(cash)} received so far`}</div>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close"
            className="ml-auto w-10 h-10 shrink-0 rounded-xl text-muted hover:text-paper hover:bg-card flex items-center justify-center disabled:opacity-50"><X size={18} /></button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-5 py-4 space-y-4">
          {/* What the figure is measured against. */}
          <div className="rounded-xl border border-bdr px-3 py-2 text-xs space-y-1">
            <div className={`${row} text-muted`}><span>Invoice total</span><span className="tabular-nums text-paper">{m(inv?.total)}</span></div>
            {credited > 0 && <div className={`${row} text-violet-700`}><span>Credit notes</span><span className="tabular-nums">-{m(credited)}</span></div>}
            {applied > 0 && <div className={`${row} text-violet-700`}><span>Credit applied</span><span className="tabular-nums">-{m(applied)}</span></div>}
            <div className={`${row} text-muted`}><span>Amount received so far</span><span className="tabular-nums text-paper">{m(cash)}</span></div>
          </div>

          {loadError && <div className="text-xs text-red-600 font-semibold" role="alert">{loadError}</div>}

          <div>
            <label className={label} htmlFor="received-amount">
              {payment ? 'How much did they pay?' : 'How much has the customer paid in total on this invoice?'}
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted pointer-events-none">{currencySymbol(cur)}</span>
              <input id="received-amount" type="text" inputMode="decimal" autoComplete="off" className={`${field} !pl-7`} disabled={busy}
                value={amount} onChange={(e) => { setAmount(e.target.value); setTouched(true); typedRef.current = true; setError(''); }} placeholder="0.00" />
            </div>
            <div className="text-[11px] text-dim mt-1">
              {payment
                ? (cash > 0 ? `This payment only. It is added to the ${m(cash)} already received.` : 'This payment only, received outside Stripe.')
                : 'The total cash received, not the difference. Card payments are included.'}
            </div>
          </div>

          <div>
            <label className={label} htmlFor="received-reason">{payment ? 'Reason (optional)' : 'Reason'}</label>
            <textarea id="received-reason" className={field + ' resize-none'} rows={2} maxLength={REASON_MAX} disabled={busy}
              value={reason} onChange={(e) => { setReason(e.target.value); setError(''); }}
              placeholder={payment ? PAYMENT_REASON : `e.g. Customer sent ${m(inv?.total)} by bank transfer`} />
            <div className="flex items-start gap-2 text-[10px]">
              {tried && reasonProblem && <span className="text-red-600 font-semibold">{reasonProblem}</span>}
              <span className="ml-auto text-dim">{reasonLen} / {REASON_MAX}</span>
            </div>
          </div>
        </div>

        <div className="px-4 sm:px-5 py-3 border-t border-bdr shrink-0 space-y-2" style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
          {basis && !effect.problem && (
            <div className="text-xs space-y-1" aria-live="polite">
              <div className={`${row} text-muted`}>
                <span>Amount received</span>
                <span className="tabular-nums text-right"><span className="text-dim">{m(effect.from_amount)}</span> → <span className="font-semibold text-paper">{m(effect.amount_paid)}</span></span>
              </div>
              <div className={`${row} text-muted`}>
                <span>Balance after</span>
                <span className="tabular-nums text-right font-semibold text-paper">{m(effect.balance_due)}</span>
              </div>
              {effect.status !== inv.status && (
                <div className={effect.status === 'paid' ? 'text-emerald-700 font-semibold' : 'text-amber-deep font-semibold'}>
                  {effect.status === 'paid' ? `${invLbl} will be marked paid.` : `${invLbl} goes back to Sent with ${m(effect.balance_due)} to pay.`}
                </div>
              )}
              {effect.overpaid > 0 && (
                <div className={`${row} text-amber-deep font-semibold`}><span>Overpaid</span><span className="tabular-nums">{m(effect.overpaid)}</span></div>
              )}
              {effect.credit_moved.map((mv) => moveText(mv)).filter(Boolean).map((t) => (
                <div key={t} className="text-amber-deep">{t}</div>
              ))}
              {effect.not_on_a_credit_note > 0 && (
                <div className="text-amber-deep">
                  Overpaid {m(effect.not_on_a_credit_note)}. {overpaidAdvice({
                    invoice: { ...inv, amount_paid: effect.amount_paid, status: effect.status },
                    overpaid: effect.not_on_a_credit_note,
                    canCredit: canRaiseCredit(inv),
                  })}
                </div>
              )}
            </div>
          )}
          {basis && untouchedSame && (
            <div className="text-xs text-muted">Type the total the customer has actually paid on {invLbl}.</div>
          )}
          {showProblem && !error && <div className="text-xs text-red-600 font-semibold" role="alert">{effect.problem}</div>}
          {error && <div className="text-xs text-red-600 font-semibold" role="alert">{error}</div>}
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} disabled={busy} className="btn-ghost px-4 py-2.5 rounded-xl text-sm disabled:opacity-50">Close</button>
            <button type="button" onClick={save} disabled={busy || !basis}
              className="flex-1 sm:flex-none sm:ml-auto btn-glass px-5 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-50">
              {busy ? 'Saving…' : payment
                ? (effect.problem ? 'Record payment' : `Record ${m(round2(effect.amount_paid - effect.from_amount))} payment`)
                : 'Save amount received'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

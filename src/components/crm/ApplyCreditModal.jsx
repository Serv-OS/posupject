import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Check } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { money } from './InvoicesPanel.jsx';
import { plainError } from './CreditNoteModal.jsx';
import {
  ALLOCATABLE_STATUSES, ALLOCATION_NOTE_MAX, allocationDefault, allocationEffect, allocationProblems,
  balanceDue, creditAvailable, creditNoteLabel, creditUse,
} from '../../lib/creditNotes';

// As plainError, but the one failure that is new here gets its own words: the
// credit allocations migration not applied yet (the table, a column or
// allocate_credit missing).
export function allocError(error) {
  const msg = String(error?.message || error || '');
  if (error?.code === 'PGRST202' || error?.code === 'PGRST205' || error?.code === '42P01' || error?.code === '42703'
      || (/credit_allocation|allocate_credit|amount_allocated|refunded_amount/.test(msg) && /could not find|does not exist|schema cache/i.test(msg))) {
    return 'Applying credit is not set up on this database yet. The credit allocations migration needs applying first.';
  }
  return plainError(error);
}

const invLabel = (n) => (n == null || n === '' ? '' : `INV-${n}`);
// Typed money: spaces, commas and a pound or dollar sign are fine to type.
const cleanAmount = (v) => String(v ?? '').replace(/[\s,£$]/g, '');
const amountText = (v) => (Number(v) || 0).toFixed(2);
const partyOf = (row) => [row?.company?.name, row?.location?.name].filter(Boolean).join(' · ');

// The same customer: the same company, or with no company on the starting
// side, the same contact. Anything else sits behind "Show other customers".
function sameCustomer(base, row) {
  if (base?.company_id) return row?.company_id === base.company_id;
  if (base?.contact_id) return row?.contact_id === base.contact_id;
  return false;
}

function fmtDay(d, currency) {
  if (!d) return '';
  const date = new Date(String(d).length <= 10 ? `${d}T00:00:00` : d);
  if (Number.isNaN(date.getTime())) return String(d);
  return date.toLocaleDateString(currency === 'USD' ? 'en-US' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * The apply screen (spec Behaviour 2 and 3). Open it from a credit note with
 * `note` (pick the invoice the credit goes to) or from an unpaid invoice with
 * `invoice` (pick the credit note it comes from). Both are read again when the
 * screen opens. The amount starts at the credit available or the balance due,
 * whichever is less, and can be lowered; allocate_credit has the final say on
 * every figure, and allocationProblems says the same things before it is sent.
 * onApplied(row, { note, invoice, amount, settles }) once it has gone through.
 */
export default function ApplyCreditModal({ note: noteProp = null, invoice: invoiceProp = null, onClose, onApplied }) {
  const fromNote = !!noteProp;
  const [base, setBase] = useState(fromNote ? noteProp : invoiceProp);
  const [rows, setRows] = useState(null);           // the candidates; null while the first read runs
  const [numbers, setNumbers] = useState({});        // invoice id -> invoice_number
  const [loadError, setLoadError] = useState('');
  const [others, setOthers] = useState(false);
  const [pickedId, setPickedId] = useState(null);
  const [amount, setAmount] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const firstRead = useRef(true);

  const cur = base?.currency || 'GBP';
  const m = (v) => money(v, cur);
  const baseId = fromNote ? noteProp?.id : invoiceProp?.id;

  // Fresh rows every time: a colleague may have applied, refunded or been
  // paid since the page loaded. The candidates are filtered here as well as
  // by the query, so the list never offers what allocate_credit would refuse
  // for the invoice or note itself.
  const read = useCallback(async () => {
    if (fromNote) {
      const [n, list] = await Promise.all([
        supabase.from('credit_notes').select('*').eq('id', baseId).single(),
        supabase.from('invoices').select('*, company:companies(name), location:locations(name)')
          .in('status', ALLOCATABLE_STATUSES).eq('currency', noteProp.currency || 'GBP').order('issue_date', { ascending: true }),
      ]);
      const err = n.error || list.error;
      if (err || !n.data) return { error: err || 'Credit note not found.' };
      const note = n.data;
      const found = (list.data || [])
        .filter((i) => i.id !== note.invoice_id && ALLOCATABLE_STATUSES.includes(i.status)
          && (i.currency || 'GBP') === (note.currency || 'GBP') && balanceDue(i) > 0)
        .sort((a, b) => String(a.issue_date || '').localeCompare(String(b.issue_date || '')) || (Number(a.invoice_number) || 0) - (Number(b.invoice_number) || 0));
      const src = await supabase.from('invoices').select('id, invoice_number').eq('id', note.invoice_id);
      return { base: note, rows: found, numbers: Object.fromEntries((src.data || []).map((i) => [i.id, i.invoice_number])) };
    }
    const [i, list] = await Promise.all([
      supabase.from('invoices').select('*').eq('id', baseId).single(),
      supabase.from('credit_notes').select('*, company:companies(name), location:locations(name)')
        .eq('status', 'issued').eq('refund_status', 'owed').eq('currency', invoiceProp.currency || 'GBP').order('credit_number', { ascending: true }),
    ]);
    const err = i.error || list.error;
    if (err || !i.data) return { error: err || 'Invoice not found.' };
    const invoice = i.data;
    const found = (list.data || [])
      .filter((c) => c.invoice_id !== invoice.id && (c.currency || 'GBP') === (invoice.currency || 'GBP') && creditAvailable(c) > 0)
      .sort((a, b) => (Number(a.credit_number) || 0) - (Number(b.credit_number) || 0));
    const ids = [...new Set(found.map((c) => c.invoice_id))];
    const src = ids.length ? await supabase.from('invoices').select('id, invoice_number').in('id', ids) : { data: [] };
    return { base: invoice, rows: found, numbers: Object.fromEntries((src.data || []).map((x) => [x.id, x.invoice_number])) };
  }, [fromNote, baseId, noteProp?.currency, invoiceProp?.currency]);

  const pairFor = (row, b = base) => (fromNote ? { note: b, invoice: row } : { note: row, invoice: b });

  const refresh = useCallback(async () => {
    const got = await read();
    if (got.error) { setLoadError(allocError(got.error)); setRows((r) => r || []); return; }
    setLoadError('');
    setBase(got.base);
    setRows(got.rows);
    setNumbers(got.numbers);
    if (firstRead.current) {
      firstRead.current = false;
      // One candidate for this customer: it is picked already.
      const same = got.rows.filter((r) => sameCustomer(got.base, r));
      if (same.length === 1) {
        setPickedId(same[0].id);
        setAmount(amountText(allocationDefault(fromNote ? { note: got.base, invoice: same[0] } : { note: same[0], invoice: got.base })));
      }
    } else {
      setPickedId((id) => (got.rows.some((r) => r.id === id) ? id : null));
    }
  }, [read, fromNote]);

  useEffect(() => { refresh(); }, [refresh]);

  const list = rows || [];
  const same = list.filter((r) => sameCustomer(base, r));
  const rest = list.filter((r) => !sameCustomer(base, r));
  const shown = others ? [...same, ...rest] : same;
  const picked = list.find((r) => r.id === pickedId) || null;
  const pair = picked ? pairFor(picked) : null;
  const typed = cleanAmount(amount);
  const problems = pair ? allocationProblems({ ...pair, amount: typed, allocationNote: text }) : [];
  const effect = pair && !problems.length ? allocationEffect({ ...pair, amount: typed, allocationNote: text }) : null;

  const choose = (row) => {
    if (busy) return;
    setPickedId(row.id);
    setAmount(amountText(allocationDefault(pairFor(row))));
    setError('');
  };
  const toggleOthers = () => {
    const next = !others;
    setOthers(next);
    if (!next && picked && !sameCustomer(base, picked)) { setPickedId(null); setAmount(''); }
  };

  const apply = async () => {
    setError('');
    if (!pair) { setError(fromNote ? 'Choose the invoice to apply the credit to.' : 'Choose the credit note to use.'); return; }
    if (problems.length) { setError(problems[0]); return; }
    setBusy(true);
    const { data, error: rpcError } = await supabase.rpc('allocate_credit', {
      p_credit_note_id: pair.note.id,
      p_invoice_id: pair.invoice.id,
      p_amount: Number(typed),
      p_note: text.trim() || null,
    });
    setBusy(false);
    if (rpcError) {
      setError(allocError(rpcError));
      // What was on screen may be out of date, so it is read again.
      refresh();
      return;
    }
    onApplied?.(data, { note: pair.note, invoice: pair.invoice, amount: effect?.amount ?? Number(typed), settles: !!effect?.invoice?.settles });
  };

  const noteLbl = fromNote ? creditNoteLabel(base) : '';
  const title = fromNote ? `Apply credit from ${noteLbl}` : `Use credit on ${invLabel(base?.invoice_number)}`;
  const sub = fromNote
    ? `${m(creditAvailable(base))} credit available${numbers[base?.invoice_id] != null ? ` · raised on ${invLabel(numbers[base.invoice_id])}` : ''}`
    : `${m(balanceDue(base))} left to pay`;
  const noun = fromNote ? 'invoice' : 'credit note';
  const most = pair ? allocationDefault(pair) : 0;

  const field = 'w-full r-field !text-[16px] sm:!text-sm disabled:opacity-60';
  const label = 'text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-muted mb-1 block';
  const noteLen = [...text.trim()].length;

  const candidate = (row) => {
    const on = row.id === pickedId;
    const other = !sameCustomer(base, row);
    let head, figure, lines;
    if (fromNote) {
      const bal = balanceDue(row);
      head = invLabel(row.invoice_number);
      figure = `${m(bal)} to pay`;
      lines = [
        [partyOf(row), row.due_date ? `Due ${fmtDay(row.due_date, cur)}` : null].filter(Boolean).join(' · '),
        Math.abs(bal - Number(row.total || 0)) >= 0.005 ? `Invoice total ${m(row.total)}` : null,
      ];
    } else {
      const use = creditUse(row);
      head = creditNoteLabel(row);
      figure = `${m(use.left)} available`;
      lines = [
        [numbers[row.invoice_id] != null ? `From ${invLabel(numbers[row.invoice_id])}` : null, fmtDay(row.issue_date, cur), partyOf(row)].filter(Boolean).join(' · '),
        use.used > 0 ? `${m(use.used)} already used` : null,
      ];
    }
    return (
      <button key={row.id} type="button" role="radio" aria-checked={on} onClick={() => choose(row)} disabled={busy}
        className={`w-full text-left rounded-xl border p-3 flex items-start gap-3 min-h-[56px] transition disabled:opacity-60 ${on ? 'border-ember bg-ember/10' : 'border-bdr hover:bg-card'}`}>
        <span className={`mt-0.5 w-5 h-5 shrink-0 rounded-full border-2 flex items-center justify-center ${on ? 'border-ember bg-ember text-white' : 'border-bdr'}`}>
          {on && <Check size={12} strokeWidth={3} />}
        </span>
        <span className="flex-1 min-w-0">
          <span className="flex items-baseline gap-2">
            <span className="font-mono text-sm font-semibold text-paper">{head}</span>
            <span className="ml-auto text-sm font-semibold text-paper tabular-nums text-right">{figure}</span>
          </span>
          {lines.filter(Boolean).map((l, k) => <span key={k} className="block text-xs text-muted break-words">{l}</span>)}
          {other && <span className="block text-xs text-amber-deep font-semibold">This {noun} is for a different customer.</span>}
        </span>
      </button>
    );
  };

  return createPortal(
    // Portalled to <body> like the raise screen: full screen on a phone, a
    // centred dialog from sm up.
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-stretch sm:items-center justify-center sm:p-6"
      onClick={(e) => e.target === e.currentTarget && !busy && onClose?.()}>
      <div role="dialog" aria-modal="true" aria-label={title}
        style={{ background: 'var(--scene)' }}
        className="sm:rounded-2xl shadow-2xl w-full sm:max-w-xl flex flex-col max-h-full sm:max-h-[92vh] min-h-0">

        <div className="px-4 sm:px-5 py-3 border-b border-bdr flex items-center gap-3 shrink-0">
          <div className="min-w-0">
            <div className="text-base font-bold text-paper truncate">{title}</div>
            <div className="text-[11px] text-muted">{sub}</div>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close"
            className="ml-auto w-10 h-10 shrink-0 rounded-xl text-muted hover:text-paper hover:bg-card flex items-center justify-center disabled:opacity-50"><X size={18} /></button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-5 py-4 space-y-4">
          <div className="space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={label + ' !mb-0'}>{fromNote ? 'Choose an invoice' : 'Choose a credit note'}</span>
              {rest.length > 0 && (
                <label className="ml-auto flex items-center gap-2 cursor-pointer select-none min-h-[40px]">
                  <input type="checkbox" className="w-5 h-5 accent-emerald-600" checked={others} disabled={busy} onChange={toggleOthers} />
                  <span className="text-xs text-paper">Show other customers ({rest.length})</span>
                </label>
              )}
            </div>
            {rows == null && !loadError && <div className="text-xs text-dim italic py-4 text-center">Loading…</div>}
            {loadError && <div className="text-xs text-red-600 font-semibold" role="alert">{loadError}</div>}
            {rows != null && !loadError && shown.length === 0 && (
              <div className="text-xs text-dim italic py-4 text-center">
                {list.length === 0
                  ? (fromNote
                    ? `No sent or viewed ${cur} invoices have anything left to pay.`
                    : `No ${cur} credit notes have credit available.`)
                  : `Nothing for this customer. Tick Show other customers to see the rest.`}
              </div>
            )}
            <div role="radiogroup" aria-label={fromNote ? 'Invoices' : 'Credit notes'} className="space-y-2">
              {shown.map(candidate)}
            </div>
          </div>

          {pair && (
            <div className="space-y-3">
              <div>
                <label className={label} htmlFor="alloc-amount">Amount to apply</label>
                <input id="alloc-amount" type="text" inputMode="decimal" autoComplete="off" className={field} disabled={busy}
                  value={amount} onChange={(e) => { setAmount(e.target.value); setError(''); }} placeholder="0.00" />
                <div className="text-[10px] text-dim mt-0.5">
                  Up to {m(most)}: the {m(creditAvailable(pair.note))} left on {creditNoteLabel(pair.note)} or the {m(balanceDue(pair.invoice))} to pay on {invLabel(pair.invoice.invoice_number)}, whichever is less.
                </div>
              </div>
              <div>
                <label className={label} htmlFor="alloc-note">Note (optional)</label>
                <textarea id="alloc-note" className={field + ' resize-none'} rows={2} maxLength={ALLOCATION_NOTE_MAX} disabled={busy}
                  value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Customer paid 224 less on the next invoice" />
                <div className="text-[10px] text-dim text-right">{noteLen} / {ALLOCATION_NOTE_MAX}</div>
              </div>
            </div>
          )}
        </div>

        <div className="px-4 sm:px-5 py-3 border-t border-bdr shrink-0 space-y-2" style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
          {pair && effect && (
            <div className="text-xs space-y-0.5">
              <div className="text-muted">
                {creditNoteLabel(pair.note)}: {effect.note.credit_available > 0
                  ? <><span className="font-semibold text-paper">{m(effect.note.credit_available)}</span> credit left afterwards</>
                  : <span className="font-semibold text-paper">all of its credit used</span>}
              </div>
              <div className="text-muted">
                {invLabel(pair.invoice.invoice_number)}: {effect.invoice.settles
                  ? <span className="font-semibold text-emerald-700">paid in full</span>
                  : <><span className="font-semibold text-paper">{m(effect.invoice.balance_due)}</span> left to pay afterwards</>}
              </div>
            </div>
          )}
          {pair && problems.length > 0 && (
            <ul className="text-xs text-red-600 list-disc pl-4 space-y-0.5">
              {problems.map((p) => <li key={p}>{p}</li>)}
            </ul>
          )}
          {error && !problems.includes(error) && <div className="text-xs text-red-600 font-semibold" role="alert">{error}</div>}
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} disabled={busy} className="btn-ghost px-4 py-2.5 rounded-xl text-sm disabled:opacity-50">Close</button>
            <button type="button" onClick={apply} disabled={busy || !pair}
              className="flex-1 sm:flex-none sm:ml-auto btn-glass px-5 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-50">
              {busy ? 'Applying…' : effect ? `Apply ${m(effect.amount)}` : 'Apply credit'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

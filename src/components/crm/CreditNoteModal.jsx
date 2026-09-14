import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Plus, RotateCcw } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { money } from './InvoicesPanel.jsx';
import { round2, taxLabelFor, currencySymbol } from '../../lib/money';
import {
  linesFromInvoice, taxRatesFor, creditTotals, creditableLeft, balanceDue, validateCredit, refundFor,
  lineNet, lineTax, lineCreditLeft, creditIssueDate, REASON_MAX,
} from '../../lib/creditNotes';

const FN = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

// The calendar day a credit note or a refund is dated. The database's own
// current_date is the UTC date, so the browser sends the day in the
// invoice's region instead: a pound invoice takes the UK day, a dollar one
// the US office day. Without this a US credit raised at 6pm Pacific would be
// dated tomorrow, and land in next month's report on the last day of a month.
const REGION_TZ = { GBP: 'Europe/London', USD: 'America/Los_Angeles' };
export function regionToday(currency = 'GBP', now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: REGION_TZ[currency] || REGION_TZ.GBP, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now);
    const get = (t) => parts.find((p) => p.type === t)?.value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

// The database functions already raise plain sentences, so those pass
// straight through. Only the two failures that are NOT ours get new words:
// the migration not applied yet (PostgREST cannot find the function or
// table), and no connection at all.
export function plainError(error) {
  const msg = String(error?.message || error || '');
  if (error?.code === 'PGRST202' || error?.code === '42P01' || error?.code === 'PGRST205'
      || (/credit_note/.test(msg) && /could not find|does not exist|schema cache/i.test(msg))) {
    return 'Credit notes are not set up on this database yet. The credit notes migration needs applying first.';
  }
  if (/failed to fetch|networkerror|load failed/i.test(msg)) return 'Could not reach the server. Check the connection and try again.';
  return msg || 'Something went wrong. Try again.';
}

/**
 * What a credit is raised against, read fresh: the invoice, its lines, and the
 * lines of its issued credit notes (what earlier credits already used, so no
 * line is credited twice). { invoice, lines, creditedLines } or { error }.
 */
export async function loadCreditBasis(invoiceId) {
  const [i, li, cn] = await Promise.all([
    supabase.from('invoices').select('*').eq('id', invoiceId).single(),
    supabase.from('invoice_line_items').select('*').eq('invoice_id', invoiceId).order('sort'),
    supabase.from('credit_notes').select('id').eq('invoice_id', invoiceId).eq('status', 'issued'),
  ]);
  const error = i.error || li.error || cn.error;
  if (error) return { error };
  const ids = (cn.data || []).map((c) => c.id);
  let creditedLines = [];
  if (ids.length) {
    const cl = await supabase.from('credit_note_lines').select('invoice_line_id, qty, unit_price, tax_rate').in('credit_note_id', ids);
    if (cl.error) return { error: cl.error };
    creditedLines = cl.data || [];
  }
  return { invoice: i.data, lines: li.data || [], creditedLines };
}

let keySeq = 0;
const withKey = (l) => ({ ...l, _key: `l${++keySeq}` });

/**
 * The raise screen (spec Behaviour 2 to 4). Starts with every invoice line at
 * what is left on it (full value when nothing is credited yet); the user
 * lowers, removes or adds lines, gives a reason and issues. There is no draft:
 * issue_credit_note creates the note as issued in one call, and that call has
 * the final say on every figure shown here. Pass what loadCreditBasis read.
 */
export default function CreditNoteModal({ invoice: invoiceProp, invoiceLines: linesProp = [], creditedLines: creditedProp = [], contactEmail = '', onClose, onIssued }) {
  const [invoice, setInvoice] = useState(invoiceProp);
  const [invoiceLines, setInvoiceLines] = useState(linesProp || []);
  const [creditedLines, setCreditedLines] = useState(creditedProp || []);
  const [lines, setLines] = useState(() => linesFromInvoice(linesProp, creditedProp).map(withKey));
  const [reason, setReason] = useState('');
  const [emailOn, setEmailOn] = useState(false);
  const [emailTo, setEmailTo] = useState(invoiceProp?.email_to || contactEmail || '');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const touched = useRef(false);

  // What is left to credit can change while this screen is open (a colleague
  // raising a credit on the same invoice), so it is read again once. The
  // starting lines are only swapped in if nobody has started editing.
  useEffect(() => {
    let live = true;
    (async () => {
      const basis = await loadCreditBasis(invoiceProp.id);
      if (!live || basis.error) return;
      setInvoice(basis.invoice);
      setInvoiceLines(basis.lines);
      setCreditedLines(basis.creditedLines);
      if (!touched.current) setLines(linesFromInvoice(basis.lines, basis.creditedLines).map(withKey));
    })();
    return () => { live = false; };
  }, [invoiceProp.id]);

  const cur = invoice?.currency || 'GBP';
  const m = (v) => money(v, cur);
  const taxLbl = taxLabelFor(cur);
  const sorted = [...invoiceLines].sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0));
  const srcOf = (l) => (l.invoice_line_id ? invoiceLines.find((s) => s.id === l.invoice_line_id) : null);

  const edit = (fn) => { touched.current = true; setLines(fn); };
  const setLine = (key, k, v) => edit((p) => p.map((l) => (l._key === key ? { ...l, [k]: v } : l)));
  const removeLine = (key) => edit((p) => p.filter((l) => l._key !== key));
  const wholeInvoice = () => edit(() => linesFromInvoice(invoiceLines, creditedLines).map(withKey));
  const addFreeLine = () => {
    // A goodwill credit usually carries the rate the invoice charged, so it
    // starts on the first line's rate (any rate on the invoice is allowed).
    const allowed = taxRatesFor({ line: {}, invoiceLines, invoice });
    const first = sorted.length ? Number(sorted[0].tax_rate) || 0 : Number(invoice?.tax_rate) || 0;
    edit((p) => [...p, withKey({ invoice_line_id: null, name: '', description: '', qty: 1, unit_price: '', tax_rate: allowed.includes(first) ? first : 0 })]);
  };

  // What is sent is what is checked: the inputs hold text, the database wants
  // numbers, and a blank box means 0 to both.
  const payload = lines.map((l) => ({
    invoice_line_id: l.invoice_line_id || null,
    name: String(l.name || '').trim(),
    description: String(l.description || '').trim() || null,
    qty: Number(l.qty) || 0,
    unit_price: Number(l.unit_price) || 0,
    tax_rate: Number(l.tax_rate) || 0,
  }));
  const totals = creditTotals(payload);
  const left = creditableLeft(invoice);
  const over = totals.total > left;
  const refund = refundFor({ invoice, creditTotal: totals.total });
  const newBalance = balanceDue({ ...invoice, amount_credited: round2(Number(invoice?.amount_credited || 0) + totals.total) });

  // The database only limits the whole credit. "Lower qty or unit price" is
  // the rule on screen too, so a copied line cannot go above the invoice line
  // it came from; otherwise a credit could quietly re-price the invoice.
  const lineLimits = [];
  payload.forEach((l, i) => {
    const src = srcOf(l);
    if (!src) return;
    if (l.qty > (Number(src.qty) || 0)) lineLimits.push(`Line ${i + 1}: the quantity is more than on the invoice.`);
    if (l.unit_price > (Number(src.unit_price) || 0)) lineLimits.push(`Line ${i + 1}: the unit price is more than on the invoice.`);
  });
  // Dated today in the invoice's region, or the invoice's own date if later.
  const today = regionToday(cur);
  const issueDate = creditIssueDate(invoice, today);
  const problems = [...validateCredit({ invoice, lines: payload, reason, invoiceLines, creditedLines, issueDate, today }), ...lineLimits];

  const issue = async () => {
    setTried(true); setError('');
    if (problems.length) return;
    const to = emailTo.trim();
    if (emailOn && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) { setError('Enter a valid email address, or untick Email it.'); return; }
    if (!confirm(`Issue a credit note for ${m(totals.total)} against INV-${invoice.invoice_number}? It cannot be edited once issued.`)) return;
    setBusy(true);
    const { data: note, error: rpcError } = await supabase.rpc('issue_credit_note', {
      p_invoice_id: invoice.id,
      p_reason: reason.trim(),
      p_lines: payload,
      p_issue_date: issueDate,
    });
    if (rpcError || !note) {
      setBusy(false);
      setError(plainError(rpcError || 'The credit note was not created. Try again.'));
      return;
    }
    // The note exists from here on. A failed email must not read as a failed
    // credit, so it is handed back to the invoice screen to say so.
    let emailedTo = null, emailError = null;
    if (emailOn) {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const res = await fetch(`${FN}/credit-note-send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
          body: JSON.stringify({ credit_note_id: note.id, to }),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.error || 'Send failed');
        emailedTo = d.to || to;
      } catch (e) { emailError = plainError(e); }
    }
    setBusy(false);
    onIssued?.(note, { emailedTo, emailError });
  };

  const field = 'w-full r-field !text-[16px] sm:!text-sm disabled:opacity-60';
  const label = 'text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-muted mb-1 block';
  const reasonLen = [...reason.trim()].length;

  return createPortal(
    // Portalled to <body>: the invoice screen's cards use backdrop-filter,
    // which would otherwise clip a fixed overlay to the card. Full screen on a
    // phone, a centred dialog from sm up.
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-stretch sm:items-center justify-center sm:p-6"
      onClick={(e) => e.target === e.currentTarget && !busy && onClose?.()}>
      <div role="dialog" aria-modal="true" aria-label={`Credit note for INV-${invoice?.invoice_number}`}
        style={{ background: 'var(--scene)' }}
        className="sm:rounded-2xl shadow-2xl w-full sm:max-w-2xl flex flex-col max-h-full sm:max-h-[92vh] min-h-0">

        <div className="px-4 sm:px-5 py-3 border-b border-bdr flex items-center gap-3 shrink-0">
          <div className="min-w-0">
            <div className="text-base font-bold text-paper truncate">Credit note for INV-{invoice?.invoice_number}</div>
            <div className="text-[11px] text-muted">
              Invoice {m(invoice?.total)}
              {Number(invoice?.amount_credited) > 0 && <> · already credited {m(invoice.amount_credited)}</>}
              {' · '}<span className="font-semibold text-paper">left to credit {m(left)}</span>
            </div>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close"
            className="ml-auto w-10 h-10 shrink-0 rounded-xl text-muted hover:text-paper hover:bg-card flex items-center justify-center disabled:opacity-50"><X size={18} /></button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-5 py-4 space-y-4">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={label + ' !mb-0'}>What to credit</span>
            <div className="ml-auto flex items-center gap-2 flex-wrap">
              <button type="button" onClick={wholeInvoice} disabled={busy || !invoiceLines.length}
                className="btn-ghost px-3 py-2 rounded-xl text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50">
                <RotateCcw size={13} /> Credit the whole invoice
              </button>
              <button type="button" onClick={addFreeLine} disabled={busy}
                className="btn-ghost px-3 py-2 rounded-xl text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50">
                <Plus size={13} /> Add a line
              </button>
            </div>
          </div>
          {Number(invoice?.amount_credited) > 0 && (
            <div className="text-[11px] text-amber-deep">Part of this invoice is already credited. Each line starts at what is left on it; a line credited in full is not shown.</div>
          )}

          {lines.length === 0 && (
            <div className="text-xs text-dim italic py-4 text-center">No lines. Use Credit the whole invoice or Add a line.</div>
          )}
          {lines.map((l, i) => {
            const src = srcOf(l);
            const rates = taxRatesFor({ line: l, invoiceLines, invoice });
            const p = payload[i];
            return (
              <div key={l._key} className="glass-inner rounded-xl p-3 space-y-2">
                <div className="flex items-start gap-2">
                  <span className="text-[10px] font-mono text-dim pt-1 shrink-0">{i + 1}</span>
                  {l.invoice_line_id ? (
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-paper break-words">{l.name}</div>
                      {l.description && <div className="text-xs text-muted break-words">{l.description}</div>}
                      {src && <div className="text-[10px] text-dim">On the invoice: {Number(src.qty) || 0} x {m(src.unit_price)} at {Number(src.tax_rate) || 0}%</div>}
                      {src && lineCreditLeft(src, creditedLines) < lineNet(src) && (
                        <div className="text-[10px] text-dim">Left to credit on this line: {m(lineCreditLeft(src, creditedLines))} before {taxLbl}</div>
                      )}
                    </div>
                  ) : (
                    <div className="flex-1 min-w-0 space-y-2">
                      <input className={field} value={l.name} disabled={busy} onChange={(e) => setLine(l._key, 'name', e.target.value)} placeholder="Line name, e.g. Goodwill credit" />
                      <input className={field} value={l.description || ''} disabled={busy} onChange={(e) => setLine(l._key, 'description', e.target.value)} placeholder="Description (optional)" />
                    </div>
                  )}
                  <button type="button" onClick={() => removeLine(l._key)} disabled={busy} title="Remove line" aria-label={`Remove line ${i + 1}`}
                    className="w-9 h-9 shrink-0 rounded-lg text-red-500 hover:bg-red-50 text-lg leading-none disabled:opacity-50">&times;</button>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <label className="min-w-0"><span className="text-[9px] text-muted block mb-0.5">Qty</span>
                    <input type="number" inputMode="decimal" min="0" step="any" className={field} disabled={busy}
                      value={l.qty} onChange={(e) => setLine(l._key, 'qty', e.target.value)} /></label>
                  <label className="min-w-0"><span className="text-[9px] text-muted block mb-0.5">Unit {currencySymbol(cur)} (ex {taxLbl})</span>
                    <input type="number" inputMode="decimal" min="0" step="any" className={field} disabled={busy}
                      value={l.unit_price} onChange={(e) => setLine(l._key, 'unit_price', e.target.value)} placeholder="0.00" /></label>
                  <label className="min-w-0"><span className="text-[9px] text-muted block mb-0.5">{taxLbl} %</span>
                    {/* Only 0 or what the invoice charged: crediting tax the
                        invoice never charged would hand back tax never paid. */}
                    <select className={field} disabled={busy} value={String(Number(l.tax_rate) || 0)}
                      onChange={(e) => setLine(l._key, 'tax_rate', Number(e.target.value))}>
                      {rates.map((r) => <option key={r} value={String(r)}>{r}%</option>)}
                    </select></label>
                </div>
                <div className="text-right text-xs text-muted">
                  Credit <span className="text-paper font-mono font-semibold">{m(lineNet(p))}</span>
                  <span className="mx-1.5 text-dim">+</span>
                  {taxLbl} <span className="text-paper font-mono font-semibold">{m(lineTax(p))}</span>
                </div>
              </div>
            );
          })}

          <div>
            <label className={label} htmlFor="cn-reason">Reason (the customer sees this)</label>
            <textarea id="cn-reason" className={field + ' resize-none'} rows={3} maxLength={REASON_MAX} disabled={busy}
              value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Terminal returned unused" />
            <div className="text-[10px] text-dim text-right">{reasonLen} / {REASON_MAX}</div>
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input type="checkbox" className="w-5 h-5 accent-emerald-600" checked={emailOn} disabled={busy} onChange={(e) => setEmailOn(e.target.checked)} />
              <span className="text-sm text-paper">Email it to {emailTo.trim() || 'the customer'}</span>
            </label>
            {emailOn && (
              <input type="email" inputMode="email" autoComplete="email" className={field} disabled={busy}
                value={emailTo} onChange={(e) => setEmailTo(e.target.value)} placeholder="customer@example.com" />
            )}
          </div>
        </div>

        <div className="px-4 sm:px-5 py-3 border-t border-bdr shrink-0 space-y-2" style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
          <div className="text-sm space-y-0.5">
            <div className="flex justify-between text-muted"><span>Subtotal</span><span className="tabular-nums">{m(totals.subtotal)}</span></div>
            <div className="flex justify-between text-muted"><span>{taxLbl}</span><span className="tabular-nums">{m(totals.tax_amount)}</span></div>
            <div className="flex justify-between font-bold text-paper"><span>Total credit</span><span className={`tabular-nums ${over ? 'text-red-600' : ''}`}>{m(totals.total)}</span></div>
            {over
              ? <div className="text-xs text-red-600">That is more than the {m(left)} left to credit.</div>
              : refund.refund_status === 'owed'
                ? <div className="text-xs text-amber-deep">Money has already been taken on this invoice, so a refund of {m(refund.refund_due)} will be owed. Mark it refunded once the money has gone back.</div>
                : totals.total > 0 && <div className="text-xs text-muted">Balance due after this credit: <span className="font-semibold text-paper">{m(newBalance)}</span></div>}
          </div>
          {tried && problems.length > 0 && (
            <ul className="text-xs text-red-600 list-disc pl-4 space-y-0.5">
              {problems.map((p) => <li key={p}>{p}</li>)}
            </ul>
          )}
          {error && <div className="text-xs text-red-600 font-semibold" role="alert">{error}</div>}
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} disabled={busy} className="btn-ghost px-4 py-2.5 rounded-xl text-sm disabled:opacity-50">Close</button>
            <button type="button" onClick={issue} disabled={busy}
              className="flex-1 sm:flex-none sm:ml-auto btn-glass px-5 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-50">
              {busy ? 'Issuing…' : `Issue credit note ${m(totals.total)}`}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

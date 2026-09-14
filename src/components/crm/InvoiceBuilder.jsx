import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { ArrowLeft, Send, Link2, Trash2, Plus, Check, Ban, Repeat, FileDown, FileMinus, Mail } from 'lucide-react';
import { money, invStatus, INV_BADGE, creditMarker, CN_BADGE } from './InvoicesPanel.jsx';
import CreditNoteModal, { plainError, regionToday, loadCreditBasis } from './CreditNoteModal.jsx';
import { listPrice, unitPriceFor, isPricedIn } from '../../lib/catalogue';
import { round2, taxLabelFor, defaultTaxRateFor, currencySymbol, currencyLocale } from '../../lib/money';
import { currencyForCountry } from '../../lib/region';
import { downloadInvoicePdf, creditNotePdf } from '../../lib/invoicePdf';
import {
  canRaiseCredit, balanceDue, amountPaid, creditState, creditNoteLabel, creditNoteStatusLabel,
  cancelCreditEffect, overpaidNotOnCredit, REFUND_METHODS, REASON_MIN, REASON_MAX,
} from '../../lib/creditNotes';

const FN = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

export default function InvoiceBuilder({ invoiceId, profile, onClose, onNavigate }) {
  const [inv, setInv] = useState(null);
  const [lines, setLines] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [locations, setLocations] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [products, setProducts] = useState([]);
  const [stockCounts, setStockCounts] = useState({});
  const [globalTerms, setGlobalTerms] = useState('');
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [seller, setSeller] = useState(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [flash, setFlash] = useState('');
  // Declared up here with the rest: a hook below the loading return would
  // change the hook count between the first render and the next.
  const [flipNote, setFlipNote] = useState('');
  // As last read from the database. `inv` and `lines` carry unsaved edits;
  // credit notes are always raised against what was saved and sent.
  const [savedInv, setSavedInv] = useState(null);
  const [creditNotes, setCreditNotes] = useState([]);
  // False when the credit notes table is not there yet (the migration not
  // applied): then nothing about credit notes is shown, not even the button.
  const [creditsReady, setCreditsReady] = useState(false);
  const [raising, setRaising] = useState(null);     // { invoice, lines, creditedLines } while the raise screen is open
  const [refunding, setRefunding] = useState(null);   // credit note id with the refund form open
  const [cnBusy, setCnBusy] = useState('');            // `${id}:${action}` while one runs
  const canWrite = profile.role === 'owner' || profile.role === 'editor';
  const isOwner = profile.role === 'owner';

  const load = useCallback(async () => {
    const [i, li, c, l, ct, st, pr, sk, cn] = await Promise.all([
      supabase.from('invoices').select('*').eq('id', invoiceId).single(),
      supabase.from('invoice_line_items').select('*').eq('invoice_id', invoiceId).order('sort'),
      supabase.from('companies').select('id, name, address, city, postcode, country').order('name'),
      supabase.from('locations').select('id, name, company_id, address, city, postcode, country').order('name'),
      supabase.from('contacts').select('id, first_name, last_name, email').order('last_name'),
      supabase.from('support_settings').select('invoice_terms, business_name, business_address, business_email, business_phone, logo_url, quote_accent').eq('id', 1).maybeSingle(),
      supabase.from('products').select('id, name, description, default_price, default_price_usd, cost_price_usd, category').eq('active', true).order('name'),
      supabase.from('inv_serials').select('product_id').eq('status', 'in_stock'),
      // Newest first. An error (the credit notes migration not applied yet)
      // reads as no credit notes, so the invoice still opens.
      supabase.from('credit_notes').select('*').eq('invoice_id', invoiceId).order('credit_number', { ascending: false }),
    ]);
    setInv(i.data);
    setSavedInv(i.data);
    setCreditNotes(cn.error ? [] : (cn.data || [])); setCreditsReady(!cn.error);
    setLines((li.data || []).length ? li.data : [{ _new: true, name: '', description: '', qty: 1, unit_price: 0, tax_rate: defaultTaxRateFor(i.data?.currency) }]);
    setCompanies(c.data || []); setLocations(l.data || []); setContacts(ct.data || []);
    setProducts(pr.data || []);
    const counts = {};
    (sk.data || []).forEach(r => { counts[r.product_id] = (counts[r.product_id] || 0) + 1; });
    setStockCounts(counts);
    setGlobalTerms(st.data?.invoice_terms || '');
    setSeller(st.data || {});
  }, [invoiceId]);
  useEffect(() => { load(); }, [load]);

  // After a credit note action: its list and the invoice's credited figure
  // change, and a cancel can put a paid invoice back to sent (with what was
  // paid kept), so those are taken too. Nothing else, so unsaved edits on the
  // page are kept.
  const refreshCredits = useCallback(async () => {
    const [cn, i] = await Promise.all([
      supabase.from('credit_notes').select('*').eq('invoice_id', invoiceId).order('credit_number', { ascending: false }),
      supabase.from('invoices').select('*').eq('id', invoiceId).single(),
    ]);
    if (!cn.error) { setCreditNotes(cn.data || []); setCreditsReady(true); }
    if (i.data) {
      setSavedInv(i.data);
      const { amount_credited, status, amount_paid, paid_at, updated_at } = i.data;
      setInv(p => (p ? { ...p, amount_credited, status, amount_paid, paid_at, updated_at } : i.data));
    }
  }, [invoiceId]);

  if (!inv) return <div className="h-full flex items-center justify-center text-dim text-sm">Loading invoice…</div>;

  const st = invStatus(inv);
  const locked = ['paid', 'void'].includes(inv.status);
  // The invoice's own currency drives every symbol, label and default below.
  const cur = inv.currency || 'GBP';
  const m = (v) => money(v, cur);
  const taxLbl = taxLabelFor(cur);
  // Changing currency re-bases the DEFAULT tax rates: lines still on the old
  // default (20 GBP / 0 USD) follow to the new one, so a US invoice never
  // quietly carries 20% 'Sales tax'. Custom rates are left alone.
  const changeCurrency = (next) => {
    if (next === cur) return;
    const oldDef = defaultTaxRateFor(cur), newDef = defaultTaxRateFor(next);
    // A price is never carried across currencies: a catalogue line takes the
    // product's price in the new currency (0 if it has none there), and a
    // typed line resets to 0, because its number was in the old money and no
    // exchange rate exists. This also fires when the Company or Location
    // picker flips the currency, which is why it says so on screen.
    setLines(p => p.map(l => ({
      ...l,
      tax_rate: Number(l.tax_rate ?? oldDef) === oldDef ? newDef : l.tax_rate,
      unit_price: l.product_id ? unitPriceFor(products.find(x => x.id === l.product_id), next) : 0,
    })));
    setFlipNote(`Currency changed to ${currencySymbol(next)}. Catalogue lines took their ${currencySymbol(next)} price; typed lines reset to 0.`);
    set('currency', next);
  };
  const set = (k, v) => setInv(p => ({ ...p, [k]: v }));
  const setLine = (i, k, v) => setLines(p => p.map((l, j) => j === i ? { ...l, [k]: v } : l));
  const locs = locations.filter(l => !inv.company_id || l.company_id === inv.company_id);

  const subtotal = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unit_price) || 0), 0);
  const taxAmount = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unit_price) || 0) * (Number(l.tax_rate) || 0) / 100, 0);
  const total = subtotal + taxAmount;

  // Credit notes point at this invoice's lines, and what is left to credit is
  // worked out from its total. Saving re-writes every line (new ids, so those
  // links would be cut) and could drop the total below what is already
  // credited. So while a credit note is issued, lines, totals and the customer
  // are frozen; the way to reduce the invoice further is another credit note.
  // A cancelled note takes nothing off, so once every note is cancelled the
  // invoice can be corrected again (posupcrm works the same way).
  const hasCredits = creditNotes.length > 0;
  const issuedNotes = creditNotes.filter(c => c.status === 'issued');
  const creditLocked = issuedNotes.length > 0 || creditState(inv) !== 'none';
  const linesLocked = locked || creditLocked;
  const credited = Number(inv.amount_credited) || 0;
  const refundOwed = round2(issuedNotes.filter(c => c.refund_status === 'owed').reduce((s, c) => s + (Number(c.refund_due) || 0), 0));
  const liveInv = { ...inv, total };
  const paidSoFar = amountPaid(liveInv);
  // A balance line only when it says something: there is credit, or part has
  // been paid and some is still owed (a deposit). A plain paid invoice already
  // reads Total then Paid, and "Balance due 0.00" under that is noise.
  const showBalance = !['draft', 'void'].includes(inv.status)
    && (creditState(inv) !== 'none' || (paidSoFar > 0 && balanceDue(liveInv) > 0));
  // Taken beyond what the invoice asks for and not on any credit note as a
  // refund (a card payment that landed after a credit, or paid twice).
  const overpaid = creditsReady ? overpaidNotOnCredit(liveInv, creditNotes) : 0;
  const mark = creditMarker(inv);

  const notify = (msg) => { setFlash(msg); setTimeout(() => setFlash(''), 2500); };

  const save = async (extra = {}) => {
    setSaving(true);
    // Asked again at save time: a colleague may have raised a credit note
    // since this screen loaded. A draft can never have one, so drafts skip it.
    let frozen = creditLocked;
    if (!frozen && creditsReady && inv.status !== 'draft') {
      const { count } = await supabase.from('credit_notes').select('id', { count: 'exact', head: true })
        .eq('invoice_id', invoiceId).eq('status', 'issued');
      frozen = (count || 0) > 0;
    }
    const patch = {
      company_id: inv.company_id || null, location_id: inv.location_id || null, contact_id: inv.contact_id || null,
      currency: cur,
      email_to: (inv.email_to || '').trim() || null, issue_date: inv.issue_date, due_date: inv.due_date || null,
      ...(frozen ? {} : { subtotal, tax_amount: taxAmount, total }),
      terms: (inv.terms || '').trim() || null, notes: (inv.notes || '').trim() || null,
      po_number: (inv.po_number || '').trim() || null, ...extra,
    };
    let { error } = await supabase.from('invoices').update(patch).eq('id', invoiceId);
    if (!error && !frozen) {
      ({ error } = await supabase.from('invoice_line_items').delete().eq('invoice_id', invoiceId));
      const clean = lines.filter(l => (l.name || '').trim());
      if (!error && clean.length) {
        ({ error } = await supabase.from('invoice_line_items').insert(clean.map((l, i) => ({
          invoice_id: invoiceId, name: l.name.trim(), description: (l.description || '').trim() || null,
          qty: Number(l.qty) || 1, unit_price: Number(l.unit_price) || 0,
          tax_rate: Number(l.tax_rate) || 0, sort: i,
        }))));
      }
    }
    setSaving(false);
    // The database refuses new totals or lines once a credit note is issued,
    // even when a colleague's credit landed after the check above. Its message
    // says so in plain words; the page then shows the invoice as it stands.
    if (error) { alert(error.message); load(); return false; }
    load();
    return true;
  };

  const sendInvoice = async () => {
    let to = inv.email_to || contacts.find(c => c.id === inv.contact_id)?.email || '';
    to = prompt('Send invoice to:', to);
    if (!to) return;
    if (!(await save())) return;
    setSending(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`${FN}/invoice-send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ invoice_id: invoiceId, to: to.trim() }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Send failed');
      notify(`Sent to ${d.to}`);
      load();
    } catch (e) { alert('Send failed: ' + e.message); }
    setSending(false);
  };

  const copyLink = async () => {
    await save();
    const url = `${window.location.origin}/i/${inv.public_token}`;
    try { await navigator.clipboard.writeText(url); notify('Link copied'); } catch { prompt('Invoice link:', url); }
  };

  // The seller and customer blocks, shared by the invoice and credit note PDFs.
  const sellerInfo = () => ({
    name: seller?.business_name, address: seller?.business_address,
    email: seller?.business_email, phone: seller?.business_phone,
    logo_url: seller?.logo_url, accent: seller?.quote_accent,
  });
  const billToFor = (row) => {
    const company = companies.find(c => c.id === row.company_id);
    const location = locations.find(l => l.id === row.location_id);
    const contact = contacts.find(c => c.id === row.contact_id);
    const addr = (o) => o ? [o.address, o.city, o.postcode].filter(Boolean).join(', ') : '';
    return {
      companyName: company?.name, companyAddress: addr(company),
      contactName: contact ? [contact.first_name, contact.last_name].filter(Boolean).join(' ') : '',
      contactEmail: contact?.email,
      locationName: location?.name, locationAddress: addr(location),
    };
  };

  // One-click PDF. Persists edits first (unless locked) so the file matches the
  // saved invoice, then renders client-side via the lazy-loaded generator.
  const downloadPdf = async () => {
    setPdfBusy(true);
    try {
      if (!locked && !(await save())) { setPdfBusy(false); return; }
      await downloadInvoicePdf({
        inv: { ...inv, terms: inv.terms || globalTerms }, lines,
        totals: { subtotal, tax: taxAmount, total, paid: inv.amount_paid },
        seller: sellerInfo(),
        billTo: billToFor(inv),
        fmt: m, taxLabel: taxLbl, dateLocale: currencyLocale(cur),
      });
      notify('PDF downloaded');
    } catch (e) { alert('PDF failed: ' + e.message); }
    setPdfBusy(false);
  };

  const markPaid = async () => {
    // With credit on the invoice the customer pays the balance, not the total.
    // Recording the total would read as an overpayment, and the next credit
    // note would then say a refund is owed that never was.
    const paid = credited > 0 ? round2(amountPaid(savedInv) + balanceDue(savedInv)) : total;
    if (!confirm(credited > 0
      ? `Mark this invoice as paid? This records ${m(paid)} received outside Stripe: the total less credit notes.`
      : 'Mark this invoice as paid (received outside Stripe)?')) return;
    await save({ status: 'paid', paid_at: new Date().toISOString(), amount_paid: paid });
    notify('Marked paid');
  };
  const voidInvoice = async () => {
    // A void invoice drops out of every total but its credit notes would not,
    // so the two would disagree. The credit notes are cancelled first.
    if (issuedNotes.length) {
      alert(`This invoice has ${issuedNotes.length === 1 ? 'a credit note' : 'credit notes'} against it. An owner must cancel ${issuedNotes.length === 1 ? 'it' : 'them'} before the invoice can be voided.`);
      return;
    }
    if (!confirm('Void this invoice? The public link will stop working.')) return;
    await save({ status: 'void' });
  };
  const del = async () => {
    // Credit notes keep their invoice for the records (the database refuses
    // the delete), so say so before asking rather than after.
    if (hasCredits) {
      alert(`INV-${inv.invoice_number} has credit notes against it, so it cannot be deleted.`);
      return;
    }
    if (!confirm(`Delete invoice INV-${inv.invoice_number}? This cannot be undone.`)) return;
    const { error } = await supabase.from('invoices').delete().eq('id', invoiceId);
    if (error) {
      alert(error.code === '23503'
        ? `INV-${inv.invoice_number} has credit notes or other records linked to it, so it cannot be deleted.`
        : `Could not delete the invoice: ${error.message}`);
      refreshCredits();
      return;
    }
    onClose();
  };

  // ── Credit notes ──
  // The raise screen works from the invoice as SAVED. Unsaved edits are saved
  // first, as Send and PDF do, on a credited invoice too (its header can still
  // change, and the refresh after issuing would otherwise drop the edits).
  // Saving gives the lines new ids, so the invoice, its lines and what earlier
  // credit notes used are read back once the save has landed, and only then
  // does the screen open: it never starts from line ids that are gone.
  const openCredit = async () => {
    if (!locked && !(await save())) return;
    const basis = await loadCreditBasis(invoiceId);
    if (basis.error) { alert(`Could not load the invoice: ${plainError(basis.error)}`); return; }
    if (!canRaiseCredit(basis.invoice)) { alert('Nothing is left to credit on this invoice.'); refreshCredits(); return; }
    setRaising(basis);
  };
  const canCredit = canWrite && creditsReady && canRaiseCredit(savedInv);

  const onCreditIssued = (note, { emailedTo, emailError } = {}) => {
    setRaising(null);
    refreshCredits();
    const lbl = creditNoteLabel(note);
    if (emailError) alert(`${lbl} was issued, but the email did not send: ${emailError}`);
    else notify(emailedTo ? `${lbl} issued and sent to ${emailedTo}` : `${lbl} issued`);
  };

  const creditPdf = async (note) => {
    setCnBusy(`${note.id}:pdf`);
    try {
      const { data: cnLines, error } = await supabase.from('credit_note_lines').select('*').eq('credit_note_id', note.id).order('sort');
      if (error) throw error;
      const ncur = note.currency || cur;
      await creditNotePdf({
        note, lines: cnLines || [], invoice: savedInv || inv,
        seller: sellerInfo(), billTo: billToFor(note),
        fmt: (v) => money(v, ncur), taxLabel: taxLabelFor(ncur), dateLocale: currencyLocale(ncur),
      });
    } catch (e) { alert('PDF failed: ' + plainError(e)); }
    setCnBusy('');
  };

  const emailCredit = async (note) => {
    const lbl = creditNoteLabel(note);
    const contactEmail = contacts.find(c => c.id === (note.contact_id || inv.contact_id))?.email;
    const to = prompt(`Email ${lbl} to:`, note.email_to || savedInv?.email_to || contactEmail || '');
    if (!to || !to.trim()) return;
    setCnBusy(`${note.id}:email`);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`${FN}/credit-note-send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ credit_note_id: note.id, to: to.trim() }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Send failed');
      notify(`${lbl} sent to ${d.to || to.trim()}`);
      refreshCredits();
    } catch (e) { alert(`Could not send ${lbl}: ${plainError(e)}`); }
    setCnBusy('');
  };

  const cancelCredit = async (note) => {
    const lbl = creditNoteLabel(note);
    // Said before asking, by the same rules the database applies.
    const effect = cancelCreditEffect({ invoice: savedInv || inv, notes: creditNotes, noteId: note.id });
    if (effect.problem) { alert(effect.problem); return; }
    const also = [
      note.refund_status === 'owed' ? `The refund owed on it (${money(note.refund_due, note.currency || cur)}) is cleared.` : null,
      ...effect.refunds.map(r => {
        const other = creditNotes.find(c => c.id === r.id);
        return r.refund_due > 0
          ? `The refund owed on ${creditNoteLabel(other)} drops to ${m(r.refund_due)}.`
          : `${creditNoteLabel(other)} no longer owes a refund.`;
      }),
      effect.reopen ? `INV-${inv.invoice_number} was paid for what was left after this credit, so it goes back to Sent with ${m(effect.balance_due)} to pay.` : null,
    ].filter(Boolean);
    const why = prompt(`Cancel ${lbl}? It keeps its number but no longer reduces the invoice.${also.length ? `\n\n${also.join('\n')}` : ''}\n\nWhy is it being cancelled?`);
    if (why == null) return;
    const len = [...why.trim()].length;
    if (len < REASON_MIN || len > REASON_MAX) { alert(`Give a reason of ${REASON_MIN} to ${REASON_MAX} characters.`); return; }
    setCnBusy(`${note.id}:cancel`);
    const { error } = await supabase.rpc('cancel_credit_note', { p_id: note.id, p_reason: why.trim() });
    setCnBusy('');
    if (error) { alert(plainError(error)); return; }
    notify(`${lbl} cancelled`);
    refreshCredits();
  };

  const input = "w-full px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper placeholder-dim focus:outline-none focus:border-ember disabled:opacity-60";
  const cell = "px-2 py-1.5 bg-card border border-bdr rounded-lg text-sm text-paper placeholder-dim focus:outline-none focus:border-ember disabled:opacity-60";
  const label = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block";

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 py-4 border-b border-bdr flex items-center gap-3 flex-wrap">
        <button onClick={onClose} className="text-muted hover:text-paper"><ArrowLeft size={18} /></button>
        <div className="text-xl font-bold text-paper">INV-{inv.invoice_number}</div>
        <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-lg ${INV_BADGE[st]}`}>{st}</span>
        {mark && <span className="text-[10px] font-semibold text-violet-700">{mark}</span>}
        {inv.viewed_at
          ? <span className="text-[10px] font-semibold text-emerald-600" title={`Customer opened the invoice ${new Date(inv.viewed_at).toLocaleString('en-GB')}`}>👁 Viewed {new Date(inv.viewed_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
          : inv.sent_at && <span className="text-[10px] text-muted">Sent {new Date(inv.sent_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · not opened yet</span>}
        {inv.recurring_id && <span className="text-[10px] text-uv flex items-center gap-1"><Repeat size={11} /> from recurring schedule</span>}
        {flash && <span className="text-xs text-emerald-600 font-semibold">✓ {flash}</span>}
        {canWrite && (
          <div className="flex gap-2 ml-auto flex-wrap">
            {!locked && <button onClick={() => save().then(ok => ok && notify('Saved'))} disabled={saving} className="btn-ghost px-4 py-2 rounded-xl text-sm disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>}
            <button onClick={copyLink} className="btn-ghost px-3 py-2 rounded-xl text-sm flex items-center gap-1.5"><Link2 size={14} /> Copy link</button>
            <button onClick={downloadPdf} disabled={pdfBusy} title="Download this invoice as a PDF" className="btn-ghost px-3 py-2 rounded-xl text-sm flex items-center gap-1.5 disabled:opacity-50"><FileDown size={14} /> {pdfBusy ? 'Preparing…' : 'PDF'}</button>
            {canCredit && <button onClick={openCredit} disabled={saving} title="Reduce this invoice with a credit note" className="btn-ghost px-3 py-2 rounded-xl text-sm flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50"><FileMinus size={14} /> Raise credit note</button>}
            {!locked && <button onClick={sendInvoice} disabled={sending} className="btn-glass px-4 py-2 rounded-xl text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50"><Send size={14} /> {sending ? 'Sending…' : inv.sent_at ? 'Resend' : 'Send'}</button>}
            {!locked && !(credited > 0 && balanceDue(savedInv) === 0) && <button onClick={markPaid} className="px-3 py-2 rounded-xl text-sm font-semibold bg-emerald-500/15 text-emerald-700 border border-emerald-500/30 flex items-center gap-1.5"><Check size={14} /> Mark paid</button>}
            {!locked && <button onClick={voidInvoice} title="Void" className="btn-ghost px-3 py-2 rounded-xl text-sm flex items-center gap-1.5 text-muted"><Ban size={14} /></button>}
            {profile.role === 'owner' && <button onClick={del} title="Delete" className="px-3 py-2 text-red-600 border border-red-200 rounded-xl hover:bg-red-50"><Trash2 size={14} /></button>}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-[900px] mx-auto space-y-5">

          {/* Customer + dates */}
          <div className="glass-card rounded-2xl p-5 grid grid-cols-2 md:grid-cols-3 gap-3">
            <div><label className={label}>Company</label>
              <select className={input} disabled={linesLocked} value={inv.company_id || ''} onChange={e => {
                const id = e.target.value || null;
                set('company_id', id); set('location_id', null);
                // A draft follows its customer's country; a sent document never
                // changes currency behind anyone's back.
                if (id && inv.status === 'draft') {
                  const co = companies.find(x => x.id === id);
                  if (co) changeCurrency(currencyForCountry(co.country));
                }
              }}>
                <option value="">—</option>{companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
            <div><label className={label}>Currency</label>
              <select className={input} disabled={inv.status !== 'draft'} value={cur} onChange={e => changeCurrency(e.target.value)}>
                <option value="GBP">GBP £ (UK — VAT)</option>
                <option value="USD">USD $ (US — sales tax)</option>
              </select></div>
            <div><label className={label}>Location</label>
              <select className={input} disabled={linesLocked} value={inv.location_id || ''} onChange={e => {
                const id = e.target.value || null;
                set('location_id', id);
                // Site country first, then company: a draft for the US site of
                // a UK group bills in dollars. Sent documents never move.
                if (id && inv.status === 'draft') {
                  const loc = locations.find(x => x.id === id);
                  const co = companies.find(x => x.id === inv.company_id);
                  changeCurrency(currencyForCountry(loc?.country || co?.country));
                }
              }}>
                <option value="">—</option>{locs.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
            <div><label className={label}>Contact</label>
              <select className={input} disabled={locked} value={inv.contact_id || ''} onChange={e => set('contact_id', e.target.value || null)}>
                <option value="">—</option>{contacts.map(c => <option key={c.id} value={c.id}>{[c.first_name, c.last_name].filter(Boolean).join(' ') || c.email}</option>)}</select></div>
            <div><label className={label}>Send to (email)</label><input className={input} disabled={locked} value={inv.email_to || ''} onChange={e => set('email_to', e.target.value)} placeholder="defaults to contact" /></div>
            <div><label className={label}>PO number</label><input className={input} disabled={locked} value={inv.po_number || ''} onChange={e => set('po_number', e.target.value)} placeholder="Customer purchase order ref" /></div>
            <div><label className={label}>Issue date</label><input type="date" className={input} disabled={locked} value={inv.issue_date || ''} onChange={e => set('issue_date', e.target.value)} /></div>
            <div><label className={label}>Due date</label><input type="date" className={input} disabled={locked} value={inv.due_date || ''} onChange={e => set('due_date', e.target.value)} /></div>
          </div>

          {/* Lines */}
          <div className="glass-card rounded-2xl p-5 space-y-2">
            <div className="flex items-center gap-3">
              <span className={label + ' !mb-0'}>Line items</span>
              {!linesLocked && (
                <div className="ml-auto flex items-center gap-3">
                  {products.length > 0 ? (
                    <select className={input + ' !w-60 !py-1.5 text-xs'} value=""
                      onChange={e => {
                        const p = products.find(x => x.id === e.target.value);
                        if (p) setLines(prev => {
                          const blank = prev.length === 1 && !(prev[0].name || '').trim();
                          const line = { _new: true, product_id: p.id, name: p.name, description: p.description || '', qty: 1, unit_price: unitPriceFor(p, cur), tax_rate: defaultTaxRateFor(cur) };
                          return blank ? [line] : [...prev, line];
                        });
                      }}>
                      <option value="">+ Add from products…</option>
                      {products.map(p => <option key={p.id} value={p.id}>
                        {p.name} — {listPrice(p, cur)}{stockCounts[p.id] != null ? ` (${stockCounts[p.id]} in stock)` : ''}
                      </option>)}
                    </select>
                  ) : (
                    <span className="text-[11px] text-dim italic">No products in the catalogue yet — add them under Inventory → Products</span>
                  )}
                  <button onClick={() => setLines(p => [...p, { _new: true, name: '', description: '', qty: 1, unit_price: 0, tax_rate: defaultTaxRateFor(cur) }])}
                    className="text-xs text-ember hover:text-ember-deep font-medium flex items-center gap-1"><Plus size={13} /> Blank line</button>
                </div>
              )}
            </div>
            {flipNote && <div className="text-[11px] text-amber-700">{flipNote}</div>}
            {creditLocked && !locked && (
              <div className="text-[11px] text-dim italic">The lines are locked because a credit note has been issued on this invoice. To reduce it further, raise another credit note.</div>
            )}
            {!linesLocked && products.some(p => !isPricedIn(p, cur)) && (
              <div className="text-[11px] text-dim italic">Some products have no {currencySymbol(cur)} price yet and land at 0 to type. Set it under Products.</div>
            )}
            {lines.length === 0 && <div className="text-xs text-dim italic py-4 text-center">No line items yet. Add from products or start a blank line.</div>}
            {lines.map((l, i) => (
              <div key={l.id || `n${i}`} className="glass-inner rounded-xl p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <input className={cell + ' flex-1'} disabled={linesLocked} value={l.name} onChange={e => setLine(i, 'name', e.target.value)} placeholder="Item name — e.g. Card terminal" />
                  {!linesLocked && <button onClick={() => setLines(p => p.filter((_, j) => j !== i))} title="Remove line" className="text-red-500 hover:text-red-600 text-sm shrink-0">&times;</button>}
                </div>
                <input className={cell + ' w-full text-xs'} disabled={linesLocked} value={l.description || ''} onChange={e => setLine(i, 'description', e.target.value)} placeholder="Description (shown on the invoice)" />
                <div className="grid grid-cols-3 gap-2">
                  <div><span className="text-[9px] text-dim block">Qty</span>
                    <input type="number" className={cell + ' w-full'} disabled={linesLocked} value={l.qty} onChange={e => setLine(i, 'qty', e.target.value)} placeholder="1" /></div>
                  <div><span className="text-[9px] text-dim block">Unit {currencySymbol(cur)} (ex {taxLbl})</span>
                    <input type="number" className={cell + ' w-full'} disabled={linesLocked} value={l.unit_price} onChange={e => setLine(i, 'unit_price', e.target.value)} placeholder="0.00" /></div>
                  <div><span className="text-[9px] text-dim block">{taxLbl} %</span>
                    <input type="number" className={cell + ' w-full'} disabled={linesLocked} value={l.tax_rate ?? defaultTaxRateFor(cur)} onChange={e => setLine(i, 'tax_rate', e.target.value)} placeholder={String(defaultTaxRateFor(cur))} /></div>
                </div>
                <div className="text-right text-xs text-muted">
                  Net: <span className="text-paper font-mono font-semibold">{m((Number(l.qty) || 0) * (Number(l.unit_price) || 0))}</span>
                  <span className="mx-1.5 text-dim">·</span>
                  {taxLbl}: <span className="text-paper font-mono font-semibold">{m((Number(l.qty) || 0) * (Number(l.unit_price) || 0) * (Number(l.tax_rate) || 0) / 100)}</span>
                </div>
              </div>
            ))}
            <div className="flex justify-end pt-2 border-t border-bdr">
              <div className="w-64 space-y-1.5 text-sm">
                <div className="flex justify-between text-muted"><span>Subtotal</span><span className="tabular-nums">{m(subtotal)}</span></div>
                <div className="flex justify-between text-muted"><span>{taxLbl} (per line)</span><span className="tabular-nums">{m(taxAmount)}</span></div>
                <div className="flex justify-between text-base font-bold text-paper pt-1.5 border-t border-bdr"><span>Total</span><span className="tabular-nums">{m(total)}</span></div>
                {inv.status === 'paid' && <div className="flex justify-between text-emerald-600 font-semibold"><span>Paid</span><span className="tabular-nums">{m(inv.amount_paid ?? total)}</span></div>}
                {/* Part paid (a deposit, or paid before a credit was cancelled):
                    the money in, so the balance below adds up. */}
                {inv.status !== 'paid' && paidSoFar > 0 && <div className="flex justify-between text-emerald-600 font-semibold"><span>Paid</span><span className="tabular-nums">{m(paidSoFar)}</span></div>}
                {credited > 0 && <div className="flex justify-between text-violet-700"><span>Credited</span><span className="tabular-nums">-{m(credited)}</span></div>}
                {showBalance && <div className="flex justify-between font-bold text-paper pt-1.5 border-t border-bdr"><span>Balance due</span><span className="tabular-nums">{m(balanceDue(liveInv))}</span></div>}
                {refundOwed > 0 && <div className="flex justify-between text-amber-deep font-semibold"><span>Refund owed</span><span className="tabular-nums">{m(refundOwed)}</span></div>}
                {overpaid > 0 && (
                  <div className="text-amber-deep">
                    <div className="flex justify-between font-semibold"><span>Overpaid</span><span className="tabular-nums">{m(overpaid)}</span></div>
                    <div className="text-[11px]">More was paid than this invoice asks for and no credit note shows it as a refund owed. Refund it to the customer.</div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Credit notes. Always against the saved invoice; each one is fixed
              once issued apart from its refund and cancel fields. */}
          {creditsReady && hasCredits && (
            <div className="glass-card rounded-2xl p-5 space-y-2">
              <div className="flex items-center gap-3 flex-wrap">
                <span className={label + ' !mb-0'}>Credit notes</span>
                <span className="text-xs text-dim font-mono">({creditNotes.length})</span>
                {canCredit && (
                  <button onClick={openCredit} disabled={saving} className="ml-auto text-xs text-ember hover:text-ember-deep font-medium flex items-center gap-1 disabled:opacity-50"><Plus size={13} /> Raise another</button>
                )}
              </div>
              {creditNotes.map(cn => {
                const lbl = creditNoteStatusLabel(cn);
                const gone = cn.status === 'cancelled';
                const ncur = cn.currency || cur;
                const nm = (v) => money(v, ncur);
                const busy = cnBusy.startsWith(`${cn.id}:`);
                const btn = 'btn-ghost px-3 py-2 rounded-xl text-xs flex items-center gap-1.5 disabled:opacity-50';
                return (
                  <div key={cn.id} className="glass-inner rounded-xl p-3 space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`font-mono text-sm font-semibold ${gone ? 'line-through text-dim' : 'text-paper'}`}>{creditNoteLabel(cn)}</span>
                      <span className="text-xs text-muted">{fmtDay(cn.issue_date, ncur)}</span>
                      <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-lg ${CN_BADGE[lbl]}`}>{lbl}</span>
                      <span className={`ml-auto font-mono tabular-nums text-sm ${gone ? 'line-through text-dim' : 'text-paper font-semibold'}`}>{nm(cn.total)}</span>
                    </div>
                    <div className={`text-xs break-words ${gone ? 'text-dim' : 'text-muted'}`}>{cn.reason}</div>
                    {!gone && cn.refund_status === 'owed' && (
                      <div className="text-xs text-amber-deep font-semibold">Refund owed: {nm(cn.refund_due)}</div>
                    )}
                    {!gone && cn.refund_status === 'refunded' && (
                      <div className="text-xs text-emerald-700">
                        Refunded {nm(cn.refund_due)}{cn.refunded_at ? ` on ${fmtDay(cn.refunded_at, ncur)}` : ''}{cn.refund_method && cn.refund_method !== 'Other' ? ` by ${cn.refund_method.toLowerCase()}` : ''}{cn.refund_note ? `. ${cn.refund_note}` : ''}
                      </div>
                    )}
                    {gone && (
                      <div className="text-xs text-dim">Cancelled{cn.cancelled_at ? ` ${fmtDay(cn.cancelled_at, ncur)}` : ''}{cn.cancel_reason ? `: ${cn.cancel_reason}` : ''}</div>
                    )}
                    {cn.sent_at && <div className="text-[10px] text-dim">Emailed{cn.email_to ? ` to ${cn.email_to}` : ''} {fmtDay(cn.sent_at, ncur)}</div>}
                    <div className="flex items-center gap-2 flex-wrap">
                      <button onClick={() => creditPdf(cn)} disabled={busy} className={btn}><FileDown size={13} /> {cnBusy === `${cn.id}:pdf` ? 'Preparing…' : 'PDF'}</button>
                      {canWrite && !gone && <button onClick={() => emailCredit(cn)} disabled={busy} className={btn}><Mail size={13} /> {cnBusy === `${cn.id}:email` ? 'Sending…' : cn.sent_at ? 'Email again' : 'Email'}</button>}
                      {canWrite && !gone && cn.refund_status === 'owed' && refunding !== cn.id && (
                        <button onClick={() => setRefunding(cn.id)} disabled={busy} className={btn + ' !text-emerald-700'}><Check size={13} /> Mark refunded</button>
                      )}
                      {isOwner && !gone && cn.refund_status !== 'refunded' && (
                        <button onClick={() => cancelCredit(cn)} disabled={busy} className={btn + ' !text-red-600 ml-auto'}><Ban size={13} /> {cnBusy === `${cn.id}:cancel` ? 'Cancelling…' : 'Cancel'}</button>
                      )}
                    </div>
                    {refunding === cn.id && (
                      <RefundForm note={cn} currency={ncur} money={nm}
                        onCancel={() => setRefunding(null)}
                        onDone={() => { setRefunding(null); notify(`${creditNoteLabel(cn)} marked refunded`); refreshCredits(); }} />
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Notes + terms */}
          <div className="glass-card rounded-2xl p-5 space-y-3">
            <div><label className={label}>Notes (shown on the invoice)</label>
              <textarea className={input + ' resize-none'} rows={2} disabled={locked} value={inv.notes || ''} onChange={e => set('notes', e.target.value)} /></div>
            <div><label className={label}>Terms</label>
              <textarea className={input + ' resize-none'} rows={3} disabled={locked} value={inv.terms || ''} onChange={e => set('terms', e.target.value)}
                placeholder={globalTerms ? `Default: ${globalTerms.slice(0, 120)}…` : 'Falls back to the global invoice terms in Settings'} /></div>
          </div>

        </div>
      </div>

      {raising && (
        <CreditNoteModal invoice={raising.invoice} invoiceLines={raising.lines} creditedLines={raising.creditedLines}
          contactEmail={contacts.find(c => c.id === raising.invoice.contact_id)?.email || ''}
          onClose={() => setRaising(null)} onIssued={onCreditIssued} />
      )}
    </div>
  );
}

// A date or timestamp as a day, in the invoice's own locale.
function fmtDay(d, currency) {
  if (!d) return '';
  const date = new Date(String(d).length <= 10 ? `${d}T00:00:00` : d);
  if (Number.isNaN(date.getTime())) return String(d);
  return date.toLocaleDateString(currencyLocale(currency), { day: 'numeric', month: 'short', year: 'numeric' });
}

// Records a refund made outside the app (a bank transfer, a refund on the card
// machine). Nothing goes to Stripe; mark_credit_note_refunded only notes it.
function RefundForm({ note, currency, money: nm, onDone, onCancel }) {
  const today = regionToday(currency);
  const [method, setMethod] = useState(REFUND_METHODS[0]);
  const [on, setOn] = useState(today);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const field = 'w-full r-field !text-[16px] sm:!text-sm';
  const lbl = 'text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-muted mb-1 block';

  const save = async () => {
    setErr('');
    if (!on) { setErr('Pick the day the refund was made.'); return; }
    if (on > today) { setErr('The refund date cannot be in the future.'); return; }
    setBusy(true);
    const { error } = await supabase.rpc('mark_credit_note_refunded', {
      p_id: note.id, p_method: method, p_note: text.trim() || null, p_refunded_on: on,
    });
    setBusy(false);
    if (error) { setErr(plainError(error)); return; }
    onDone();
  };

  return (
    <div className="rounded-xl border border-bdr p-3 space-y-2">
      <div className="text-xs text-paper font-semibold">Record the {nm(note.refund_due)} refund</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <label className="min-w-0"><span className={lbl}>How</span>
          <select className={field} value={method} disabled={busy} onChange={e => setMethod(e.target.value)}>
            {REFUND_METHODS.map(x => <option key={x} value={x}>{x}</option>)}
          </select></label>
        <label className="min-w-0"><span className={lbl}>Refunded on</span>
          <input type="date" className={field} value={on} max={today} disabled={busy} onChange={e => setOn(e.target.value)} /></label>
      </div>
      <label className="block"><span className={lbl}>Note (optional)</span>
        <input className={field} value={text} maxLength={500} disabled={busy} onChange={e => setText(e.target.value)} placeholder="e.g. Bank reference" /></label>
      {err && <div className="text-xs text-red-600 font-semibold" role="alert">{err}</div>}
      <div className="flex items-center gap-2">
        <button onClick={save} disabled={busy} className="btn-glass px-4 py-2 rounded-xl text-xs font-semibold disabled:opacity-50">{busy ? 'Saving…' : 'Mark refunded'}</button>
        <button onClick={onCancel} disabled={busy} className="btn-ghost px-3 py-2 rounded-xl text-xs disabled:opacity-50">Close</button>
      </div>
    </div>
  );
}

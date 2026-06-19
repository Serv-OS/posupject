import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { ArrowLeft, Send, Link2, Trash2, Plus, Check, Ban, Repeat, FileDown } from 'lucide-react';
import { money, invStatus, INV_BADGE } from './InvoicesPanel.jsx';

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
  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  const load = useCallback(async () => {
    const [i, li, c, l, ct, st, pr, sk] = await Promise.all([
      supabase.from('invoices').select('*').eq('id', invoiceId).single(),
      supabase.from('invoice_line_items').select('*').eq('invoice_id', invoiceId).order('sort'),
      supabase.from('companies').select('id, name, address, city, postcode').order('name'),
      supabase.from('locations').select('id, name, company_id, address, city, postcode').order('name'),
      supabase.from('contacts').select('id, first_name, last_name, email').order('last_name'),
      supabase.from('support_settings').select('invoice_terms, business_name, business_address, business_email, business_phone, logo_url, quote_accent').eq('id', 1).maybeSingle(),
      supabase.from('products').select('id, name, description, default_price, category').eq('active', true).order('name'),
      supabase.from('inv_serials').select('product_id').eq('status', 'in_stock'),
    ]);
    setInv(i.data);
    setLines((li.data || []).length ? li.data : [{ _new: true, name: '', description: '', qty: 1, unit_price: 0, tax_rate: 20 }]);
    setCompanies(c.data || []); setLocations(l.data || []); setContacts(ct.data || []);
    setProducts(pr.data || []);
    const counts = {};
    (sk.data || []).forEach(r => { counts[r.product_id] = (counts[r.product_id] || 0) + 1; });
    setStockCounts(counts);
    setGlobalTerms(st.data?.invoice_terms || '');
    setSeller(st.data || {});
  }, [invoiceId]);
  useEffect(() => { load(); }, [load]);

  if (!inv) return <div className="h-full flex items-center justify-center text-dim text-sm">Loading invoice…</div>;

  const st = invStatus(inv);
  const locked = ['paid', 'void'].includes(inv.status);
  const set = (k, v) => setInv(p => ({ ...p, [k]: v }));
  const setLine = (i, k, v) => setLines(p => p.map((l, j) => j === i ? { ...l, [k]: v } : l));
  const locs = locations.filter(l => !inv.company_id || l.company_id === inv.company_id);

  const subtotal = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unit_price) || 0), 0);
  const taxAmount = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unit_price) || 0) * (Number(l.tax_rate) || 0) / 100, 0);
  const total = subtotal + taxAmount;

  const notify = (msg) => { setFlash(msg); setTimeout(() => setFlash(''), 2500); };

  const save = async (extra = {}) => {
    setSaving(true);
    const patch = {
      company_id: inv.company_id || null, location_id: inv.location_id || null, contact_id: inv.contact_id || null,
      email_to: (inv.email_to || '').trim() || null, issue_date: inv.issue_date, due_date: inv.due_date || null,
      subtotal, tax_amount: taxAmount, total,
      terms: (inv.terms || '').trim() || null, notes: (inv.notes || '').trim() || null,
      po_number: (inv.po_number || '').trim() || null, ...extra,
    };
    const { error } = await supabase.from('invoices').update(patch).eq('id', invoiceId);
    if (!error) {
      await supabase.from('invoice_line_items').delete().eq('invoice_id', invoiceId);
      const clean = lines.filter(l => (l.name || '').trim());
      if (clean.length) {
        await supabase.from('invoice_line_items').insert(clean.map((l, i) => ({
          invoice_id: invoiceId, name: l.name.trim(), description: (l.description || '').trim() || null,
          qty: Number(l.qty) || 1, unit_price: Number(l.unit_price) || 0,
          tax_rate: Number(l.tax_rate) || 0, sort: i,
        })));
      }
    }
    setSaving(false);
    if (error) { alert(error.message); return false; }
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

  // One-click PDF. Persists edits first (unless locked) so the file matches the
  // saved invoice, then renders client-side via the lazy-loaded generator.
  const downloadPdf = async () => {
    setPdfBusy(true);
    try {
      if (!locked && !(await save())) { setPdfBusy(false); return; }
      const { downloadInvoicePdf } = await import('../../lib/invoicePdf');
      const company = companies.find(c => c.id === inv.company_id);
      const location = locations.find(l => l.id === inv.location_id);
      const contact = contacts.find(c => c.id === inv.contact_id);
      const addr = (o) => o ? [o.address, o.city, o.postcode].filter(Boolean).join(', ') : '';
      await downloadInvoicePdf({
        inv: { ...inv, terms: inv.terms || globalTerms }, lines,
        totals: { subtotal, tax: taxAmount, total, paid: inv.amount_paid },
        seller: {
          name: seller?.business_name, address: seller?.business_address,
          email: seller?.business_email, phone: seller?.business_phone,
          logo_url: seller?.logo_url, accent: seller?.quote_accent,
        },
        billTo: {
          companyName: company?.name, companyAddress: addr(company),
          contactName: contact ? [contact.first_name, contact.last_name].filter(Boolean).join(' ') : '',
          contactEmail: contact?.email,
          locationName: location?.name, locationAddress: addr(location),
        },
        fmt: money, taxLabel: 'VAT', dateLocale: 'en-GB',
      });
      notify('PDF downloaded');
    } catch (e) { alert('PDF failed: ' + e.message); }
    setPdfBusy(false);
  };

  const markPaid = async () => {
    if (!confirm('Mark this invoice as paid (received outside Stripe)?')) return;
    await save({ status: 'paid', paid_at: new Date().toISOString(), amount_paid: total });
    notify('Marked paid');
  };
  const voidInvoice = async () => {
    if (!confirm('Void this invoice? The public link will stop working.')) return;
    await save({ status: 'void' });
  };
  const del = async () => {
    if (!confirm(`Delete invoice INV-${inv.invoice_number}? This cannot be undone.`)) return;
    await supabase.from('invoices').delete().eq('id', invoiceId);
    onClose();
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
        {inv.recurring_id && <span className="text-[10px] text-uv flex items-center gap-1"><Repeat size={11} /> from recurring schedule</span>}
        {flash && <span className="text-xs text-emerald-600 font-semibold">✓ {flash}</span>}
        {canWrite && (
          <div className="flex gap-2 ml-auto flex-wrap">
            {!locked && <button onClick={() => save().then(ok => ok && notify('Saved'))} disabled={saving} className="btn-ghost px-4 py-2 rounded-xl text-sm disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>}
            <button onClick={copyLink} className="btn-ghost px-3 py-2 rounded-xl text-sm flex items-center gap-1.5"><Link2 size={14} /> Copy link</button>
            <button onClick={downloadPdf} disabled={pdfBusy} title="Download this invoice as a PDF" className="btn-ghost px-3 py-2 rounded-xl text-sm flex items-center gap-1.5 disabled:opacity-50"><FileDown size={14} /> {pdfBusy ? 'Preparing…' : 'PDF'}</button>
            {!locked && <button onClick={sendInvoice} disabled={sending} className="btn-glass px-4 py-2 rounded-xl text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50"><Send size={14} /> {sending ? 'Sending…' : inv.sent_at ? 'Resend' : 'Send'}</button>}
            {!locked && <button onClick={markPaid} className="px-3 py-2 rounded-xl text-sm font-semibold bg-emerald-500/15 text-emerald-700 border border-emerald-500/30 flex items-center gap-1.5"><Check size={14} /> Mark paid</button>}
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
              <select className={input} disabled={locked} value={inv.company_id || ''} onChange={e => { set('company_id', e.target.value || null); set('location_id', null); }}>
                <option value="">—</option>{companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
            <div><label className={label}>Location</label>
              <select className={input} disabled={locked} value={inv.location_id || ''} onChange={e => set('location_id', e.target.value || null)}>
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
              {!locked && (
                <div className="ml-auto flex items-center gap-3">
                  {products.length > 0 ? (
                    <select className={input + ' !w-60 !py-1.5 text-xs'} value=""
                      onChange={e => {
                        const p = products.find(x => x.id === e.target.value);
                        if (p) setLines(prev => {
                          const blank = prev.length === 1 && !(prev[0].name || '').trim();
                          const line = { _new: true, name: p.name, description: p.description || '', qty: 1, unit_price: Number(p.default_price) || 0, tax_rate: 20 };
                          return blank ? [line] : [...prev, line];
                        });
                      }}>
                      <option value="">+ Add from products…</option>
                      {products.map(p => <option key={p.id} value={p.id}>
                        {p.name} — £{Number(p.default_price).toLocaleString('en-GB')}{stockCounts[p.id] != null ? ` (${stockCounts[p.id]} in stock)` : ''}
                      </option>)}
                    </select>
                  ) : (
                    <span className="text-[11px] text-dim italic">No products in the catalogue yet — add them under Inventory → Products</span>
                  )}
                  <button onClick={() => setLines(p => [...p, { _new: true, name: '', description: '', qty: 1, unit_price: 0, tax_rate: 20 }])}
                    className="text-xs text-ember hover:text-ember-deep font-medium flex items-center gap-1"><Plus size={13} /> Blank line</button>
                </div>
              )}
            </div>
            {lines.length === 0 && <div className="text-xs text-dim italic py-4 text-center">No line items yet. Add from products or start a blank line.</div>}
            {lines.map((l, i) => (
              <div key={l.id || `n${i}`} className="glass-inner rounded-xl p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <input className={cell + ' flex-1'} disabled={locked} value={l.name} onChange={e => setLine(i, 'name', e.target.value)} placeholder="Item name — e.g. Card terminal" />
                  {!locked && <button onClick={() => setLines(p => p.filter((_, j) => j !== i))} title="Remove line" className="text-red-500 hover:text-red-600 text-sm shrink-0">&times;</button>}
                </div>
                <input className={cell + ' w-full text-xs'} disabled={locked} value={l.description || ''} onChange={e => setLine(i, 'description', e.target.value)} placeholder="Description (shown on the invoice)" />
                <div className="grid grid-cols-3 gap-2">
                  <div><span className="text-[9px] text-dim block">Qty</span>
                    <input type="number" className={cell + ' w-full'} disabled={locked} value={l.qty} onChange={e => setLine(i, 'qty', e.target.value)} placeholder="1" /></div>
                  <div><span className="text-[9px] text-dim block">Unit £ (ex VAT)</span>
                    <input type="number" className={cell + ' w-full'} disabled={locked} value={l.unit_price} onChange={e => setLine(i, 'unit_price', e.target.value)} placeholder="0.00" /></div>
                  <div><span className="text-[9px] text-dim block">VAT %</span>
                    <input type="number" className={cell + ' w-full'} disabled={locked} value={l.tax_rate ?? 20} onChange={e => setLine(i, 'tax_rate', e.target.value)} placeholder="20" /></div>
                </div>
                <div className="text-right text-xs text-muted">
                  Net: <span className="text-paper font-mono font-semibold">{money((Number(l.qty) || 0) * (Number(l.unit_price) || 0))}</span>
                  <span className="mx-1.5 text-dim">·</span>
                  VAT: <span className="text-paper font-mono font-semibold">{money((Number(l.qty) || 0) * (Number(l.unit_price) || 0) * (Number(l.tax_rate) || 0) / 100)}</span>
                </div>
              </div>
            ))}
            <div className="flex justify-end pt-2 border-t border-bdr">
              <div className="w-64 space-y-1.5 text-sm">
                <div className="flex justify-between text-muted"><span>Subtotal</span><span className="tabular-nums">{money(subtotal)}</span></div>
                <div className="flex justify-between text-muted"><span>VAT (per line)</span><span className="tabular-nums">{money(taxAmount)}</span></div>
                <div className="flex justify-between text-base font-bold text-paper pt-1.5 border-t border-bdr"><span>Total</span><span className="tabular-nums">{money(total)}</span></div>
                {inv.status === 'paid' && <div className="flex justify-between text-emerald-600 font-semibold"><span>Paid</span><span className="tabular-nums">{money(inv.amount_paid ?? total)}</span></div>}
              </div>
            </div>
          </div>

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
    </div>
  );
}

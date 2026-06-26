import { useEffect, useState, useCallback, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import { computeTotals, lineNet, gbp2 } from '../../lib/money.js';
import { isUkVat } from '../../lib/branding.js';
import AttachmentsCard from '../crm/AttachmentsCard.jsx';

const STATUS = ['draft', 'to_pay', 'partially_paid', 'paid', 'void'];
const STATUS_LABEL = { draft: 'Draft', to_pay: 'To pay', partially_paid: 'Partially paid', paid: 'Paid', void: 'Void' };

export default function BillBuilder({ billId, profile, onClose, onNavigate }) {
  const [bill, setBill] = useState(null);
  const [lines, setLines] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [locations, setLocations] = useState([]);
  const [deals, setDeals] = useState([]);
  const [categories, setCategories] = useState([]);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState('');
  const canWrite = profile.role === 'owner' || profile.role === 'editor';
  const uk = isUkVat();

  const load = useCallback(async () => {
    const [b, li, s, c, l, d, cat] = await Promise.all([
      supabase.from('bills').select('*').eq('id', billId).single(),
      supabase.from('bill_line_items').select('*').eq('bill_id', billId).order('sort'),
      supabase.from('inv_suppliers').select('id, name, vat_number, default_category_id').order('name'),
      supabase.from('companies').select('id, name').order('name'),
      supabase.from('locations').select('id, name, company_id').order('name'),
      supabase.from('deals').select('id, title, company_id').order('created_at', { ascending: false }).limit(500),
      supabase.from('expense_categories').select('id, label, default_tax_rate, reclaimable').eq('active', true).order('sort'),
    ]);
    setBill(b.data); setLines((li.data || []).map(x => ({ ...x })));
    setSuppliers(s.data || []); setCompanies(c.data || []); setLocations(l.data || []);
    setDeals(d.data || []); setCategories(cat.data || []);
  }, [billId]);
  useEffect(() => { load(); }, [load]);

  const totals = useMemo(() => computeTotals(lines), [lines]);

  if (!bill) return <div className="h-full flex items-center justify-center text-dim text-sm">Loading bill…</div>;

  const set = (k, v) => setBill(p => ({ ...p, [k]: v }));
  const setLine = (i, patch) => setLines(ls => ls.map((l, j) => j === i ? { ...l, ...patch } : l));
  const addLine = () => setLines(ls => [...ls, { name: '', description: '', qty: 1, unit_price: 0, tax_rate: 20, category_id: bill.category_id || null }]);
  const removeLine = (i) => setLines(ls => ls.filter((_, j) => j !== i));
  const notify = (m) => { setFlash(m); setTimeout(() => setFlash(''), 2500); };
  const locs = locations.filter(l => !bill.company_id || l.company_id === bill.company_id);

  // When a supplier is picked, default the category + snapshot their VAT number.
  const pickSupplier = (id) => {
    const s = suppliers.find(x => x.id === id);
    setBill(p => ({ ...p, supplier_id: id || null,
      category_id: p.category_id || s?.default_category_id || null,
      supplier_vat_number: p.supplier_vat_number || s?.vat_number || null }));
  };

  const save = async (extra = {}) => {
    setSaving(true);
    const reclaim = bill.vat_reclaim_amount === '' || bill.vat_reclaim_amount == null ? null : Number(bill.vat_reclaim_amount);
    const patch = {
      supplier_id: bill.supplier_id || null, category_id: bill.category_id || null,
      company_id: bill.company_id || null, location_id: bill.location_id || null, deal_id: bill.deal_id || null,
      cost_context: bill.cost_context || 'ongoing', status: bill.status,
      description: (bill.description || '').trim() || null, supplier_ref: (bill.supplier_ref || '').trim() || null,
      issue_date: bill.issue_date, due_date: bill.due_date || null, currency: bill.currency || 'GBP',
      subtotal: totals.net, tax_amount: totals.vat, total: totals.gross,
      vat_reclaimable: !!bill.vat_reclaimable, vat_reclaim_amount: reclaim,
      has_vat_invoice: !!bill.has_vat_invoice, supplier_vat_number: (bill.supplier_vat_number || '').trim() || null,
      amount_paid: Number(bill.amount_paid) || 0, paid_at: bill.paid_at || null,
      payment_method: (bill.payment_method || '').trim() || null, payment_reference: (bill.payment_reference || '').trim() || null,
      notes: (bill.notes || '').trim() || null, updated_at: new Date().toISOString(), ...extra,
    };
    const { error } = await supabase.from('bills').update(patch).eq('id', billId);
    if (!error) {
      await supabase.from('bill_line_items').delete().eq('bill_id', billId);
      const clean = lines.filter(l => (l.name || '').trim());
      if (clean.length) {
        await supabase.from('bill_line_items').insert(clean.map((l, i) => ({
          bill_id: billId, name: l.name.trim(), description: (l.description || '').trim() || null,
          qty: Number(l.qty) || 1, unit_price: Number(l.unit_price) || 0, tax_rate: Number(l.tax_rate) || 0,
          category_id: l.category_id || null, line_total: lineNet(l), sort: i,
        })));
      }
    }
    setSaving(false);
    if (error) { alert(error.message); return false; }
    notify('Saved'); load();
    return true;
  };

  const markPaid = async () => {
    await save({ status: 'paid', amount_paid: totals.gross, paid_at: new Date().toISOString() });
    setBill(p => ({ ...p, status: 'paid', amount_paid: totals.gross, paid_at: new Date().toISOString() }));
  };

  const input = "w-full px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper placeholder-dim focus:outline-none focus:border-ember";
  const label = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block";
  const cell = "px-2 py-1.5 bg-card border border-bdr rounded-lg text-sm text-paper focus:outline-none focus:border-ember";

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-bdr flex items-center gap-3 flex-wrap">
        <button onClick={onClose} className="text-muted hover:text-paper text-lg">&larr;</button>
        <div className="flex-1 min-w-0">
          <div className="text-xl font-bold text-paper">Bill #{bill.bill_number}</div>
          <div className="text-xs text-muted mt-0.5">{suppliers.find(s => s.id === bill.supplier_id)?.name || 'No supplier'}{bill.supplier_ref ? ` · ref ${bill.supplier_ref}` : ''}</div>
        </div>
        {canWrite && (
          <div className="flex items-center gap-2">
            {flash && <span className="text-sm text-emerald-600 font-medium">✓ {flash}</span>}
            <button onClick={() => save()} disabled={saving} className="btn-glass px-5 py-2 rounded-xl text-sm font-semibold disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>
            {bill.status !== 'paid' && <button onClick={markPaid} className="px-4 py-2 text-sm font-semibold rounded-xl bg-emerald-100 text-emerald-700 border border-emerald-200 hover:bg-emerald-200">Mark paid</button>}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="grid grid-cols-12 gap-4 max-w-[1200px]">
          {/* Left: lines */}
          <div className="col-span-8 space-y-4">
            <div className="glass-card rounded-2xl overflow-hidden">
              <div className="px-4 py-3 border-b border-bdr flex items-center gap-2">
                <h3 className="text-sm font-bold text-paper">Line items</h3>
                {canWrite && <button onClick={addLine} className="ml-auto text-xs text-ember hover:text-ember-deep font-medium">+ Add line</button>}
              </div>
              <div className="p-3 space-y-2">
                {lines.length === 0 && <div className="text-xs text-dim italic py-4 text-center">No lines yet.</div>}
                {lines.map((l, i) => (
                  <div key={i} className="glass-inner rounded-xl p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <input className={cell + ' flex-1'} value={l.name} onChange={e => setLine(i, { name: e.target.value })} placeholder="Item / description" />
                      <button onClick={() => removeLine(i)} className="text-red-500 hover:text-red-600 text-sm shrink-0">×</button>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                      <div><span className="text-[9px] text-dim block">Qty</span><input type="number" className={cell + ' w-full'} value={l.qty} onChange={e => setLine(i, { qty: e.target.value })} /></div>
                      <div><span className="text-[9px] text-dim block">Unit £ (net)</span><input type="number" className={cell + ' w-full'} value={l.unit_price} onChange={e => setLine(i, { unit_price: e.target.value })} /></div>
                      <div><span className="text-[9px] text-dim block">VAT %</span><input type="number" className={cell + ' w-full'} value={l.tax_rate ?? 20} onChange={e => setLine(i, { tax_rate: e.target.value })} /></div>
                      <div className="col-span-2"><span className="text-[9px] text-dim block">Category</span>
                        <select className={cell + ' w-full'} value={l.category_id || ''} onChange={e => setLine(i, { category_id: e.target.value || null })}>
                          <option value="">—</option>{categories.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                        </select></div>
                    </div>
                    <div className="text-right text-xs text-muted">Net <span className="text-paper font-mono font-semibold">{gbp2(lineNet(l))}</span></div>
                  </div>
                ))}
              </div>
            </div>
            <div className="glass-card rounded-2xl p-4">
              <label className={label}>Notes (internal)</label>
              <textarea className={input + ' resize-none'} rows={2} value={bill.notes || ''} onChange={e => set('notes', e.target.value)} placeholder="Internal notes" />
            </div>
            <AttachmentsCard subjectType="bill" subjectId={billId} profile={profile} />
          </div>

          {/* Right: details + totals + pay */}
          <div className="col-span-4 space-y-4">
            <div className="glass-card rounded-2xl p-4">
              <div className="text-sm font-bold text-paper mb-1">Totals</div>
              <Row k="Net" v={gbp2(totals.net)} />
              <Row k="VAT" v={gbp2(totals.vat)} />
              <Row k="Gross" v={gbp2(totals.gross)} bold />
            </div>

            <div className="glass-card rounded-2xl p-4 space-y-3">
              <div className="text-sm font-bold text-paper">Bill details</div>
              <div><label className={label}>Supplier</label>
                <select className={input} value={bill.supplier_id || ''} onChange={e => pickSupplier(e.target.value)}>
                  <option value="">—</option>{suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select></div>
              <div><label className={label}>Supplier ref (their invoice no.)</label><input className={input} value={bill.supplier_ref || ''} onChange={e => set('supplier_ref', e.target.value)} /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className={label}>Issue date</label><input type="date" className={input} value={bill.issue_date || ''} onChange={e => set('issue_date', e.target.value)} /></div>
                <div><label className={label}>Due date</label><input type="date" className={input} value={bill.due_date || ''} onChange={e => set('due_date', e.target.value)} /></div>
              </div>
              <div><label className={label}>Default category</label>
                <select className={input} value={bill.category_id || ''} onChange={e => set('category_id', e.target.value || null)}>
                  <option value="">—</option>{categories.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select></div>
            </div>

            <div className="glass-card rounded-2xl p-4 space-y-3">
              <div className="text-sm font-bold text-paper">Attribution</div>
              <div><label className={label}>Cost context</label>
                <div className="flex gap-1 bg-card rounded-xl p-0.5">
                  {['ongoing', 'deal'].map(c => (
                    <button key={c} onClick={() => set('cost_context', c)} className={`flex-1 px-3 py-1.5 rounded-lg text-xs font-semibold ${bill.cost_context === c ? 'bg-ember text-white' : 'text-muted'}`}>{c === 'deal' ? 'Deal cost' : 'Ongoing'}</button>
                  ))}
                </div>
                <div className="text-[10px] text-dim mt-1">{bill.cost_context === 'deal' ? 'Cost of winning/delivering a specific deal.' : 'Recurring cost of servicing this customer/location.'}</div>
              </div>
              <div><label className={label}>Customer</label>
                <select className={input} value={bill.company_id || ''} onChange={e => { set('company_id', e.target.value || null); set('location_id', null); }}>
                  <option value="">—</option>{companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select></div>
              <div><label className={label}>Location</label>
                <select className={input} value={bill.location_id || ''} onChange={e => set('location_id', e.target.value || null)}>
                  <option value="">—</option>{locs.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select></div>
              <div><label className={label}>Deal</label>
                <select className={input} value={bill.deal_id || ''} onChange={e => set('deal_id', e.target.value || null)}>
                  <option value="">—</option>{deals.filter(d => !bill.company_id || d.company_id === bill.company_id).map(d => <option key={d.id} value={d.id}>{d.title}</option>)}
                </select></div>
            </div>

            {uk && (
              <div className="glass-card rounded-2xl p-4 space-y-3">
                <div className="text-sm font-bold text-paper">VAT reclaim</div>
                <div><label className={label}>Supplier VAT number</label><input className={input} value={bill.supplier_vat_number || ''} onChange={e => set('supplier_vat_number', e.target.value)} placeholder="GB123456789" /></div>
                <Check label="Valid VAT invoice held" checked={!!bill.has_vat_invoice} onChange={v => set('has_vat_invoice', v)} />
                <Check label="Input VAT reclaimable" checked={!!bill.vat_reclaimable} onChange={v => set('vat_reclaimable', v)} />
                <div><label className={label}>Reclaim amount (blank = full VAT {gbp2(totals.vat)})</label><input type="number" className={input} value={bill.vat_reclaim_amount ?? ''} onChange={e => set('vat_reclaim_amount', e.target.value)} placeholder={String(totals.vat)} /></div>
                {(!bill.has_vat_invoice || !bill.supplier_vat_number) && bill.vat_reclaimable && totals.vat > 0 &&
                  <div className="text-[11px] text-amber-600">⚠ Not yet reclaimable — needs a valid VAT invoice + supplier VAT number.</div>}
              </div>
            )}

            <div className="glass-card rounded-2xl p-4 space-y-3">
              <div className="text-sm font-bold text-paper">Payment</div>
              <div><label className={label}>Status</label>
                <select className={input} value={bill.status} onChange={e => set('status', e.target.value)}>
                  {STATUS.map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                </select></div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className={label}>Amount paid £</label><input type="number" className={input} value={bill.amount_paid || 0} onChange={e => set('amount_paid', e.target.value)} /></div>
                <div><label className={label}>Paid date</label><input type="date" className={input} value={bill.paid_at ? bill.paid_at.slice(0, 10) : ''} onChange={e => set('paid_at', e.target.value || null)} /></div>
                <div><label className={label}>Method</label><input className={input} value={bill.payment_method || ''} onChange={e => set('payment_method', e.target.value)} placeholder="bank / card" /></div>
                <div><label className={label}>Reference</label><input className={input} value={bill.payment_reference || ''} onChange={e => set('payment_reference', e.target.value)} /></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ k, v, bold }) {
  return <div className="flex justify-between py-1 text-sm"><span className="text-muted">{k}</span><span className={`font-mono ${bold ? 'text-paper font-bold' : 'text-paper'}`}>{v}</span></div>;
}
function Check({ label, checked, onChange }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className="flex items-center gap-2 text-sm text-paper">
      <span className={`w-4 h-4 rounded border flex items-center justify-center text-[10px] ${checked ? 'bg-ember border-ember text-white' : 'border-bdr'}`}>{checked ? '✓' : ''}</span>
      {label}
    </button>
  );
}

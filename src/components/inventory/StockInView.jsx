import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { PackagePlus, Plus, Trash2 } from 'lucide-react';
import { INV_CATEGORIES, CONDITIONS, parseSerials, nsSerial, stockIn, supplierCurrency } from '../../lib/inventoryOps';
import { currencySymbol } from '../../lib/money';

// Product cost prices are GBP list (same rule as the quote catalogue), so they
// are only prefilled into a line struck in GBP.
const CATALOGUE_CCY = 'GBP';

const input = "w-full px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper placeholder-dim focus:outline-none focus:border-ember";
const label = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block";

const blankLine = () => ({ product_id: '', product_name: '', category: '', serialText: '', noSerials: false, qty: 1, condition: '', used: false, unit_cost: '' });

export default function StockInView({ profile }) {
  const [products, setProducts] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [orders, setOrders] = useState([]);
  const [warehouse, setWarehouse] = useState('');
  const [supplierName, setSupplierName] = useState('');
  const [poNumber, setPoNumber] = useState('');
  const [linesState, setLines] = useState([blankLine()]);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { load(); }, []);
  const load = async () => {
    const [p, w, s, o] = await Promise.all([
      supabase.from('products').select('id, name, inv_category, default_price, cost_price').eq('active', true).order('name'),
      supabase.from('inv_warehouses').select('*').order('created_at'),
      supabase.from('inv_suppliers').select('id, name, default_currency').order('name'),
      supabase.from('inv_orders').select('id, po_number, supplier_id, supplier_name, lines:inv_order_lines(*)').neq('status', 'cancelled').order('created_at', { ascending: false }),
    ]);
    setProducts(p.data || []); setWarehouses(w.data || []); setSuppliers(s.data || []); setOrders(o.data || []);
    if ((w.data || []).length && !warehouse) setWarehouse(w.data[0].id);
  };

  // Unit costs land on inv_serials.cost with no currency column, so the currency
  // is decided up front: the linked PO's supplier, else the supplier typed, else GBP.
  const linkedPO = orders.find(o => o.po_number === poNumber);
  const ccy = supplierCurrency(suppliers, linkedPO || supplierName);
  const sym = currencySymbol(ccy);

  const set = (i, k, v) => setLines(prev => prev.map((l, idx) => idx === i ? { ...l, [k]: v } : l));
  const pickProduct = (i, id) => {
    const p = products.find(x => x.id === id);
    setLines(prev => prev.map((l, idx) => idx === i ? { ...l, product_id: id, product_name: p?.name || '', category: p?.inv_category || l.category, unit_cost: l.unit_cost === '' && ccy === CATALOGUE_CCY && p?.cost_price != null ? p.cost_price : l.unit_cost } : l));
  };
  // Products can be picked before the supplier is typed. If the currency then
  // leaves GBP, drop any catalogue prefill still in place so a GBP list price
  // never sits under a $ label. PO-locked lines are already in the PO's currency.
  useEffect(() => {
    if (ccy === CATALOGUE_CCY || poNumber) return;
    setLines(prev => prev.map(l => {
      const p = products.find(x => x.id === l.product_id);
      return p && p.cost_price != null && String(l.unit_cost) === String(p.cost_price) ? { ...l, unit_cost: '' } : l;
    }));
  }, [ccy, poNumber, products]);

  // PO link: locked landed costs flow onto lines
  const pickPO = (poNo) => {
    setPoNumber(poNo);
    const po = orders.find(o => o.po_number === poNo);
    if (po) {
      setSupplierName(po.supplier_name || '');
      setLines(prev => prev.map(l => {
        const line = (po.lines || []).find(x => x.product_name === l.product_name);
        return line ? { ...l, unit_cost: line.landed_unit_cost ?? line.unit_cost ?? l.unit_cost } : l;
      }));
    }
  };

  const submit = async () => {
    setSaving(true); setError(''); setDone('');
    try {
      const payload = linesState.filter(l => l.product_name).map(l => {
        const serials = l.noSerials
          ? Array.from({ length: Math.max(1, Number(l.qty) || 1) }, nsSerial)
          : parseSerials(l.serialText);
        const po = orders.find(o => o.po_number === poNumber);
        const locked = po && (po.lines || []).find(x => x.product_name === l.product_name);
        return {
          product_id: l.product_id || null, product_name: l.product_name, category: l.category,
          serials, condition: l.condition, used: l.used,
          unit_cost: locked ? (locked.landed_unit_cost ?? locked.unit_cost) : (l.unit_cost === '' ? null : Number(l.unit_cost)),
          po_number: poNumber || null,
        };
      });
      if (!payload.length) throw new Error('Add at least one product line.');
      await stockIn({ warehouse, products: payload, byName: profile.display_name || profile.email, actorId: profile.id, supplierName });
      const total = payload.reduce((s, p) => s + p.serials.length, 0);
      setDone(`Received ${total} unit${total !== 1 ? 's' : ''} into stock.`);
      setLines([blankLine()]); setPoNumber('');
    } catch (e) { setError(e.message); }
    setSaving(false);
  };

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-5 border-b border-bdr flex items-center gap-2.5">
        <PackagePlus size={20} className="text-ember" />
        <div>
          <div className="text-xl font-bold text-paper">Stock In</div>
          <div className="text-xs text-muted">Receive goods into a warehouse with serial capture</div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-[900px] mx-auto space-y-4">
          <div className="glass-card rounded-2xl p-5 grid grid-cols-1 md:grid-cols-3 gap-3">
            <div><label className={label}>Warehouse</label>
              <div className="flex gap-1.5">
                <select className={input} value={warehouse} onChange={e => setWarehouse(e.target.value)}>
                  {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
                <button type="button" title="Add warehouse" onClick={async () => {
                  const name = prompt('New warehouse / stock location name:');
                  if (!name?.trim()) return;
                  const { data, error: werr } = await supabase.from('inv_warehouses').insert({ name: name.trim() }).select().single();
                  if (werr) { alert(werr.message); return; }
                  await load(); setWarehouse(data.id);
                }} className="px-3 rounded-xl border border-bdr text-muted hover:text-paper hover:border-ember shrink-0">+</button>
              </div></div>
            <div><label className={label}>Supplier</label>
              <input className={input} list="inv-suppliers" value={supplierName} onChange={e => setSupplierName(e.target.value)} placeholder="Supplier name" />
              <datalist id="inv-suppliers">{suppliers.map(s => <option key={s.id} value={s.name} />)}</datalist></div>
            <div><label className={label}>Purchase order (locks costs)</label>
              <select className={input} value={poNumber} onChange={e => pickPO(e.target.value)}>
                <option value="">No PO</option>
                {orders.map(o => <option key={o.id} value={o.po_number}>{o.po_number} — {o.supplier_name}</option>)}
              </select></div>
          </div>

          {linesState.map((l, i) => (
            <div key={i} className="glass-card rounded-2xl p-5 space-y-3">
              <div className="flex items-center">
                <span className="text-sm font-bold text-paper">Product {i + 1}</span>
                {linesState.length > 1 && <button onClick={() => setLines(p => p.filter((_, x) => x !== i))} className="ml-auto text-dim hover:text-red-600"><Trash2 size={15} /></button>}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div><label className={label}>Product</label>
                  <select className={input} value={l.product_id} onChange={e => pickProduct(i, e.target.value)}>
                    <option value="">Select…</option>
                    {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select></div>
                <div><label className={label}>Category</label>
                  <select className={input} value={l.category} onChange={e => set(i, 'category', e.target.value)}>
                    <option value="">Select…</option>
                    {INV_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select></div>
                <div><label className={label}>Unit cost {sym} {poNumber && <span className="text-emerald-600">(PO-locked)</span>}</label>
                  <input className={input} value={l.unit_cost} onChange={e => set(i, 'unit_cost', e.target.value)} placeholder="0.00" disabled={!!poNumber} /></div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className={label}>Condition</label>
                  <select className={input} value={l.condition} onChange={e => set(i, 'condition', e.target.value)}>
                    {CONDITIONS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select></div>
                <div className="flex items-end gap-4 pb-1">
                  <label className="flex items-center gap-1.5 text-xs text-muted cursor-pointer">
                    <input type="checkbox" checked={l.used} onChange={e => set(i, 'used', e.target.checked)} className="accent-ember" /> Used unit (permanent flag)
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-muted cursor-pointer">
                    <input type="checkbox" checked={l.noSerials} onChange={e => set(i, 'noSerials', e.target.checked)} className="accent-ember" /> No serial numbers
                  </label>
                </div>
              </div>
              {l.noSerials ? (
                <div><label className={label}>Quantity</label>
                  <input type="number" min="1" className={input + ' !w-32'} value={l.qty} onChange={e => set(i, 'qty', e.target.value)} /></div>
              ) : (
                <div>
                  <label className={label}>Serial numbers — paste or scan, separated by spaces / new lines ({parseSerials(l.serialText).length})</label>
                  <textarea className={input + ' font-mono resize-none'} rows={3} value={l.serialText} onChange={e => set(i, 'serialText', e.target.value)} placeholder="SN001 SN002 SN003…" />
                </div>
              )}
            </div>
          ))}

          <div className="flex items-center gap-3">
            <button onClick={() => setLines(p => [...p, blankLine()])} className="btn-ghost px-4 py-2 rounded-xl text-sm flex items-center gap-1.5"><Plus size={15} /> Add product</button>
            <button onClick={submit} disabled={saving} className="btn-glass px-6 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-50 ml-auto">
              {saving ? 'Receiving…' : 'Receive into stock'}</button>
          </div>
          {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-2">{error}</div>}
          {done && <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-2">✓ {done}</div>}
        </div>
      </div>
    </div>
  );
}

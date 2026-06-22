import { useEffect, useState } from 'react';
import { INV_CATEGORIES } from '../../lib/inventoryOps';
import { supabase } from '../../lib/supabase';

const CATEGORIES = [
  { key: 'hardware', label: 'Hardware', icon: '\u{1F5A5}\u{FE0F}' },
  { key: 'services', label: 'Services', icon: '\u{1F6E0}\u{FE0F}' },
  { key: 'saas', label: 'SaaS plan', icon: '\u{1F4E6}' },
  { key: 'payments', label: 'Payments', icon: '\u{1F4B3}' },
];
const CAT_LABEL = Object.fromEntries(CATEGORIES.map(c => [c.key, c.label]));
const BILLING = { one_off: 'One-off', monthly: 'Monthly', annual: 'Annual', usage: 'Usage' };

const blank = { name: '', description: '', sku: '', category: 'hardware', billing_type: 'one_off', default_price: '', cost_price: '', cost_tax_rate: 20, unit: '', active: true, track_inventory: false, inv_category: '', default_threshold: '', supplier_id: '' };

export default function ProductsPanel({ profile }) {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState(blank);
  const [suppliers, setSuppliers] = useState([]);
  const [stockCounts, setStockCounts] = useState({});

  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  useEffect(() => { load(); }, []);
  const load = async () => {
    setLoading(true);
    const { data } = await supabase.from('products').select('*').order('category').order('name');
    const { data: sup } = await supabase.from('inv_suppliers').select('id, name').order('name');
    setSuppliers(sup || []);
    const { data: ser } = await supabase.from('inv_serials').select('product_name, status');
    const counts = {};
    (ser || []).forEach(r => {
      if (!counts[r.product_name]) counts[r.product_name] = { in_stock: 0, in_transit: 0, deployed: 0 };
      if (r.status === 'in_stock' || r.status === 'staged') counts[r.product_name].in_stock++;
      else if (r.status === 'in_transit') counts[r.product_name].in_transit++;
      else if (r.status === 'deployed') counts[r.product_name].deployed++;
    });
    setStockCounts(counts);
    setProducts(data || []);
    setLoading(false);
  };

  const startNew = () => { setDraft(blank); setEditing('new'); };
  const startEdit = (p) => { setDraft({ ...p, default_price: p.default_price ?? '', cost_price: p.cost_price ?? '', cost_tax_rate: p.cost_tax_rate ?? 20 }); setEditing(p.id); };

  const save = async () => {
    if (!draft.name.trim()) { alert('Name is required.'); return; }
    const payload = {
      name: draft.name.trim(), description: draft.description?.trim() || null, sku: draft.sku?.trim() || null,
      category: draft.category, billing_type: draft.billing_type,
      default_price: parseFloat(draft.default_price) || 0, cost_price: draft.cost_price === '' ? null : parseFloat(draft.cost_price),
      cost_tax_rate: draft.cost_tax_rate === '' || draft.cost_tax_rate == null ? null : parseFloat(draft.cost_tax_rate),
      unit: draft.unit?.trim() || null, active: draft.active,
      track_inventory: !!draft.track_inventory, inv_category: draft.inv_category || null,
      default_threshold: draft.default_threshold === '' || draft.default_threshold == null ? null : parseInt(draft.default_threshold),
      supplier_id: draft.supplier_id || null,
    };
    const { error } = editing === 'new'
      ? await supabase.from('products').insert(payload)
      : await supabase.from('products').update(payload).eq('id', editing);
    if (error) { alert('Could not save product:\n\n' + error.message + '\n\nYour details are still here — fix the issue and try again.'); return; }
    setEditing(null); load();
  };
  const remove = async (p) => { if (!confirm(`Delete product "${p.name}"?`)) return; const { error } = await supabase.from('products').delete().eq('id', p.id); if (error) { alert('Could not delete: ' + error.message); return; } load(); };

  const money = (v) => `£${Number(v || 0).toLocaleString('en-GB', { minimumFractionDigits: 0 })}`;
  const input = "w-full px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper placeholder-dim focus:outline-none focus:border-ember";
  const label = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block";

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-bdr flex items-center justify-between">
        <div>
          <div className="text-lg font-bold text-paper">Products</div>
          <div className="text-[10px] text-dim font-mono uppercase tracking-[0.18em]">{products.length} items in your catalogue</div>
        </div>
        {canWrite && editing === null && (
          <button onClick={startNew} className="px-3 py-1.5 bg-ember text-white text-sm font-semibold rounded-xl hover:bg-ember-deep transition">+ New product</button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="max-w-3xl space-y-4">
          {editing !== null && (
            <div className="glass-card rounded-2xl p-5 space-y-3">
              <div className="text-sm font-bold text-paper">{editing === 'new' ? 'New product' : 'Edit product'}</div>
              <div><label className={label}>Name</label><input className={input} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} autoFocus /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className={label}>Category</label><select className={input} value={draft.category} onChange={e => setDraft({ ...draft, category: e.target.value })}>
                  {CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}</select></div>
                <div><label className={label}>Billing</label><select className={input} value={draft.billing_type} onChange={e => setDraft({ ...draft, billing_type: e.target.value })}>
                  {Object.entries(BILLING).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
                <div><label className={label}>Selling price (£)</label><input type="number" className={input} value={draft.default_price} onChange={e => setDraft({ ...draft, default_price: e.target.value })} /></div>
                <div><label className={label}>Cost price (£)</label><input type="number" className={input} value={draft.cost_price} onChange={e => setDraft({ ...draft, cost_price: e.target.value })} />
                  {draft.default_price !== '' && draft.cost_price !== '' && Number(draft.default_price) > 0 && (
                    <div className="text-[11px] text-emerald-600 font-semibold mt-1">
                      Margin: £{(Number(draft.default_price) - Number(draft.cost_price)).toFixed(2)} ({Math.round(((Number(draft.default_price) - Number(draft.cost_price)) / Number(draft.default_price)) * 100)}%)
                    </div>
                  )}</div>
                <div><label className={label}>Purchase VAT %</label><input type="number" className={input} value={draft.cost_tax_rate ?? ''} onChange={e => setDraft({ ...draft, cost_tax_rate: e.target.value })} placeholder="20" />
                  {draft.cost_price !== '' && draft.cost_price != null && draft.cost_tax_rate !== '' && draft.cost_tax_rate != null && (
                    <div className="text-[11px] text-dim mt-1">Cost inc VAT: £{(Number(draft.cost_price) * (1 + Number(draft.cost_tax_rate) / 100)).toFixed(2)}</div>
                  )}</div>
                <div><label className={label}>Unit (optional)</label><input className={input} value={draft.unit || ''} onChange={e => setDraft({ ...draft, unit: e.target.value })} placeholder="per till, per location…" /></div>
                <div><label className={label}>SKU (optional)</label><input className={input} value={draft.sku || ''} onChange={e => setDraft({ ...draft, sku: e.target.value })} /></div>
              </div>
              <div><label className={label}>Description</label><textarea className={input + ' resize-none'} rows={2} value={draft.description || ''} onChange={e => setDraft({ ...draft, description: e.target.value })} /></div>
              <label className="flex items-center gap-2 text-sm text-paper cursor-pointer"><input type="checkbox" checked={draft.active} onChange={e => setDraft({ ...draft, active: e.target.checked })} /> Active (available on quotes)</label>

              {/* Inventory settings */}
              <div className="glass-inner rounded-xl p-3 space-y-3">
                <label className="flex items-center gap-2 text-sm text-paper cursor-pointer">
                  <input type="checkbox" checked={!!draft.track_inventory} onChange={e => setDraft({ ...draft, track_inventory: e.target.checked })} className="accent-ember" />
                  Track in inventory (serial-tracked hardware)
                </label>
                <div><label className={label}>Default supplier</label>
                  <select className={input} value={draft.supplier_id || ''} onChange={e => setDraft({ ...draft, supplier_id: e.target.value })}>
                    <option value="">None</option>
                    {suppliers.map(su => <option key={su.id} value={su.id}>{su.name}</option>)}
                  </select>
                  {suppliers.length === 0 && <div className="text-[10px] text-dim mt-1">No suppliers yet — add them under Inventory → Suppliers.</div>}</div>
                {draft.track_inventory && (
                  <div className="grid grid-cols-2 gap-3">
                    <div><label className={label}>Hardware category</label>
                      <select className={input} value={draft.inv_category || ''} onChange={e => setDraft({ ...draft, inv_category: e.target.value })}>
                        <option value="">Select…</option>
                        {INV_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                      </select></div>
                    <div><label className={label}>Low-stock threshold</label>
                      <input type="number" min="0" className={input} value={draft.default_threshold ?? ''} onChange={e => setDraft({ ...draft, default_threshold: e.target.value })} placeholder="3" /></div>
                  </div>
                )}
              </div>
              <div className="flex gap-2"><button onClick={save} className="px-4 py-2 bg-ember text-white text-sm font-semibold rounded-xl">Save</button><button onClick={() => setEditing(null)} className="px-4 py-2 text-sm text-muted border border-bdr rounded-xl">Cancel</button></div>
            </div>
          )}

          {loading && <div className="py-8 text-center text-dim text-sm">Loading…</div>}
          {!loading && products.length === 0 && editing === null && (
            <div className="py-12 text-center text-dim text-sm">No products yet. Add the hardware, services, SaaS plans and payment rates you sell.</div>
          )}

          {CATEGORIES.map(cat => {
            const items = products.filter(p => p.category === cat.key);
            if (!items.length) return null;
            return (
              <div key={cat.key}>
                <div className="text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-2 mt-2">{cat.icon} {cat.label}</div>
                <div className="space-y-2">
                  {items.map(p => (
                    <div key={p.id} className="glass-card rounded-2xl p-4 flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold text-paper">{p.name}</span>
                          {!p.active && <span className="px-1.5 py-0.5 text-[9px] font-bold uppercase rounded bg-slate-100 text-slate-500">Inactive</span>}
                        </div>
                        {p.description && <div className="text-xs text-muted line-clamp-1">{p.description}</div>}
                        {p.supplier_id && <div className="text-[10px] text-dim mt-0.5">Supplier: {suppliers.find(s => s.id === p.supplier_id)?.name || '—'}</div>}
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-sm font-mono text-paper">{money(p.default_price)}</div>
                        {p.cost_price != null && (
                          <div className="text-[10px] text-dim">cost {money(p.cost_price)}{p.default_price > 0 ? ` · ${Math.round(((p.default_price - p.cost_price) / p.default_price) * 100)}% margin` : ''}</div>
                        )}
                        <div className="text-[10px] text-dim">{BILLING[p.billing_type]}{p.unit ? ` · ${p.unit}` : ''}</div>
                        {p.track_inventory && (() => {
                          const c = stockCounts[p.name] || { in_stock: 0, in_transit: 0, deployed: 0 };
                          const low = p.default_threshold != null && c.in_stock <= p.default_threshold;
                          return (
                            <div className="flex items-center gap-1.5 justify-end mt-1">
                              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${low ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'}`}>{c.in_stock} in stock{low ? ' · LOW' : ''}</span>
                              {c.in_transit > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">{c.in_transit} transit</span>}
                              {c.deployed > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">{c.deployed} deployed</span>}
                            </div>
                          );
                        })()}
                      </div>
                      {canWrite && (
                        <div className="flex gap-2 shrink-0">
                          <button onClick={() => startEdit(p)} className="text-xs text-ember hover:text-ember-deep">Edit</button>
                          <button onClick={() => remove(p)} className="text-xs text-red-600 hover:text-red-700">Delete</button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

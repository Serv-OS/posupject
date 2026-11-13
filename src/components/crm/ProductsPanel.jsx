import { useEffect, useState } from 'react';
import { INV_CATEGORIES } from '../../lib/inventoryOps';
import { supabase } from '../../lib/supabase';
import { marginFor, bundleParts, partsTotalFor, partsCostFor } from '../../lib/catalogue';
import { fmtMoney, fmtMoney0, currencySymbol, taxLabelFor, defaultTaxRateFor } from '../../lib/money';

const CATEGORIES = [
  { key: 'hardware', label: 'Hardware', icon: '\u{1F5A5}\u{FE0F}' },
  { key: 'services', label: 'Services', icon: '\u{1F6E0}\u{FE0F}' },
  { key: 'saas', label: 'SaaS plan', icon: '\u{1F4E6}' },
  { key: 'payments', label: 'Payments', icon: '\u{1F4B3}' },
];
const CAT_LABEL = Object.fromEntries(CATEGORIES.map(c => [c.key, c.label]));
const BILLING = { one_off: 'One-off', monthly: 'Monthly', annual: 'Annual', usage: 'Usage' };

// The catalogue has ONE price column and no currency (migration 019), so every
// price on this screen is pounds by construction and is labelled as such rather
// than guessed at. A USD quote or invoice never copies it: InvoicesPanel and
// QuoteBuilder mirror this CATALOGUE_CCY and blank the price on a $ document.
// A per-currency product price is the real fix and needs DDL.
const CATALOGUE_CCY = 'GBP';
const SYM = currencySymbol(CATALOGUE_CCY);
const TAX = taxLabelFor(CATALOGUE_CCY);

const blank = { name: '', description: '', sku: '', category: 'hardware', billing_type: 'one_off', default_price: '', cost_price: '', default_price_usd: '', cost_price_usd: '', cost_tax_rate: defaultTaxRateFor(CATALOGUE_CCY), unit: '', active: true, track_inventory: false, inv_category: '', default_threshold: '', supplier_id: '', sku_us: '', is_bundle: false, notes: '', parts: { GBP: [], USD: [] } };
const REGIONS = [{ ccy: 'GBP', label: 'UK parts' }, { ccy: 'USD', label: 'US parts' }];

export default function ProductsPanel({ profile }) {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState(blank);
  const [suppliers, setSuppliers] = useState([]);
  const [stockCounts, setStockCounts] = useState({});
  const [notes, setNotes] = useState({});
  const [bundleRows, setBundleRows] = useState([]);

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
    // Internal notes and bundle parts live in their own staff only tables
    // (migration 123); products itself is readable by the public quote pages.
    const [{ data: nt }, { data: br }] = await Promise.all([
      supabase.from('product_notes').select('product_id, notes'),
      supabase.from('product_bundle_items').select('bundle_id, component_id, region, qty, sort'),
    ]);
    setNotes(Object.fromEntries((nt || []).map(n => [n.product_id, n.notes])));
    setBundleRows(br || []);
    setProducts(data || []);
    setLoading(false);
  };

  const startNew = () => { setDraft(blank); setEditing('new'); };
  const partsOf = (id) => Object.fromEntries(REGIONS.map(({ ccy }) => [ccy,
    bundleRows.filter(r => r.bundle_id === id && r.region === ccy).sort((a, b) => a.sort - b.sort).map(r => ({ component_id: r.component_id, qty: r.qty }))]));
  const startEdit = (p) => { setDraft({ ...p, sku_us: p.sku_us ?? '', notes: notes[p.id] ?? '', parts: partsOf(p.id), default_price: p.default_price ?? '', cost_price: p.cost_price ?? '', default_price_usd: p.default_price_usd ?? '', cost_price_usd: p.cost_price_usd ?? '', cost_tax_rate: p.cost_tax_rate ?? defaultTaxRateFor(CATALOGUE_CCY) }); setEditing(p.id); };

  // A bundle's cost is its parts' costs added up, per market, never typed.
  const partList = (parts, ccy, pool = products) => (parts?.[ccy] || [])
    .map(x => ({ qty: Math.max(1, parseInt(x.qty) || 1), product: pool.find(p => p.id === x.component_id) })).filter(x => x.product);
  const bundleCost = (parts, pool) => ({ GBP: partsCostFor(partList(parts, 'GBP', pool), 'GBP'), USD: partsCostFor(partList(parts, 'USD', pool), 'USD') });
  const draftCost = draft.is_bundle ? bundleCost(draft.parts) : null;
  // What the cost fields and margins show: typed for a product, summed for a bundle.
  const eff = draftCost ? { ...draft, cost_price: draftCost.GBP.total ?? '', cost_price_usd: draftCost.USD.total ?? '' } : draft;

  const save = async () => {
    if (!draft.name.trim()) { alert('Name is required.'); return; }
    const payload = {
      name: draft.name.trim(), description: draft.description?.trim() || null, sku: draft.sku?.trim() || null,
      sku_us: draft.sku_us?.trim() || null, is_bundle: !!draft.is_bundle,
      category: draft.category, billing_type: draft.billing_type,
      // Empty is "not priced for the UK yet", not £0: a US-only product must not look priced at nothing on a pound quote.
      default_price: draft.default_price === '' || draft.default_price == null ? null : parseFloat(draft.default_price),
      cost_price: draftCost ? draftCost.GBP.total : draft.cost_price === '' || draft.cost_price == null ? null : parseFloat(draft.cost_price),
      // Dollar prices are their own prices, never derived from the pound ones.
      // Empty means "not priced for the US yet", and a US document says so.
      default_price_usd: draft.default_price_usd === '' || draft.default_price_usd == null ? null : parseFloat(draft.default_price_usd),
      cost_price_usd: draftCost ? draftCost.USD.total : draft.cost_price_usd === '' || draft.cost_price_usd == null ? null : parseFloat(draft.cost_price_usd),
      cost_tax_rate: draft.cost_tax_rate === '' || draft.cost_tax_rate == null ? null : parseFloat(draft.cost_tax_rate),
      unit: draft.unit?.trim() || null, active: draft.active,
      track_inventory: !!draft.track_inventory, inv_category: draft.inv_category || null,
      default_threshold: draft.default_threshold === '' || draft.default_threshold == null ? null : parseInt(draft.default_threshold),
      supplier_id: draft.supplier_id || null,
    };
    const { data: saved, error } = editing === 'new'
      ? await supabase.from('products').insert(payload).select('id').single()
      : await supabase.from('products').update(payload).eq('id', editing).select('id').single();
    if (error) { alert('Could not save product:\n\n' + error.message + '\n\nYour details are still here, fix the issue and try again.'); return; }
    const id = saved.id;
    const fail = (what, e) => { alert(`The product saved, but its ${what} did not:\n\n${e.message}\n\nYour details are still here, press Save again.`); setEditing(id); };
    const note = (draft.notes || '').trim();
    if (note !== (notes[id] || '').trim()) {
      const { error: ne } = note
        ? await supabase.from('product_notes').upsert({ product_id: id, notes: note, updated_by: profile.id, updated_at: new Date().toISOString() })
        : await supabase.from('product_notes').delete().eq('product_id', id);
      if (ne) return fail('internal notes', ne);
    }
    // A bundle's parts are replaced as a set. A product that stops being a
    // bundle keeps no parts, so nothing lists them by mistake.
    const rows = draft.is_bundle ? REGIONS.flatMap(({ ccy }) => (draft.parts?.[ccy] || [])
      .filter(x => x.component_id)
      .map((x, i) => ({ bundle_id: id, component_id: x.component_id, region: ccy, qty: Math.max(1, parseInt(x.qty) || 1), sort: i }))) : [];
    const had = bundleRows.some(r => r.bundle_id === id);
    if (had || rows.length) {
      const { error: de } = await supabase.from('product_bundle_items').delete().eq('bundle_id', id);
      if (de) return fail('bundle parts', de);
      if (rows.length) { const { error: ie } = await supabase.from('product_bundle_items').insert(rows); if (ie) return fail('bundle parts', ie); }
    }
    // A part's cost just changed: every bundle using it takes the new total.
    if (!draft.is_bundle) {
      const pool = products.map(p => (p.id === id ? { ...p, ...payload } : p));
      const bundleIds = [...new Set(bundleRows.filter(r => r.component_id === id).map(r => r.bundle_id))];
      for (const b of bundleIds) {
        const parts = partsOf(b);
        const c = bundleCost(parts, pool);
        const { error: be } = await supabase.from('products').update({ cost_price: c.GBP.total, cost_price_usd: c.USD.total }).eq('id', b);
        if (be) alert(`Saved, but the cost of ${pool.find(p => p.id === b)?.name || 'a bundle'} did not update:\n\n${be.message}`);
      }
    }
    setEditing(null); load();
  };
  const usedIn = (id) => [...new Set(bundleRows.filter(r => r.component_id === id).map(r => r.bundle_id))].map(b => products.find(p => p.id === b)?.name).filter(Boolean);
  const remove = async (p) => {
    const inBundles = usedIn(p.id);
    if (inBundles.length) { alert(`"${p.name}" is a part of ${inBundles.join(', ')}. Take it out of ${inBundles.length === 1 ? 'that bundle' : 'those bundles'} first, or set it Inactive.`); return; }
    if (!confirm(`Delete product "${p.name}"?`)) return;
    const { error } = await supabase.from('products').delete().eq('id', p.id);
    if (error) { alert('Could not delete: ' + error.message); return; }
    load();
  };
  const setParts = (ccy, list) => setDraft(d => ({ ...d, parts: { ...d.parts, [ccy]: list } }));
  // Anything that is not itself a bundle can be a part.
  const partChoices = products.filter(p => !p.is_bundle && p.id !== editing);

  // Whole pounds print whole (£299) and anything else at 2dp (£12.50); the old
  // hand-rolled formatter printed £12.5.
  const moneyIn = (v, ccy) => (Number.isInteger(Number(v || 0)) ? fmtMoney0(v, ccy) : fmtMoney(v, ccy));
  const money = (v) => moneyIn(v, CATALOGUE_CCY);
  const input = "w-full px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper placeholder-dim focus:outline-none focus:border-ember";
  const label = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block";

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-bdr flex items-center justify-between">
        <div>
          <div className="text-lg font-bold text-paper">Products</div>
          <div className="text-[10px] text-dim font-mono uppercase tracking-[0.18em]">{products.length} items in your catalogue · £ and $ list prices</div>
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
                <div><label className={label}>Selling price ({SYM} {CATALOGUE_CCY})</label><input type="number" className={input} value={draft.default_price ?? ''} onChange={e => setDraft({ ...draft, default_price: e.target.value })} placeholder="not priced for the UK yet" /></div>
                <div><label className={label}>Cost price ({SYM} {CATALOGUE_CCY}){draftCost ? ', parts added up' : ''}</label><input type="number" className={input} disabled={!!draftCost} value={eff.cost_price ?? ''} onChange={e => setDraft({ ...draft, cost_price: e.target.value })} placeholder={draftCost ? 'from the UK parts' : '0.00'} />
                  {draftCost?.GBP.missing.length > 0 && <div className="text-[11px] text-amber-600 mt-1">No {SYM} cost on: {draftCost.GBP.missing.join(', ')}</div>}
                  {eff.default_price !== '' && eff.default_price != null && eff.cost_price !== '' && eff.cost_price != null && Number(eff.default_price) > 0 && (
                    <div className="text-[11px] text-emerald-600 font-semibold mt-1">
                      Margin: {fmtMoney(Number(eff.default_price) - Number(eff.cost_price), CATALOGUE_CCY)} ({Math.round(((Number(eff.default_price) - Number(eff.cost_price)) / Number(eff.default_price)) * 100)}%)
                    </div>
                  )}</div>
                {/* A US price is a different price, not a conversion: items sell for
                    more there. Both fields optional; empty means the product is not
                    priced for the US yet and a dollar quote will say so. */}
                <div><label className={label}>Selling price ($ USD)</label><input type="number" className={input} value={draft.default_price_usd ?? ''} onChange={e => setDraft({ ...draft, default_price_usd: e.target.value })} placeholder="not priced for the US yet" /></div>
                <div><label className={label}>Cost price ($ USD){draftCost ? ', parts added up' : ''}</label><input type="number" className={input} disabled={!!draftCost} value={eff.cost_price_usd ?? ''} onChange={e => setDraft({ ...draft, cost_price_usd: e.target.value })} placeholder={draftCost ? 'from the US parts' : '0.00'} />
                  {draftCost?.USD.missing.length > 0 && <div className="text-[11px] text-amber-600 mt-1">No $ cost on: {draftCost.USD.missing.join(', ')}</div>}
                  {(() => { const m = marginFor(eff, 'USD'); return m && (
                    <div className="text-[11px] text-emerald-600 font-semibold mt-1">Margin: {fmtMoney(m.amount, 'USD')} ({m.pct}%)</div>
                  ); })()}</div>
                <div><label className={label}>Purchase {TAX} %</label><input type="number" className={input} value={draft.cost_tax_rate ?? ''} onChange={e => setDraft({ ...draft, cost_tax_rate: e.target.value })} placeholder={String(defaultTaxRateFor(CATALOGUE_CCY))} />
                  {eff.cost_price !== '' && eff.cost_price != null && draft.cost_tax_rate !== '' && draft.cost_tax_rate != null && (
                    <div className="text-[11px] text-dim mt-1">Cost inc {TAX}: {fmtMoney(Number(eff.cost_price) * (1 + Number(draft.cost_tax_rate) / 100), CATALOGUE_CCY)}</div>
                  )}</div>
                <div><label className={label}>Unit (optional)</label><input className={input} value={draft.unit || ''} onChange={e => setDraft({ ...draft, unit: e.target.value })} placeholder="per till, per location…" /></div>
                <div><label className={label}>UK SKU (optional)</label><input className={input} value={draft.sku || ''} onChange={e => setDraft({ ...draft, sku: e.target.value })} /></div>
                <div><label className={label}>US SKU (optional)</label><input className={input} value={draft.sku_us || ''} onChange={e => setDraft({ ...draft, sku_us: e.target.value })} /></div>
              </div>
              <div className="text-[11px] text-dim italic">A pound quote takes the £ price, a dollar quote takes the $ price. Leave the $ price empty and a US line lands at 0 to be typed.</div>
              <div><label className={label}>Description</label><textarea className={input + ' resize-none'} rows={2} value={draft.description || ''} onChange={e => setDraft({ ...draft, description: e.target.value })} /></div>
              <div><label className={label}>Internal notes (staff only, never on quotes or invoices)</label><textarea className={input + ' resize-none'} rows={2} value={draft.notes || ''} onChange={e => setDraft({ ...draft, notes: e.target.value })} placeholder="Supplier quirks, lead times, what to check before ordering…" /></div>
              <label className="flex items-center gap-2 text-sm text-paper cursor-pointer"><input type="checkbox" checked={draft.active} onChange={e => setDraft({ ...draft, active: e.target.checked })} /> Active (available on quotes)</label>

              {/* A bundle is priced on its own; its parts differ by market and are
                  listed under the line on a quote in that market's money. */}
              <div className="glass-inner rounded-xl p-3 space-y-3">
                <label className="flex items-center gap-2 text-sm text-paper cursor-pointer">
                  <input type="checkbox" checked={!!draft.is_bundle} onChange={e => setDraft({ ...draft, is_bundle: e.target.checked })} className="accent-ember" />
                  Bundle (made of other products, e.g. Kiosk - Counter mounted)
                </label>
                {draft.is_bundle && (
                  <div className="grid sm:grid-cols-2 gap-3">
                    {REGIONS.map(({ ccy, label: title }) => {
                      const list = draft.parts?.[ccy] || [];
                      const total = partsTotalFor(list.map(x => ({ qty: Math.max(1, parseInt(x.qty) || 1), product: products.find(p => p.id === x.component_id) })).filter(x => x.product), ccy);
                      return (
                        <div key={ccy} className="space-y-2">
                          <div className={label}>{title}</div>
                          {list.map((x, i) => (
                            <div key={i} className="flex items-center gap-2">
                              <input type="number" min="1" className={input + ' !w-16'} value={x.qty} onChange={e => setParts(ccy, list.map((y, j) => j === i ? { ...y, qty: e.target.value } : y))} />
                              <div className="flex-1 text-sm text-paper truncate">{products.find(p => p.id === x.component_id)?.name || 'Unknown product'}</div>
                              <button onClick={() => setParts(ccy, list.filter((_, j) => j !== i))} className="text-xs text-red-600">Remove</button>
                            </div>
                          ))}
                          <select className={input + ' text-xs'} value="" onChange={e => { const id = e.target.value; if (id && !list.some(y => y.component_id === id)) setParts(ccy, [...list, { component_id: id, qty: 1 }]); }}>
                            <option value="">+ Add a part…</option>
                            {partChoices.map(p => <option key={p.id} value={p.id} disabled={list.some(y => y.component_id === p.id)}>{p.name}</option>)}
                          </select>
                          {list.length === 0 && <div className="text-[11px] text-dim italic">No {ccy === 'GBP' ? 'UK' : 'US'} parts yet.</div>}
                          {total !== null && <div className="text-[11px] text-dim">Parts add up to {fmtMoney(total, ccy)} (guide only, the bundle uses its own price).</div>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

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
                          {p.is_bundle && <span className="px-1.5 py-0.5 text-[9px] font-bold uppercase rounded bg-ember/10 text-ember">Bundle</span>}
                        </div>
                        {(p.sku || p.sku_us) && <div className="text-[10px] font-mono text-dim">{p.sku && `UK ${p.sku}`}{p.sku && p.sku_us && ' · '}{p.sku_us && `US ${p.sku_us}`}</div>}
                        {p.is_bundle && REGIONS.map(({ ccy }) => {
                          const list = bundleParts(p.id, bundleRows, products, ccy);
                          return <div key={ccy} className="text-[10px] text-dim truncate">{ccy === 'GBP' ? 'UK' : 'US'}: {list.length ? list.map(x => `${x.qty} x ${x.product.name}`).join(', ') : <span className="text-amber-600">no parts yet</span>}</div>;
                        })}
                        {notes[p.id] && <div className="text-[10px] text-dim italic line-clamp-1">Note: {notes[p.id]}</div>}
                        {p.description && <div className="text-xs text-muted line-clamp-1">{p.description}</div>}
                        {p.supplier_id && <div className="text-[10px] text-dim mt-0.5">Supplier: {suppliers.find(s => s.id === p.supplier_id)?.name || '—'}</div>}
                      </div>
                      <div className="text-right shrink-0">
                        {p.default_price != null
                          ? <div className="text-sm font-mono text-paper">{money(p.default_price)}</div>
                          : <div className="text-[10px] text-amber-600">no £ price yet</div>}
                        {p.cost_price != null && (
                          <div className="text-[10px] text-dim">cost {money(p.cost_price)}{p.default_price > 0 ? ` · ${Math.round(((p.default_price - p.cost_price) / p.default_price) * 100)}% margin` : ''}</div>
                        )}
                        {/* The dollar price sits under the pound one, or says it is missing. */}
                        {p.default_price_usd != null
                          ? <div className="text-sm font-mono text-paper">{moneyIn(p.default_price_usd, 'USD')}</div>
                          : <div className="text-[10px] text-amber-600">no $ price yet</div>}
                        {p.cost_price_usd != null && (() => { const m = marginFor(p, 'USD'); return (
                          <div className="text-[10px] text-dim">cost {moneyIn(p.cost_price_usd, 'USD')}{m ? ` · ${m.pct}% margin` : ''}</div>
                        ); })()}
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

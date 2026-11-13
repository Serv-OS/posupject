import { useEffect, useState } from 'react';
import { INV_CATEGORIES } from '../../lib/inventoryOps';
import { supabase } from '../../lib/supabase';
import { marginFor, bundleParts, partsTotalFor, partsCostFor, bundleBuildable } from '../../lib/catalogue';
import { fmtMoney, fmtMoney0, currencySymbol, taxLabelFor, defaultTaxRateFor } from '../../lib/money';

const CATEGORIES = [
  { key: 'hardware', label: 'Hardware', icon: '\u{1F5A5}\u{FE0F}' },
  { key: 'services', label: 'Services', icon: '\u{1F6E0}\u{FE0F}' },
  { key: 'saas', label: 'SaaS plan', icon: '\u{1F4E6}' },
  { key: 'payments', label: 'Payments', icon: '\u{1F4B3}' },
];
const CAT_LABEL = Object.fromEntries(CATEGORIES.map(c => [c.key, c.label]));
const BILLING = { one_off: 'One-off', monthly: 'Monthly', annual: 'Annual', usage: 'Usage' };
const SHOW = {
  all: { label: 'Everything', test: () => true },
  active: { label: 'Active only', test: (p) => p.active },
  inactive: { label: 'Inactive', test: (p) => !p.active },
  bundles: { label: 'Bundles', test: (p) => p.is_bundle },
  parts: { label: 'Parts only (not sold)', test: (p) => p.sold_separately === false },
  tracked: { label: 'Stock tracked', test: (p) => p.track_inventory },
  low: { label: 'Low stock', test: (p, { stockCounts }) => p.track_inventory && p.default_threshold != null && (stockCounts[p.name]?.in_stock || 0) <= p.default_threshold },
  no_price: { label: 'Missing a £ or $ price', test: (p) => p.default_price == null || p.default_price_usd == null },
};

// The catalogue has ONE price column and no currency (migration 019), so every
// price on this screen is pounds by construction and is labelled as such rather
// than guessed at. A USD quote or invoice never copies it: InvoicesPanel and
// QuoteBuilder mirror this CATALOGUE_CCY and blank the price on a $ document.
// A per-currency product price is the real fix and needs DDL.
const CATALOGUE_CCY = 'GBP';
const SYM = currencySymbol(CATALOGUE_CCY);
const TAX = taxLabelFor(CATALOGUE_CCY);

const blank = { name: '', description: '', sku: '', category: 'hardware', billing_type: 'one_off', default_price: '', cost_price: '', default_price_usd: '', cost_price_usd: '', cost_tax_rate: defaultTaxRateFor(CATALOGUE_CCY), unit: '', active: true, track_inventory: false, inv_category: '', default_threshold: '', supplier_id: '', sku_us: '', is_bundle: false, sold_separately: true, notes: '', parts: { GBP: [], USD: [] } };
const REGIONS = [{ ccy: 'GBP', label: 'UK parts' }, { ccy: 'USD', label: 'US parts' }];

export default function ProductsPanel({ profile }) {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('all');
  const [show, setShow] = useState('all');
  const [draft, setDraft] = useState(blank);
  const [suppliers, setSuppliers] = useState([]);
  const [stockCounts, setStockCounts] = useState({});
  const [inStockById, setInStockById] = useState({});
  const [notes, setNotes] = useState({});
  const [bundleRows, setBundleRows] = useState([]);

  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  useEffect(() => { load(); }, []);
  const load = async () => {
    setLoading(true);
    const { data } = await supabase.from('products').select('*').order('category').order('name');
    const { data: sup } = await supabase.from('inv_suppliers').select('id, name').order('name');
    setSuppliers(sup || []);
    const { data: ser } = await supabase.from('inv_serials').select('product_id, product_name, status');
    // Units free to send, by product, for how many bundles can be built.
    const byId = {};
    (ser || []).forEach(r => { if (r.status === 'in_stock' && r.product_id) byId[r.product_id] = (byId[r.product_id] || 0) + 1; });
    setInStockById(byId);
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
      sku_us: draft.sku_us?.trim() || null, is_bundle: !!draft.is_bundle, sold_separately: draft.sold_separately !== false,
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
  // Search and filter: every word must appear in the name, either SKU or the description.
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = products.filter(p => {
    if (cat !== 'all' && p.category !== cat) return false;
    if (!SHOW[show].test(p, { stockCounts })) return false;
    const hay = [p.name, p.sku, p.sku_us, p.description, p.inv_category].filter(Boolean).join(' ').toLowerCase();
    return words.every(w => hay.includes(w));
  });
  const label = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block";

  const ukMargin = eff.default_price !== '' && eff.default_price != null && eff.cost_price !== '' && eff.cost_price != null && Number(eff.default_price) > 0
    ? { amount: Number(eff.default_price) - Number(eff.cost_price), pct: Math.round(((Number(eff.default_price) - Number(eff.cost_price)) / Number(eff.default_price)) * 100) } : null;
  const usMargin = marginFor(eff, 'USD');
  const pct = (sell, cost) => (sell > 0 && cost != null ? Math.round(((sell - cost) / sell) * 100) : null);
  const section = "text-[11px] font-bold uppercase tracking-[0.14em] text-paper mb-2";
  const COLS = 'md:grid md:grid-cols-[minmax(0,2.2fr)_90px_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.1fr)_96px] md:items-center md:gap-4';

  // One price column (UK or US) for a row: the price, then cost and margin.
  const priceCell = (p, ccy) => {
    const sell = ccy === 'USD' ? p.default_price_usd : p.default_price;
    const cost = ccy === 'USD' ? p.cost_price_usd : p.cost_price;
    const m = sell != null ? pct(Number(sell), cost == null ? null : Number(cost)) : null;
    return (
      <div className="md:text-right">
        {sell != null ? <span className="text-sm font-mono text-paper">{moneyIn(sell, ccy)}</span> : <span className="text-[11px] text-amber-600">no {ccy === 'USD' ? '$' : '£'} price</span>}
        {cost != null && <div className="text-[10px] text-dim">cost {moneyIn(cost, ccy)}{m != null ? ` · ${m}%` : ''}</div>}
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-3 border-b border-bdr space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-lg font-bold text-paper">Products</div>
            <div className="text-[10px] text-dim font-mono uppercase tracking-[0.18em]">{products.length} in your catalogue · £ and $ list prices</div>
          </div>
          {canWrite && <button onClick={startNew} className="px-3 py-1.5 bg-ember text-white text-sm font-semibold rounded-xl hover:bg-ember-deep transition">+ New product</button>}
        </div>
        {!loading && products.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, SKU or description…" className={input + ' !w-auto flex-1 min-w-[200px] !py-1.5'} />
            <select value={cat} onChange={e => setCat(e.target.value)} className={input + ' !w-auto !py-1.5'}>
              <option value="all">All categories</option>
              {CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
            <select value={show} onChange={e => setShow(e.target.value)} className={input + ' !w-auto !py-1.5'}>
              {Object.entries(SHOW).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            {(q || cat !== 'all' || show !== 'all') && <button onClick={() => { setQ(''); setCat('all'); setShow('all'); }} className="text-xs text-ember">Clear</button>}
            <span className="text-[11px] text-dim ml-auto">{shown.length} of {products.length}</span>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && <div className="py-8 text-center text-dim text-sm">Loading…</div>}
        {!loading && products.length === 0 && (
          <div className="py-12 text-center text-dim text-sm">No products yet. Add the hardware, services, SaaS plans and payment rates you sell.</div>
        )}
        {!loading && products.length > 0 && shown.length === 0 && <div className="py-8 text-center text-dim text-sm">No products match.</div>}

        {!loading && shown.length > 0 && (
          <div className={`hidden ${COLS} px-6 py-2 text-[10px] font-mono font-bold uppercase tracking-[0.14em] text-dim border-b border-bdr sticky top-0 z-10`} style={{ background: 'var(--scene-bg, var(--surface-solid))' }}>
            <div>Product</div><div>Billing</div><div className="text-right">UK £</div><div className="text-right">US $</div><div>Stock</div><div />
          </div>
        )}

        {CATEGORIES.map(c => {
          const items = shown.filter(p => p.category === c.key);
          if (!items.length) return null;
          return (
            <div key={c.key}>
              <div className="px-6 pt-4 pb-1 text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim">{c.icon} {c.label} · {items.length}</div>
              {items.map(p => {
                const st = stockCounts[p.name] || { in_stock: 0, in_transit: 0, deployed: 0 };
                const low = p.default_threshold != null && st.in_stock <= p.default_threshold;
                return (
                  <div key={p.id} onClick={() => canWrite && startEdit(p)}
                    className={`grid grid-cols-2 gap-x-4 gap-y-1 ${COLS} px-6 py-2.5 border-b border-bdr/60 ${canWrite ? 'cursor-pointer hover:bg-card/60' : ''} ${editing === p.id ? 'bg-ember/5' : ''}`}>
                    <div className="min-w-0 col-span-2 md:col-span-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-paper">{p.name}</span>
                        {!p.active && <span className="px-1.5 py-0.5 text-[9px] font-bold uppercase rounded bg-slate-100 text-slate-500">Inactive</span>}
                        {p.is_bundle && <span className="px-1.5 py-0.5 text-[9px] font-bold uppercase rounded bg-ember/10 text-ember">Bundle</span>}
                        {p.sold_separately === false && <span className="px-1.5 py-0.5 text-[9px] font-bold uppercase rounded bg-sky-100 text-sky-700">Part only</span>}
                        {(p.sku || p.sku_us) && <span className="text-[10px] font-mono text-dim">{p.sku && `UK ${p.sku}`}{p.sku && p.sku_us && ' · '}{p.sku_us && `US ${p.sku_us}`}</span>}
                      </div>
                      {p.is_bundle && REGIONS.map(({ ccy }) => {
                        const list = bundleParts(p.id, bundleRows, products, ccy);
                        return <div key={ccy} className="text-[10px] text-dim truncate">{ccy === 'GBP' ? 'UK' : 'US'}: {list.length ? list.map(x => `${x.qty} x ${x.product.name}`).join(', ') : <span className="text-amber-600">no parts yet</span>}</div>;
                      })}
                      {!p.is_bundle && p.description && <div className="text-[11px] text-muted truncate">{p.description}</div>}
                      {notes[p.id] && <div className="text-[10px] text-dim italic truncate">Note: {notes[p.id]}</div>}
                    </div>
                    <div className="text-[11px] text-muted col-span-2 md:col-span-1">{BILLING[p.billing_type]}{p.unit ? ` · ${p.unit}` : ''}</div>
                    {priceCell(p, 'GBP')}
                    {priceCell(p, 'USD')}
                    <div className="flex flex-wrap gap-1">
                      {p.is_bundle ? REGIONS.map(({ ccy }) => {
                        const can = bundleBuildable(bundleParts(p.id, bundleRows, products, ccy), inStockById);
                        return can == null ? null : <span key={ccy} className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${can > 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>{ccy === 'GBP' ? 'UK' : 'US'} {can} can build</span>;
                      }) : p.track_inventory ? (
                        <>
                          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${low ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'}`}>{st.in_stock} in stock{low ? ' · low' : ''}</span>
                          {st.in_transit > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">{st.in_transit} transit</span>}
                          {st.deployed > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">{st.deployed} out</span>}
                        </>
                      ) : <span className="text-[10px] text-dim">not tracked</span>}
                    </div>
                    {canWrite ? (
                      <div className="flex gap-3 md:justify-end" onClick={e => e.stopPropagation()}>
                        <button onClick={() => startEdit(p)} className="text-xs text-ember hover:text-ember-deep">Edit</button>
                        <button onClick={() => remove(p)} className="text-xs text-red-600 hover:text-red-700">Delete</button>
                      </div>
                    ) : <div />}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* The editor opens beside the list, so the catalogue stays in view. */}
      {editing !== null && (
        <div className="fixed inset-0 z-[60] flex justify-end" onClick={() => setEditing(null)}>
          <div className="absolute inset-0 bg-black/20" />
          <div onClick={e => e.stopPropagation()} className="relative h-full w-full max-w-[760px] flex flex-col shadow-2xl border-l border-bdr" style={{ background: 'var(--surface-solid, var(--scene-bg))' }}>
            <div className="px-5 py-3 border-b border-bdr flex items-center gap-3">
              <div className="flex-1 text-base font-bold text-paper truncate">{editing === 'new' ? 'New product' : draft.name || 'Edit product'}</div>
              <button onClick={save} className="px-4 py-1.5 bg-ember text-white text-sm font-semibold rounded-xl">Save</button>
              <button onClick={() => setEditing(null)} className="px-3 py-1.5 text-sm text-muted border border-bdr rounded-xl">Cancel</button>
            </div>
            <div className="flex-1 overflow-y-auto p-5 space-y-5">
              <div>
                <div className={section}>Basics</div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="col-span-2 sm:col-span-4"><label className={label}>Name</label><input className={input} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} autoFocus /></div>
                  <div><label className={label}>Category</label><select className={input} value={draft.category} onChange={e => setDraft({ ...draft, category: e.target.value })}>
                    {CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}</select></div>
                  <div><label className={label}>Billing</label><select className={input} value={draft.billing_type} onChange={e => setDraft({ ...draft, billing_type: e.target.value })}>
                    {Object.entries(BILLING).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
                  <div><label className={label}>Unit</label><input className={input} value={draft.unit || ''} onChange={e => setDraft({ ...draft, unit: e.target.value })} placeholder="per till…" /></div>
                  <label className="flex items-end gap-2 text-sm text-paper cursor-pointer pb-2"><input type="checkbox" checked={draft.active} onChange={e => setDraft({ ...draft, active: e.target.checked })} className="accent-ember" /> Active</label>
                  <label className="col-span-2 sm:col-span-4 flex items-start gap-2 text-sm text-paper cursor-pointer">
                    <input type="checkbox" checked={draft.sold_separately !== false} onChange={e => setDraft({ ...draft, sold_separately: e.target.checked })} className="accent-ember mt-0.5" />
                    <span>Sold on its own <span className="text-[11px] text-dim">(untick for a part, e.g. a Sunmi screen that only goes into bundles: it stays in stock and bundles but is not offered on quotes or invoices)</span></span>
                  </label>
                </div>
              </div>

              {/* A US price is a different price, not a conversion: items sell for
                  more there. Empty means not priced for that market yet, and a
                  document in that money says so. */}
              <div>
                <div className={section}>Pricing and SKUs</div>
                <div className="grid sm:grid-cols-2 gap-3">
                  {[{ ccy: 'GBP', flag: 'United Kingdom', sym: SYM, sku: 'sku', sell: 'default_price', cost: 'cost_price', m: ukMargin },
                    { ccy: 'USD', flag: 'United States', sym: '$', sku: 'sku_us', sell: 'default_price_usd', cost: 'cost_price_usd', m: usMargin }].map(r => (
                    <div key={r.ccy} className="glass-inner rounded-xl p-3 space-y-2">
                      <div className="text-xs font-semibold text-paper">{r.flag} ({r.sym})</div>
                      <div><label className={label}>SKU</label><input className={input} value={draft[r.sku] || ''} onChange={e => setDraft({ ...draft, [r.sku]: e.target.value })} /></div>
                      <div className="grid grid-cols-2 gap-2">
                        <div><label className={label}>Selling</label><input type="number" className={input} value={draft[r.sell] ?? ''} onChange={e => setDraft({ ...draft, [r.sell]: e.target.value })} placeholder="not priced" /></div>
                        <div><label className={label}>Cost{draftCost ? ' (parts)' : ''}</label><input type="number" className={input} disabled={!!draftCost} value={eff[r.cost] ?? ''} onChange={e => setDraft({ ...draft, [r.cost]: e.target.value })} placeholder={draftCost ? 'from parts' : '0.00'} /></div>
                      </div>
                      {draftCost?.[r.ccy].missing.length > 0 && <div className="text-[11px] text-amber-600">No {r.sym} cost on: {draftCost[r.ccy].missing.join(', ')}</div>}
                      {r.m && <div className="text-[11px] text-emerald-600 font-semibold">Margin {fmtMoney(r.m.amount, r.ccy)} ({r.m.pct}%)</div>}
                      {r.ccy === 'GBP' && (
                        <div><label className={label}>Purchase {TAX} %</label><input type="number" className={input + ' !w-28'} value={draft.cost_tax_rate ?? ''} onChange={e => setDraft({ ...draft, cost_tax_rate: e.target.value })} placeholder={String(defaultTaxRateFor(CATALOGUE_CCY))} />
                          {eff.cost_price !== '' && eff.cost_price != null && draft.cost_tax_rate !== '' && draft.cost_tax_rate != null && (
                            <span className="text-[11px] text-dim ml-2">Cost inc {TAX}: {fmtMoney(Number(eff.cost_price) * (1 + Number(draft.cost_tax_rate) / 100), CATALOGUE_CCY)}</span>
                          )}</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-3">
                <div><label className={label}>Description (on quotes)</label><textarea className={input + ' resize-none'} rows={3} value={draft.description || ''} onChange={e => setDraft({ ...draft, description: e.target.value })} /></div>
                <div><label className={label}>Internal notes (staff only)</label><textarea className={input + ' resize-none'} rows={3} value={draft.notes || ''} onChange={e => setDraft({ ...draft, notes: e.target.value })} placeholder="Supplier quirks, lead times…" /></div>
              </div>

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
                              <input type="number" min="1" className={input + ' !w-16 !py-1'} value={x.qty} onChange={e => setParts(ccy, list.map((y, j) => j === i ? { ...y, qty: e.target.value } : y))} />
                              <div className="flex-1 text-sm text-paper truncate">{products.find(p => p.id === x.component_id)?.name || 'Unknown product'}</div>
                              <button onClick={() => setParts(ccy, list.filter((_, j) => j !== i))} className="text-xs text-red-600">Remove</button>
                            </div>
                          ))}
                          <select className={input + ' text-xs'} value="" onChange={e => { const id = e.target.value; if (id && !list.some(y => y.component_id === id)) setParts(ccy, [...list, { component_id: id, qty: 1 }]); }}>
                            <option value="">+ Add a part…</option>
                            {partChoices.map(p => <option key={p.id} value={p.id} disabled={list.some(y => y.component_id === p.id)}>{p.name}</option>)}
                          </select>
                          {list.length === 0 && <div className="text-[11px] text-dim italic">No {ccy === 'GBP' ? 'UK' : 'US'} parts yet.</div>}
                          {total !== null && <div className="text-[11px] text-dim">Parts list at {fmtMoney(total, ccy)} (guide; the bundle uses its own price).</div>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="glass-inner rounded-xl p-3 space-y-3">
                <label className="flex items-center gap-2 text-sm text-paper cursor-pointer">
                  <input type="checkbox" checked={!!draft.track_inventory} onChange={e => setDraft({ ...draft, track_inventory: e.target.checked })} className="accent-ember" />
                  Track in inventory (serial-tracked hardware)
                </label>
                <div className="grid sm:grid-cols-3 gap-3">
                  <div><label className={label}>Default supplier</label>
                    <select className={input} value={draft.supplier_id || ''} onChange={e => setDraft({ ...draft, supplier_id: e.target.value })}>
                      <option value="">None</option>
                      {suppliers.map(su => <option key={su.id} value={su.id}>{su.name}</option>)}
                    </select></div>
                  {draft.track_inventory && <>
                    <div><label className={label}>Hardware category</label>
                      <select className={input} value={draft.inv_category || ''} onChange={e => setDraft({ ...draft, inv_category: e.target.value })}>
                        <option value="">Select…</option>
                        {INV_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                      </select></div>
                    <div><label className={label}>Low stock at</label>
                      <input type="number" min="0" className={input} value={draft.default_threshold ?? ''} onChange={e => setDraft({ ...draft, default_threshold: e.target.value })} placeholder="3" /></div>
                  </>}
                </div>
                {suppliers.length === 0 && <div className="text-[10px] text-dim">No suppliers yet. Add them under Inventory, Suppliers.</div>}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

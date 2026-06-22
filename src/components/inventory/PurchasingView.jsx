import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { ShoppingCart, Plus, X, Truck, Trash2 } from 'lucide-react';
import { parseSerials, receiveShipment, fmtGBP, shippedByProduct } from '../../lib/inventoryOps';

const input = "w-full px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper placeholder-dim focus:outline-none focus:border-ember";
const label = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block";
const PO_BADGE = { pending: 'bg-amber-100 text-amber-700', partial: 'bg-blue-100 text-blue-700', received: 'bg-emerald-100 text-emerald-700', cancelled: 'bg-slate-200 text-slate-500' };

export default function PurchasingView({ profile, initialTab = 'orders' }) {
  const [tab, setTab] = useState(initialTab);
  const [orders, setOrders] = useState([]);
  const [shipments, setShipments] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [products, setProducts] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [creatingPO, setCreatingPO] = useState(false);
  const [arranging, setArranging] = useState(null);   // order (or null) -> shipment modal
  const [receiving, setReceiving] = useState(null);   // shipment -> receive modal
  const [editSupplier, setEditSupplier] = useState(null);
  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  useEffect(() => { load(); }, []);
  const load = async () => {
    const [o, sh, su, p, w] = await Promise.all([
      supabase.from('inv_orders').select('*, lines:inv_order_lines(*)').order('created_at', { ascending: false }),
      supabase.from('inv_shipments').select('*, lines:inv_shipment_lines(*), warehouse:inv_warehouses(name)').order('created_at', { ascending: false }),
      supabase.from('inv_suppliers').select('*').order('name'),
      supabase.from('products').select('id, name, inv_category, default_price, cost_price, cost_tax_rate').eq('active', true).order('name'),
      supabase.from('inv_warehouses').select('*'),
    ]);
    setOrders(o.data || []); setShipments(sh.data || []); setSuppliers(su.data || []);
    setProducts(p.data || []); setWarehouses(w.data || []);
  };

  const transit = shipments.filter(s => s.status === 'in_transit');
  const shipHistory = shipments.filter(s => s.status !== 'in_transit');

  const TABS = [['orders', `Purchase Orders (${orders.length})`], ['transit', `In Transit (${transit.length})`],
    ['shiphist', 'Shipment History'], ['suppliers', `Suppliers (${suppliers.length})`]];

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-bdr flex items-center gap-3 flex-wrap">
        <ShoppingCart size={20} className="text-ember" />
        <div className="text-xl font-bold text-paper mr-2">Purchasing</div>
        <div className="flex gap-0.5 bg-card rounded-xl p-0.5">
          {TABS.map(([k, lbl]) => (
            <button key={k} onClick={() => setTab(k)} className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${tab === k ? 'bg-ember text-white' : 'text-muted'}`}>{lbl}</button>
          ))}
        </div>
        {canWrite && tab === 'orders' && <button onClick={() => setCreatingPO(true)} className="btn-glass px-4 py-2 rounded-xl text-sm font-semibold ml-auto flex items-center gap-1.5"><Plus size={15} /> New PO</button>}
        {canWrite && tab === 'transit' && <button onClick={() => setArranging({})} className="btn-glass px-4 py-2 rounded-xl text-sm font-semibold ml-auto flex items-center gap-1.5"><Truck size={15} /> Arrange shipment</button>}
        {canWrite && tab === 'suppliers' && <button onClick={() => setEditSupplier({})} className="btn-glass px-4 py-2 rounded-xl text-sm font-semibold ml-auto flex items-center gap-1.5"><Plus size={15} /> Add supplier</button>}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-[1100px] mx-auto space-y-3">

          {tab === 'orders' && orders.map(o => {
            const received = o.lines.reduce((s, l) => s + (l.received_qty || 0), 0);
            const total = o.lines.reduce((s, l) => s + l.qty, 0);
            const shippedMap = shippedByProduct(o, shipments);
            const shipped = Object.values(shippedMap).reduce((a, b) => a + b, 0);
            const remaining = total - shipped;
            const openShipment = shipments.find(sh => sh.order_id === o.id && sh.status === 'in_transit');
            const displayStatus = (o.status !== 'cancelled' && o.status !== 'received' && remaining <= 0 && openShipment) ? 'in transit' : o.status;
            const cancelOrder = async () => {
              if (!confirm(`Cancel ${o.po_number}?`)) return;
              await supabase.from('inv_orders').update({ status: 'cancelled' }).eq('id', o.id);
              load();
            };
            return (
              <div key={o.id} className="glass-card rounded-2xl p-5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono font-bold text-paper">{o.po_number}</span>
                  <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${displayStatus === 'in transit' ? 'bg-blue-100 text-blue-700' : PO_BADGE[o.status]}`}>{displayStatus}</span>
                  <span className="text-sm text-muted">{o.supplier_name}</span>
                  {o.expected_by && <span className="text-xs text-dim">· expected {new Date(o.expected_by).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>}
                  <span className="text-xs text-dim">· {shipped}/{total} shipped · {received}/{total} received</span>
                  <span className="ml-auto text-sm font-semibold text-paper tabular-nums">{fmtGBP(o.total_with_tax)}</span>
                </div>
                {canWrite && o.status !== 'received' && o.status !== 'cancelled' && (
                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    {remaining > 0 && (
                      <button onClick={() => setArranging(o)} className="px-3 py-1.5 rounded-xl bg-ember/15 text-ember-deep border border-ember/25 text-xs font-semibold hover:bg-ember/25 flex items-center gap-1">
                        <Truck size={12} /> {shipped > 0 ? 'Arrange remaining' : 'Arrange / split shipment'}</button>
                    )}
                    {openShipment && (
                      <button onClick={() => setReceiving(openShipment)} className="px-3 py-1.5 rounded-xl bg-emerald-500/15 text-emerald-700 border border-emerald-500/30 text-xs font-semibold hover:bg-emerald-500/25">
                        Receive (full or part)</button>
                    )}
                    {shipped === 0 && <button onClick={cancelOrder} className="px-3 py-1.5 rounded-xl text-red-600 border border-red-200 text-xs font-semibold hover:bg-red-50">Cancel</button>}
                  </div>
                )}
                <div className="mt-2 text-xs text-muted space-y-0.5">
                  {o.lines.map(l => {
                    const lShipped = Math.min(shippedMap[l.product_name] || 0, l.qty);
                    const landedTotal = (l.landed_unit_cost ?? l.unit_cost ?? 0) * l.qty;
                    return (
                      <div key={l.id} className="flex items-center gap-2 flex-wrap">
                        <span className="text-paper">{l.product_name}</span><span>× {l.qty}</span>
                        <span className="text-dim">@ {fmtGBP(l.unit_cost)}{l.landed_unit_cost != null && l.landed_unit_cost !== l.unit_cost ? ` (landed ${fmtGBP(l.landed_unit_cost)} · ${fmtGBP(landedTotal)} total)` : ''}</span>
                        <span className="ml-auto text-dim">{lShipped}/{l.qty} shipped · {l.received_qty || 0}/{l.qty} received</span>
                      </div>
                    );
                  })}
                  {o.tax_amount > 0 && <div className="text-dim">Tax: {fmtGBP(o.tax_amount)}{o.tax_rate ? ` (${o.tax_rate}%)` : ''}{o.tax_ref ? ` · ${o.tax_ref}` : ''} · Total inc tax: {fmtGBP(o.total_with_tax)}</div>}
                </div>
              </div>
            );
          })}
          {tab === 'orders' && orders.length === 0 && <Empty>No purchase orders yet.</Empty>}

          {tab === 'transit' && transit.map(s => <ShipmentCard key={s.id} s={s} canWrite={canWrite} onReceive={() => setReceiving(s)} />)}
          {tab === 'transit' && transit.length === 0 && <Empty>Nothing in transit.</Empty>}

          {tab === 'shiphist' && shipHistory.map(s => <ShipmentCard key={s.id} s={s} />)}
          {tab === 'shiphist' && shipHistory.length === 0 && <Empty>No shipment history.</Empty>}

          {tab === 'suppliers' && suppliers.map(su => (
            <div key={su.id} className="glass-card rounded-2xl px-5 py-3.5 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-paper">{su.name}</div>
                <div className="text-xs text-muted">{[su.contact_name, su.email, su.phone].filter(Boolean).join(' · ') || 'No contact details'}</div>
              </div>
              {canWrite && <button onClick={() => setEditSupplier(su)} className="btn-ghost px-3 py-1.5 rounded-xl text-xs">Edit</button>}
            </div>
          ))}
          {tab === 'suppliers' && suppliers.length === 0 && <Empty>No suppliers yet.</Empty>}
        </div>
      </div>

      {creatingPO && <POModal products={products} suppliers={suppliers} profile={profile} onClose={() => setCreatingPO(false)} onSaved={() => { setCreatingPO(false); load(); }} />}
      {arranging && <ShipmentModal order={arranging.id ? arranging : null} suppliers={suppliers} products={products} warehouses={warehouses} allShipments={shipments} onClose={() => setArranging(null)} onSaved={() => { setArranging(null); load(); }} />}
      {receiving && <ReceiveModal shipment={receiving} warehouses={warehouses} profile={profile} onClose={() => setReceiving(null)} onSaved={() => { setReceiving(null); load(); }} />}
      {editSupplier && <SupplierModal supplier={editSupplier} onClose={() => setEditSupplier(null)} onSaved={() => { setEditSupplier(null); load(); }} />}
    </div>
  );
}

const Empty = ({ children }) => <div className="glass-card rounded-2xl p-8 text-center text-dim text-sm italic">{children}</div>;

function ShipmentCard({ s, canWrite, onReceive }) {
  const units = s.lines.reduce((n, l) => n + l.qty, 0);
  const recd = s.lines.reduce((n, l) => n + (l.received_qty || 0), 0);
  return (
    <div className="glass-card rounded-2xl p-5">
      <div className="flex items-center gap-2 flex-wrap">
        <Truck size={15} className="text-ember" />
        <span className="text-sm font-semibold text-paper">{s.supplier_name || 'Shipment'}</span>
        <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${s.status === 'in_transit' ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>{s.status.replace('_', ' ')}</span>
        {s.po_number && <span className="text-xs text-dim">· {s.po_number}</span>}
        {s.eta && s.status === 'in_transit' && <span className="text-xs text-dim">· ETA {new Date(s.eta).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>}
        <span className="text-xs text-dim">· {recd}/{units} received → {s.warehouse?.name || '—'}</span>
        {canWrite && s.status === 'in_transit' && <button onClick={onReceive} className="ml-auto px-3 py-1.5 rounded-xl bg-emerald-500/15 text-emerald-700 border border-emerald-500/30 text-xs font-semibold hover:bg-emerald-500/25">Receive</button>}
      </div>
      <div className="mt-2 text-xs text-muted space-y-0.5">
        {s.lines.map(l => <div key={l.id}>{l.product_name} × {l.qty}{l.unit_cost != null ? ` @ ${fmtGBP(l.unit_cost)} landed` : ''}</div>)}
      </div>
    </div>
  );
}

// ── New PO (ports the tax-split landed cost calc) ────────────────────────────
function POModal({ products, suppliers, profile, onClose, onSaved }) {
  const [supplierName, setSupplierName] = useState('');
  const [expectedBy, setExpectedBy] = useState('');
  const [taxAmount, setTaxAmount] = useState('');
  const [taxRef, setTaxRef] = useState('');
  const [rows, setRows] = useState([{ product_id: '', product_name: '', category: '', qty: 1, unit_cost: '', tax_rate: '' }]);
  const [saving, setSaving] = useState(false);
  const set = (i, k, v) => setRows(p => p.map((r, x) => x === i ? { ...r, [k]: v } : r));
  const pick = (i, id) => { const p = products.find(x => x.id === id); setRows(prev => prev.map((r, x) => x === i ? { ...r, product_id: id, product_name: p?.name || '', category: p?.inv_category || '', unit_cost: r.unit_cost || p?.cost_price || '', tax_rate: (r.tax_rate !== '' && r.tax_rate != null) ? r.tax_rate : (p?.cost_tax_rate ?? 20) } : r)); };

  const subtotal = rows.reduce((s, r) => s + (Number(r.unit_cost) || 0) * (Number(r.qty) || 0), 0);
  // VAT is auto-computed per line from each product's purchase VAT rate; a typed
  // "Tax amount" overrides (e.g. to match a supplier invoice to the penny).
  const lineTax = rows.reduce((s, r) => s + (Number(r.unit_cost) || 0) * (Number(r.qty) || 0) * (Number(r.tax_rate) || 0) / 100, 0);
  const resolvedTax = taxAmount !== '' ? Number(taxAmount) : lineTax;

  const save = async () => {
    setSaving(true);
    try {
      const lines = rows.filter(r => r.product_name && Number(r.qty) > 0);
      if (!supplierName.trim()) throw new Error('Supplier is required.');
      if (!lines.length) throw new Error('Add at least one line.');
      const poNumber = `PO-${new Date().getFullYear()}-${String(Date.now()).slice(-5)}`;
      // Per-line VAT from each product's rate → landed unit cost. If a total VAT
      // was typed to match a supplier invoice, split it proportionally instead.
      const manualOverride = taxAmount !== '';
      const withTax = lines.map(r => {
        const lineValue = (Number(r.unit_cost) || 0) * Number(r.qty);
        const taxShare = manualOverride
          ? (subtotal > 0 ? (lineValue / subtotal) * resolvedTax : 0)
          : lineValue * (Number(r.tax_rate) || 0) / 100;
        const taxPerUnit = Number(r.qty) > 0 ? taxShare / Number(r.qty) : 0;
        return { ...r, taxShare, taxPerUnit, landed: (Number(r.unit_cost) || 0) + taxPerUnit };
      });
      const blendedRate = subtotal > 0 ? +((resolvedTax / subtotal) * 100).toFixed(2) : null;
      const { data: order, error } = await supabase.from('inv_orders').insert({
        po_number: poNumber, supplier_name: supplierName.trim(),
        supplier_id: suppliers.find(s => s.name === supplierName.trim())?.id || null,
        expected_by: expectedBy || null, status: 'pending',
        subtotal: +subtotal.toFixed(2), tax_rate: blendedRate,
        tax_amount: +resolvedTax.toFixed(2), tax_ref: taxRef || null,
        total_with_tax: +(subtotal + resolvedTax).toFixed(2), created_by: profile.id,
      }).select().single();
      if (error) throw error;
      await supabase.from('inv_order_lines').insert(withTax.map((r, i) => ({
        order_id: order.id, product_id: r.product_id || null, product_name: r.product_name, category: r.category || null,
        qty: Number(r.qty), unit_cost: r.unit_cost === '' ? null : Number(r.unit_cost),
        tax_share: +r.taxShare.toFixed(4), tax_per_unit: +r.taxPerUnit.toFixed(4),
        landed_unit_cost: +r.landed.toFixed(4), sort: i,
      })));
      onSaved();
    } catch (e) { alert(e.message); }
    setSaving(false);
  };

  return (
    <Modal title="New purchase order" onClose={onClose} wide>
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <div><label className={label}>Supplier</label>
            <input className={input} list="po-suppliers" value={supplierName} onChange={e => setSupplierName(e.target.value)} />
            <datalist id="po-suppliers">{suppliers.map(s => <option key={s.id} value={s.name} />)}</datalist></div>
          <div><label className={label}>Expected by</label><input type="date" className={input} value={expectedBy} onChange={e => setExpectedBy(e.target.value)} /></div>
          <div><label className={label}>Tax ref</label><input className={input} value={taxRef} onChange={e => setTaxRef(e.target.value)} placeholder="VAT invoice #" /></div>
        </div>
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[1fr_64px_84px_64px_32px] gap-2 items-end">
            <div><label className={label}>Product</label>
              <select className={input} value={r.product_id} onChange={e => pick(i, e.target.value)}>
                <option value="">Select…</option>{products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select></div>
            <div><label className={label}>Qty</label><input type="number" min="1" className={input} value={r.qty} onChange={e => set(i, 'qty', e.target.value)} /></div>
            <div><label className={label}>Unit £</label><input className={input} value={r.unit_cost} onChange={e => set(i, 'unit_cost', e.target.value)} /></div>
            <div><label className={label}>VAT %</label><input className={input} value={r.tax_rate ?? ''} onChange={e => set(i, 'tax_rate', e.target.value)} placeholder="20" /></div>
            <button onClick={() => setRows(p => p.filter((_, x) => x !== i))} className="text-dim hover:text-red-600 pb-2"><Trash2 size={15} /></button>
          </div>
        ))}
        <button onClick={() => setRows(p => [...p, { product_id: '', product_name: '', category: '', qty: 1, unit_cost: '', tax_rate: '' }])}
          className="text-xs text-ember hover:text-ember-deep font-medium">+ Add line</button>
        <div><label className={label}>Override total VAT £ (optional)</label>
          <input className={input + ' max-w-xs'} value={taxAmount} onChange={e => setTaxAmount(e.target.value)} placeholder="auto-calculated from each product's VAT" /></div>
        <div className="text-sm text-muted">Subtotal <b className="text-paper">{fmtGBP(subtotal)}</b> · VAT <b className="text-paper">{fmtGBP(resolvedTax)}</b> · Total <b className="text-paper">{fmtGBP(subtotal + resolvedTax)}</b>
          <div className="text-[11px] text-dim mt-0.5">VAT is calculated per line from each product's purchase VAT rate (set on the product). Override above to match a supplier invoice. Landed unit cost locks onto received serials.</div></div>
        <div className="flex gap-2"><button onClick={save} disabled={saving} className="btn-glass px-5 py-2 rounded-xl text-sm font-semibold disabled:opacity-50">Create PO</button>
          <button onClick={onClose} className="btn-ghost px-4 py-2 rounded-xl text-sm">Cancel</button></div>
      </div>
    </Modal>
  );
}

// ── Arrange shipment (from a PO or standalone) ───────────────────────────────
function ShipmentModal({ order, suppliers, products, warehouses, allShipments, onClose, onSaved }) {
  const [supplierName, setSupplierName] = useState(order?.supplier_name || '');
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.id || '');
  const [eta, setEta] = useState('');
  const [freight, setFreight] = useState('');
  const shippedMap = order ? shippedByProduct(order, allShipments || []) : {};
  const [rows, setRows] = useState(order
    ? order.lines.map(l => ({ product_id: l.product_id, product_name: l.product_name, category: l.category, max: l.qty - Math.min(shippedMap[l.product_name] || 0, l.qty), qty: l.qty - Math.min(shippedMap[l.product_name] || 0, l.qty), unit_cost: l.landed_unit_cost ?? l.unit_cost ?? '' })).filter(r => r.max > 0)
    : [{ product_id: '', product_name: '', category: '', qty: 1, unit_cost: '' }]);
  const [saving, setSaving] = useState(false);
  const set = (i, k, v) => setRows(p => p.map((r, x) => x === i ? { ...r, [k]: v } : r));
  const pick = (i, id) => { const p = products.find(x => x.id === id); setRows(prev => prev.map((r, x) => x === i ? { ...r, product_id: id, product_name: p?.name || '', category: p?.inv_category || '' } : r)); };

  const save = async () => {
    setSaving(true);
    try {
      const lines = rows.filter(r => r.product_name && Number(r.qty) > 0);
      if (!lines.length) throw new Error('Add at least one line.');
      const totalUnits = lines.reduce((s, r) => s + Number(r.qty), 0);
      const freightPerUnit = totalUnits > 0 && freight !== '' ? Number(freight) / totalUnits : 0;
      const { data: sh, error } = await supabase.from('inv_shipments').insert({
        order_id: order?.id || null, po_number: order?.po_number || null,
        supplier_name: supplierName || null, warehouse_id: warehouseId || null,
        eta: eta || null, freight_cost: freight === '' ? 0 : Number(freight), status: 'in_transit',
      }).select().single();
      if (error) throw error;
      await supabase.from('inv_shipment_lines').insert(lines.map(r => ({
        shipment_id: sh.id, product_id: r.product_id || null, product_name: r.product_name, category: r.category || null,
        qty: Number(r.qty), unit_cost: r.unit_cost === '' ? null : +(Number(r.unit_cost) + freightPerUnit).toFixed(4),
      })));
      // Split shipment: if this doesn't cover everything outstanding, the PO is partial
      if (order) {
        const orderedTotal = order.lines.reduce((s, l) => s + l.qty, 0);
        const alreadyShipped = Object.values(shippedMap).reduce((a, b) => a + b, 0);
        const nowShipping = lines.reduce((s, r) => s + Number(r.qty), 0);
        if (alreadyShipped + nowShipping < orderedTotal) {
          await supabase.from('inv_orders').update({ status: 'partial' }).eq('id', order.id);
        }
      }
      onSaved();
    } catch (e) { alert(e.message); }
    setSaving(false);
  };

  return (
    <Modal title={order ? `Arrange shipment — ${order.po_number}` : 'Arrange shipment'} onClose={onClose} wide>
      <div className="space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div><label className={label}>Supplier</label>
            <input className={input} list="ship-suppliers" value={supplierName} onChange={e => setSupplierName(e.target.value)} />
            <datalist id="ship-suppliers">{suppliers.map(s => <option key={s.id} value={s.name} />)}</datalist></div>
          <div><label className={label}>To warehouse</label>
            <select className={input} value={warehouseId} onChange={e => setWarehouseId(e.target.value)}>
              {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select></div>
          <div><label className={label}>ETA</label><input type="date" className={input} value={eta} onChange={e => setEta(e.target.value)} /></div>
          <div><label className={label}>Freight £ (split/unit)</label><input className={input} value={freight} onChange={e => setFreight(e.target.value)} placeholder="0" /></div>
        </div>
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[1fr_90px_110px_32px] gap-2 items-end">
            <div><label className={label}>Product</label>
              {order ? <input className={input} value={r.product_name} disabled />
                : <select className={input} value={r.product_id} onChange={e => pick(i, e.target.value)}>
                  <option value="">Select…</option>{products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>}</div>
            <div><label className={label}>Qty{order && r.max != null ? ` (max ${r.max})` : ''}</label><input type="number" min="1" max={order ? r.max : undefined} className={input} value={r.qty} onChange={e => set(i, 'qty', e.target.value)} /></div>
            <div><label className={label}>Unit £</label><input className={input} value={r.unit_cost} onChange={e => set(i, 'unit_cost', e.target.value)} /></div>
            {!order && <button onClick={() => setRows(p => p.filter((_, x) => x !== i))} className="text-dim hover:text-red-600 pb-2"><Trash2 size={15} /></button>}
          </div>
        ))}
        {!order && <button onClick={() => setRows(p => [...p, { product_id: '', product_name: '', category: '', qty: 1, unit_cost: '' }])}
          className="text-xs text-ember hover:text-ember-deep font-medium">+ Add line</button>}
        <div className="flex gap-2"><button onClick={save} disabled={saving} className="btn-glass px-5 py-2 rounded-xl text-sm font-semibold disabled:opacity-50">Create shipment</button>
          <button onClick={onClose} className="btn-ghost px-4 py-2 rounded-xl text-sm">Cancel</button></div>
      </div>
    </Modal>
  );
}

// ── Receive shipment (full or partial, serial capture) ───────────────────────
function ReceiveModal({ shipment, warehouses, profile, onClose, onSaved }) {
  const [warehouseId, setWarehouseId] = useState(shipment.warehouse_id || warehouses[0]?.id || '');
  const [entries, setEntries] = useState(shipment.lines.map(l => ({ line_id: l.id, serialText: '', qty: '' })));
  const [saving, setSaving] = useState(false);
  const set = (i, k, v) => setEntries(p => p.map((e, x) => x === i ? { ...e, [k]: v } : e));

  const save = async () => {
    setSaving(true);
    try {
      const receipts = entries.map(e => ({ line_id: e.line_id, serials: parseSerials(e.serialText), qty: e.qty === '' ? 0 : Number(e.qty) }))
        .filter(e => e.serials.length || e.qty > 0);
      if (!receipts.length) throw new Error('Enter serials (or quantities) to receive.');
      await receiveShipment({ shipmentId: shipment.id, receipts, warehouse: warehouseId, byName: profile.display_name || profile.email, actorId: profile.id });
      onSaved();
    } catch (e) { alert(e.message); }
    setSaving(false);
  };

  return (
    <Modal title={`Receive — ${shipment.supplier_name || 'shipment'}${shipment.po_number ? ` (${shipment.po_number})` : ''}`} onClose={onClose} wide>
      <div className="space-y-4">
        <div><label className={label}>Into warehouse</label>
          <select className={input + ' !w-60'} value={warehouseId} onChange={e => setWarehouseId(e.target.value)}>
            {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select></div>
        {shipment.lines.map((l, i) => {
          const remaining = l.qty - (l.received_qty || 0);
          if (remaining <= 0) return <div key={l.id} className="text-xs text-emerald-600">✓ {l.product_name} fully received</div>;
          return (
            <div key={l.id} className="glass-inner rounded-xl p-3 space-y-2">
              <div className="text-sm text-paper font-medium">{l.product_name} <span className="text-dim font-normal">— {remaining} outstanding</span></div>
              <textarea className={input + ' font-mono resize-none'} rows={2} value={entries[i].serialText}
                onChange={e => set(i, 'serialText', e.target.value)} placeholder="Scan/paste serials for this line… (leave blank for non-serialised)" />
              <div className="flex items-center gap-2 text-xs text-muted">
                or receive <input type="number" min="0" max={remaining} className="w-20 px-2 py-1 bg-card border border-bdr rounded-lg text-sm text-paper" value={entries[i].qty} onChange={e => set(i, 'qty', e.target.value)} /> units without serials
              </div>
            </div>
          );
        })}
        <div className="text-[11px] text-dim">Receive everything or just part — the shipment stays in transit until all units arrive. Landed unit costs lock onto each serial.</div>
        <div className="flex gap-2"><button onClick={save} disabled={saving} className="btn-glass px-5 py-2 rounded-xl text-sm font-semibold disabled:opacity-50">Receive</button>
          <button onClick={onClose} className="btn-ghost px-4 py-2 rounded-xl text-sm">Cancel</button></div>
      </div>
    </Modal>
  );
}

function SupplierModal({ supplier, onClose, onSaved }) {
  const [f, setF] = useState({ name: supplier.name || '', contact_name: supplier.contact_name || '', email: supplier.email || '', phone: supplier.phone || '', notes: supplier.notes || '' });
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const save = async () => {
    if (!f.name.trim()) { alert('Name required'); return; }
    if (supplier.id) await supabase.from('inv_suppliers').update(f).eq('id', supplier.id);
    else await supabase.from('inv_suppliers').insert(f);
    onSaved();
  };
  return (
    <Modal title={supplier.id ? 'Edit supplier' : 'Add supplier'} onClose={onClose}>
      <div className="space-y-3">
        <div><label className={label}>Name</label><input className={input} value={f.name} onChange={e => set('name', e.target.value)} autoFocus /></div>
        <div><label className={label}>Contact</label><input className={input} value={f.contact_name} onChange={e => set('contact_name', e.target.value)} /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className={label}>Email</label><input className={input} value={f.email} onChange={e => set('email', e.target.value)} /></div>
          <div><label className={label}>Phone</label><input className={input} value={f.phone} onChange={e => set('phone', e.target.value)} /></div>
        </div>
        <div><label className={label}>Notes</label><textarea className={input + ' resize-none'} rows={2} value={f.notes} onChange={e => set('notes', e.target.value)} /></div>
        <div className="flex gap-2"><button onClick={save} className="btn-glass px-5 py-2 rounded-xl text-sm font-semibold">Save</button>
          <button onClick={onClose} className="btn-ghost px-4 py-2 rounded-xl text-sm">Cancel</button></div>
      </div>
    </Modal>
  );
}

function Modal({ title, children, onClose, wide }) {
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className={`glass-card rounded-2xl w-full ${wide ? 'max-w-2xl' : 'max-w-md'} max-h-[90vh] overflow-y-auto`} onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-bdr flex items-center justify-between sticky top-0 glass-card z-10">
          <div className="text-base font-bold text-paper">{title}</div>
          <button onClick={onClose} className="text-muted hover:text-paper"><X size={18} /></button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

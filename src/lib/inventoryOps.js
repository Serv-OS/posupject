import { supabase } from './supabase';
import { fmtMoney } from './money';

// Inventory operations — ports the AIO Inventory business rules onto Postgres.
// Current state lives on inv_serials; every change also writes an inv_movements
// ledger row (the audit trail the old app derived everything from).

export const INV_CATEGORIES = [
  'Cash Drawer', 'Payment Terminal', 'Customer-Facing Display', 'POS Terminal',
  'Kitchen Display System', 'Kitchen Printer', 'Receipt/Label Printer', 'Monitor Stand',
  'Monitor Mount', 'Ceiling Mount', 'Wi-Fi Access Point', 'Gateway/Router', 'Mobile Router',
  'LTE Failover', 'PoE Switch', 'Card Reader', 'Menu Board', 'Tablet', 'Tableside AI Device',
  'MPOS', 'Kiosk', 'Kiosk Stand', 'Kiosk Mount', 'Other',
];

export const CONDITIONS = [
  ['', 'Good'], ['needs-testing', 'Needs testing'], ['pass', 'Tested — pass'],
  ['fail', 'Tested — fail'], ['fail-tl', 'Fail — total loss'],
];

export const norm = (s) => String(s || '').trim().toUpperCase();
export const parseSerials = (text) => [...new Set(String(text || '')
  .split(/[\n,;\t ]+/).map(norm).filter(Boolean))];

// Placeholder serials for non-serialised goods (same trick as the old app)
export const nsSerial = () => `NS-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

// Throws if any serial already exists anywhere in the system (old app blocked
// duplicates in stock holding AND active shipments; with one serials table we
// simply block any live serial — written-off ones may be re-received).
export async function assertSerialsNew(serials) {
  const real = serials.filter(s => !s.startsWith('NS-'));
  if (!real.length) return;
  const { data } = await supabase.from('inv_serials').select('serial, status').in('serial', real);
  const live = (data || []).filter(r => r.status !== 'written_off');
  if (live.length) {
    throw new Error(`Already in the system: ${live.map(r => `${r.serial} (${r.status.replace('_', ' ')})`).join(', ')}`);
  }
}

async function ledger(row) {
  await supabase.from('inv_movements').insert(row);
}

// ── Stock In: receive units straight into a warehouse ───────────────────────
// products: [{ product_id, product_name, category, serials[], condition, used, unit_cost, po_number, supplier_name }]
export async function stockIn({ warehouse, products, byName, actorId, supplierName }) {
  if (!warehouse) throw new Error('Warehouse is required.');
  if (!products?.length) throw new Error('Add at least one product.');
  const all = products.flatMap(p => p.serials);
  if (all.length !== new Set(all).size) throw new Error('Duplicate serials within this receipt.');
  await assertSerialsNew(all);

  for (const p of products) {
    if (!p.product_name) throw new Error('Each line needs a product.');
    if (!p.serials?.length) throw new Error(`"${p.product_name}": add serials or use the no-serials toggle.`);
    const used = !!p.used || p.condition === 'fail' || p.condition === 'fail-tl';
    const rows = p.serials.map(s => ({
      serial: norm(s), product_id: p.product_id || null, product_name: p.product_name,
      category: p.category || null, status: 'in_stock', warehouse_id: warehouse,
      used, condition: p.condition || '', cost: p.unit_cost ?? null,
      po_number: p.po_number || null, supplier_name: supplierName || p.supplier_name || null,
    }));
    const { error } = await supabase.from('inv_serials').insert(rows);
    if (error) throw error;
    await ledger({
      type: 'in', product_name: p.product_name, category: p.category || null,
      serials: p.serials, qty: p.serials.length, supplier_name: supplierName || null,
      po_number: p.po_number || null, condition: p.condition || '', by_name: byName || null, actor_id: actorId,
    });
  }
}

// ── Stock Out: dispatch serials to a customer (CRM company/location) ────────
export async function stockOut({ serials, companyId, locationId, customerName, ref, byName, actorId }) {
  if (!serials?.length) throw new Error('Add at least one serial.');
  if (!companyId && !customerName?.trim()) throw new Error('Pick a customer (or enter a name).');
  const { data: rows } = await supabase.from('inv_serials').select('*').in('serial', serials.map(norm));
  const found = new Map((rows || []).map(r => [r.serial, r]));
  const missing = serials.map(norm).filter(s => !found.has(s));
  if (missing.length) throw new Error('Not in the system: ' + missing.join(', '));
  const notInStock = [...found.values()].filter(r => r.status !== 'in_stock');
  if (notInStock.length) throw new Error('Not in stock: ' + notInStock.map(r => `${r.serial} (${r.status.replace('_', ' ')})`).join(', '));

  const now = new Date().toISOString();
  const { error } = await supabase.from('inv_serials').update({
    status: 'deployed', company_id: companyId || null, location_id: locationId || null,
    customer_name: customerName || null, deployed_at: now, dispatch_ref: ref || null, warehouse_id: null,
  }).in('serial', serials.map(norm));
  if (error) throw error;

  // ledger per product group
  const byProduct = {};
  [...found.values()].forEach(r => { (byProduct[r.product_name] = byProduct[r.product_name] || []).push(r.serial); });
  for (const [product, ss] of Object.entries(byProduct)) {
    await ledger({
      type: 'out', product_name: product, serials: ss, qty: ss.length,
      company_id: companyId || null, location_id: locationId || null,
      customer_name: customerName || null, ref: ref || null, by_name: byName || null, actor_id: actorId,
    });
  }
}

// ── Recall a deployed serial back for servicing ──────────────────────────────
export async function recallToServicing({ serial, warehouse, condition, byName, actorId }) {
  const s = norm(serial);
  const { data: row } = await supabase.from('inv_serials').select('*').eq('serial', s).maybeSingle();
  if (!row) throw new Error('Serial not found.');
  if (row.status !== 'deployed') throw new Error(`${s} is not deployed (status: ${row.status}).`);
  await supabase.from('inv_serials').update({
    status: 'servicing', warehouse_id: warehouse || null, condition: condition || 'needs-testing',
  }).eq('serial', s);
  await ledger({
    type: 'recall', product_name: row.product_name, serials: [s], qty: 1,
    company_id: row.company_id, location_id: row.location_id, customer_name: row.customer_name,
    condition: condition || 'needs-testing', by_name: byName || null, actor_id: actorId,
  });
}

// Servicing outcome: back to stock, or flag as RMA / total loss
export async function resolveServicing({ serial, outcome, warehouse, testedBy, notes }) {
  const s = norm(serial);
  const { data: row } = await supabase.from('inv_serials').select('*').eq('serial', s).maybeSingle();
  if (!row) throw new Error('Serial not found.');
  const patch = { tested_by: testedBy || null, tested_at: new Date().toISOString(), test_notes: notes || null };
  if (outcome === 'pass') Object.assign(patch, { status: 'in_stock', condition: 'pass', warehouse_id: warehouse || row.warehouse_id });
  else if (outcome === 'rma') Object.assign(patch, { status: 'rma', condition: 'fail' });
  else if (outcome === 'total_loss') Object.assign(patch, { status: 'total_loss', condition: 'fail-tl' });
  else throw new Error('Unknown outcome.');
  await supabase.from('inv_serials').update(patch).eq('serial', s);
}

// Dispatch an RMA/TL unit back to the supplier (leaves the building)
export async function dispatchRmaTl({ serial, type, ref, byName, actorId }) {
  const s = norm(serial);
  const { data: row } = await supabase.from('inv_serials').select('*').eq('serial', s).maybeSingle();
  if (!row) throw new Error('Serial not found.');
  await supabase.from('inv_serials').update({ status: 'written_off', rma_type: type }).eq('serial', s);
  await ledger({
    type: 'rma_out', product_name: row.product_name, serials: [s], qty: 1,
    supplier_name: row.supplier_name, ref: ref || null, condition: row.condition,
    by_name: byName || null, actor_id: actorId, notes: type === 'tl' ? 'Total loss' : 'RMA return',
  });
}

// ── Shipments: receive (full or partial) into stock ─────────────────────────
// receipts: [{ line_id, serials[], qty }] — serials replace NS- placeholders
export async function receiveShipment({ shipmentId, receipts, warehouse, byName, actorId }) {
  const { data: shipment } = await supabase.from('inv_shipments').select('*, lines:inv_shipment_lines(*)').eq('id', shipmentId).single();
  if (!shipment) throw new Error('Shipment not found.');
  if (shipment.status !== 'in_transit') throw new Error('Shipment is not in transit.');
  const wh = warehouse || shipment.warehouse_id;
  if (!wh) throw new Error('Warehouse is required.');

  let allReceived = true;
  for (const line of shipment.lines) {
    const rec = receipts.find(r => r.line_id === line.id);
    const already = line.received_qty || 0;
    const remaining = line.qty - already;
    if (!rec || remaining <= 0) { if (remaining > 0) allReceived = false; continue; }
    let serials = (rec.serials || []).map(norm).filter(Boolean);
    const qty = serials.length || Math.min(Number(rec.qty) || 0, remaining);
    if (qty <= 0) { allReceived = false; continue; }
    if (!serials.length) serials = Array.from({ length: qty }, nsSerial);
    if (serials.length > remaining) throw new Error(`"${line.product_name}": receiving ${serials.length} but only ${remaining} outstanding.`);
    await assertSerialsNew(serials);

    const rows = serials.map(s => ({
      serial: s, product_id: line.product_id, product_name: line.product_name, category: line.category,
      status: 'in_stock', warehouse_id: wh, cost: line.unit_cost ?? null,
      po_number: shipment.po_number || null, supplier_name: shipment.supplier_name || null,
      shipment_id: shipment.id, order_id: shipment.order_id,
    }));
    const { error } = await supabase.from('inv_serials').insert(rows);
    if (error) throw error;
    await supabase.from('inv_shipment_lines').update({ received_qty: already + serials.length }).eq('id', line.id);
    if (already + serials.length < line.qty) allReceived = false;
    await ledger({
      type: 'in', product_name: line.product_name, category: line.category, serials, qty: serials.length,
      supplier_name: shipment.supplier_name, po_number: shipment.po_number, by_name: byName || null, actor_id: actorId,
      notes: `Shipment receive${serials.length < line.qty - already ? ' (partial)' : ''}`,
    });
  }

  await supabase.from('inv_shipments').update(
    allReceived ? { status: 'received', received_at: new Date().toISOString(), received_by: byName || null } : {}
  ).eq('id', shipmentId);

  // roll PO status forward
  if (shipment.order_id) {
    const { data: lines } = await supabase.from('inv_order_lines').select('qty, received_qty').eq('order_id', shipment.order_id);
    // received counts come from serials linked to the order
    const { count } = await supabase.from('inv_serials').select('id', { count: 'exact', head: true }).eq('order_id', shipment.order_id);
    const ordered = (lines || []).reduce((s, l) => s + l.qty, 0);
    const status = (count || 0) >= ordered ? 'received' : (count || 0) > 0 ? 'partial' : 'pending';
    await supabase.from('inv_orders').update({ status }).eq('id', shipment.order_id);
  }
}

// ── Threshold helpers ────────────────────────────────────────────────────────
export function thresholdFor(thresholds, products, productName, warehouseId) {
  const t = thresholds.find(x => x.product_name === productName && x.warehouse_id === warehouseId);
  if (t) return t.threshold;
  const p = products.find(x => x.name === productName);
  return p?.default_threshold ?? 3;
}

// GBP-only legacy formatter. Kept for surfaces that have no supplier context;
// anything that can name its supplier should use fmtCost + supplierCurrency.
export const fmtGBP = (n) => n == null ? '—' : '£' + Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── Currency of inventory money ─────────────────────────────────────────────
// inv_orders / inv_shipments / inv_serials carry no currency column. The only
// stored fact about which currency a PO, shipment or landed cost was struck in
// is the supplier's default_currency (inv_suppliers, migration 059), so every
// inventory figure follows its supplier. GBP and USD are never converted.
export const fmtCost = (n, ccy = 'GBP') => n == null ? '—' : fmtMoney(n, ccy);

// `ref` is a row with supplier_id / supplier_name, or a plain supplier name.
// Matched by id first, then by name (datalists store free text), else GBP.
export function supplierCurrency(suppliers, ref) {
  const id = typeof ref === 'object' && ref ? ref.supplier_id : null;
  const name = String((typeof ref === 'string' ? ref : ref?.supplier_name) || '').trim().toLowerCase();
  const s = (suppliers || []).find(x => id && x.id === id)
    || (name && (suppliers || []).find(x => String(x.name || '').trim().toLowerCase() === name));
  return s?.default_currency === 'USD' ? 'USD' : 'GBP';
}

// A shipment inherits its PO's currency; a standalone one follows its supplier.
export function shipmentCurrency(shipment, orders, suppliers) {
  const order = shipment?.order_id ? (orders || []).find(o => o.id === shipment.order_id) : null;
  return supplierCurrency(suppliers, order || shipment);
}

export const csvExport = (rows, filename) => {
  if (!rows.length) return;
  const keys = Object.keys(rows[0]);
  const csv = [keys.join(','), ...rows.map(r => keys.map(k => `"${String(r[k] ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = filename;
  a.click();
};

// ── Serial admin (ports setProductCost / renameSerial / deleteSerial) ────────
// Set cost on EVERY serial of a product (in stock and deployed), like the old app
export async function setProductCost(productName, cost) {
  await supabase.from('inv_serials').update({ cost }).eq('product_name', productName);
}

export async function renameSerial(oldSerial, newSerial) {
  const o = norm(oldSerial), n = norm(newSerial);
  if (!n) throw new Error('New serial required.');
  await assertSerialsNew([n]);
  const { error } = await supabase.from('inv_serials').update({ serial: n }).eq('serial', o);
  if (error) throw error;
  // keep the ledger consistent so lookup by the new serial shows full history
  const { data: mvs } = await supabase.from('inv_movements').select('id, serials').contains('serials', [o]);
  for (const m of (mvs || [])) {
    await supabase.from('inv_movements').update({ serials: m.serials.map(s => s === o ? n : s) }).eq('id', m.id);
  }
}

export async function deleteSerial(serial) {
  const s = norm(serial);
  const { error } = await supabase.from('inv_serials').delete().eq('serial', s);
  if (error) throw error;
  // ledger rows are kept for audit
}

// Shipped quantity per product for an order (any shipment status) — drives
// remaining/split logic on POs
export function shippedByProduct(order, shipments) {
  const map = {};
  shipments.filter(sh => sh.order_id === order.id && sh.status !== 'cancelled').forEach(sh => {
    (sh.lines || []).forEach(l => { map[l.product_name] = (map[l.product_name] || 0) + l.qty; });
  });
  return map;
}

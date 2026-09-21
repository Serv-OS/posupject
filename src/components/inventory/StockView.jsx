import { useEffect, useState, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import { Boxes, Search, X, Undo2, Send, Pencil, Trash2, PoundSterling } from 'lucide-react';
import { CONDITIONS, recallToServicing, resolveServicing, dispatchRmaTl, thresholdFor, fmtGBP, csvExport, norm, setProductCost, renameSerial, deleteSerial } from '../../lib/inventoryOps';
import { toDayISO } from '../../lib/day';

const input = "px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper placeholder-dim focus:outline-none focus:border-ember";
const STATUS_BADGE = {
  in_stock: 'bg-emerald-100 text-emerald-700', staged: 'bg-blue-100 text-blue-700',
  in_transit: 'bg-amber-100 text-amber-700', deployed: 'bg-purple-100 text-purple-700',
  servicing: 'bg-orange-100 text-orange-700', rma: 'bg-red-100 text-red-700',
  total_loss: 'bg-red-200 text-red-800', written_off: 'bg-slate-200 text-slate-500',
};
const condLabel = (c) => (CONDITIONS.find(([k]) => k === c)?.[1]) || c || 'Good';

export default function StockView({ profile, onNavigate }) {
  const [tab, setTab] = useState('holding');
  const [serialRows, setSerialRows] = useState([]);
  const [movements, setMovements] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [thresholds, setThresholds] = useState([]);
  const [products, setProducts] = useState([]);
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState('all');
  const [lookup, setLookup] = useState(null); // serial row + history
  const [histType, setHistType] = useState('all');
  const [histFrom, setHistFrom] = useState('');
  const [histTo, setHistTo] = useState('');
  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  useEffect(() => { load(); }, []);
  const load = async () => {
    const [s, w, t, p, m] = await Promise.all([
      supabase.from('inv_serials').select('*, company:companies(name), location:locations(name), warehouse:inv_warehouses(name)').order('updated_at', { ascending: false }),
      supabase.from('inv_warehouses').select('*'),
      supabase.from('inv_thresholds').select('*'),
      supabase.from('products').select('id, name, default_threshold').order('name'),
      supabase.from('inv_movements').select('*').order('occurred_at', { ascending: false }).limit(500),
    ]);
    setSerialRows(s.data || []); setWarehouses(w.data || []); setThresholds(t.data || []);
    setProducts(p.data || []); setMovements(m.data || []);
  };

  const cats = useMemo(() => [...new Set(serialRows.map(r => r.category).filter(Boolean))].sort(), [serialRows]);

  const filterRows = (rows) => rows.filter(r => {
    if (catFilter !== 'all' && r.category !== catFilter) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return [r.serial, r.product_name, r.customer_name, r.company?.name, r.location?.name, r.po_number]
      .some(v => (v || '').toLowerCase().includes(q));
  });

  const holding = filterRows(serialRows.filter(r => ['in_stock', 'staged', 'in_transit'].includes(r.status)));
  const deployed = filterRows(serialRows.filter(r => r.status === 'deployed'));
  const servicing = filterRows(serialRows.filter(r => r.status === 'servicing' || (r.status === 'in_stock' && r.condition === 'needs-testing')));
  const rmaRows = filterRows(serialRows.filter(r => ['rma', 'total_loss'].includes(r.status)));
  const writtenOff = filterRows(serialRows.filter(r => r.status === 'written_off'));

  // stock by product (with thresholds) for the holding summary
  const byProduct = useMemo(() => {
    const map = {};
    serialRows.filter(r => r.status === 'in_stock').forEach(r => {
      const k = `${r.product_name}||${r.warehouse_id || ''}`;
      if (!map[k]) map[k] = { product: r.product_name, warehouse_id: r.warehouse_id, warehouse: r.warehouse?.name || '—', n: 0 };
      map[k].n++;
    });
    return Object.values(map).map(v => ({ ...v, threshold: thresholdFor(thresholds, products, v.product, v.warehouse_id) }))
      .sort((a, b) => a.product.localeCompare(b.product));
  }, [serialRows, thresholds, products]);

  const openLookup = async (serial) => {
    const s = norm(serial);
    const row = serialRows.find(r => r.serial === s);
    const { data: hist } = await supabase.from('inv_movements').select('*').contains('serials', [s]).order('occurred_at', { ascending: false });
    setLookup({ row: row || { serial: s, status: 'unknown' }, history: hist || [] });
  };

  const setThreshold = async (productName, warehouseId, value) => {
    await supabase.from('inv_thresholds').upsert(
      { product_name: productName, warehouse_id: warehouseId, threshold: Number(value) || 0 },
      { onConflict: 'product_name,warehouse_id' });
    load();
  };

  const doRecall = async (r) => {
    const wh = warehouses[0]?.id;
    if (!confirm(`Recall ${r.serial} from ${r.location?.name || r.company?.name || r.customer_name || 'site'} for servicing?`)) return;
    try { await recallToServicing({ serial: r.serial, warehouse: wh, byName: profile.display_name || profile.email, actorId: profile.id }); load(); }
    catch (e) { alert(e.message); }
  };
  const doResolve = async (r, outcome) => {
    const notes = outcome === 'pass' ? (prompt('Test notes (optional):') ?? '') : (prompt('Fault notes (optional):') ?? '');
    try { await resolveServicing({ serial: r.serial, outcome, warehouse: r.warehouse_id || warehouses[0]?.id, testedBy: profile.display_name || profile.email, notes }); load(); }
    catch (e) { alert(e.message); }
  };
  const doSetCost = async (r) => {
    const v = prompt(`Unit cost for ALL "${r.product_name}" serials (current ${r.cost ?? '—'}):`);
    if (v === null) return;
    await setProductCost(r.product_name, v === '' ? null : Number(v));
    load();
  };
  const doRename = async (r) => {
    const v = prompt(`Rename serial ${r.serial} to:`, r.serial);
    if (!v || norm(v) === r.serial) return;
    try { await renameSerial(r.serial, v); load(); } catch (e) { alert(e.message); }
  };
  const doDelete = async (r) => {
    if (!confirm(`Delete serial ${r.serial} from the system?\n\nMovement history is kept for audit, but the unit leaves stock entirely.`)) return;
    try { await deleteSerial(r.serial); load(); } catch (e) { alert(e.message); }
  };
  const doRmaDispatch = async (r) => {
    const type = r.status === 'total_loss' ? 'tl' : 'rma';
    if (!confirm(`Dispatch ${r.serial} back to ${r.supplier_name || 'supplier'} (${type.toUpperCase()})?`)) return;
    try { await dispatchRmaTl({ serial: r.serial, type, byName: profile.display_name || profile.email, actorId: profile.id }); load(); }
    catch (e) { alert(e.message); }
  };

  const exportCsv = () => {
    const rows = (tab === 'holding' ? holding : tab === 'deployed' ? deployed : tab === 'service' ? [...servicing, ...rmaRows, ...writtenOff] : []).map(r => ({
      serial: r.serial, product: r.product_name, category: r.category || '', status: r.status,
      warehouse: r.warehouse?.name || '', customer: r.location?.name || r.company?.name || r.customer_name || '',
      condition: r.condition || '', used: r.used ? 'yes' : '', cost: r.cost ?? '', po: r.po_number || '',
    }));
    csvExport(rows, `stock-${tab}-${toDayISO()}.csv`);
  };

  const TABS = [['holding', `Holding (${holding.length})`], ['deployed', `Deployed (${deployed.length})`],
    ['service', `Servicing & RMA (${servicing.length + rmaRows.length})`], ['history', 'History']];

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-bdr flex items-center gap-3 flex-wrap">
        <Boxes size={20} className="text-ember" />
        <div className="text-xl font-bold text-paper mr-2">Stock</div>
        <div className="flex gap-0.5 bg-card rounded-xl p-0.5">
          {TABS.map(([k, lbl]) => (
            <button key={k} onClick={() => setTab(k)} className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${tab === k ? 'bg-ember text-white' : 'text-muted'}`}>{lbl}</button>
          ))}
        </div>
        <div className="relative ml-auto">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-dim" />
          <input className={input + ' pl-8 w-64'} value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search serial, product, customer…" onKeyDown={e => { if (e.key === 'Enter' && search.trim()) openLookup(search); }} />
        </div>
        <select className={input} value={catFilter} onChange={e => setCatFilter(e.target.value)}>
          <option value="all">All categories</option>
          {cats.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <button onClick={exportCsv} className="btn-ghost px-3 py-2 rounded-xl text-xs">CSV</button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-[1300px] mx-auto space-y-5">

          {tab === 'holding' && (
            <>
              {/* Stock counts per product × warehouse with editable thresholds */}
              <div className="glass-card rounded-2xl overflow-hidden">
                <div className="px-5 py-3 border-b border-bdr text-[13px] font-bold text-paper">Stock levels</div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-0 divide-y md:divide-y-0 divide-bdr">
                  {byProduct.map(v => (
                    <div key={v.product + v.warehouse_id} className={`px-5 py-3 flex items-center gap-3 ${v.n <= v.threshold ? 'bg-red-500/5' : ''}`}>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-paper truncate">{v.product}</div>
                        <div className="text-[11px] text-dim">{v.warehouse}</div>
                      </div>
                      <div className={`text-xl font-bold tabular-nums ${v.n <= v.threshold ? 'text-red-600' : 'text-paper'}`}>{v.n}</div>
                      {canWrite && <input className="w-14 px-2 py-1 bg-card border border-bdr rounded-lg text-xs text-right text-muted"
                        title="Low-stock threshold" defaultValue={v.threshold}
                        onBlur={e => Number(e.target.value) !== v.threshold && setThreshold(v.product, v.warehouse_id, e.target.value)} />}
                    </div>
                  ))}
                  {byProduct.length === 0 && <div className="px-5 py-6 text-sm text-dim italic col-span-3 text-center">Nothing in stock yet — receive goods via Stock In.</div>}
                </div>
              </div>
              <SerialTable rows={holding} onLookup={openLookup} cols={['warehouse', 'condition', 'cost', 'po']}
                actions={canWrite ? [
                  (r) => <button key="c" onClick={() => doSetCost(r)} title="Set cost (all of this product)" className="text-dim hover:text-ember"><PoundSterling size={13} /></button>,
                  (r) => <button key="e" onClick={() => doRename(r)} title="Rename serial" className="text-dim hover:text-paper"><Pencil size={13} /></button>,
                  (r) => <button key="d" onClick={() => doDelete(r)} title="Delete serial" className="text-dim hover:text-red-600"><Trash2 size={13} /></button>,
                ] : []} />
            </>
          )}

          {tab === 'deployed' && (
            <SerialTable rows={deployed} onLookup={openLookup} cols={['customer', 'deployed', 'ref', 'cost']}
              onNavigate={onNavigate}
              actions={canWrite ? [(r) => <button key="r" onClick={() => doRecall(r)} title="Recall for servicing" className="text-dim hover:text-ember"><Undo2 size={14} /></button>] : []} />
          )}

          {tab === 'service' && (
            <>
              <Section title={`Servicing queue (${servicing.length})`}>
                <SerialTable rows={servicing} onLookup={openLookup} cols={['warehouse', 'condition', 'customer']}
                  actions={canWrite ? [
                    (r) => <button key="p" onClick={() => doResolve(r, 'pass')} className="px-2 py-1 rounded-lg bg-emerald-500/15 text-emerald-700 text-[11px] font-semibold">Pass → stock</button>,
                    (r) => <button key="f" onClick={() => doResolve(r, 'rma')} className="px-2 py-1 rounded-lg bg-red-500/10 text-red-600 text-[11px] font-semibold">Fail → RMA</button>,
                    (r) => <button key="t" onClick={() => doResolve(r, 'total_loss')} className="px-2 py-1 rounded-lg bg-red-500/15 text-red-700 text-[11px] font-semibold">Total loss</button>,
                  ] : []} />
              </Section>
              <Section title={`RMA & total loss — awaiting return (${rmaRows.length})`}>
                <SerialTable rows={rmaRows} onLookup={openLookup} cols={['condition', 'supplier', 'cost']}
                  actions={canWrite ? [(r) => <button key="d" onClick={() => doRmaDispatch(r)} className="px-2 py-1 rounded-lg bg-card text-muted hover:text-paper text-[11px] font-semibold flex items-center gap-1"><Send size={11} /> Dispatch to supplier</button>] : []} />
              </Section>
              <Section title={`RMA / TL dispatched (${writtenOff.length})`}>
                <SerialTable rows={writtenOff} onLookup={openLookup} cols={['supplier', 'condition', 'cost']} />
              </Section>
            </>
          )}

          {tab === 'history' && (() => {
            const histRows = movements.filter(m => {
              if (histType !== 'all' && m.type !== histType) return false;
              if (histFrom && m.occurred_at.slice(0, 10) < histFrom) return false;
              if (histTo && m.occurred_at.slice(0, 10) > histTo) return false;
              if (!search) return true;
              return m.serials.some(x => x.includes(norm(search))) || m.product_name.toLowerCase().includes(search.toLowerCase()) || (m.customer_name || '').toLowerCase().includes(search.toLowerCase());
            });
            return (
            <div className="glass-card rounded-2xl overflow-hidden">
              <div className="px-5 py-3 border-b border-bdr flex items-center gap-2 flex-wrap">
                <select className={input} value={histType} onChange={e => setHistType(e.target.value)}>
                  <option value="all">All types</option>
                  {['in', 'out', 'recall', 'rma_out', 'writeoff'].map(t => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
                </select>
                <input type="date" className={input} value={histFrom} onChange={e => setHistFrom(e.target.value)} />
                <span className="text-dim text-xs">to</span>
                <input type="date" className={input} value={histTo} onChange={e => setHistTo(e.target.value)} />
                <button onClick={() => csvExport(histRows.map(m => ({
                  date: m.occurred_at, type: m.type, product: m.product_name, qty: m.qty,
                  serials: m.serials.join(' '), customer: m.customer_name || '', supplier: m.supplier_name || '', po: m.po_number || '', by: m.by_name || '',
                })), 'movement-history.csv')} className="btn-ghost px-3 py-1.5 rounded-xl text-xs ml-auto">CSV ({histRows.length})</button>
              </div>
              <div className="divide-y divide-bdr">
                {histRows.map(m => (
                  <div key={m.id} className="px-5 py-2.5 flex items-center gap-3 text-sm">
                    <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded shrink-0 ${
                      m.type === 'in' ? 'bg-emerald-100 text-emerald-700' : m.type === 'out' ? 'bg-purple-100 text-purple-700'
                      : m.type === 'recall' ? 'bg-orange-100 text-orange-700' : m.type === 'rma_out' ? 'bg-red-100 text-red-700' : 'bg-slate-200 text-slate-600'}`}>{m.type.replace('_', ' ')}</span>
                    <div className="flex-1 min-w-0">
                      <span className="text-paper">{m.product_name}</span>
                      <span className="text-muted"> × {m.qty}</span>
                      {m.customer_name || m.supplier_name ? <span className="text-dim"> · {m.customer_name || m.supplier_name}</span> : null}
                      {m.po_number && <span className="text-dim"> · {m.po_number}</span>}
                      <div className="text-[11px] text-dim font-mono truncate">{m.serials.slice(0, 6).join(' ')}{m.serials.length > 6 ? ` +${m.serials.length - 6}` : ''}</div>
                    </div>
                    <span className="text-xs text-dim shrink-0">{m.by_name || ''}</span>
                    <span className="text-xs text-dim shrink-0">{new Date(m.occurred_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                ))}
                {histRows.length === 0 && <div className="px-5 py-8 text-center text-dim text-sm italic">No movements match.</div>}
              </div>
            </div>
            );
          })()}
        </div>
      </div>

      {/* Serial lookup drawer */}
      {lookup && (
        <div className="fixed inset-0 z-50 flex justify-end" onClick={() => setLookup(null)}>
          <div className="absolute inset-0 bg-black/40" />
          <div className="relative w-full max-w-md h-full glass-card border-l border-bdr overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-bdr flex items-center gap-2 sticky top-0 glass-card">
              <span className="font-mono font-bold text-paper">{lookup.row.serial}</span>
              <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${STATUS_BADGE[lookup.row.status] || 'bg-slate-200 text-slate-600'}`}>{(lookup.row.status || '').replace('_', ' ')}</span>
              <button onClick={() => setLookup(null)} className="ml-auto text-muted hover:text-paper"><X size={18} /></button>
            </div>
            <div className="p-5 space-y-4">
              {lookup.row.product_name && (
                <div className="glass-inner rounded-xl p-3 text-sm space-y-1">
                  <div className="text-paper font-medium">{lookup.row.product_name}</div>
                  <div className="text-xs text-muted">{lookup.row.category || ''}{lookup.row.used ? ' · used' : ''}{lookup.row.condition ? ` · ${condLabel(lookup.row.condition)}` : ''}</div>
                  {(lookup.row.location?.name || lookup.row.company?.name || lookup.row.customer_name) && (
                    <div className="text-xs text-muted">At: <button className="text-ember" onClick={() => lookup.row.location_id ? onNavigate?.('location', lookup.row.location_id) : lookup.row.company_id && onNavigate?.('company', lookup.row.company_id)}>
                      {lookup.row.location?.name || lookup.row.company?.name || lookup.row.customer_name}</button></div>
                  )}
                  <div className="text-xs text-dim">{lookup.row.po_number ? `PO ${lookup.row.po_number} · ` : ''}{lookup.row.cost != null ? fmtGBP(lookup.row.cost) : 'No cost'}</div>
                </div>
              )}
              <div className="text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim">Movement history</div>
              <div className="space-y-2">
                {lookup.history.map(m => (
                  <div key={m.id} className="text-xs flex items-center gap-2 py-1.5 border-b border-bdr/40 last:border-0">
                    <span className="font-bold uppercase text-[9px] text-muted w-14">{m.type.replace('_', ' ')}</span>
                    <span className="text-paper flex-1">{m.customer_name || m.supplier_name || m.warehouse_name || m.product_name}</span>
                    <span className="text-dim">{new Date(m.occurred_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })}</span>
                  </div>
                ))}
                {lookup.history.length === 0 && <div className="text-xs text-dim italic">No recorded movements.</div>}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }) {
  return <div><div className="text-[11px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-2">{title}</div>{children}</div>;
}

function SerialTable({ rows, cols, onLookup, actions = [], onNavigate }) {
  return (
    <div className="glass-card rounded-2xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[700px]">
          <thead><tr className="text-[10px] font-mono font-bold uppercase tracking-[0.12em] text-dim border-b border-bdr">
            <th className="text-left px-5 py-2 font-bold">Serial</th>
            <th className="text-left px-3 py-2 font-bold">Product</th>
            {cols.includes('warehouse') && <th className="text-left px-3 py-2 font-bold">Warehouse</th>}
            {cols.includes('customer') && <th className="text-left px-3 py-2 font-bold">Customer</th>}
            {cols.includes('supplier') && <th className="text-left px-3 py-2 font-bold">Supplier</th>}
            {cols.includes('deployed') && <th className="text-left px-3 py-2 font-bold">Deployed</th>}
            {cols.includes('ref') && <th className="text-left px-3 py-2 font-bold">Ref</th>}
            {cols.includes('condition') && <th className="text-left px-3 py-2 font-bold">Condition</th>}
            {cols.includes('cost') && <th className="text-right px-3 py-2 font-bold">Cost</th>}
            {cols.includes('po') && <th className="text-left px-3 py-2 font-bold">PO</th>}
            {actions.length > 0 && <th className="px-3 py-2" />}
          </tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.serial} className="border-b border-bdr/50 hover:bg-card/40">
                <td className="px-5 py-2">
                  <button onClick={() => onLookup(r.serial)} className="font-mono text-xs text-paper hover:text-ember">{r.serial}</button>
                  {r.status !== 'in_stock' && <span className={`ml-1.5 text-[8px] font-bold uppercase px-1 py-0.5 rounded ${STATUS_BADGE[r.status]}`}>{r.status.replace('_', ' ')}</span>}
                  {r.used && <span className="ml-1 text-[8px] font-bold uppercase px-1 py-0.5 rounded bg-slate-200 text-slate-600">used</span>}
                </td>
                <td className="px-3 py-2 text-paper">{r.product_name}<div className="text-[10px] text-dim">{r.category || ''}</div></td>
                {cols.includes('warehouse') && <td className="px-3 py-2 text-muted">{r.warehouse?.name || '—'}</td>}
                {cols.includes('customer') && <td className="px-3 py-2">
                  <button onClick={() => r.location_id ? onNavigate?.('location', r.location_id) : r.company_id && onNavigate?.('company', r.company_id)}
                    className="text-muted hover:text-ember text-left">{r.location?.name || r.company?.name || r.customer_name || '—'}</button>
                </td>}
                {cols.includes('supplier') && <td className="px-3 py-2 text-muted">{r.supplier_name || '—'}</td>}
                {cols.includes('deployed') && <td className="px-3 py-2 text-muted">{r.deployed_at ? new Date(r.deployed_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }) : '—'}</td>}
                {cols.includes('ref') && <td className="px-3 py-2 text-muted">{r.dispatch_ref || '—'}</td>}
                {cols.includes('condition') && <td className="px-3 py-2"><span className="text-xs text-muted">{condLabel(r.condition)}</span></td>}
                {cols.includes('cost') && <td className="px-3 py-2 text-right tabular-nums text-muted">{r.cost != null ? fmtGBP(r.cost) : '—'}</td>}
                {cols.includes('po') && <td className="px-3 py-2 text-muted text-xs">{r.po_number || '—'}</td>}
                {actions.length > 0 && <td className="px-3 py-2"><div className="flex gap-1.5 justify-end">{actions.map(fn => fn(r))}</div></td>}
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={9} className="px-5 py-6 text-center text-dim text-sm italic">Nothing here.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

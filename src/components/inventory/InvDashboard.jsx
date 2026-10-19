import { useEffect, useState, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import { Warehouse, AlertTriangle } from 'lucide-react';
import { thresholdFor, fmtGBP, movementWhere, moveTypeLabel, MOVEMENT_SELECT } from '../../lib/inventoryOps';

export default function InvDashboard({ profile, onNavigate }) {
  const [serials, setSerials] = useState([]);
  const [movements, setMovements] = useState([]);
  const [thresholds, setThresholds] = useState([]);
  const [products, setProducts] = useState([]);
  const [shipments, setShipments] = useState([]);

  useEffect(() => {
    (async () => {
      const [s, m, t, p, sh] = await Promise.all([
        supabase.from('inv_serials').select('serial, product_name, status, warehouse_id, cost, warehouse:inv_warehouses(name)'),
        supabase.from('inv_movements').select(MOVEMENT_SELECT).order('occurred_at', { ascending: false }).limit(12),
        supabase.from('inv_thresholds').select('*'),
        supabase.from('products').select('id, name, default_threshold'),
        supabase.from('inv_shipments').select('id, status').eq('status', 'in_transit'),
      ]);
      setSerials(s.data || []); setMovements(m.data || []); setThresholds(t.data || []);
      setProducts(p.data || []); setShipments(sh.data || []);
    })();
  }, []);

  const inStock = serials.filter(r => r.status === 'in_stock');
  const deployed = serials.filter(r => r.status === 'deployed');
  const transit = serials.filter(r => r.status === 'in_transit');
  const stockValue = inStock.reduce((s, r) => s + (Number(r.cost) || 0), 0);

  const lowStock = useMemo(() => {
    const map = {};
    inStock.forEach(r => {
      const k = `${r.product_name}||${r.warehouse_id || ''}`;
      if (!map[k]) map[k] = { product: r.product_name, warehouse_id: r.warehouse_id, warehouse: r.warehouse?.name || '—', n: 0 };
      map[k].n++;
    });
    return Object.values(map).map(v => ({ ...v, threshold: thresholdFor(thresholds, products, v.product, v.warehouse_id) }))
      .filter(v => v.n <= v.threshold).sort((a, b) => a.n - b.n);
  }, [serials, thresholds, products]);

  const byProductRows = useMemo(() => {
    const map = {};
    serials.forEach(r => {
      if (!map[r.product_name]) map[r.product_name] = { product: r.product_name, in_stock: 0, in_transit: 0, deployed: 0, costSum: 0, costN: 0, value: 0 };
      const m = map[r.product_name];
      if (r.status === 'in_stock' || r.status === 'staged') { m.in_stock++; m.value += Number(r.cost) || 0; }
      else if (r.status === 'in_transit') m.in_transit++;
      else if (r.status === 'deployed') m.deployed++;
      if (r.cost != null) { m.costSum += Number(r.cost); m.costN++; }
    });
    const prodMap = new Map(products.map(pp => [pp.name, pp]));
    return Object.values(map).map(m => {
      const t = thresholdFor(thresholds, products, m.product, null) ?? prodMap.get(m.product)?.default_threshold ?? 3;
      return { ...m, avgCost: m.costN ? m.costSum / m.costN : null, low: m.in_stock <= t };
    }).sort((a, b) => a.product.localeCompare(b.product));
  }, [serials, thresholds, products]);

  const byWarehouse = useMemo(() => {
    const map = {};
    inStock.forEach(r => { const k = r.warehouse?.name || '—'; map[k] = (map[k] || 0) + 1; });
    return Object.entries(map).sort((a, b) => b[1] - a[1]);
  }, [serials]);

  const Stat = ({ label, value, sub, onClick }) => (
    <button onClick={onClick} className="glass-card rounded-2xl p-4 text-left hover:border-ember/30 transition">
      <div className="text-[10px] font-mono font-bold uppercase tracking-[0.14em] text-dim mb-1">{label}</div>
      <div className="text-2xl font-bold text-paper tabular-nums">{value}</div>
      {sub && <div className="text-[11px] text-dim mt-0.5">{sub}</div>}
    </button>
  );

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-5 border-b border-bdr flex items-center gap-2.5">
        <Warehouse size={20} className="text-ember" />
        <div>
          <div className="text-xl font-bold text-paper">Inventory</div>
          <div className="text-xs text-muted">Hardware stock at a glance</div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-[1200px] mx-auto space-y-5">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Stat label="In stock" value={inStock.length} sub={`${fmtGBP(stockValue)} value`} onClick={() => onNavigate?.('view', 'inv_stock')} />
            <Stat label="Deployed" value={deployed.length} sub="at customer sites" onClick={() => onNavigate?.('view', 'inv_stock')} />
            <Stat label="In transit" value={transit.length} sub={`${shipments.length} open shipment${shipments.length !== 1 ? 's' : ''}`} onClick={() => onNavigate?.('view', 'inv_purchasing')} />
            <Stat label="Low stock alerts" value={lowStock.length} sub={lowStock.length ? 'needs reordering' : 'all healthy'} onClick={() => onNavigate?.('view', 'inv_stock')} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div className="glass-card rounded-2xl overflow-hidden">
              <div className="px-5 py-3 border-b border-bdr flex items-center gap-2">
                <AlertTriangle size={14} className="text-red-500" />
                <h3 className="text-[13px] font-bold text-paper">Low stock</h3>
              </div>
              <div className="divide-y divide-bdr">
                {lowStock.map(v => (
                  <div key={v.product + v.warehouse_id} className="px-5 py-2.5 flex items-center gap-3 text-sm">
                    <div className="flex-1 min-w-0"><span className="text-paper">{v.product}</span><span className="text-[11px] text-dim block">{v.warehouse}</span></div>
                    <span className="text-red-600 font-bold tabular-nums">{v.n}</span>
                    <span className="text-[11px] text-dim">/ min {v.threshold}</span>
                  </div>
                ))}
                {lowStock.length === 0 && <div className="px-5 py-6 text-center text-dim text-sm italic">Nothing below threshold.</div>}
              </div>
            </div>

            <div className="glass-card rounded-2xl overflow-hidden">
              <div className="px-5 py-3 border-b border-bdr"><h3 className="text-[13px] font-bold text-paper">Stock by warehouse</h3></div>
              <div className="divide-y divide-bdr">
                {byWarehouse.map(([name, n]) => (
                  <div key={name} className="px-5 py-2.5 flex items-center text-sm"><span className="text-paper flex-1">{name}</span><span className="font-bold text-paper tabular-nums">{n}</span></div>
                ))}
                {byWarehouse.length === 0 && <div className="px-5 py-6 text-center text-dim text-sm italic">No stock yet.</div>}
              </div>
            </div>
          </div>

          {/* Stock by product (in stock + transit + avg/landed value) */}
          <div className="glass-card rounded-2xl overflow-hidden">
            <div className="px-5 py-3 border-b border-bdr"><h3 className="text-[13px] font-bold text-paper">Stock by product</h3></div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[600px]">
                <thead><tr className="text-[10px] font-mono font-bold uppercase tracking-[0.12em] text-dim border-b border-bdr">
                  <th className="text-left px-5 py-2 font-bold">Product</th>
                  <th className="text-right px-3 py-2 font-bold">In stock</th>
                  <th className="text-right px-3 py-2 font-bold">In transit</th>
                  <th className="text-right px-3 py-2 font-bold">Deployed</th>
                  <th className="text-right px-3 py-2 font-bold">Avg cost</th>
                  <th className="text-right px-5 py-2 font-bold">Stock value</th>
                </tr></thead>
                <tbody>
                  {byProductRows.map(r => (
                    <tr key={r.product} className={`border-b border-bdr/50 ${r.low ? 'bg-red-500/5' : ''}`}>
                      <td className="px-5 py-2 text-paper">{r.product}{r.low && <span className="ml-1.5 text-[8px] font-bold uppercase px-1 py-0.5 rounded bg-red-100 text-red-700">low</span>}</td>
                      <td className={`px-3 py-2 text-right tabular-nums font-semibold ${r.low ? 'text-red-600' : 'text-paper'}`}>{r.in_stock}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted">{r.in_transit || '—'}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted">{r.deployed || '—'}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted">{r.avgCost != null ? fmtGBP(r.avgCost) : '—'}</td>
                      <td className="px-5 py-2 text-right tabular-nums text-paper">{fmtGBP(r.value)}</td>
                    </tr>
                  ))}
                  {byProductRows.length === 0 && <tr><td colSpan={6} className="px-5 py-6 text-center text-dim italic text-sm">No stock yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          <div className="glass-card rounded-2xl overflow-hidden">
            <div className="px-5 py-3 border-b border-bdr"><h3 className="text-[13px] font-bold text-paper">Recent movements</h3></div>
            <div className="divide-y divide-bdr">
              {movements.map(m => (
                <div key={m.id} className="px-5 py-2.5 flex items-center gap-3 text-sm">
                  <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded shrink-0 ${m.type === 'in' ? 'bg-emerald-100 text-emerald-700' : m.type === 'out' ? 'bg-purple-100 text-purple-700' : m.type === 'transfer' ? 'bg-sky-100 text-sky-700' : 'bg-orange-100 text-orange-700'}`}>{moveTypeLabel(m.type)}</span>
                  <span className="text-paper flex-1 min-w-0 truncate">{m.product_name} × {m.qty}{movementWhere(m) ? ` ${m.type === 'in' || m.type === 'rma_out' ? '←' : '→'} ${movementWhere(m)}` : ''}</span>
                  <span className="text-xs text-dim shrink-0">{new Date(m.occurred_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                </div>
              ))}
              {movements.length === 0 && <div className="px-5 py-6 text-center text-dim text-sm italic">No movements yet — start with Stock In or a Purchase Order.</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

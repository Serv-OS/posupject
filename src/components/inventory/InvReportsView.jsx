import { useEffect, useState, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import { BarChart3 } from 'lucide-react';
import { fmtGBP, csvExport, whereLabel } from '../../lib/inventoryOps';

const input = "px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper focus:outline-none focus:border-ember";
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export default function InvReportsView() {
  const [serials, setSerials] = useState([]);
  const [movements, setMovements] = useState([]);
  const [orders, setOrders] = useState([]);
  const monthStart = () => { const d = new Date(); d.setDate(1); return iso(d); };
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(iso(new Date()));

  useEffect(() => {
    (async () => {
      const [s, m, o] = await Promise.all([
        supabase.from('inv_serials').select('serial, product_name, category, status, cost, customer_name, deployed_at, company:companies(name), location:locations(name), warehouse:inv_warehouses(name)'),
        supabase.from('inv_movements').select('*').order('occurred_at', { ascending: false }),
        supabase.from('inv_orders').select('*'),
      ]);
      setSerials(s.data || []); setMovements(m.data || []); setOrders(o.data || []);
    })();
  }, []);

  const inRange = (ts) => ts && ts.slice(0, 10) >= from && ts.slice(0, 10) <= to;
  const rangeMv = movements.filter(m => inRange(m.occurred_at));

  const summary = useMemo(() => ({
    unitsIn: rangeMv.filter(m => m.type === 'in').reduce((s, m) => s + m.qty, 0),
    unitsOut: rangeMv.filter(m => m.type === 'out').reduce((s, m) => s + m.qty, 0),
    writeoffs: rangeMv.filter(m => ['writeoff', 'rma_out'].includes(m.type)).reduce((s, m) => s + m.qty, 0),
    stockValue: serials.filter(r => r.status === 'in_stock').reduce((s, r) => s + (Number(r.cost) || 0), 0),
    deployedValue: serials.filter(r => r.status === 'deployed').reduce((s, r) => s + (Number(r.cost) || 0), 0),
    poSpend: orders.filter(o => inRange(o.created_at) && o.status !== 'cancelled').reduce((s, o) => s + Number(o.total_with_tax || 0), 0),
    taxPaid: orders.filter(o => inRange(o.created_at) && o.status !== 'cancelled').reduce((s, o) => s + Number(o.tax_amount || 0), 0),
  }), [rangeMv, serials, orders, from, to]);

  const group = (rows, key) => {
    const map = {};
    rows.forEach(r => { const k = key(r) || '—'; map[k] = (map[k] || 0) + 1; });
    return Object.entries(map).sort((a, b) => b[1] - a[1]);
  };
  const byCategory = group(serials.filter(r => r.status === 'in_stock'), r => r.category);
  const byProduct = group(serials.filter(r => r.status === 'in_stock'), r => r.product_name);
  // Company and site together: two sites of one company are two bars, and kit
  // with no site still names its company.
  const deployedByCustomer = group(serials.filter(r => r.status === 'deployed'), r => whereLabel(r));
  const byWarehouse = group(serials.filter(r => r.status === 'in_stock'), r => r.warehouse?.name);

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-bdr flex items-center gap-3 flex-wrap">
        <BarChart3 size={20} className="text-ember" />
        <div className="text-xl font-bold text-paper mr-2">Inventory Reports</div>
        <input type="date" className={input} value={from} onChange={e => setFrom(e.target.value)} />
        <span className="text-dim text-xs">to</span>
        <input type="date" className={input} value={to} onChange={e => setTo(e.target.value)} />
        <button onClick={() => csvExport(rangeMv.map(m => ({
          date: m.occurred_at, type: m.type, product: m.product_name, qty: m.qty,
          serials: m.serials.join(' '), customer: m.customer_name || '', supplier: m.supplier_name || '', po: m.po_number || '', by: m.by_name || '',
        })), `inventory-movements-${from}-${to}.csv`)} className="btn-ghost px-3 py-2 rounded-xl text-xs ml-auto">Export movements CSV</button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-[1200px] mx-auto space-y-5">
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
            <Stat label="Units in" value={summary.unitsIn} />
            <Stat label="Units out" value={summary.unitsOut} />
            <Stat label="Write-offs / RMA" value={summary.writeoffs} />
            <Stat label="PO spend" value={fmtGBP(summary.poSpend)} />
            <Stat label="Tax paid" value={fmtGBP(summary.taxPaid)} />
            <Stat label="Stock value" value={fmtGBP(summary.stockValue)} />
            <Stat label="Deployed value" value={fmtGBP(summary.deployedValue)} />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <Bars title="Stock by category" rows={byCategory} />
            <Bars title="Stock by product" rows={byProduct} />
            <Bars title="Deployed by customer" rows={deployedByCustomer} />
            <Bars title="Holding by warehouse" rows={byWarehouse} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="glass-card rounded-2xl p-3.5">
      <div className="text-[9px] font-mono font-bold uppercase tracking-[0.12em] text-dim mb-1">{label}</div>
      <div className="text-lg font-bold text-paper tabular-nums">{value}</div>
    </div>
  );
}

function Bars({ title, rows }) {
  const max = Math.max(1, ...rows.map(([, n]) => n));
  return (
    <div className="glass-card rounded-2xl overflow-hidden">
      <div className="px-5 py-3 border-b border-bdr"><h3 className="text-[13px] font-bold text-paper">{title}</h3></div>
      <div className="p-4 space-y-1.5">
        {rows.slice(0, 12).map(([name, n]) => (
          <div key={name} className="flex items-center gap-2 text-xs">
            <span className="w-40 text-muted truncate" title={name}>{name}</span>
            <div className="flex-1 h-3.5 rounded bg-card overflow-hidden">
              <div className="h-full rounded bg-ember/60" style={{ width: `${(n / max) * 100}%` }} />
            </div>
            <span className="w-8 text-right tabular-nums text-paper">{n}</span>
          </div>
        ))}
        {rows.length === 0 && <div className="text-sm text-dim italic text-center py-4">No data.</div>}
      </div>
    </div>
  );
}

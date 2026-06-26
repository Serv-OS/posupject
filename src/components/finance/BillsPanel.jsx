import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { Wallet, Plus } from 'lucide-react';
import { gbp2 } from '../../lib/money.js';

const fmtD = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }) : '—';

// Effective display status: a to_pay/partially_paid bill past its due date shows as overdue.
export const billStatus = (b) => {
  if (['paid', 'void', 'draft'].includes(b.status)) return b.status;
  if (b.due_date && new Date(b.due_date) < new Date(new Date().toDateString())) return 'overdue';
  return b.status;
};
const BADGE = {
  draft: 'bg-slate-200 text-slate-600', to_pay: 'bg-amber-100 text-amber-700',
  partially_paid: 'bg-blue-100 text-blue-700', overdue: 'bg-red-100 text-red-700',
  paid: 'bg-emerald-100 text-emerald-700', void: 'bg-slate-100 text-slate-400',
};
const STATUS_LABEL = { draft: 'draft', to_pay: 'to pay', partially_paid: 'part-paid', overdue: 'overdue', paid: 'paid', void: 'void' };

export default function BillsPanel({ profile, onNavigate }) {
  const [bills, setBills] = useState([]);
  const [statusFilter, setStatusFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from('bills')
      .select('*, supplier:inv_suppliers(name), company:companies(name)')
      .order('created_at', { ascending: false });
    setBills(data || []); setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const newBill = async () => {
    const { data, error } = await supabase.from('bills').insert({
      status: 'draft', created_by: profile.id,
      due_date: new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10),
    }).select('id').single();
    if (error) { alert(error.message); return; }
    onNavigate?.('bill', data.id);
  };

  const supName = (b) => b.supplier?.name || b.company?.name || b.description || 'Untitled bill';
  const owed = (b) => Number(b.total || 0) - Number(b.amount_paid || 0);
  const toPay = bills.filter(b => ['to_pay', 'partially_paid'].includes(b.status));
  const outstanding = toPay.reduce((s, b) => s + owed(b), 0);
  const overdueList = bills.filter(b => billStatus(b) === 'overdue');
  const overdueSum = overdueList.reduce((s, b) => s + owed(b), 0);
  const mStart = new Date(); mStart.setDate(1);
  const paidThisMonth = bills.filter(b => b.status === 'paid' && b.paid_at && new Date(b.paid_at) >= mStart)
    .reduce((s, b) => s + Number(b.amount_paid ?? b.total ?? 0), 0);

  const filtered = statusFilter === 'all' ? bills : bills.filter(b => billStatus(b) === statusFilter);
  const input = "px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper focus:outline-none focus:border-ember";

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-5 border-b border-bdr flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2.5">
          <Wallet size={20} className="text-ember" />
          <div>
            <div className="text-xl font-bold text-paper">Bills</div>
            <div className="text-xs text-muted">Supplier costs — capture, track and pay</div>
          </div>
        </div>
        {canWrite && <button onClick={newBill} className="btn-glass px-4 py-2 rounded-xl text-sm font-semibold flex items-center gap-1.5"><Plus size={15} /> New bill</button>}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-[1100px] mx-auto space-y-5">
          <div className="grid grid-cols-3 gap-4">
            <Stat label="To pay" value={gbp2(outstanding)} sub={`${toPay.length} outstanding`} tone={toPay.length ? 'amber' : null} />
            <Stat label="Overdue" value={gbp2(overdueSum)} sub={`${overdueList.length} overdue`} tone={overdueList.length ? 'red' : null} />
            <Stat label="Paid this month" value={gbp2(paidThisMonth)} tone="emerald" />
          </div>

          <div className="glass-card rounded-2xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-bdr flex items-center gap-2">
              <h3 className="text-[13px] font-bold text-paper">All bills</h3>
              <span className="text-xs text-dim font-mono">({filtered.length})</span>
              <select className={input + ' ml-auto !py-1.5 text-xs'} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
                <option value="all">All statuses</option>
                {['draft', 'to_pay', 'partially_paid', 'overdue', 'paid', 'void'].map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
              </select>
            </div>
            <div className="divide-y divide-bdr">
              {loading ? <div className="p-6 text-center text-dim text-sm">Loading…</div>
                : filtered.length === 0 ? <div className="p-8 text-center text-dim text-sm italic">No bills yet — add your first supplier cost.</div>
                : filtered.map(b => {
                  const st = billStatus(b);
                  return (
                    <div key={b.id} onClick={() => onNavigate?.('bill', b.id)}
                      className="px-5 py-3 flex items-center gap-4 hover:bg-card/50 cursor-pointer">
                      <div className="font-mono text-xs text-dim w-20 shrink-0">BILL-{b.bill_number}</div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-paper font-medium truncate">{supName(b)}</div>
                        <div className="text-[10px] text-dim flex items-center gap-2">
                          {b.cost_context === 'deal' ? <span className="text-uv">deal cost</span> : <span>ongoing</span>}
                          {b.supplier_ref && <span>· ref {b.supplier_ref}</span>}
                        </div>
                      </div>
                      <div className="text-xs text-muted shrink-0 w-24 text-right">Due {fmtD(b.due_date)}</div>
                      <div className="text-sm font-semibold text-paper tabular-nums shrink-0 w-24 text-right">{gbp2(b.total)}</div>
                      <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-lg shrink-0 w-20 text-center ${BADGE[st]}`}>{STATUS_LABEL[st]}</span>
                    </div>
                  );
                })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, tone }) {
  const color = tone === 'red' ? 'text-red-600' : tone === 'emerald' ? 'text-emerald-600' : tone === 'amber' ? 'text-amber-600' : 'text-paper';
  return (
    <div className="glass-card rounded-2xl p-4">
      <div className="text-[10px] font-mono font-bold uppercase tracking-[0.14em] text-dim mb-1">{label}</div>
      <div className={`text-2xl font-bold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="text-[11px] text-dim mt-0.5">{sub}</div>}
    </div>
  );
}

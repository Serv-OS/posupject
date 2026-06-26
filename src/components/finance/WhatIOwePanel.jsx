import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { Banknote } from 'lucide-react';
import { gbp2 } from '../../lib/money.js';

const fmtD = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }) : '—';
const daysOverdue = (due) => due ? Math.floor((Date.now() - new Date(due + 'T00:00:00')) / 86400000) : 0;
const bucketOf = (b) => {
  const d = daysOverdue(b.due_date);
  if (d <= 0) return 'current';
  if (d <= 30) return 'd30';
  if (d <= 60) return 'd60';
  return 'd60p';
};
const BUCKETS = [['current', 'Not yet due'], ['d30', '1–30 days'], ['d60', '31–60 days'], ['d60p', '60+ days']];

export default function WhatIOwePanel({ profile, onNavigate }) {
  const [bills, setBills] = useState([]);
  const [sel, setSel] = useState({});
  const [ref, setRef] = useState('');
  const [loading, setLoading] = useState(true);
  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from('bills')
      .select('*, supplier:inv_suppliers(name), company:companies(name)')
      .in('status', ['to_pay', 'partially_paid']).order('due_date');
    setBills(data || []); setSel({}); setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const owed = (b) => Number(b.total || 0) - Number(b.amount_paid || 0);
  const total = bills.reduce((s, b) => s + owed(b), 0);
  const byBucket = (k) => bills.filter(b => bucketOf(b) === k);
  const supName = (b) => b.supplier?.name || b.company?.name || b.description || 'Untitled bill';

  const selectedIds = Object.keys(sel).filter(id => sel[id]);
  const selectedSum = bills.filter(b => sel[b.id]).reduce((s, b) => s + owed(b), 0);
  const toggle = (id) => setSel(s => ({ ...s, [id]: !s[id] }));

  const markPaid = async () => {
    if (!selectedIds.length) return;
    if (!confirm(`Mark ${selectedIds.length} bill(s) as paid (${gbp2(selectedSum)})${ref ? ` with reference "${ref}"` : ''}?`)) return;
    const nowIso = new Date().toISOString();
    for (const b of bills.filter(x => sel[x.id])) {
      await supabase.from('bills').update({
        status: 'paid', amount_paid: Number(b.total || 0), paid_at: nowIso,
        payment_reference: ref.trim() || b.payment_reference || null, updated_at: nowIso,
      }).eq('id', b.id);
    }
    setRef(''); load();
  };

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-5 border-b border-bdr flex items-center gap-2.5">
        <Banknote size={20} className="text-ember" />
        <div>
          <div className="text-xl font-bold text-paper">What I owe</div>
          <div className="text-xs text-muted">Outstanding supplier bills, by age</div>
        </div>
        <div className="ml-auto text-right">
          <div className="text-2xl font-bold tabular-nums text-paper">{gbp2(total)}</div>
          <div className="text-[11px] text-dim">{bills.length} outstanding</div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-3xl mx-auto space-y-5">
          {canWrite && selectedIds.length > 0 && (
            <div className="glass-card rounded-2xl p-3 flex items-center gap-3 flex-wrap sticky top-0 z-10">
              <span className="text-sm text-paper font-medium">{selectedIds.length} selected · {gbp2(selectedSum)}</span>
              <input value={ref} onChange={e => setRef(e.target.value)} placeholder="Payment reference (e.g. bank run 26/06)"
                className="flex-1 min-w-[180px] px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper" />
              <button onClick={markPaid} className="btn-glass px-4 py-2 rounded-xl text-sm font-semibold">Mark paid</button>
            </div>
          )}
          {loading ? <div className="p-6 text-center text-dim text-sm">Loading…</div>
            : bills.length === 0 ? <div className="glass-card rounded-2xl p-8 text-center text-dim text-sm italic">Nothing outstanding 🎉</div>
            : BUCKETS.map(([k, lbl]) => {
              const rows = byBucket(k);
              if (!rows.length) return null;
              const sum = rows.reduce((s, b) => s + owed(b), 0);
              return (
                <div key={k} className="glass-card rounded-2xl overflow-hidden">
                  <div className="px-5 py-2.5 border-b border-bdr flex items-center gap-2">
                    <h3 className={`text-[13px] font-bold ${k === 'd60p' ? 'text-red-600' : k === 'd60' ? 'text-amber-600' : 'text-paper'}`}>{lbl}</h3>
                    <span className="text-xs text-dim font-mono">({rows.length})</span>
                    <span className="ml-auto text-sm font-semibold tabular-nums text-paper">{gbp2(sum)}</span>
                  </div>
                  <div className="divide-y divide-bdr/60">
                    {rows.map(b => (
                      <div key={b.id} className="px-5 py-2.5 flex items-center gap-3 text-sm">
                        {canWrite && <input type="checkbox" checked={!!sel[b.id]} onChange={() => toggle(b.id)} className="shrink-0" />}
                        <div className="flex-1 min-w-0 cursor-pointer" onClick={() => onNavigate?.('bill', b.id)}>
                          <div className="text-paper font-medium truncate hover:text-ember">{supName(b)}</div>
                          <div className="text-[10px] text-dim">BILL-{b.bill_number} · due {fmtD(b.due_date)}{b.status === 'partially_paid' ? ` · part-paid ${gbp2(b.amount_paid)}` : ''}</div>
                        </div>
                        <div className="tabular-nums font-semibold text-paper shrink-0">{gbp2(owed(b))}</div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          <div className="text-[11px] text-dim">Staff reimbursements will appear here too once the staff‑expenses module lands.</div>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { Receipt as ReceiptText, Plus, Truck as Car } from 'lucide-react';
import { gbp2 } from '../../lib/money.js';
import { isApprover, STATUS_LABEL, STATUS_BADGE } from '../../lib/expenseOps.js';

const fmtD = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }) : '—';

export default function ExpensesPanel({ profile, onNavigate }) {
  const approver = isApprover(profile);
  const [tab, setTab] = useState('mine');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from('expenses')
      .select('*, submitter:profiles!expenses_submitter_id_fkey(display_name), category:expense_categories(label)')
      .order('created_at', { ascending: false });
    setRows(data || []); setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const newExpense = async () => {
    const { data, error } = await supabase.from('expenses').insert({
      submitter_id: profile.id, reimburse_to_user_id: profile.id, created_by: profile.id,
      status: 'draft', type: 'staff_claim', expense_date: new Date().toISOString().slice(0, 10),
    }).select('id').single();
    if (error) { alert(error.message); return; }
    onNavigate?.('expense', data.id);
  };

  const mine = rows.filter(r => r.submitter_id === profile.id);
  const toApprove = rows.filter(r => r.status === 'submitted');
  const list = tab === 'mine' ? mine : tab === 'approve' ? toApprove : rows;
  const owedToMe = mine.filter(r => r.status === 'approved').reduce((s, r) => s + Number(r.total || 0), 0);

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-5 border-b border-bdr flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2.5">
          <ReceiptText size={20} className="text-ember" />
          <div>
            <div className="text-xl font-bold text-paper">Expenses</div>
            <div className="text-xs text-muted">Submit expenses &amp; mileage, track reimbursement</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-0.5 bg-card rounded-xl p-0.5">
            <button onClick={() => setTab('mine')} className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${tab === 'mine' ? 'bg-ember text-white' : 'text-muted'}`}>My claims</button>
            {approver && <button onClick={() => setTab('approve')} className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${tab === 'approve' ? 'bg-ember text-white' : 'text-muted'}`}>To approve{toApprove.length ? ` (${toApprove.length})` : ''}</button>}
            {approver && <button onClick={() => setTab('all')} className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${tab === 'all' ? 'bg-ember text-white' : 'text-muted'}`}>All</button>}
          </div>
          <button onClick={newExpense} className="btn-glass px-4 py-2 rounded-xl text-sm font-semibold flex items-center gap-1.5"><Plus size={15} /> New claim</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-3xl mx-auto space-y-4">
          {tab === 'mine' && (
            <div className="glass-card rounded-2xl p-4">
              <div className="text-[10px] font-mono font-bold uppercase tracking-[0.14em] text-dim mb-1">Approved, awaiting payment</div>
              <div className="text-2xl font-bold tabular-nums text-emerald-600">{gbp2(owedToMe)}</div>
            </div>
          )}
          <div className="glass-card rounded-2xl overflow-hidden">
            <div className="px-5 py-3 border-b border-bdr flex items-center gap-2">
              <h3 className="text-[13px] font-bold text-paper">{tab === 'mine' ? 'My claims' : tab === 'approve' ? 'Awaiting approval' : 'All claims'}</h3>
              <span className="text-xs text-dim font-mono">({list.length})</span>
            </div>
            <div className="divide-y divide-bdr/60">
              {loading ? <div className="p-6 text-center text-dim text-sm">Loading…</div>
                : list.length === 0 ? <div className="p-8 text-center text-dim text-sm italic">{tab === 'approve' ? 'Nothing awaiting approval.' : 'No claims yet.'}</div>
                : list.map(r => (
                  <div key={r.id} onClick={() => onNavigate?.('expense', r.id)} className="px-5 py-3 flex items-center gap-3 hover:bg-card/50 cursor-pointer">
                    <span className="shrink-0 text-dim">{r.type === 'mileage' ? <Car size={16} /> : <ReceiptText size={16} />}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-paper font-medium truncate">{r.description || (r.type === 'mileage' ? `${r.from_location || '?'} → ${r.to_location || '?'}` : 'Expense claim')}</div>
                      <div className="text-[10px] text-dim">EXP-{r.expense_number} · {fmtD(r.expense_date)}{tab !== 'mine' ? ` · ${r.submitter?.display_name || ''}` : ''}{r.category?.label ? ` · ${r.category.label}` : ''}</div>
                    </div>
                    <div className="text-sm font-semibold text-paper tabular-nums shrink-0">{gbp2(r.total)}</div>
                    <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-lg shrink-0 w-20 text-center ${STATUS_BADGE[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                  </div>
                ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

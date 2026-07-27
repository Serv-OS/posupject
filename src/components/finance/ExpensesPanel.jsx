import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { Receipt as ReceiptText, Plus, Truck as Car } from 'lucide-react';
import { gbp2 } from '../../lib/money.js';
import { isApprover, STATUS_LABEL, STATUS_BADGE, PAID_BY_SHORT, isCompanyPaid } from '../../lib/expenseOps.js';

const fmtD = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }) : '—';

export default function ExpensesPanel({ profile, onNavigate }) {
  const approver = isApprover(profile);
  const [tab, setTab] = useState('mine');
  const [rows, setRows] = useState([]);
  const [members, setMembers] = useState([]);
  const [runMonth, setRunMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [includeOlder, setIncludeOlder] = useState(true);
  const [paying, setPaying] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data }, prof] = await Promise.all([
      supabase.from('expenses')
        .select('*, submitter:profiles!expenses_submitter_id_fkey(display_name), category:expense_categories(label)')
        .order('created_at', { ascending: false }),
      supabase.from('profiles').select('id, display_name, email'),
    ]);
    setRows(data || []); setMembers(prof.data || []); setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const newExpense = async () => {
    const { data: me } = await supabase.from('profiles').select('default_expense_paid_by').eq('id', profile.id).maybeSingle();
    const { data, error } = await supabase.from('expenses').insert({
      submitter_id: profile.id, reimburse_to_user_id: profile.id, created_by: profile.id,
      paid_by: me?.default_expense_paid_by || 'personal',
      status: 'draft', type: 'staff_claim', expense_date: new Date().toISOString().slice(0, 10),
    }).select('id').single();
    if (error) { alert(error.message); return; }
    onNavigate?.('expense', data.id);
  };

  const mine = rows.filter(r => r.submitter_id === profile.id);
  const toApprove = rows.filter(r => r.status === 'submitted');
  const list = tab === 'mine' ? mine : tab === 'approve' ? toApprove : rows;
  const owedToMe = mine.filter(r => r.status === 'approved' && !isCompanyPaid(r)).reduce((s, r) => s + Number(r.total || 0), 0);

  // ── Reimbursement run: approved claims grouped by who gets paid back ──
  const personName = (id) => { const m = members.find(u => u.id === id); return m ? (m.display_name || m.email?.split('@')[0]) : 'Unknown'; };
  const monthStart = runMonth + '-01';
  const monthEnd = (() => { const [y, m] = runMonth.split('-').map(Number); return `${runMonth}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`; })();
  const inRunWindow = (r) => r.expense_date && r.expense_date <= monthEnd && (includeOlder || r.expense_date >= monthStart);
  const runnable = rows.filter(r => r.status === 'approved' && !isCompanyPaid(r) && inRunWindow(r));
  // Company-card spend in the same window: recorded (and VAT-reclaimed), nothing to pay.
  const companyPaid = rows.filter(r => isCompanyPaid(r) && ['approved', 'paid'].includes(r.status) && inRunWindow(r));
  const companyPaidTotal = companyPaid.reduce((s, r) => s + Number(r.total || 0), 0);
  const runGroups = (() => {
    const m = new Map();
    for (const r of runnable) { const k = r.reimburse_to_user_id || r.submitter_id; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
    return [...m.entries()].map(([id, list2]) => ({ id, list: list2, total: list2.reduce((s, r) => s + Number(r.total || 0), 0) }))
      .sort((a, b) => b.total - a.total);
  })();
  const runTotal = runGroups.reduce((s, g) => s + g.total, 0);

  const payRun = async (ids, label, total) => {
    if (!confirm(`Mark ${ids.length} expense${ids.length === 1 ? '' : 's'} (${gbp2(total)}) as paid to ${label}?\n\nThey'll be closed against run RUN-${runMonth}.`)) return;
    setPaying(true);
    const { error } = await supabase.from('expenses').update({
      status: 'paid', paid_at: new Date().toISOString(),
      payment_method: 'reimbursement', payment_reference: `RUN-${runMonth}`,
    }).in('id', ids);
    setPaying(false);
    if (error) { alert(error.message); return; }
    load();
  };

  const exportRun = () => {
    const data = runGroups.flatMap(g => g.list.map(r => [personName(g.id), `EXP-${r.expense_number}`, r.expense_date, r.type,
      r.description || (r.type === 'mileage' ? `${r.from_location || '?'} → ${r.to_location || '?'}` : ''), r.total]));
    const csv = [['Pay to', 'Ref', 'Date', 'Type', 'Description', 'Total'].join(','),
      ...data.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `expense-run-${runMonth}.csv`; a.click();
  };

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
            {approver && <button onClick={() => setTab('payrun')} className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${tab === 'payrun' ? 'bg-ember text-white' : 'text-muted'}`}>Pay run{runnable.length ? ` (${runnable.length})` : ''}</button>}
          </div>
          <button onClick={newExpense} className="btn-glass px-4 py-2 rounded-xl text-sm font-semibold flex items-center gap-1.5"><Plus size={15} /> New claim</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-3xl mx-auto space-y-4">
          {tab === 'payrun' && approver && (
            <>
              <div className="glass-card rounded-2xl p-4 flex items-center gap-3 flex-wrap">
                <input type="month" className="px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper focus:outline-none focus:border-ember" value={runMonth} onChange={e => setRunMonth(e.target.value)} />
                <button type="button" onClick={() => setIncludeOlder(v => !v)} className="flex items-center gap-2 text-xs text-paper">
                  <span className={`w-4 h-4 rounded border flex items-center justify-center text-[10px] ${includeOlder ? 'bg-ember border-ember text-white' : 'border-bdr'}`}>{includeOlder ? '✓' : ''}</span>
                  Include older unpaid claims
                </button>
                <div className="ml-auto flex items-center gap-2">
                  <span className="text-sm text-paper">Run total <span className="font-bold tabular-nums text-emerald-600">{gbp2(runTotal)}</span></span>
                  <button onClick={exportRun} disabled={!runnable.length} className="px-3 py-1.5 text-xs text-muted border border-bdr rounded hover:text-paper disabled:opacity-40">Export CSV</button>
                  <button onClick={() => payRun(runnable.map(r => r.id), 'everyone in this run', runTotal)} disabled={!runnable.length || paying}
                    className="px-3 py-1.5 text-xs font-semibold rounded-xl bg-emerald-100 text-emerald-700 border border-emerald-200 hover:bg-emerald-200 disabled:opacity-40">
                    {paying ? 'Marking…' : 'Mark whole run paid'}
                  </button>
                </div>
              </div>
              {runGroups.map(g => (
                <div key={g.id} className="glass-card rounded-2xl overflow-hidden">
                  <div className="px-5 py-3 border-b border-bdr flex items-center gap-2">
                    <h3 className="text-[13px] font-bold text-paper">{personName(g.id)}</h3>
                    <span className="text-xs text-dim font-mono">({g.list.length})</span>
                    <div className="ml-auto flex items-center gap-3">
                      <span className="text-sm font-bold tabular-nums text-paper">{gbp2(g.total)}</span>
                      <button onClick={() => payRun(g.list.map(r => r.id), personName(g.id), g.total)} disabled={paying}
                        className="px-3 py-1 text-xs font-semibold rounded-lg bg-emerald-100 text-emerald-700 border border-emerald-200 hover:bg-emerald-200 disabled:opacity-40">Mark paid</button>
                    </div>
                  </div>
                  <div className="divide-y divide-bdr/60">
                    {g.list.map(r => (
                      <div key={r.id} onClick={() => onNavigate?.('expense', r.id)} className="px-5 py-2 flex items-center gap-3 hover:bg-card/50 cursor-pointer text-sm">
                        <span className="shrink-0 text-dim">{r.type === 'mileage' ? <Car size={14} /> : <ReceiptText size={14} />}</span>
                        <span className="flex-1 text-paper truncate">{r.description || (r.type === 'mileage' ? `${r.from_location || '?'} → ${r.to_location || '?'}` : 'Expense claim')}</span>
                        {r.expense_date < monthStart && <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">older</span>}
                        <span className="text-[10px] text-dim font-mono">EXP-{r.expense_number} · {fmtD(r.expense_date)}</span>
                        <span className="tabular-nums font-semibold text-paper w-20 text-right">{gbp2(r.total)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {runGroups.length === 0 && <div className="glass-card rounded-2xl p-8 text-center text-dim text-sm italic">No approved, unpaid claims for this run. 🎉</div>}

              {companyPaid.length > 0 && (
                <div className="glass-card rounded-2xl overflow-hidden">
                  <div className="px-5 py-3 border-b border-bdr flex items-center gap-2">
                    <h3 className="text-[13px] font-bold text-paper">Company card — nothing to pay</h3>
                    <span className="text-xs text-dim font-mono">({companyPaid.length})</span>
                    <span className="ml-auto text-sm font-bold tabular-nums text-muted">{gbp2(companyPaidTotal)}</span>
                  </div>
                  <div className="divide-y divide-bdr/60">
                    {companyPaid.map(r => (
                      <div key={r.id} onClick={() => onNavigate?.('expense', r.id)} className="px-5 py-2 flex items-center gap-3 hover:bg-card/50 cursor-pointer text-sm">
                        <span className="shrink-0 text-dim">{r.type === 'mileage' ? <Car size={14} /> : <ReceiptText size={14} />}</span>
                        <span className="flex-1 text-paper truncate">{r.description || (r.type === 'mileage' ? `${r.from_location || '?'} → ${r.to_location || '?'}` : 'Expense claim')}</span>
                        <span className="text-[10px] text-dim font-mono">{r.submitter?.display_name || ''} · EXP-{r.expense_number} · {fmtD(r.expense_date)}</span>
                        <span className="tabular-nums text-muted w-20 text-right">{gbp2(r.total)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="px-5 py-2 border-t border-bdr text-[11px] text-dim">Already settled by the company — still counted for VAT and reporting.</div>
                </div>
              )}
            </>
          )}
          {tab === 'mine' && (
            <div className="glass-card rounded-2xl p-4">
              <div className="text-[10px] font-mono font-bold uppercase tracking-[0.14em] text-dim mb-1">Approved, awaiting payment</div>
              <div className="text-2xl font-bold tabular-nums text-emerald-600">{gbp2(owedToMe)}</div>
            </div>
          )}
          {tab !== 'payrun' && (
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
                    {isCompanyPaid(r) && <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-slate-200 text-slate-600 shrink-0">{PAID_BY_SHORT.company_card}</span>}
                    <div className="text-sm font-semibold text-paper tabular-nums shrink-0">{gbp2(r.total)}</div>
                    <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-lg shrink-0 w-20 text-center ${STATUS_BADGE[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                  </div>
                ))}
            </div>
          </div>
          )}
        </div>
      </div>
    </div>
  );
}

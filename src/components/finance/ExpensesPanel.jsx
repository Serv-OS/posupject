import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { Receipt as ReceiptText, Plus, Truck as Car, ChevronRight, Check, X, Download } from 'lucide-react';
import { gbp2 } from '../../lib/money.js';
import { isApprover, STATUS_LABEL, STATUS_BADGE, PAID_BY_SHORT, isCompanyPaid,
  buildApprovePatch, personOf, expenseMatches, sumExpenses } from '../../lib/expenseOps.js';

const fmtD = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }) : '—';
const fsel = 'px-2 py-1 bg-card border border-bdr rounded-lg text-[11px] text-paper focus:outline-none focus:border-ember';
// An active filter is outlined, so "on" never has to be inferred from how a
// browser chooses to draw an empty control.
const fcls = (v) => `${fsel}${v ? ' border-ember bg-ember/10' : ''}`;
const Stat = ({ label, value, sub }) => (
  <div className="glass-card rounded-2xl p-4">
    <div className="text-[10px] font-mono font-bold uppercase tracking-[0.14em] text-dim">{label}</div>
    <div className="text-xl font-bold tabular-nums text-paper mt-0.5">{value}</div>
    {sub && <div className="text-[11px] text-muted mt-0.5">{sub}</div>}
  </div>
);
const Detail = ({ k, v }) => (
  <div><div className="text-[9px] font-mono uppercase tracking-wider text-dim">{k}</div><div className="text-paper">{v ?? '—'}</div></div>
);

export default function ExpensesPanel({ profile, onNavigate }) {
  const approver = isApprover(profile);
  const [tab, setTab] = useState('mine');
  const [rows, setRows] = useState([]);
  const [members, setMembers] = useState([]);
  const [runMonth, setRunMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [includeOlder, setIncludeOlder] = useState(true);
  const [paying, setPaying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [cats, setCats] = useState([]);
  const [sel, setSel] = useState(() => new Set());   // ids ticked for a bulk action
  const [open, setOpen] = useState(null);            // id expanded for detail
  const [busy, setBusy] = useState(false);
  const blankF = { person: '', categoryId: '', type: '', paidBy: '', from: '', to: '', min: '', max: '', q: '' };
  const [f, setF] = useState(blankF);
  const setFilter = (k, v) => { setF(p => ({ ...p, [k]: v })); setSel(new Set()); };
  const fActive = Object.entries(f).some(([, v]) => v !== '');

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data }, prof] = await Promise.all([
      supabase.from('expenses')
        .select('*, submitter:profiles!expenses_submitter_id_fkey(display_name), category:expense_categories(label)')
        .order('created_at', { ascending: false }),
      supabase.from('profiles').select('id, display_name, email'),
    ]);
    supabase.from('expense_categories').select('id, label').order('label').then(r => setCats(r.data || []));
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
  const base = tab === 'mine' ? mine : tab === 'approve' ? toApprove : rows;
  // One predicate for the list, the tick-boxes and the report, so "approve all
  // shown" and "shown" can never mean two different sets.
  const list = base.filter(r => expenseMatches(r, f));

  const nameOf = (id) => { const m = members.find(u => u.id === id); return m ? (m.display_name || m.email?.split('@')[0]) : 'Unknown'; };
  // Only offer people who actually appear, so the dropdown is never a list of
  // names with nothing behind them.
  const peopleInView = [...new Set(base.map(personOf).filter(Boolean))]
    .map(id => ({ id, name: nameOf(id) })).sort((a, b) => a.name.localeCompare(b.name));

  const selected = list.filter(r => sel.has(r.id));
  const selTotal = selected.reduce((a, r) => a + Number(r.total || 0), 0);
  const toggle = (id) => setSel(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allShown = list.length > 0 && list.every(r => sel.has(r.id));
  const toggleAll = () => setSel(allShown ? new Set() : new Set(list.map(r => r.id)));

  // Approve in bulk using the SAME rule as the single-claim screen: personal
  // claims stop at `approved` and wait for a run, company-card ones are already
  // settled and go straight to `paid`. Getting that wrong here would invent
  // reimbursements nobody is owed, and 8 of the 11 waiting are company card.
  const bulkApprove = async () => {
    const targets = selected.filter(r => r.status === 'submitted');
    if (!targets.length) return;
    const card = targets.filter(isCompanyPaid);
    const reimb = targets.filter(r => !isCompanyPaid(r));
    const lines = [
      `Approve ${targets.length} claim${targets.length === 1 ? '' : 's'} totalling ${gbp2(targets.reduce((a, r) => a + Number(r.total || 0), 0))}?`, '',
      reimb.length ? `• ${reimb.length} personal (${gbp2(reimb.reduce((a, r) => a + Number(r.total || 0), 0))}) — approved, then owed back in a pay run` : null,
      card.length ? `• ${card.length} company card (${gbp2(card.reduce((a, r) => a + Number(r.total || 0), 0))}) — closed as paid, nothing to reimburse` : null,
    ].filter(Boolean).join('\n');
    if (!confirm(lines)) return;
    setBusy(true);
    const now = new Date().toISOString();
    // Two writes, not one per claim: the patch differs only by paid_by.
    for (const group of [reimb, card]) {
      if (!group.length) continue;
      const { patch } = buildApprovePatch(group[0], profile.id, now);
      const ids = group.map(r => r.id);
      const { error } = await supabase.from('expenses').update({ ...patch, updated_at: now }).in('id', ids);
      if (error) { setBusy(false); alert(error.message); return; }
      await supabase.from('expense_events').insert(group.map(r => ({
        expense_id: r.id, actor_id: profile.id, from_status: r.status, to_status: patch.status,
        note: isCompanyPaid(r) ? 'bulk approved - company card, no reimbursement due' : 'bulk approved',
      })));
    }
    setBusy(false); setSel(new Set()); load();
  };

  const bulkReject = async () => {
    const targets = selected.filter(r => r.status === 'submitted');
    if (!targets.length) return;
    const reason = prompt(`Reject ${targets.length} claim${targets.length === 1 ? '' : 's'}. Reason?`);
    if (reason == null) return;
    setBusy(true);
    const now = new Date().toISOString();
    const { error } = await supabase.from('expenses').update({
      status: 'rejected', approver_id: profile.id, rejection_reason: reason, updated_at: now,
    }).in('id', targets.map(r => r.id));
    if (!error) {
      await supabase.from('expense_events').insert(targets.map(r => ({
        expense_id: r.id, actor_id: profile.id, from_status: r.status, to_status: 'rejected', note: reason,
      })));
    }
    setBusy(false); setSel(new Set());
    if (error) { alert(error.message); return; }
    load();
  };

  // Line by line, without leaving the list.
  const rowAct = async (r, action) => {
    let patch, note;
    if (action === 'approve') { const b = buildApprovePatch(r, profile.id, new Date().toISOString()); patch = b.patch; note = b.note; }
    else { const reason = prompt(`Reject EXP-${r.expense_number}. Reason?`); if (reason == null) return;
           patch = { status: 'rejected', approver_id: profile.id, rejection_reason: reason }; note = reason; }
    setBusy(true);
    const now = new Date().toISOString();
    const { error } = await supabase.from('expenses').update({ ...patch, updated_at: now }).eq('id', r.id);
    if (!error) await supabase.from('expense_events').insert({ expense_id: r.id, actor_id: profile.id, from_status: r.status, to_status: patch.status, note });
    setBusy(false);
    if (error) { alert(error.message); return; }
    load();
  };
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

  // ── Report ────────────────────────────────────────────────────────────────
  // The question this answers is "does what we recorded match what actually
  // went out". So it splits by WHO PAID: company-card spend has to agree with
  // the card statement, personal spend has to agree with what was reimbursed.
  // Anything still unapproved in the window is shown separately, because that
  // is the usual reason a total does not tie out.
  const [groupBy, setGroupBy] = useState('person');
  const reportRows = rows.filter(r => r.status !== 'draft' && expenseMatches(r, f));
  const rTot = sumExpenses(reportRows);
  const rCard = sumExpenses(reportRows.filter(isCompanyPaid));
  const rPersonal = sumExpenses(reportRows.filter(r => !isCompanyPaid(r)));
  const rPending = sumExpenses(reportRows.filter(r => r.status === 'submitted'));
  const catLabel = (r) => r.category?.label || 'Uncategorised';
  const groupKey = (r) => groupBy === 'person' ? nameOf(personOf(r))
    : groupBy === 'category' ? catLabel(r)
    : isCompanyPaid(r) ? 'Company card' : 'Personal (reimbursed)';
  const groups = (() => {
    const m = new Map();
    for (const r of reportRows) { const k = groupKey(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
    return [...m.entries()].map(([k, l]) => ({ k, ...sumExpenses(l) })).sort((a, b) => b.gross - a.gross);
  })();

  const rangeLabel = f.from || f.to ? `${f.from || 'start'} to ${f.to || 'today'}` : 'all dates';
  const setRange = (from, to) => setF(p => ({ ...p, from, to }));
  const thisMonth = () => { const d = new Date(); const m = d.toISOString().slice(0, 7); setRange(`${m}-01`, new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10)); };
  const lastMonth = () => { const d = new Date(); const p2 = new Date(d.getFullYear(), d.getMonth() - 1, 1); const m = p2.toISOString().slice(0, 7);
    setRange(`${m}-01`, new Date(p2.getFullYear(), p2.getMonth() + 1, 0).toISOString().slice(0, 10)); };
  const taxYear = () => { const d = new Date(); const y = (d.getMonth() > 3 || (d.getMonth() === 3 && d.getDate() >= 6)) ? d.getFullYear() : d.getFullYear() - 1;
    setRange(`${y}-04-06`, `${y + 1}-04-05`); };

  const exportReport = () => {
    const head = ['Ref', 'Date', 'Person', 'Category', 'Type', 'Paid by', 'Description', 'Net', 'VAT', 'Total', 'VAT reclaim', 'Status'];
    const body = reportRows.map(r => [`EXP-${r.expense_number}`, r.expense_date, nameOf(personOf(r)), catLabel(r), r.type,
      isCompanyPaid(r) ? 'Company card' : 'Personal', r.description || (r.type === 'mileage' ? `${r.from_location || '?'} to ${r.to_location || '?'}` : ''),
      Number(r.subtotal || 0).toFixed(2), Number(r.tax_amount || 0).toFixed(2), Number(r.total || 0).toFixed(2),
      r.vat_reclaimable ? Number(r.vat_reclaim_amount ?? r.tax_amount ?? 0).toFixed(2) : '0.00', r.status]);
    const csv = [head, ...body].map(row => row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `expenses-${f.from || 'all'}-to-${f.to || 'today'}.csv`; a.click();
  };

  const reportPdf = async () => {
    const { downloadListPdf } = await import('../../lib/listPdf.js');
    const filters = [`Dates: ${rangeLabel}`];
    if (f.person) filters.push(`Person: ${nameOf(f.person)}`);
    if (f.paidBy) filters.push(`Paid by: ${f.paidBy === 'company_card' ? 'company card' : 'personal'}`);
    if (f.categoryId) filters.push(`Category: ${cats.find(c => c.id === f.categoryId)?.label || ''}`);
    await downloadListPdf({
      title: 'Expenses',
      columns: ['Ref', 'Date', 'Person', 'Category', 'Paid by', 'Description', 'Net', 'VAT', 'Total', 'Status'],
      rows: reportRows.map(r => [`EXP-${r.expense_number}`, fmtD(r.expense_date), nameOf(personOf(r)), catLabel(r),
        isCompanyPaid(r) ? 'Company card' : 'Personal',
        r.description || (r.type === 'mileage' ? `${r.from_location || '?'} to ${r.to_location || '?'}` : ''),
        gbp2(r.subtotal), gbp2(r.tax_amount), gbp2(r.total), STATUS_LABEL[r.status]]),
      filters,
      footNote: `Company card ${gbp2(rCard.gross)}  ·  Personal ${gbp2(rPersonal.gross)}  ·  Total ${gbp2(rTot.gross)}  ·  Reclaimable VAT ${gbp2(rTot.reclaimable)}`,
      filename: `expenses-${f.from || 'all'}-to-${f.to || 'today'}.pdf`,
    });
  };

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
            {approver && <button onClick={() => setTab('report')} className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${tab === 'report' ? 'bg-ember text-white' : 'text-muted'}`}>Report</button>}
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
          {tab === 'report' && approver && (
            <>
              <div className="glass-card rounded-2xl p-4 space-y-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] font-mono font-bold uppercase tracking-[0.14em] text-dim">Dates</span>
                  <input type="date" className={fcls(f.from)} value={f.from} onChange={e => setFilter('from', e.target.value)} title="On or after" />
                  <span className="text-dim text-xs">to</span>
                  <input type="date" className={fcls(f.to)} value={f.to} onChange={e => setFilter('to', e.target.value)} title="On or before" />
                  <button onClick={thisMonth} className="px-2 py-1 rounded-lg text-[11px] font-semibold bg-card text-muted hover:text-paper">This month</button>
                  <button onClick={lastMonth} className="px-2 py-1 rounded-lg text-[11px] font-semibold bg-card text-muted hover:text-paper">Last month</button>
                  <button onClick={taxYear} className="px-2 py-1 rounded-lg text-[11px] font-semibold bg-card text-muted hover:text-paper">Tax year</button>
                  {(f.from || f.to) && <button onClick={() => setRange('', '')} className="text-[11px] text-dim hover:text-red-600">Clear dates</button>}
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <select className={fcls(f.person)} value={f.person} onChange={e => setFilter('person', e.target.value)}>
                    <option value="">Everyone</option>
                    {peopleInView.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                  <select className={fcls(f.categoryId)} value={f.categoryId} onChange={e => setFilter('categoryId', e.target.value)}>
                    <option value="">All categories</option>
                    {cats.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                  </select>
                  <select className={fcls(f.paidBy)} value={f.paidBy} onChange={e => setFilter('paidBy', e.target.value)}>
                    <option value="">Any payer</option>
                    <option value="personal">Personal (reimburse)</option>
                    <option value="company_card">Company card</option>
                  </select>
                  <span className="ml-auto flex items-center gap-2">
                    <button onClick={exportReport} className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-card text-muted hover:text-paper flex items-center gap-1.5"><Download size={13} /> CSV</button>
                    <button onClick={reportPdf} className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-card text-muted hover:text-paper flex items-center gap-1.5"><Download size={13} /> PDF</button>
                  </span>
                </div>
              </div>

              {/* Split by who paid, because that is what you reconcile against:
                  card spend to the card statement, personal to the pay run. */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Stat label="Total" value={gbp2(rTot.gross)} sub={`${rTot.count} claim${rTot.count === 1 ? '' : 's'}`} />
                <Stat label="On the company card" value={gbp2(rCard.gross)} sub={`${rCard.count} · match to the statement`} />
                <Stat label="Personal, reimbursed" value={gbp2(rPersonal.gross)} sub={`${rPersonal.count} · match to the pay run`} />
                <Stat label="Reclaimable VAT" value={gbp2(rTot.reclaimable)} sub={`of ${gbp2(rTot.tax)} VAT charged`} />
              </div>
              {rPending.count > 0 && (
                <div className="glass-card rounded-2xl p-3 text-xs text-amber-700 bg-amber-50/60 border border-amber-200">
                  <b>{rPending.count}</b> claim{rPending.count === 1 ? '' : 's'} worth <b>{gbp2(rPending.gross)}</b> in this range
                  are still awaiting approval, so they are counted above but have not been settled. That is the usual reason a total does not tie out.
                </div>
              )}

              <div className="glass-card rounded-2xl overflow-hidden">
                <div className="px-5 py-3 border-b border-bdr flex items-center gap-2 flex-wrap">
                  <h3 className="text-[13px] font-bold text-paper">Breakdown</h3>
                  <div className="flex items-center gap-0.5 bg-card rounded-lg p-0.5 ml-2">
                    {[['person', 'By person'], ['category', 'By category'], ['payer', 'By payer']].map(([k, l]) => (
                      <button key={k} onClick={() => setGroupBy(k)}
                        className={`px-2.5 py-1 rounded text-[11px] font-semibold ${groupBy === k ? 'bg-ember text-white' : 'text-muted hover:text-paper'}`}>{l}</button>
                    ))}
                  </div>
                  <span className="ml-auto text-[11px] text-dim">{rangeLabel}</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-[10px] font-mono uppercase tracking-wider text-dim border-b border-bdr">
                        <th className="text-left px-5 py-2 font-medium">{groupBy === 'person' ? 'Person' : groupBy === 'category' ? 'Category' : 'Paid by'}</th>
                        <th className="text-right px-3 py-2 font-medium">Claims</th>
                        <th className="text-right px-3 py-2 font-medium">Net</th>
                        <th className="text-right px-3 py-2 font-medium">VAT</th>
                        <th className="text-right px-3 py-2 font-medium">Reclaimable</th>
                        <th className="text-right px-5 py-2 font-medium">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groups.length === 0 && <tr><td colSpan={6} className="p-8 text-center text-dim text-sm italic">Nothing in this range.</td></tr>}
                      {groups.map(g => (
                        <tr key={g.k} className="border-b border-bdr/60 last:border-0">
                          <td className="px-5 py-2.5 text-paper">{g.k}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-muted">{g.count}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-muted">{gbp2(g.net)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-muted">{gbp2(g.tax)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-muted">{gbp2(g.reclaimable)}</td>
                          <td className="px-5 py-2.5 text-right tabular-nums font-semibold text-paper">{gbp2(g.gross)}</td>
                        </tr>
                      ))}
                      {groups.length > 0 && (
                        <tr className="border-t border-bdr bg-card/40">
                          <td className="px-5 py-2.5 font-bold text-paper">Total</td>
                          <td className="px-3 py-2.5 text-right tabular-nums font-bold text-paper">{rTot.count}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums font-bold text-paper">{gbp2(rTot.net)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums font-bold text-paper">{gbp2(rTot.tax)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums font-bold text-paper">{gbp2(rTot.reclaimable)}</td>
                          <td className="px-5 py-2.5 text-right tabular-nums font-bold text-paper">{gbp2(rTot.gross)}</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="px-5 py-2 border-t border-bdr text-[11px] text-dim">
                  Drafts are excluded: nobody has claimed them yet. Reclaimable VAT counts only claims marked reclaimable with a VAT invoice held.
                </div>
              </div>
            </>
          )}

          {tab !== 'payrun' && tab !== 'report' && (
          <div className="glass-card rounded-2xl overflow-hidden">
            <div className="px-5 py-3 border-b border-bdr flex items-center gap-2 flex-wrap">
              <h3 className="text-[13px] font-bold text-paper">{tab === 'mine' ? 'My claims' : tab === 'approve' ? 'Awaiting approval' : 'All claims'}</h3>
              <span className="text-xs text-dim font-mono">({list.length}{fActive && base.length !== list.length ? ` of ${base.length}` : ''})</span>
              <span className="ml-auto text-xs text-muted tabular-nums">{gbp2(sumExpenses(list).gross)}</span>
            </div>

            {/* Filters. Person is who the claim is FOR, which is not always who
                typed it in: a claim can be raised for someone else and it is the
                person getting the money who matters before you pay. */}
            <div className="px-5 py-2.5 border-b border-bdr bg-card/40 flex items-center gap-2 flex-wrap">
              <select className={fcls(f.person)} value={f.person} onChange={e => setFilter('person', e.target.value)}>
                <option value="">Everyone</option>
                {peopleInView.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
              <select className={fcls(f.categoryId)} value={f.categoryId} onChange={e => setFilter('categoryId', e.target.value)}>
                <option value="">All categories</option>
                {cats.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
              <select className={fcls(f.paidBy)} value={f.paidBy} onChange={e => setFilter('paidBy', e.target.value)}>
                <option value="">Any payer</option>
                <option value="personal">Personal (reimburse)</option>
                <option value="company_card">Company card</option>
              </select>
              <select className={fcls(f.type)} value={f.type} onChange={e => setFilter('type', e.target.value)}>
                <option value="">Any type</option>
                <option value="staff_claim">Receipt</option>
                <option value="mileage">Mileage</option>
              </select>
              {/* Labelled, because a date input cannot hold placeholder text and
                  Safari draws an EMPTY one with today's date greyed in, which
                  reads as a filter that is already on. */}
              <label className="flex items-center gap-1">
                <span className="text-[9px] font-mono uppercase text-dim">From</span>
                <input type="date" className={fcls(f.from)} value={f.from} onChange={e => setFilter('from', e.target.value)} />
              </label>
              <label className="flex items-center gap-1">
                <span className="text-[9px] font-mono uppercase text-dim">To</span>
                <input type="date" className={fcls(f.to)} value={f.to} onChange={e => setFilter('to', e.target.value)} />
              </label>
              <input className={fcls(f.q) + ' w-40'} placeholder="Search…" value={f.q} onChange={e => setFilter('q', e.target.value)} />
              {fActive && <button onClick={() => { setF(blankF); setSel(new Set()); }} className="text-xs text-dim hover:text-red-600 font-medium">Clear</button>}
            </div>

            {/* Bulk bar. Only appears once something is ticked, and it always
                says how much money it is about to move. */}
            {approver && tab !== 'mine' && selected.length > 0 && (
              <div className="px-5 py-2.5 border-b border-bdr bg-ember/10 flex items-center gap-3 flex-wrap">
                <span className="text-xs font-semibold text-paper">{selected.length} selected · {gbp2(selTotal)}</span>
                <button onClick={bulkApprove} disabled={busy || !selected.some(r => r.status === 'submitted')}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-100 text-emerald-700 border border-emerald-200 hover:bg-emerald-200 disabled:opacity-40">
                  Approve {selected.filter(r => r.status === 'submitted').length}
                </button>
                <button onClick={bulkReject} disabled={busy || !selected.some(r => r.status === 'submitted')}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-50 text-red-700 border border-red-200 hover:bg-red-100 disabled:opacity-40">
                  Reject
                </button>
                <button onClick={() => setSel(new Set())} className="text-xs text-dim hover:text-paper">Clear selection</button>
              </div>
            )}
            {approver && tab !== 'mine' && list.length > 0 && (
              <div className="px-5 py-1.5 border-b border-bdr flex items-center gap-2">
                <input type="checkbox" checked={allShown} onChange={toggleAll} className="accent-ember" id="selall" />
                <label htmlFor="selall" className="text-[11px] text-dim cursor-pointer">Select all {list.length} shown</label>
              </div>
            )}
            <div className="divide-y divide-bdr/60">
              {loading ? <div className="p-6 text-center text-dim text-sm">Loading…</div>
                : list.length === 0 ? <div className="p-8 text-center text-dim text-sm italic">{tab === 'approve' ? 'Nothing awaiting approval.' : 'No claims yet.'}</div>
                : list.map(r => (
                  <div key={r.id}>
                    <div className="px-5 py-3 flex items-center gap-3 hover:bg-card/50">
                      {approver && tab !== 'mine' && (
                        <input type="checkbox" checked={sel.has(r.id)} onChange={() => toggle(r.id)}
                          onClick={e => e.stopPropagation()} className="accent-ember shrink-0" />
                      )}
                      {/* Expand in place. Approving without opening a record is
                          the point, but not if it means approving blind. */}
                      <button onClick={() => setOpen(open === r.id ? null : r.id)}
                        title={open === r.id ? 'Hide detail' : 'Show detail'}
                        className={`shrink-0 text-dim hover:text-ember transition-transform ${open === r.id ? 'rotate-90' : ''}`}>
                        <ChevronRight size={14} />
                      </button>
                      <span className="shrink-0 text-dim">{r.type === 'mileage' ? <Car size={16} /> : <ReceiptText size={16} />}</span>
                      <div className="flex-1 min-w-0 cursor-pointer" onClick={() => onNavigate?.('expense', r.id)}>
                        <div className="text-sm text-paper font-medium truncate">{r.description || (r.type === 'mileage' ? `${r.from_location || '?'} → ${r.to_location || '?'}` : 'Expense claim')}</div>
                        <div className="text-[10px] text-dim">EXP-{r.expense_number} · {fmtD(r.expense_date)}{tab !== 'mine' ? ` · ${nameOf(personOf(r))}` : ''}{r.category?.label ? ` · ${r.category.label}` : ''}</div>
                      </div>
                      {isCompanyPaid(r) && <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-slate-200 text-slate-600 shrink-0">{PAID_BY_SHORT.company_card}</span>}
                      <div className="text-sm font-semibold text-paper tabular-nums shrink-0">{gbp2(r.total)}</div>
                      {approver && r.status === 'submitted' ? (
                        <div className="flex items-center gap-1 shrink-0">
                          <button onClick={() => rowAct(r, 'approve')} disabled={busy} title={isCompanyPaid(r) ? 'Approve — company card, closes as paid' : 'Approve'}
                            className="p-1.5 rounded-lg bg-emerald-100 text-emerald-700 hover:bg-emerald-200 disabled:opacity-40"><Check size={14} /></button>
                          <button onClick={() => rowAct(r, 'reject')} disabled={busy} title="Reject"
                            className="p-1.5 rounded-lg bg-red-50 text-red-700 hover:bg-red-100 disabled:opacity-40"><X size={14} /></button>
                        </div>
                      ) : (
                        <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-lg shrink-0 w-20 text-center ${STATUS_BADGE[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                      )}
                    </div>
                    {open === r.id && (
                      <div className="px-5 pb-3 pl-16 grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-2 text-[11px] bg-card/30">
                        <Detail k="Claimed by" v={r.submitter?.display_name} />
                        <Detail k="Reimburse to" v={r.reimburse_to_user_id ? nameOf(r.reimburse_to_user_id) : '—'} />
                        <Detail k="Paid by" v={isCompanyPaid(r) ? 'Company card' : 'Personal'} />
                        <Detail k="Category" v={r.category?.label} />
                        <Detail k="Net" v={gbp2(r.subtotal)} />
                        <Detail k="VAT" v={gbp2(r.tax_amount)} />
                        <Detail k="Total" v={gbp2(r.total)} />
                        <Detail k="VAT reclaim" v={r.vat_reclaimable ? gbp2(r.vat_reclaim_amount ?? r.tax_amount) : 'Not reclaimable'} />
                        {r.type === 'mileage' && <>
                          <Detail k="Journey" v={`${r.from_location || '?'} → ${r.to_location || '?'}`} />
                          <Detail k="Miles" v={r.miles} />
                          <Detail k="Rate" v={r.rate_pence ? `${r.rate_pence}p` : null} />
                          <Detail k="Purpose" v={r.purpose} />
                        </>}
                        {r.type !== 'mileage' && !r.has_vat_invoice && (
                          <div className="col-span-2 text-amber-600">No VAT invoice held, so this one cannot be reclaimed.</div>
                        )}
                        {r.notes && <div className="col-span-2 md:col-span-4 text-muted">{r.notes}</div>}
                        {r.status === 'rejected' && r.rejection_reason && (
                          <div className="col-span-2 md:col-span-4 text-red-600">Rejected: {r.rejection_reason}</div>
                        )}
                        <div className="col-span-2 md:col-span-4">
                          <button onClick={() => onNavigate?.('expense', r.id)} className="text-ember hover:text-ember-deep font-medium">Open full claim and receipts →</button>
                        </div>
                      </div>
                    )}
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

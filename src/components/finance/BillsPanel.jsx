import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { Wallet, Plus, Repeat, X, Trash2 } from 'lucide-react';
import { gbp2, computeTotals } from '../../lib/money.js';
import { advanceRunDate, buildBillFromSchedule, isDue } from '../../lib/recurringBills.js';

const fmtD = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }) : '—';

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
  const [tab, setTab] = useState('bills');
  const [bills, setBills] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [categories, setCategories] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [locations, setLocations] = useState([]);
  const [statusFilter, setStatusFilter] = useState('all');
  const [editSched, setEditSched] = useState(null);
  const [loading, setLoading] = useState(true);
  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  const load = useCallback(async () => {
    setLoading(true);
    const [b, r, s, c, co, l] = await Promise.all([
      supabase.from('bills').select('*, supplier:inv_suppliers(name), company:companies(name)').order('created_at', { ascending: false }),
      supabase.from('recurring_bills').select('*, supplier:inv_suppliers(name)').order('next_run'),
      supabase.from('inv_suppliers').select('id, name, default_category_id').order('name'),
      supabase.from('expense_categories').select('id, label').eq('active', true).order('sort'),
      supabase.from('companies').select('id, name').order('name'),
      supabase.from('locations').select('id, name, company_id').order('name'),
    ]);
    setBills(b.data || []); setSchedules(r.data || []); setSuppliers(s.data || []);
    setCategories(c.data || []); setCompanies(co.data || []); setLocations(l.data || []); setLoading(false);
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

  const generateDue = async () => {
    const today = new Date().toISOString().slice(0, 10);
    const dueScheds = schedules.filter(s => isDue(s, today));
    if (!dueScheds.length) { alert('No recurring bills are due.'); return; }
    if (!confirm(`Generate ${dueScheds.length} due bill(s) now? They'll be created as "to pay".`)) return;
    for (const s of dueScheds) {
      const { bill, billLines } = buildBillFromSchedule(s, today);
      const { data: b, error } = await supabase.from('bills').insert({ ...bill, created_by: bill.created_by || profile.id }).select('id').single();
      if (error || !b) continue;
      if (billLines.length) await supabase.from('bill_line_items').insert(billLines.map(l => ({ ...l, bill_id: b.id })));
      await supabase.from('recurring_bills').update({ next_run: advanceRunDate(s.next_run, s.frequency, s.day_of_month), last_run_at: new Date().toISOString() }).eq('id', s.id);
    }
    setTab('bills'); load();
  };

  const supName = (b) => b.supplier?.name || b.company?.name || b.description || 'Untitled bill';
  const owed = (b) => Number(b.total || 0) - Number(b.amount_paid || 0);
  const toPay = bills.filter(b => ['to_pay', 'partially_paid'].includes(b.status));
  const outstanding = toPay.reduce((s, b) => s + owed(b), 0);
  const overdueList = bills.filter(b => billStatus(b) === 'overdue');
  const mStart = new Date(); mStart.setDate(1);
  const paidThisMonth = bills.filter(b => b.status === 'paid' && b.paid_at && new Date(b.paid_at) >= mStart).reduce((s, b) => s + Number(b.amount_paid ?? b.total ?? 0), 0);
  const dueCount = schedules.filter(s => isDue(s, new Date().toISOString().slice(0, 10))).length;
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
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-0.5 bg-card rounded-xl p-0.5">
            <button onClick={() => setTab('bills')} className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${tab === 'bills' ? 'bg-ember text-white' : 'text-muted'}`}>Bills</button>
            <button onClick={() => setTab('recurring')} className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold ${tab === 'recurring' ? 'bg-ember text-white' : 'text-muted'}`}><Repeat size={12} /> Recurring{dueCount ? ` (${dueCount})` : ''}</button>
          </div>
          {canWrite && (tab === 'bills'
            ? <button onClick={newBill} className="btn-glass px-4 py-2 rounded-xl text-sm font-semibold flex items-center gap-1.5"><Plus size={15} /> New bill</button>
            : <button onClick={() => setEditSched({})} className="btn-glass px-4 py-2 rounded-xl text-sm font-semibold flex items-center gap-1.5"><Plus size={15} /> New schedule</button>)}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-[1100px] mx-auto space-y-5">
          {tab === 'bills' ? (
            <>
              <div className="grid grid-cols-3 gap-4">
                <Stat label="To pay" value={gbp2(outstanding)} sub={`${toPay.length} outstanding`} tone={toPay.length ? 'amber' : null} />
                <Stat label="Overdue" value={gbp2(overdueList.reduce((s, b) => s + owed(b), 0))} sub={`${overdueList.length} overdue`} tone={overdueList.length ? 'red' : null} />
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
                        <div key={b.id} onClick={() => onNavigate?.('bill', b.id)} className="px-5 py-3 flex items-center gap-4 hover:bg-card/50 cursor-pointer">
                          <div className="font-mono text-xs text-dim w-20 shrink-0">BILL-{b.bill_number}</div>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm text-paper font-medium truncate">{supName(b)}</div>
                            <div className="text-[10px] text-dim flex items-center gap-2">
                              {b.cost_context === 'deal' ? <span className="text-uv">deal cost</span> : <span>ongoing</span>}
                              {b.recurring_id && <span className="text-uv flex items-center gap-0.5"><Repeat size={10} /> recurring</span>}
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
            </>
          ) : (
            <div className="glass-card rounded-2xl overflow-hidden">
              <div className="px-5 py-3.5 border-b border-bdr flex items-center gap-2">
                <h3 className="text-[13px] font-bold text-paper">Recurring schedules</h3>
                <span className="text-xs text-dim font-mono">({schedules.length})</span>
                {canWrite && dueCount > 0 && <button onClick={generateDue} className="ml-auto btn-glass px-3 py-1.5 rounded-xl text-xs font-semibold">Generate {dueCount} due now</button>}
              </div>
              <div className="px-5 py-2 text-[11px] text-dim border-b border-bdr">Bills auto-generate as "to pay" on their due day (daily run). You can also generate due ones now.</div>
              <div className="divide-y divide-bdr">
                {schedules.length === 0 ? <div className="p-8 text-center text-dim text-sm italic">No recurring bills yet.</div>
                  : schedules.map(s => {
                    const amount = computeTotals(Array.isArray(s.lines) ? s.lines : []).gross;
                    return (
                      <div key={s.id} onClick={() => canWrite && setEditSched(s)} className="px-5 py-3 flex items-center gap-4 hover:bg-card/50 cursor-pointer">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${s.active ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-paper font-medium truncate">{s.label || s.supplier?.name || 'Recurring bill'}</div>
                          <div className="text-[11px] text-muted">{s.supplier?.name || '—'} · {s.frequency} on day {s.day_of_month}</div>
                        </div>
                        <div className="text-xs text-muted shrink-0">Next: {fmtD(s.next_run)}</div>
                        <div className="text-sm font-semibold text-paper tabular-nums shrink-0 w-24 text-right">{gbp2(amount)}</div>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}
        </div>
      </div>

      {editSched && <ScheduleModal schedule={editSched} suppliers={suppliers} categories={categories} companies={companies} locations={locations}
        profile={profile} onClose={() => setEditSched(null)} onSaved={() => { setEditSched(null); load(); }} />}
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

const minput = "w-full px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper focus:outline-none focus:border-ember";
const mlabel = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block";

function ScheduleModal({ schedule, suppliers, categories, companies, locations, profile, onClose, onSaved }) {
  const s = schedule || {};
  const [f, setF] = useState({
    label: s.label || '', supplier_id: s.supplier_id || '', category_id: s.category_id || '',
    company_id: s.company_id || '', location_id: s.location_id || '', cost_context: s.cost_context || 'ongoing',
    frequency: s.frequency || 'monthly', day_of_month: s.day_of_month ?? 1,
    next_run: s.next_run || new Date().toISOString().slice(0, 10), due_days: s.due_days ?? 14,
    active: s.active ?? true, notes: s.notes || '',
  });
  const [lines, setLines] = useState(Array.isArray(s.lines) && s.lines.length ? s.lines : [{ name: '', description: '', qty: 1, unit_price: 0, tax_rate: 20 }]);
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const setLine = (i, k, v) => setLines(p => p.map((l, j) => j === i ? { ...l, [k]: v } : l));
  const locs = locations.filter(l => !f.company_id || l.company_id === f.company_id);
  const totals = computeTotals(lines);

  const save = async () => {
    const cleanLines = lines.filter(l => (l.name || '').trim()).map(l => ({ name: l.name.trim(), description: (l.description || '').trim() || null, qty: Number(l.qty) || 1, unit_price: Number(l.unit_price) || 0, tax_rate: Number(l.tax_rate) || 0 }));
    if (!cleanLines.length) { alert('Add at least one line'); return; }
    const row = {
      label: f.label.trim() || null, supplier_id: f.supplier_id || null, category_id: f.category_id || null,
      company_id: f.company_id || null, location_id: f.location_id || null, cost_context: f.cost_context,
      frequency: f.frequency, day_of_month: Math.min(28, Math.max(1, Number(f.day_of_month) || 1)),
      next_run: f.next_run, due_days: Number(f.due_days) || 14, lines: cleanLines,
      active: f.active, notes: f.notes.trim() || null, created_by: s.created_by || profile.id, updated_at: new Date().toISOString(),
    };
    const { error } = s.id ? await supabase.from('recurring_bills').update(row).eq('id', s.id) : await supabase.from('recurring_bills').insert(row);
    if (error) { alert(error.message); return; }
    onSaved();
  };
  const del = async () => { if (!confirm('Delete this schedule? Generated bills are kept.')) return; await supabase.from('recurring_bills').delete().eq('id', s.id); onSaved(); };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="glass-card rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-bdr flex items-center justify-between sticky top-0 glass-card z-10">
          <div className="text-base font-bold text-paper">{s.id ? 'Edit recurring bill' : 'New recurring bill'}</div>
          <button onClick={onClose} className="text-muted hover:text-paper"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div><label className={mlabel}>Label</label><input className={minput} value={f.label} onChange={e => set('label', e.target.value)} placeholder="e.g. Office rent" /></div>
            <div><label className={mlabel}>Supplier</label><select className={minput} value={f.supplier_id} onChange={e => set('supplier_id', e.target.value)}><option value="">—</option>{suppliers.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
            <div><label className={mlabel}>Category</label><select className={minput} value={f.category_id} onChange={e => set('category_id', e.target.value)}><option value="">—</option>{categories.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select></div>
            <div><label className={mlabel}>Cost context</label><select className={minput} value={f.cost_context} onChange={e => set('cost_context', e.target.value)}><option value="ongoing">Ongoing</option><option value="deal">Deal cost</option></select></div>
            <div><label className={mlabel}>Customer</label><select className={minput} value={f.company_id} onChange={e => { set('company_id', e.target.value); set('location_id', ''); }}><option value="">—</option>{companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
            <div><label className={mlabel}>Location</label><select className={minput} value={f.location_id} onChange={e => set('location_id', e.target.value)}><option value="">—</option>{locs.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div><label className={mlabel}>Frequency</label><select className={minput} value={f.frequency} onChange={e => set('frequency', e.target.value)}><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="annual">Annual</option></select></div>
            <div><label className={mlabel}>Day of month</label><input type="number" min="1" max="28" className={minput} value={f.day_of_month} onChange={e => set('day_of_month', e.target.value)} /></div>
            <div><label className={mlabel}>Next run</label><input type="date" className={minput} value={f.next_run} onChange={e => set('next_run', e.target.value)} /></div>
            <div><label className={mlabel}>Due (days)</label><input type="number" className={minput} value={f.due_days} onChange={e => set('due_days', e.target.value)} /></div>
            <div className="col-span-2 flex items-end"><button type="button" onClick={() => set('active', !f.active)} className="flex items-center gap-2 text-sm text-paper"><span className={`relative w-9 h-5 rounded-full transition ${f.active ? 'bg-emerald-500' : 'bg-slate-300'}`}><span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${f.active ? 'left-[18px]' : 'left-0.5'}`} /></span>Active</button></div>
          </div>
          <div className="glass-inner rounded-xl p-3 space-y-2">
            <div className="flex items-center"><span className={mlabel + ' !mb-0'}>Line items</span><button onClick={() => setLines(p => [...p, { name: '', description: '', qty: 1, unit_price: 0, tax_rate: 20 }])} className="ml-auto text-xs text-ember hover:text-ember-deep font-medium">+ Line</button></div>
            {lines.map((l, i) => (
              <div key={i} className="flex items-center gap-2">
                <input className={minput + ' flex-1'} value={l.name} onChange={e => setLine(i, 'name', e.target.value)} placeholder="Item" />
                <input type="number" className={minput + ' !w-16'} value={l.qty} onChange={e => setLine(i, 'qty', e.target.value)} placeholder="Qty" />
                <input type="number" className={minput + ' !w-24'} value={l.unit_price} onChange={e => setLine(i, 'unit_price', e.target.value)} placeholder="Unit £" />
                <input type="number" className={minput + ' !w-16'} value={l.tax_rate} onChange={e => setLine(i, 'tax_rate', e.target.value)} placeholder="VAT%" />
                <button onClick={() => setLines(p => p.filter((_, j) => j !== i))} className="text-red-500 hover:text-red-600 shrink-0">×</button>
              </div>
            ))}
            <div className="text-right text-sm font-bold text-paper tabular-nums">Total {gbp2(totals.gross)}</div>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button onClick={save} className="btn-glass px-5 py-2 rounded-xl text-sm font-semibold">Save schedule</button>
            <button onClick={onClose} className="btn-ghost px-4 py-2 rounded-xl text-sm">Cancel</button>
            {s.id && <button onClick={del} className="ml-auto text-red-600 hover:bg-red-50 p-2 rounded-xl"><Trash2 size={16} /></button>}
          </div>
        </div>
      </div>
    </div>
  );
}

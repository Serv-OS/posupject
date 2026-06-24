import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { Receipt, Plus, Repeat, X, Trash2 } from 'lucide-react';

export const money = (v) => `£${Number(v || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtD = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }) : '—';

// Effective display status: sent/viewed past due = overdue
export const invStatus = (inv) => {
  if (['paid', 'void', 'draft'].includes(inv.status)) return inv.status;
  if (inv.due_date && new Date(inv.due_date) < new Date(new Date().toDateString())) return 'overdue';
  return inv.status;
};
export const INV_BADGE = {
  draft: 'bg-slate-200 text-slate-600', sent: 'bg-blue-100 text-blue-700', viewed: 'bg-indigo-100 text-indigo-700',
  paid: 'bg-emerald-100 text-emerald-700', overdue: 'bg-red-100 text-red-700', void: 'bg-slate-100 text-slate-400',
};

export default function InvoicesPanel({ profile, onNavigate }) {
  const [tab, setTab] = useState('invoices');
  const [invoices, setInvoices] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [locations, setLocations] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [products, setProducts] = useState([]);
  const [statusFilter, setStatusFilter] = useState('all');
  const [editSched, setEditSched] = useState(null);
  const [loading, setLoading] = useState(true);
  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  const load = useCallback(async () => {
    setLoading(true);
    const [i, r, c, l, ct, pr] = await Promise.all([
      supabase.from('invoices').select('*, company:companies(name), location:locations(name)').order('created_at', { ascending: false }),
      supabase.from('recurring_invoices').select('*, company:companies(name), location:locations(name)').order('created_at', { ascending: false }),
      supabase.from('companies').select('id, name').order('name'),
      supabase.from('locations').select('id, name, company_id').order('name'),
      supabase.from('contacts').select('id, first_name, last_name, email').order('last_name'),
      supabase.from('products').select('id, name, description, default_price').eq('active', true).order('name'),
    ]);
    setInvoices(i.data || []); setSchedules(r.data || []); setCompanies(c.data || []);
    setLocations(l.data || []); setContacts(ct.data || []); setProducts(pr.data || []);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const newInvoice = async () => {
    const { data, error } = await supabase.from('invoices').insert({
      status: 'draft', created_by: profile.id,
      due_date: new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10),
    }).select('id').single();
    if (error) { alert(error.message); return; }
    onNavigate?.('invoice', data.id);
  };

  const custName = (x) => x.location?.name || x.company?.name || x.label || '—';

  const open = invoices.filter(i => ['sent', 'viewed'].includes(i.status));
  const outstanding = open.reduce((s, i) => s + Number(i.total || 0), 0);
  const overdueList = invoices.filter(i => invStatus(i) === 'overdue');
  const overdueSum = overdueList.reduce((s, i) => s + Number(i.total || 0), 0);
  const mStart = new Date(); mStart.setDate(1);
  const paidThisMonth = invoices.filter(i => i.status === 'paid' && i.paid_at && new Date(i.paid_at) >= mStart)
    .reduce((s, i) => s + Number(i.amount_paid ?? i.total ?? 0), 0);

  const filtered = statusFilter === 'all' ? invoices : invoices.filter(i => invStatus(i) === statusFilter);

  const input = "px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper focus:outline-none focus:border-ember";

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-5 border-b border-bdr flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2.5">
          <Receipt size={20} className="text-ember" />
          <div>
            <div className="text-xl font-bold text-paper">Invoices</div>
            <div className="text-xs text-muted">Raise, send and track payment</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-0.5 bg-card rounded-xl p-0.5">
            <button onClick={() => setTab('invoices')} className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${tab === 'invoices' ? 'bg-ember text-white' : 'text-muted'}`}>Invoices</button>
            <button onClick={() => setTab('recurring')} className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold ${tab === 'recurring' ? 'bg-ember text-white' : 'text-muted'}`}><Repeat size={12} /> Recurring</button>
          </div>
          {canWrite && (tab === 'invoices'
            ? <button onClick={newInvoice} className="btn-glass px-4 py-2 rounded-xl text-sm font-semibold flex items-center gap-1.5"><Plus size={15} /> New invoice</button>
            : <button onClick={() => setEditSched({})} className="btn-glass px-4 py-2 rounded-xl text-sm font-semibold flex items-center gap-1.5"><Plus size={15} /> New schedule</button>)}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-[1100px] mx-auto space-y-5">

          {/* Headline */}
          <div className="grid grid-cols-3 gap-4">
            <Stat label="Outstanding" value={money(outstanding)} sub={`${open.length} open invoice${open.length !== 1 ? 's' : ''}`} />
            <Stat label="Overdue" value={money(overdueSum)} sub={`${overdueList.length} overdue`} tone={overdueList.length ? 'red' : null} />
            <Stat label="Paid this month" value={money(paidThisMonth)} tone="emerald" />
          </div>

          {tab === 'invoices' ? (
            <div className="glass-card rounded-2xl overflow-hidden">
              <div className="px-5 py-3.5 border-b border-bdr flex items-center gap-2">
                <h3 className="text-[13px] font-bold text-paper">All invoices</h3>
                <span className="text-xs text-dim font-mono">({filtered.length})</span>
                <select className={input + ' ml-auto !py-1.5 text-xs'} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
                  <option value="all">All statuses</option>
                  {['draft', 'sent', 'viewed', 'overdue', 'paid', 'void'].map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div className="divide-y divide-bdr">
                {loading ? <div className="p-6 text-center text-dim text-sm">Loading…</div>
                  : filtered.length === 0 ? <div className="p-8 text-center text-dim text-sm italic">No invoices yet — raise your first one.</div>
                  : filtered.map(inv => {
                    const st = invStatus(inv);
                    return (
                      <div key={inv.id} onClick={() => onNavigate?.('invoice', inv.id)}
                        className="px-5 py-3 flex items-center gap-4 hover:bg-card/50 cursor-pointer">
                        <div className="font-mono text-xs text-dim w-20 shrink-0">INV-{inv.invoice_number}</div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-paper font-medium truncate">{custName(inv)}</div>
                          {inv.viewed_at && <div className="text-[10px] text-emerald-600">👁 Viewed {new Date(inv.viewed_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>}
                          {inv.recurring_id && <div className="text-[10px] text-uv flex items-center gap-1"><Repeat size={10} /> recurring</div>}
                        </div>
                        <div className="text-xs text-muted shrink-0 w-24 text-right">Due {fmtD(inv.due_date)}</div>
                        <div className="text-sm font-semibold text-paper tabular-nums shrink-0 w-24 text-right">{money(inv.total)}</div>
                        <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-lg shrink-0 w-20 text-center ${INV_BADGE[st]}`}>{st}</span>
                      </div>
                    );
                  })}
              </div>
            </div>
          ) : (
            <div className="glass-card rounded-2xl overflow-hidden">
              <div className="px-5 py-3.5 border-b border-bdr">
                <h3 className="text-[13px] font-bold text-paper">Recurring schedules</h3>
                <div className="text-[11px] text-dim">Invoices are generated and emailed automatically on the day they're due to go out (daily run at 6am).</div>
              </div>
              <div className="divide-y divide-bdr">
                {schedules.length === 0 ? <div className="p-8 text-center text-dim text-sm italic">No recurring invoices yet.</div>
                  : schedules.map(s => {
                    const amount = (Array.isArray(s.lines) ? s.lines : []).reduce((sum, l) => sum + (Number(l.qty) || 1) * (Number(l.unit_price) || 0), 0) * (1 + Number(s.tax_rate || 0) / 100);
                    return (
                      <div key={s.id} onClick={() => canWrite && setEditSched(s)}
                        className="px-5 py-3 flex items-center gap-4 hover:bg-card/50 cursor-pointer">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${s.active ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-paper font-medium truncate">{s.label || custName(s)}</div>
                          <div className="text-[11px] text-muted">{custName(s)} · {s.frequency} on day {s.day_of_month}{s.auto_send ? ' · auto-send' : ' · draft only'}</div>
                        </div>
                        <div className="text-xs text-muted shrink-0">Next: {fmtD(s.next_run)}</div>
                        <div className="text-sm font-semibold text-paper tabular-nums shrink-0 w-24 text-right">{money(amount)}</div>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}
        </div>
      </div>

      {editSched && <ScheduleModal schedule={editSched} companies={companies} locations={locations} contacts={contacts}
        products={products} profile={profile} onClose={() => setEditSched(null)} onSaved={() => { setEditSched(null); load(); }} />}
    </div>
  );
}

function Stat({ label, value, sub, tone }) {
  const color = tone === 'red' ? 'text-red-600' : tone === 'emerald' ? 'text-emerald-600' : 'text-paper';
  return (
    <div className="glass-card rounded-2xl p-4">
      <div className="text-[10px] font-mono font-bold uppercase tracking-[0.14em] text-dim mb-1">{label}</div>
      <div className={`text-2xl font-bold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="text-[11px] text-dim mt-0.5">{sub}</div>}
    </div>
  );
}

// Solid, clearly-bordered fields so the boxes are readable on the white modal
// (the translucent bg-card + white border made them blend in). Theme-aware.
const input = "w-full px-3 py-2 rounded-xl text-sm bg-white/85 dark:bg-white/[0.06] border border-slate-300 dark:border-white/20 text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-white/35 focus:outline-none focus:border-ember focus:ring-2 focus:ring-ember/30";
const label = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-slate-500 dark:text-dim mb-1 block";

function ScheduleModal({ schedule, companies, locations, contacts, products = [], profile, onClose, onSaved }) {
  const s = schedule || {};
  const [f, setF] = useState({
    label: s.label || '', company_id: s.company_id || '', location_id: s.location_id || '', contact_id: s.contact_id || '',
    email_to: s.email_to || '', frequency: s.frequency || 'monthly', day_of_month: s.day_of_month ?? 1,
    next_run: s.next_run || new Date().toISOString().slice(0, 10), due_days: s.due_days ?? 14,
    tax_rate: s.tax_rate ?? 20, terms: s.terms || '', notes: s.notes || '',
    auto_send: s.auto_send ?? true, active: s.active ?? true,
  });
  const [lines, setLines] = useState(Array.isArray(s.lines) && s.lines.length ? s.lines : [{ name: '', description: '', qty: 1, unit_price: 0 }]);
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const setLine = (i, k, v) => setLines(p => p.map((l, j) => j === i ? { ...l, [k]: v } : l));
  const locs = locations.filter(l => !f.company_id || l.company_id === f.company_id);

  const subtotal = lines.reduce((sum, l) => sum + (Number(l.qty) || 0) * (Number(l.unit_price) || 0), 0);
  const total = subtotal * (1 + Number(f.tax_rate || 0) / 100);

  const save = async () => {
    if (!f.company_id && !f.contact_id) { alert('Pick a customer (company or contact)'); return; }
    const cleanLines = lines.filter(l => (l.name || '').trim());
    if (!cleanLines.length) { alert('Add at least one line item'); return; }
    const row = {
      label: f.label.trim() || null, company_id: f.company_id || null, location_id: f.location_id || null,
      contact_id: f.contact_id || null, email_to: f.email_to.trim() || null,
      frequency: f.frequency, day_of_month: Math.min(28, Math.max(1, Number(f.day_of_month) || 1)),
      next_run: f.next_run, due_days: Number(f.due_days) || 14, tax_rate: Number(f.tax_rate) || 0,
      lines: cleanLines.map(l => ({ name: l.name.trim(), description: (l.description || '').trim() || null, qty: Number(l.qty) || 1, unit_price: Number(l.unit_price) || 0 })),
      terms: f.terms.trim() || null, notes: f.notes.trim() || null,
      auto_send: f.auto_send, active: f.active, created_by: s.created_by || profile.id,
    };
    const { error } = s.id
      ? await supabase.from('recurring_invoices').update(row).eq('id', s.id)
      : await supabase.from('recurring_invoices').insert(row);
    if (error) { alert(error.message); return; }
    onSaved();
  };

  const del = async () => {
    if (!confirm('Delete this recurring schedule? Already-generated invoices are kept.')) return;
    await supabase.from('recurring_invoices').delete().eq('id', s.id);
    onSaved();
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="glass-card rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-bdr flex items-center justify-between sticky top-0 glass-card z-10">
          <div className="text-base font-bold text-paper">{s.id ? 'Edit recurring invoice' : 'New recurring invoice'}</div>
          <button onClick={onClose} className="text-muted hover:text-paper"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div><label className={label}>Label (optional)</label><input className={input} value={f.label} onChange={e => set('label', e.target.value)} placeholder="e.g. Monthly SaaS plan" /></div>
            <div><label className={label}>Send to (email)</label><input className={input} value={f.email_to} onChange={e => set('email_to', e.target.value)} placeholder="defaults to contact's email" /></div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div><label className={label}>Company</label>
              <select className={input} value={f.company_id} onChange={e => { set('company_id', e.target.value); set('location_id', ''); }}>
                <option value="">—</option>{companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
            <div><label className={label}>Location</label>
              <select className={input} value={f.location_id} onChange={e => set('location_id', e.target.value)}>
                <option value="">—</option>{locs.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
            <div><label className={label}>Contact</label>
              <select className={input} value={f.contact_id} onChange={e => set('contact_id', e.target.value)}>
                <option value="">—</option>{contacts.map(c => <option key={c.id} value={c.id}>{[c.first_name, c.last_name].filter(Boolean).join(' ') || c.email}</option>)}</select></div>
          </div>
          <div className="grid grid-cols-4 gap-3">
            <div><label className={label}>Frequency</label>
              <select className={input} value={f.frequency} onChange={e => set('frequency', e.target.value)}>
                <option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="annual">Annual</option></select></div>
            <div><label className={label}>Day of month</label><input type="number" min="1" max="28" className={input} value={f.day_of_month} onChange={e => set('day_of_month', e.target.value)} /></div>
            <div><label className={label}>First / next run</label><input type="date" className={input} value={f.next_run} onChange={e => set('next_run', e.target.value)} /></div>
            <div><label className={label}>Due (days)</label><input type="number" className={input} value={f.due_days} onChange={e => set('due_days', e.target.value)} /></div>
          </div>

          {/* Lines */}
          <div className="glass-inner rounded-xl p-3 space-y-2">
            <div className="flex items-center gap-3">
              <span className={label + ' !mb-0'}>Line items</span>
              <div className="ml-auto flex items-center gap-3">
                {products.length > 0 && (
                  <select className={input + ' !w-48 !py-1.5 text-xs'} value=""
                    onChange={e => {
                      const p = products.find(x => x.id === e.target.value);
                      if (p) setLines(prev => {
                        const blank = prev.length === 1 && !(prev[0].name || '').trim();
                        const line = { name: p.name, description: p.description || '', qty: 1, unit_price: Number(p.default_price) || 0 };
                        return blank ? [line] : [...prev, line];
                      });
                    }}>
                    <option value="">+ From products…</option>
                    {products.map(p => <option key={p.id} value={p.id}>{p.name} — £{Number(p.default_price).toLocaleString('en-GB')}</option>)}
                  </select>
                )}
                <button onClick={() => setLines(p => [...p, { name: '', description: '', qty: 1, unit_price: 0 }])}
                  className="text-xs text-ember hover:text-ember-deep font-medium">+ Blank line</button>
              </div>
            </div>
            {lines.map((l, i) => (
              <div key={i} className="flex gap-2 items-start">
                <div className="flex-1 space-y-1">
                  <input className={input} value={l.name} onChange={e => setLine(i, 'name', e.target.value)} placeholder="Item name" />
                  <input className={input + ' text-xs'} value={l.description || ''} onChange={e => setLine(i, 'description', e.target.value)} placeholder="Description (optional)" />
                </div>
                <input className={input + ' w-16 text-right'} value={l.qty} onChange={e => setLine(i, 'qty', e.target.value)} placeholder="Qty" />
                <input className={input + ' w-24 text-right'} value={l.unit_price} onChange={e => setLine(i, 'unit_price', e.target.value)} placeholder="Price" />
                <button onClick={() => setLines(p => p.filter((_, j) => j !== i))} className="text-dim hover:text-red-600 p-2"><Trash2 size={14} /></button>
              </div>
            ))}
            <div className="flex justify-end gap-4 text-sm pt-1">
              <span className="text-muted">VAT <input className={input + ' !w-16 !py-1 inline-block text-right ml-1'} value={f.tax_rate} onChange={e => set('tax_rate', e.target.value)} />%</span>
              <span className="font-bold text-paper tabular-nums">Total {money(total)}</span>
            </div>
          </div>

          <div className="flex items-center gap-5">
            <Toggle checked={f.auto_send} onChange={v => set('auto_send', v)} label="Auto-send by email" />
            <Toggle checked={f.active} onChange={v => set('active', v)} label="Active" />
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

function Toggle({ checked, onChange, label: lbl }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className="flex items-center gap-2">
      <span className={`relative w-9 h-5 rounded-full transition ${checked ? 'bg-emerald-500' : 'bg-slate-300'}`}>
        <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`} />
      </span>
      <span className="text-sm text-paper">{lbl}</span>
    </button>
  );
}

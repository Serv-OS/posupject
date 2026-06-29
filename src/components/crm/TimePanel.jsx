import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { fmtDuration } from '../../lib/timer';
import { Clock, Trash2, Plus, Users, Building2 } from 'lucide-react';

const SUBJECT_LABEL = { ticket: 'Ticket', task: 'Task', project: 'Project', company: 'Company', location: 'Location', deal: 'Deal', lead: 'Lead', contact: 'Contact', onboarding: 'Onboarding' };

// date helpers (local) -> yyyy-mm-dd
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function presetRange(key) {
  const now = new Date();
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  if (key === 'today') return { from: iso(start), to: iso(now) };
  if (key === 'week') { const d = new Date(start); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); return { from: iso(d), to: iso(now) }; }
  if (key === 'month') { const d = new Date(start.getFullYear(), start.getMonth(), 1); return { from: iso(d), to: iso(now) }; }
  return { from: '', to: '' }; // all time
}

export default function TimePanel({ profile, onNavigate }) {
  const [preset, setPreset] = useState('week');
  const [range, setRange] = useState(presetRange('week'));
  const [entries, setEntries] = useState([]);
  const [members, setMembers] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [staffFilter, setStaffFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ date: iso(new Date()), hours: '', company_id: '', label: '', note: '' });

  const isOwner = profile.role === 'owner';

  const applyPreset = (key) => { setPreset(key); if (key !== 'custom') setRange(presetRange(key)); };

  const load = useCallback(async () => {
    setLoading(true);
    let q = supabase.from('time_entries')
      .select('*, profile:profiles(display_name, email), company:companies(name)')
      .not('ended_at', 'is', null)
      .order('started_at', { ascending: false });
    if (range.from) q = q.gte('started_at', `${range.from}T00:00:00`);
    if (range.to) q = q.lte('started_at', `${range.to}T23:59:59`);
    const [e, m, c] = await Promise.all([
      q,
      supabase.from('profiles').select('id, display_name, email'),
      supabase.from('companies').select('id, name').order('name'),
    ]);
    setEntries(e.data || []);
    setMembers(m.data || []);
    setCompanies(c.data || []);
    setLoading(false);
  }, [range]);

  useEffect(() => { load(); }, [load]);

  const filtered = staffFilter === 'all' ? entries : entries.filter(e => e.profile_id === staffFilter);

  // Aggregations
  const byStaff = {};
  const byCompany = {};
  let total = 0;
  for (const e of filtered) {
    const sec = e.duration_seconds || 0;
    total += sec;
    const sName = e.profile?.display_name || e.profile?.email?.split('@')[0] || 'Unknown';
    byStaff[sName] = (byStaff[sName] || 0) + sec;
    const cName = e.company?.name || 'No customer';
    byCompany[cName] = (byCompany[cName] || 0) + sec;
  }
  const staffRows = Object.entries(byStaff).sort((a, b) => b[1] - a[1]);
  const companyRows = Object.entries(byCompany).sort((a, b) => b[1] - a[1]);

  const addManual = async () => {
    const hours = parseFloat(form.hours);
    if (!hours || hours <= 0) { alert('Enter hours, e.g. 1.5'); return; }
    const start = new Date(`${form.date}T09:00:00`);
    const seconds = Math.round(hours * 3600);
    const { error } = await supabase.from('time_entries').insert({
      profile_id: profile.id,
      subject_type: null, subject_id: null,
      label: form.label.trim() || 'Manual entry',
      company_id: form.company_id || null,
      note: form.note.trim() || null,
      started_at: start.toISOString(),
      ended_at: new Date(start.getTime() + seconds * 1000).toISOString(),
      duration_seconds: seconds,
    });
    if (error) { alert(error.message); return; }
    setForm({ date: iso(new Date()), hours: '', company_id: '', label: '', note: '' });
    setAdding(false);
    load();
  };

  const del = async (id) => {
    if (!confirm('Delete this time entry?')) return;
    await supabase.from('time_entries').delete().eq('id', id);
    load();
  };

  const input = "w-full px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper placeholder-dim focus:outline-none focus:border-ember";
  const hrs = (sec) => (sec / 3600).toFixed(1);

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-5 border-b border-bdr flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2.5">
          <Clock size={20} className="text-ember" />
          <div>
            <div className="text-xl font-bold text-paper">Time Tracking</div>
            <div className="text-xs text-muted">Hours by staff and by customer</div>
          </div>
        </div>
        <button onClick={() => setAdding(v => !v)} className="btn-glass px-4 py-2 rounded-xl text-sm font-semibold flex items-center gap-1.5">
          <Plus size={15} /> Add time
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-[1200px] mx-auto space-y-5">

          {/* Filters */}
          <div className="flex items-center gap-2 flex-wrap">
            {[['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['all', 'All time']].map(([k, lbl]) => (
              <button key={k} onClick={() => applyPreset(k)}
                className={`px-3 py-1.5 rounded-xl text-sm transition ${preset === k ? 'bg-ember text-white font-semibold' : 'btn-ghost'}`}>{lbl}</button>
            ))}
            <div className="flex items-center gap-1.5 ml-1">
              <input type="date" value={range.from} onChange={e => { setPreset('custom'); setRange(r => ({ ...r, from: e.target.value })); }} className={input + ' w-auto'} />
              <span className="text-dim text-xs">to</span>
              <input type="date" value={range.to} onChange={e => { setPreset('custom'); setRange(r => ({ ...r, to: e.target.value })); }} className={input + ' w-auto'} />
            </div>
            <select value={staffFilter} onChange={e => setStaffFilter(e.target.value)} className={input + ' w-auto ml-auto'}>
              <option value="all">All staff</option>
              {members.map(m => <option key={m.id} value={m.id}>{m.display_name || m.email}</option>)}
            </select>
          </div>

          {/* Add manual entry */}
          {adding && (
            <div className="glass-card rounded-2xl p-5 space-y-3">
              <div className="text-sm font-bold text-paper">Log time manually</div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div><div className="text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1">Date</div>
                  <input type="date" className={input} value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} /></div>
                <div><div className="text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1">Hours</div>
                  <input className={input} value={form.hours} onChange={e => setForm({ ...form, hours: e.target.value })} placeholder="1.5" /></div>
                <div className="col-span-2"><div className="text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1">Customer</div>
                  <select className={input} value={form.company_id} onChange={e => setForm({ ...form, company_id: e.target.value })}>
                    <option value="">No customer</option>
                    {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select></div>
              </div>
              <input className={input} value={form.label} onChange={e => setForm({ ...form, label: e.target.value })} placeholder="What did you work on?" />
              <div className="flex gap-2">
                <button onClick={addManual} className="btn-glass px-4 py-2 rounded-xl text-sm font-semibold">Save entry</button>
                <button onClick={() => setAdding(false)} className="btn-ghost px-4 py-2 rounded-xl text-sm">Cancel</button>
              </div>
            </div>
          )}

          {/* Total */}
          <div className="glass-card rounded-2xl p-5 flex items-center gap-4">
            <div className="text-3xl font-bold text-paper tabular-nums">{hrs(total)}</div>
            <div className="text-sm text-muted">total hours logged{staffFilter !== 'all' ? ' (selected staff)' : ''} in this period</div>
          </div>

          {/* Two report tables */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <ReportTable icon={<Users size={15} />} title="Hours by staff member" rows={staffRows} total={total} hrs={hrs} />
            <ReportTable icon={<Building2 size={15} />} title="Hours by customer" rows={companyRows} total={total} hrs={hrs} />
          </div>

          {/* Timesheet */}
          <div className="glass-card rounded-2xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-bdr flex items-center gap-2">
              <h3 className="text-[13px] font-bold text-paper">Timesheet</h3>
              <span className="text-xs text-dim font-mono">({filtered.length})</span>
            </div>
            <div className="divide-y divide-bdr">
              {loading ? <div className="p-6 text-center text-dim text-sm">Loading…</div>
                : filtered.length === 0 ? <div className="p-6 text-center text-dim text-sm italic">No time logged in this period.</div>
                : filtered.map(e => {
                  const sName = e.profile?.display_name || e.profile?.email?.split('@')[0] || 'Unknown';
                  const canDelete = e.profile_id === profile.id || isOwner;
                  return (
                    <div key={e.id} className="px-5 py-3 flex items-center gap-3 text-sm hover:bg-card/50">
                      <div className="w-7 h-7 rounded-full bg-ember/15 text-ember-deep text-[11px] font-bold flex items-center justify-center shrink-0">{sName[0]?.toUpperCase()}</div>
                      <div className="flex-1 min-w-0">
                        <div className="text-paper truncate">
                          {e.subject_type && e.subject_id
                            ? <button onClick={() => onNavigate?.(e.subject_type, e.subject_id)} className="hover:text-ember">{e.label || SUBJECT_LABEL[e.subject_type]}</button>
                            : (e.label || 'Manual entry')}
                        </div>
                        <div className="text-[11px] text-muted truncate">
                          {sName}{e.company?.name ? ` · ${e.company.name}` : ''}{e.subject_type ? ` · ${SUBJECT_LABEL[e.subject_type] || e.subject_type}` : ''}
                        </div>
                      </div>
                      <div className="text-xs text-dim shrink-0">{new Date(e.started_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</div>
                      <div className="text-sm font-mono font-semibold text-paper tabular-nums shrink-0 w-20 text-right">{fmtDuration(e.duration_seconds)}</div>
                      {canDelete && <button onClick={() => del(e.id)} className="text-dim hover:text-red-600 shrink-0"><Trash2 size={14} /></button>}
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

function ReportTable({ icon, title, rows, total, hrs }) {
  return (
    <div className="glass-card rounded-2xl overflow-hidden">
      <div className="px-5 py-3.5 border-b border-bdr flex items-center gap-2">
        <span className="text-ember">{icon}</span>
        <h3 className="text-[13px] font-bold text-paper">{title}</h3>
      </div>
      <div className="p-2">
        {rows.length === 0 ? <div className="p-4 text-center text-dim text-sm italic">No data</div>
          : rows.map(([name, sec]) => {
            const pct = total > 0 ? (sec / total) * 100 : 0;
            return (
              <div key={name} className="px-3 py-2">
                <div className="flex items-center justify-between text-sm mb-1">
                  <span className="text-paper truncate">{name}</span>
                  <span className="font-mono font-semibold text-paper tabular-nums ml-2">{hrs(sec)}h</span>
                </div>
                <div className="h-1.5 rounded-full bg-card overflow-hidden">
                  <div className="h-full bg-ember rounded-full" style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
}

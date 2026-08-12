import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Plane, Thermometer, Check, X, Plus } from 'lucide-react';
import { isoDate, daysBetween, leaveBalance } from '../../lib/staffing';

export default function TimeOffView({ profile }) {
  const [requests, setRequests] = useState([]);
  const [staff, setStaff] = useState([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ user_id: '', type: 'holiday', start_date: isoDate(new Date()), end_date: isoDate(new Date()), note: '' });
  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  useEffect(() => { load(); }, []);
  const load = async () => {
    const [r, p] = await Promise.all([
      supabase.from('time_off').select('*').order('created_at', { ascending: false }),
      supabase.from('profiles').select('id, display_name, email, leave_entitlement_days').order('display_name'),
    ]);
    setRequests(r.data || []); setStaff(p.data || []);
  };

  const nameOf = (id) => { const p = staff.find(s => s.id === id); return p?.display_name || p?.email?.split('@')[0] || '?'; };
  const pending = requests.filter(r => r.status === 'pending');
  // Approved leave that hasn't finished yet — the "booked" days on the balance
  // bar. These were invisible: once approved, an entry could be neither seen
  // nor cancelled, so a wrongly-booked fortnight was stuck on the balance.
  const todayIso = isoDate(new Date());
  const upcoming = requests
    .filter(r => r.status === 'approved' && r.end_date >= todayIso)
    .sort((a, b) => a.start_date.localeCompare(b.start_date));

  const cancelBooking = async (r) => {
    if (!confirm(`Remove ${nameOf(r.user_id)}'s ${r.type} (${r.days} day${r.days === 1 ? '' : 's'}, starting ${new Date(r.start_date + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })})?\n\nThe days go straight back on their balance.`)) return;
    const { error } = await supabase.from('time_off').delete().eq('id', r.id);
    if (error) { alert('Could not remove it: ' + error.message); return; }
    load();
  };

  const decide = async (id, status) => {
    await supabase.from('time_off').update({ status, decided_by: profile.id, decided_at: new Date().toISOString() }).eq('id', id);
    load();
  };

  // Dates already behind us are a record, not a request — there is nobody to
  // approve leave that has already been taken. It used to be refused outright
  // ("Holiday must be a future date"), which meant holiday taken before this
  // module existed could never be logged and every balance showed 0 taken.
  const isBackfill = form.start_date < isoDate(new Date());

  const addRequest = async () => {
    if (!form.user_id) { alert('Pick a staff member'); return; }
    const days = daysBetween(form.start_date, form.end_date);
    const row = {
      user_id: form.user_id, type: form.type, start_date: form.start_date, end_date: form.end_date,
      days, note: form.note.trim() || null,
      ...(isBackfill
        ? { status: 'approved', decided_by: profile.id, decided_at: new Date().toISOString() }
        : { status: 'pending' }),
    };
    const { error } = await supabase.from('time_off').insert(row);
    if (error) { alert(error.message); return; }
    setForm({ user_id: '', type: 'holiday', start_date: isoDate(new Date()), end_date: isoDate(new Date()), note: '' });
    setAdding(false); load();
  };

  const input = "w-full px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper focus:outline-none focus:border-ember";
  const label = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block";

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-5 border-b border-bdr flex items-center justify-between">
        <div>
          <div className="text-xl font-bold text-paper">Time Off</div>
          <div className="text-xs text-muted">Requests, approvals and leave balances</div>
        </div>
        {canWrite && <button onClick={() => setAdding(v => !v)} className="btn-glass px-4 py-2 rounded-xl text-sm font-semibold flex items-center gap-1.5"><Plus size={15} /> Log time off</button>}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-[1100px] mx-auto space-y-6">

          {adding && (
            <div className="glass-card rounded-2xl p-5 space-y-3">
              <div className="text-sm font-bold text-paper">Log / request time off</div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div><label className={label}>Staff</label>
                  <select className={input} value={form.user_id} onChange={e => setForm({ ...form, user_id: e.target.value })}>
                    <option value="">Select…</option>{staff.map(s => <option key={s.id} value={s.id}>{s.display_name || s.email}</option>)}
                  </select></div>
                <div><label className={label}>Type</label>
                  <select className={input} value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}>
                    <option value="holiday">Holiday</option><option value="sick">Sick</option>
                  </select></div>
                <div><label className={label}>From</label><input type="date" className={input} value={form.start_date} onChange={e => setForm({ ...form, start_date: e.target.value })} /></div>
                <div><label className={label}>To</label><input type="date" className={input} value={form.end_date} onChange={e => setForm({ ...form, end_date: e.target.value })} /></div>
              </div>
              <input className={input} placeholder="Note (optional)" value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} />
              {isBackfill && (
                <div className="text-xs text-amber-600 bg-amber-500/10 border border-amber-500/25 rounded-xl px-3 py-2">
                  These dates are in the past, so this is logged as <b>taken</b> straight away — no approval step —
                  and it comes off the balance immediately.
                </div>
              )}
              <div className="flex gap-2"><button onClick={addRequest} className="btn-glass px-4 py-2 rounded-xl text-sm font-semibold">{isBackfill ? 'Log as taken' : 'Submit'}</button>
                <button onClick={() => setAdding(false)} className="btn-ghost px-4 py-2 rounded-xl text-sm">Cancel</button></div>
            </div>
          )}

          {/* Request queue */}
          <div>
            <div className="text-[11px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-2">Pending requests ({pending.length})</div>
            {pending.length === 0 ? <div className="glass-card rounded-2xl p-6 text-center text-dim text-sm italic">No pending requests</div>
              : <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {pending.map(r => (
                  <div key={r.id} className="glass-card rounded-2xl p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <span className={`w-8 h-8 rounded-xl flex items-center justify-center ${r.type === 'sick' ? 'bg-red-100 text-red-600' : 'bg-amber-100 text-amber-600'}`}>
                        {r.type === 'sick' ? <Thermometer size={16} /> : <Plane size={16} />}
                      </span>
                      <div className="flex-1">
                        <div className="text-sm font-semibold text-paper">{nameOf(r.user_id)}</div>
                        <div className="text-xs text-muted capitalize">{r.type} · {r.days} day{r.days !== 1 ? 's' : ''}</div>
                      </div>
                    </div>
                    <div className="text-xs text-muted mb-2">
                      {new Date(r.start_date + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                      {r.end_date !== r.start_date && ` – ${new Date(r.end_date + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`}
                      {r.note && <span className="block text-dim mt-0.5">"{r.note}"</span>}
                    </div>
                    {canWrite && (
                      <div className="flex gap-2">
                        <button onClick={() => decide(r.id, 'approved')} className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 rounded-xl bg-emerald-500/15 text-emerald-700 border border-emerald-500/30 text-xs font-semibold hover:bg-emerald-500/25"><Check size={14} /> Approve</button>
                        <button onClick={() => decide(r.id, 'denied')} className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 rounded-xl bg-red-500/10 text-red-600 border border-red-500/25 text-xs font-semibold hover:bg-red-500/20"><X size={14} /> Deny</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>}
          </div>

          {/* Upcoming approved leave — visible, and removable while it still matters */}
          <div>
            <div className="text-[11px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-2">Upcoming &amp; booked ({upcoming.length})</div>
            {upcoming.length === 0
              ? <div className="glass-card rounded-2xl p-6 text-center text-dim text-sm italic">Nothing booked ahead</div>
              : <div className="glass-card rounded-2xl overflow-hidden divide-y divide-bdr">
                {upcoming.map(r => (
                  <div key={r.id} className="px-5 py-3 flex items-center gap-3">
                    <span className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${r.type === 'sick' ? 'bg-red-100 text-red-600' : 'bg-amber-100 text-amber-600'}`}>
                      {r.type === 'sick' ? <Thermometer size={16} /> : <Plane size={16} />}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold text-paper truncate">{nameOf(r.user_id)}</div>
                      <div className="text-xs text-muted">
                        {new Date(r.start_date + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                        {r.end_date !== r.start_date && ` – ${new Date(r.end_date + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`}
                        {' · '}{r.days} day{r.days !== 1 ? 's' : ''} · <span className="capitalize">{r.type}</span>
                        {r.start_date <= todayIso && <span className="text-emerald-600 font-semibold"> · under way</span>}
                        {r.note && <span className="text-dim"> · "{r.note}"</span>}
                      </div>
                    </div>
                    {canWrite && (
                      <button onClick={() => cancelBooking(r)}
                        className="shrink-0 flex items-center gap-1 px-3 py-1.5 rounded-xl bg-red-500/10 text-red-600 border border-red-500/25 text-xs font-semibold hover:bg-red-500/20">
                        <X size={13} /> Remove
                      </button>
                    )}
                  </div>
                ))}
              </div>}
          </div>

          {/* Balances */}
          <div className="glass-card rounded-2xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-bdr"><h3 className="text-[13px] font-bold text-paper">Leave balances</h3></div>
            <div className="divide-y divide-bdr">
              {staff.map(s => {
                const b = leaveBalance(requests, s.id, s.leave_entitlement_days);
                const used = b.taken + b.booked;
                const pct = b.entitled > 0 ? (used / b.entitled) * 100 : 0;
                return (
                  <div key={s.id} className="px-5 py-3 flex items-center gap-4">
                    <div className="w-40 text-sm text-paper truncate">{s.display_name || s.email?.split('@')[0]}</div>
                    <div className="flex-1">
                      <div className="h-2 rounded-full bg-card overflow-hidden"><div className="h-full bg-ember rounded-full" style={{ width: `${Math.min(100, pct)}%` }} /></div>
                    </div>
                    <div className="text-xs text-muted shrink-0 w-56 text-right tabular-nums">
                      <span className="text-paper font-semibold">{b.remaining}</span> left · {b.taken} taken{b.booked ? ` · ${b.booked} booked` : ''} / {b.entitled}
                    </div>
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

import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { ChevronLeft, ChevronRight, Check, AlertTriangle, Plane, Ban } from 'lucide-react';
import { isoDate, mondayOf, weekDays, DOW_SHORT, fmtRange, shiftHours } from '../../lib/staffing';
import MonthReport from './MonthReport.jsx';

function PeriodTabs({ period, setPeriod }) {
  return (
    <div className="px-4 lg:px-6 pt-3 flex gap-1 border-b border-bdr shrink-0">
      {[['week', 'By week'], ['month', 'Month (for payroll)']].map(([k, lbl]) => (
        <button key={k} onClick={() => setPeriod(k)}
          className={`px-3 py-1.5 text-xs font-semibold rounded-t-lg transition ${
            period === k ? 'bg-card text-paper border border-b-0 border-bdr' : 'text-muted hover:text-paper'
          }`}>{lbl}</button>
      ))}
    </div>
  );
}

// The week's timesheet: what each person was scheduled, what they actually
// clocked, and the difference — with holiday and sick sitting on the same row
// so an empty day reads as "booked off", not "missing".
//
// Approval is the point. A punch is the person's own claim until a manager
// signs it off; the database refuses to let anyone approve their own (the
// trigger freezes approved_by/at for non-managers), so this screen is the
// only way hours become final.

// Always render a punch in the timezone of the person who made it. Showing a
// California punch on a London clock is what made "+481m late" look like a bug
// rather than a timezone.
const HHMM = (ts, tz) => ts ? new Date(ts).toLocaleTimeString('en-GB',
  { hour: '2-digit', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) }) : '—';
// 'YYYY-MM-DD HH:MM' in that person's zone — the format punch_edit expects.
const localInput = (ts, tz) => {
  if (!ts) return '';
  const d = new Date(ts);
  const opt = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, ...(tz ? { timeZone: tz } : {}) };
  const parts = new Intl.DateTimeFormat('en-CA', opt).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
};
const asHrs = (m) => m == null ? '—' : `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, '0')}m`;
// Positive = late in / late out. Small drifts aren't worth colouring.
const varLabel = (m) => m == null || Math.abs(m) < 5 ? null : `${m > 0 ? '+' : ''}${Math.round(m)}m`;

const STATUS = {
  open:        { label: 'Still in', cls: 'bg-ember/15 text-ember-deep border-ember/25' },
  complete:    { label: 'To approve', cls: 'bg-amber-100 text-amber-700 border-amber-200' },
  auto_closed: { label: 'Auto-closed', cls: 'bg-red-100 text-red-700 border-red-200' },
  disputed:    { label: 'Disputed', cls: 'bg-red-100 text-red-700 border-red-200' },
  approved:    { label: 'Approved', cls: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  voided:      { label: 'Voided', cls: 'bg-slate-200 text-slate-500 border-slate-300' },
};

export default function TimesheetsView({ profile }) {
  const [monday, setMonday] = useState(() => mondayOf(new Date()));
  const [staff, setStaff] = useState([]);
  const [punches, setPunches] = useState([]);
  const [shifts, setShifts] = useState([]);
  const [timeOff, setTimeOff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);

  // Hours are not customer records. Only the owner sees the team's timesheets;
  // the database enforces it too, so hiding the screen is not the whole fence.
  const canApprove = profile.role === 'owner';
  const [edit, setEdit] = useState(null);   // { punch, tz, name }
  const [period, setPeriod] = useState('week');
  const days = weekDays(monday);
  const weekStart = isoDate(days[0]);
  const weekEnd = isoDate(days[6]);

  const load = useCallback(async () => {
    setLoading(true);
    const [p, pu, sh, off] = await Promise.all([
      supabase.from('profiles').select('id, display_name, email, default_weekly_hours, timezone').order('display_name'),
      supabase.from('shift_punches').select('*').gte('business_date', weekStart).lte('business_date', weekEnd),
      supabase.from('shifts').select('*').gte('date', weekStart).lte('date', weekEnd),
      supabase.from('time_off').select('*').eq('status', 'approved').lte('start_date', weekEnd).gte('end_date', weekStart),
    ]);
    setStaff(p.data || []); setPunches(pu.data || []); setShifts(sh.data || []); setTimeOff(off.data || []);
    setLoading(false);
  }, [weekStart, weekEnd]);
  useEffect(() => { load(); }, [load]);

  const setStatus = async (ids, patch, key) => {
    if (!ids.length) return;
    setBusy(key);
    const { error } = await supabase.from('shift_punches').update(patch).in('id', ids);
    if (error) alert(error.message);
    await load();
    setBusy(null);
  };
  const approve = (ids, key) =>
    setStatus(ids, { status: 'approved', approved_by: profile.id, approved_at: new Date().toISOString() }, key);
  const unapprove = (ids, key) =>
    setStatus(ids, { status: 'complete', approved_by: null, approved_at: null }, key);

  const punchesFor = (uid, d) => punches.filter(x => x.user_id === uid && x.business_date === d && x.status !== 'voided');
  // A person can have SEVERAL shifts in a day (split shifts — 12:00-16:30 then
  // 16:30-20:00). Using .find() here showed only the first and silently
  // undercounted the week's scheduled hours.
  const shiftsForDay = (uid, d) => shifts.filter(x => x.user_id === uid && x.date === d)
    .sort((a, b) => a.start_time.localeCompare(b.start_time));
  const offFor = (uid, d) => timeOff.find(x => x.user_id === uid && x.start_date <= d && x.end_date >= d);

  if (profile.role !== 'owner') {
    return <div className="p-8 text-muted text-sm">Only the owner can see the team's timesheets. Your own hours are on the Schedule screen.</div>;
  }
  // Two jobs, two periods: the week is where you check and correct a day, the
  // month is where you sign the whole thing off before paying anyone.
  if (period === 'month') {
    return (
      <div className="h-full flex flex-col">
        <PeriodTabs period={period} setPeriod={setPeriod} />
        <MonthReport profile={profile} />
      </div>
    );
  }
  if (loading) return <div className="p-8 text-dim text-sm">Loading timesheets…</div>;

  const saveEdit = async () => {
    const { punch } = edit;
    setBusy(punch.id);
    const { error } = await supabase.rpc('punch_edit', {
      p_id: punch.id,
      p_in_local: edit.inStr,
      p_out_local: edit.outStr || null,
      p_reason: edit.reason || null,
    });
    if (error) alert(error.message.replace(/^.*?:\s*/, ''));
    setEdit(null); setBusy(null); await load();
  };

  // Only people who were scheduled or clocked this week.
  const rows = staff.filter(p =>
    punches.some(x => x.user_id === p.id) || shifts.some(x => x.user_id === p.id) || timeOff.some(x => x.user_id === p.id));

  const pendingAll = punches.filter(p => p.status === 'complete').map(p => p.id);

  return (
    <div className="h-full flex flex-col">
      <PeriodTabs period={period} setPeriod={setPeriod} />
      <div className="px-4 lg:px-6 py-4 border-b border-bdr flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1">
          <button onClick={() => setMonday(m => { const x = new Date(m); x.setDate(x.getDate() - 7); return x; })} className="btn-ghost p-2 rounded-xl"><ChevronLeft size={16} /></button>
          <button onClick={() => setMonday(mondayOf(new Date()))} className="px-3 py-1.5 rounded-xl text-sm btn-ghost">This week</button>
          <button onClick={() => setMonday(m => { const x = new Date(m); x.setDate(x.getDate() + 7); return x; })} className="btn-ghost p-2 rounded-xl"><ChevronRight size={16} /></button>
        </div>
        <div className="text-sm font-bold text-paper">{fmtRange(monday)}</div>
        <div className="text-[11px] text-muted">Timesheets</div>
        {canApprove && pendingAll.length > 0 && (
          <button onClick={() => approve(pendingAll, 'all')} disabled={busy === 'all'}
            className="ml-auto px-3 py-1.5 rounded-xl bg-ember text-ink text-sm font-semibold hover:bg-ember-deep disabled:opacity-50 flex items-center gap-1.5">
            <Check size={15} /> Approve all {pendingAll.length}
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4 lg:p-6">
        {rows.length === 0 && (
          <div className="text-sm text-dim italic text-center py-10">
            Nobody was scheduled or clocked in this week.
          </div>
        )}

        <div className="space-y-4 max-w-5xl">
          {rows.map(p => {
            const mine = punches.filter(x => x.user_id === p.id && x.status !== 'voided');
            const worked = mine.reduce((s, x) => s + (x.worked_minutes || 0), 0);
            const scheduled = days.reduce((s, d) =>
              s + shiftsForDay(p.id, isoDate(d))
                .reduce((t, sh) => t + shiftHours(sh.start_time, sh.finish_time) * 60, 0), 0);
            const pending = mine.filter(x => x.status === 'complete').map(x => x.id);
            const needsEye = mine.some(x => x.status === 'auto_closed' || x.status === 'disputed');

            return (
              <div key={p.id} className="bg-card border border-bdr rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b border-bdr flex items-center gap-3 flex-wrap">
                  <div className="w-7 h-7 rounded-full bg-ember/15 text-ember-deep text-[11px] font-bold flex items-center justify-center">
                    {(p.display_name || p.email || '?')[0].toUpperCase()}
                  </div>
                  <div className="font-semibold text-paper text-sm">{p.display_name || p.email}</div>
                  {p.timezone && (
                    <span className="text-[10px] text-muted" title="Their shift times mean this zone">
                      {p.timezone.split('/').pop().replace(/_/g, ' ')} time
                    </span>
                  )}
                  {needsEye && (
                    <span className="flex items-center gap-1 text-[10px] font-bold uppercase px-2 py-0.5 rounded-lg bg-red-100 text-red-700">
                      <AlertTriangle size={11} /> Needs checking
                    </span>
                  )}
                  <div className="ml-auto flex items-center gap-4 text-xs">
                    <span className="text-muted">Scheduled <span className="text-paper font-semibold tabular-nums">{asHrs(scheduled)}</span></span>
                    <span className="text-muted">Worked <span className="text-paper font-semibold tabular-nums">{asHrs(worked)}</span></span>
                    {canApprove && pending.length > 0 && (
                      <button onClick={() => approve(pending, p.id)} disabled={busy === p.id}
                        className="px-2.5 py-1 rounded-lg bg-ember text-ink text-xs font-semibold hover:bg-ember-deep disabled:opacity-50">
                        Approve week
                      </button>
                    )}
                  </div>
                </div>

                <div className="divide-y divide-bdr">
                  {days.map((d, i) => {
                    const iso = isoDate(d);
                    const dayPunches = punchesFor(p.id, iso);
                    const daySh = shiftsForDay(p.id, iso);
                    const off = offFor(p.id, iso);
                    if (!dayPunches.length && !daySh.length && !off) return null;
                    const schedMins = daySh.reduce((t, x) => t + shiftHours(x.start_time, x.finish_time) * 60, 0);
                    return (
                      <div key={iso} className="px-4 py-2.5 flex items-start gap-3 flex-wrap">
                        <div className="w-20 shrink-0">
                          <div className="text-xs font-semibold text-paper">{DOW_SHORT[i]} {d.getDate()}</div>
                          {daySh.length === 0
                            ? <div className="text-[10px] text-dim">no shift</div>
                            : daySh.map(x => (
                                <div key={x.id} className="text-[10px] text-dim">{x.start_time}–{x.finish_time}</div>
                              ))}
                          {daySh.length > 1 && (
                            <div className="text-[10px] text-muted font-semibold">{asHrs(schedMins)} split</div>
                          )}
                        </div>

                        {/* Holiday and sick sit on the row so an empty day reads
                            as booked off rather than as a missing timesheet. */}
                        {off && (
                          <span className={`flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-lg ${
                            off.type === 'sick' ? 'bg-red-50 text-red-700' : 'bg-blue-50 text-blue-700'}`}>
                            {off.type === 'sick' ? <Ban size={12} /> : <Plane size={12} />}
                            {off.type === 'sick' ? 'Sick' : 'Holiday'}
                          </span>
                        )}

                        {dayPunches.length === 0 && !off && daySh.length > 0 && (
                          <span className="text-[11px] text-red-600 font-medium">Never clocked in</span>
                        )}

                        <div className="flex-1 min-w-[240px] space-y-1">
                          {dayPunches.map(x => {
                            const st = STATUS[x.status] || STATUS.complete;
                            const vIn = varLabel(x.variance_start_mins);
                            const vOut = varLabel(x.variance_finish_mins);
                            return (
                              <div key={x.id} className="flex items-center gap-2 flex-wrap text-xs">
                                <span className="tabular-nums text-paper">{HHMM(x.clock_in, p.timezone)} → {x.clock_out ? HHMM(x.clock_out, p.timezone) : '…'}</span>
                                {x.break_mins > 0 && <span className="text-muted">({x.break_mins}m break)</span>}
                                <span className="font-semibold text-paper tabular-nums">{asHrs(x.worked_minutes)}</span>
                                {vIn && <span className="text-[10px] text-amber-700" title="vs rota start">in {vIn}</span>}
                                {vOut && <span className="text-[10px] text-amber-700" title="vs rota finish">out {vOut}</span>}
                                <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border ${st.cls}`}>{st.label}</span>
                                {x.out_asserted && <span className="text-[10px] text-amber-700" title="Finish time was typed in, not punched live">remembered</span>}
                                {canApprove && x.clock_out && x.status !== 'approved' && (
                                  <button onClick={() => approve([x.id], x.id)} disabled={busy === x.id}
                                    className="text-[11px] text-ember hover:text-ember-deep font-semibold disabled:opacity-50">Approve</button>
                                )}
                                {canApprove && x.status === 'approved' && (
                                  <button onClick={() => unapprove([x.id], x.id)} disabled={busy === x.id}
                                    className="text-[11px] text-muted hover:text-paper disabled:opacity-50">Undo</button>
                                )}
                                {canApprove && (
                                  <button onClick={() => setEdit({ punch: x, tz: p.timezone, name: p.display_name || p.email,
                                    inStr: localInput(x.clock_in, p.timezone), outStr: localInput(x.clock_out, p.timezone), reason: '' })}
                                    className="text-[11px] text-muted hover:text-paper">Edit</button>
                                )}
                                {x.edited_at && <span className="text-[10px] text-dim" title={x.edit_reason || ''}>edited</span>}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {/* Correcting a punch. Times are typed in THAT PERSON'S zone; the
            conversion happens server-side where the zone is known. */}
        {edit && (
          <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4"
            onClick={e => e.target === e.currentTarget && setEdit(null)}>
            <div style={{ background: 'var(--card)' }} className="w-full max-w-md rounded-2xl border border-bdr shadow-2xl p-5 space-y-3">
              <div>
                <div className="text-sm font-bold text-paper">Correct {edit.name}&rsquo;s hours</div>
                <div className="text-[11px] text-muted">
                  Times in {edit.tz ? edit.tz.split('/').pop().replace(/_/g, ' ') : 'company'} time, as YYYY-MM-DD HH:MM
                </div>
              </div>
              <div>
                <label className="text-[10px] font-mono uppercase tracking-wider text-dim block mb-1">Clocked in</label>
                <input value={edit.inStr} onChange={e => setEdit(v => ({ ...v, inStr: e.target.value }))}
                  className="w-full px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper font-mono" />
              </div>
              <div>
                <label className="text-[10px] font-mono uppercase tracking-wider text-dim block mb-1">Clocked out <span className="text-dim normal-case font-sans">(blank leaves it running)</span></label>
                <input value={edit.outStr} onChange={e => setEdit(v => ({ ...v, outStr: e.target.value }))}
                  placeholder="leave blank if still on shift"
                  className="w-full px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper font-mono" />
              </div>
              <div>
                <label className="text-[10px] font-mono uppercase tracking-wider text-dim block mb-1">Why</label>
                <input value={edit.reason} onChange={e => setEdit(v => ({ ...v, reason: e.target.value }))}
                  placeholder="e.g. forgot to clock out, finished 17:30"
                  className="w-full px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper" />
              </div>
              <div className="text-[11px] text-dim">
                The change is recorded against your name, and the entry goes back to needing approval.
              </div>
              <div className="flex gap-2 justify-end pt-1">
                <button onClick={() => setEdit(null)} className="px-3 py-2 rounded-xl text-sm text-muted hover:text-paper">Cancel</button>
                <button onClick={saveEdit} disabled={busy === edit.punch.id}
                  className="px-4 py-2 rounded-xl bg-ember text-ink text-sm font-semibold hover:bg-ember-deep disabled:opacity-50">Save</button>
              </div>
            </div>
          </div>
        )}

        <div className="mt-4 text-[11px] text-dim max-w-5xl">
          Hours come from the clock, not the rota. <span className="text-muted">Auto-closed</span> means someone
          left a shift running and the system ended it — check the finish time with them before approving.
          Nobody can approve their own hours.
        </div>
      </div>
    </div>
  );
}

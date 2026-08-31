import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { ChevronLeft, ChevronRight, Download, Check, AlertTriangle } from 'lucide-react';

// The month you sign off before paying people.
//
// It answers one question per person: how many hours, and can I trust them yet?
// Everything that would make you hesitate is pulled to the front — hours still
// waiting for approval, shifts left running, entries that were auto-closed or
// edited. A month is only "ready" when none of those are outstanding.
//
// It reports HOURS, not money. There are no pay rates anywhere in this CRM, so
// inventing gross pay here would be a guess dressed up as a payslip.

const asHrs = (m) => `${Math.floor((m || 0) / 60)}h ${String(Math.round((m || 0) % 60)).padStart(2, '0')}m`;
const dec = (m) => ((m || 0) / 60).toFixed(2);           // 7.50 — what payroll wants
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayMon = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

// The pay period is not the calendar month. With startDay = 27, "September"
// runs 27 Aug -> 26 Sep. startDay = 1 gives an ordinary calendar month.
// Returns the period CONTAINING `d`.
function periodOf(d, startDay) {
  const y = d.getFullYear(), m = d.getMonth();
  const start = d.getDate() >= startDay ? new Date(y, m, startDay) : new Date(y, m - 1, startDay);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, startDay - 1);
  return { start, end };
}
// Named for the month it ENDS in — a period closing 26 Sep is September's pay.
const periodLabel = (start, end, startDay) => startDay === 1
  ? start.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
  : `${dayMon(start)} – ${dayMon(end)} ${end.getFullYear()}`;

// Overlap in days between a leave row and the month, so a holiday spanning the
// month end counts only the part that falls inside it.
const daysInMonth = (off, from, to) => {
  const s = off.start_date > from ? off.start_date : from;
  const e = off.end_date < to ? off.end_date : to;
  if (s > e) return 0;
  let n = 0;
  for (const d = new Date(s + 'T00:00:00'); iso(d) <= e; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) n++;   // working days only
  }
  return n;
};

const esc = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const safe = (v) => { const s = String(v ?? ''); return /^[=+\-@]/.test(s) ? "'" + s : s; };

export default function MonthReport({ profile }) {
  const [startDay, setStartDay] = useState(null);     // null until settings load
  const [anchor, setAnchor] = useState(new Date());    // any date inside the period
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.from('support_settings').select('pay_period_start_day').eq('id', 1).maybeSingle()
      .then(({ data }) => setStartDay(data?.pay_period_start_day || 1));
  }, []);

  const { start, end } = periodOf(anchor, startDay || 1);
  const from = iso(start);
  const to = iso(end);

  const load = useCallback(async () => {
    if (startDay === null) return;         // don't query on a guessed period
    setLoading(true);
    const [p, pu, off] = await Promise.all([
      supabase.from('profiles').select('id, display_name, email, timezone').order('display_name'),
      supabase.from('shift_punches').select('*').gte('business_date', from).lte('business_date', to),
      supabase.from('time_off').select('*').eq('status', 'approved').lte('start_date', to).gte('end_date', from),
    ]);
    const punches = (pu.data || []).filter(x => x.status !== 'voided');
    setRows((p.data || []).map(person => {
      const mine = punches.filter(x => x.user_id === person.id);
      const leave = (off.data || []).filter(x => x.user_id === person.id);
      const worked = mine.reduce((s, x) => s + (x.worked_minutes || 0), 0);
      const approved = mine.filter(x => x.status === 'approved');
      const pending = mine.filter(x => x.status === 'complete');
      const open = mine.filter(x => x.status === 'open');
      const flagged = mine.filter(x => x.status === 'auto_closed' || x.status === 'disputed');
      return {
        person,
        punches: mine,
        days: new Set(mine.map(x => x.business_date)).size,
        worked,
        approvedMins: approved.reduce((s, x) => s + (x.worked_minutes || 0), 0),
        pendingIds: pending.map(x => x.id),
        pendingMins: pending.reduce((s, x) => s + (x.worked_minutes || 0), 0),
        openCount: open.length,
        flaggedCount: flagged.length,
        editedCount: mine.filter(x => x.edited_at).length,
        holiday: leave.filter(x => x.type === 'holiday').reduce((s, x) => s + daysInMonth(x, from, to), 0),
        sick: leave.filter(x => x.type === 'sick').reduce((s, x) => s + daysInMonth(x, from, to), 0),
      };
    }).filter(r => r.punches.length || r.holiday || r.sick));
    setLoading(false);
  }, [from, to, startDay]);
  useEffect(() => { load(); }, [load]);

  const approveAll = async (ids) => {
    if (!ids.length) return;
    if (!confirm(`Approve ${ids.length} entr${ids.length === 1 ? 'y' : 'ies'}? Do this once you are happy the hours are right.`)) return;
    setBusy(true);
    const { error } = await supabase.from('shift_punches')
      .update({ status: 'approved', approved_by: profile.id, approved_at: new Date().toISOString() }).in('id', ids);
    if (error) alert(error.message);
    await load();
    setBusy(false);
  };

  const exportCsv = () => {
    const head = ['Person', 'Days worked', 'Hours worked', 'Hours (decimal)', 'Approved hours',
      'Awaiting approval', 'Still clocked in', 'Needs checking', 'Edited entries', 'Holiday days', 'Sick days', 'Ready'];
    const body = rows.map(r => [
      safe(r.person.display_name || r.person.email), r.days, asHrs(r.worked), dec(r.worked), dec(r.approvedMins),
      dec(r.pendingMins), r.openCount, r.flaggedCount, r.editedCount, r.holiday, r.sick,
      (r.pendingIds.length || r.openCount || r.flaggedCount) ? 'NO' : 'yes',
    ]);
    const totals = ['TOTAL', rows.reduce((s, r) => s + r.days, 0), asHrs(rows.reduce((s, r) => s + r.worked, 0)),
      dec(rows.reduce((s, r) => s + r.worked, 0)), dec(rows.reduce((s, r) => s + r.approvedMins, 0)),
      dec(rows.reduce((s, r) => s + r.pendingMins, 0)), '', '', '',
      rows.reduce((s, r) => s + r.holiday, 0), rows.reduce((s, r) => s + r.sick, 0), ''];
    const csv = '﻿' + [[`Timesheet ${periodLabel(start, end, startDay || 1)}`, from, to], [], head, ...body, [], totals]
      .map(r => r.map(esc).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    a.download = `timesheet-${from}-to-${to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (startDay === null || loading) return <div className="p-8 text-dim text-sm">Loading the pay period…</div>;

  const allPending = rows.flatMap(r => r.pendingIds);
  const blocked = rows.filter(r => r.pendingIds.length || r.openCount || r.flaggedCount);
  const totalWorked = rows.reduce((s, r) => s + r.worked, 0);

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 lg:px-6 py-4 border-b border-bdr flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1">
          <button onClick={() => setAnchor(new Date(start.getFullYear(), start.getMonth() - 1, start.getDate()))} className="btn-ghost p-2 rounded-xl"><ChevronLeft size={16} /></button>
          <button onClick={() => setAnchor(new Date())} className="px-3 py-1.5 rounded-xl text-sm btn-ghost">This period</button>
          <button onClick={() => setAnchor(new Date(start.getFullYear(), start.getMonth() + 1, start.getDate()))} className="btn-ghost p-2 rounded-xl"><ChevronRight size={16} /></button>
        </div>
        <div>
          <div className="text-sm font-bold text-paper">{periodLabel(start, end, startDay || 1)}</div>
          {startDay > 1 && <div className="text-[10px] text-dim">pay period, {startDay}{['th','st','nd','rd'][(startDay % 10 > 3 || (startDay > 10 && startDay < 14)) ? 0 : startDay % 10]} to the {startDay - 1}{['th','st','nd','rd'][((startDay - 1) % 10 > 3 || (startDay - 1 > 10 && startDay - 1 < 14)) ? 0 : (startDay - 1) % 10]}</div>}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={exportCsv} className="px-3 py-1.5 rounded-xl btn-ghost text-sm flex items-center gap-1.5"><Download size={15} /> Export</button>
          {allPending.length > 0 && (
            <button onClick={() => approveAll(allPending)} disabled={busy}
              className="px-3 py-1.5 rounded-xl bg-ember text-ink text-sm font-semibold hover:bg-ember-deep disabled:opacity-50 flex items-center gap-1.5">
              <Check size={15} /> Approve {allPending.length}
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 lg:p-6">
        <div className="max-w-5xl space-y-4">

          {/* The one thing you need to know before paying anyone. */}
          <div className={`rounded-xl border p-4 ${blocked.length ? 'bg-amber-50 border-amber-200' : 'bg-emerald-50 border-emerald-200'}`}>
            {blocked.length ? (
              <>
                <div className="flex items-center gap-2 text-sm font-bold text-amber-800">
                  <AlertTriangle size={16} /> Not ready to pay yet
                </div>
                <div className="text-xs text-amber-800 mt-1">
                  {blocked.map(r => r.person.display_name || r.person.email).join(', ')} —{' '}
                  {[
                    allPending.length ? `${allPending.length} entr${allPending.length === 1 ? 'y' : 'ies'} to approve` : null,
                    rows.reduce((s, r) => s + r.openCount, 0) ? `${rows.reduce((s, r) => s + r.openCount, 0)} still clocked in` : null,
                    rows.reduce((s, r) => s + r.flaggedCount, 0) ? `${rows.reduce((s, r) => s + r.flaggedCount, 0)} need checking` : null,
                  ].filter(Boolean).join(' · ')}
                </div>
              </>
            ) : (
              <div className="flex items-center gap-2 text-sm font-bold text-emerald-800">
                <Check size={16} /> Every entry approved — {asHrs(totalWorked)} across {rows.length} {rows.length === 1 ? 'person' : 'people'}
              </div>
            )}
          </div>

          <div className="bg-card border border-bdr rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[10px] font-mono uppercase tracking-wider text-dim border-b border-bdr">
                    <th className="text-left px-4 py-2.5 font-medium">Person</th>
                    <th className="text-right px-3 py-2.5 font-medium">Days</th>
                    <th className="text-right px-3 py-2.5 font-medium">Hours</th>
                    <th className="text-right px-3 py-2.5 font-medium">Approved</th>
                    <th className="text-right px-3 py-2.5 font-medium">Holiday</th>
                    <th className="text-right px-3 py-2.5 font-medium">Sick</th>
                    <th className="text-left px-4 py-2.5 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => {
                    const issues = [
                      r.pendingIds.length ? `${r.pendingIds.length} to approve` : null,
                      r.openCount ? `${r.openCount} still in` : null,
                      r.flaggedCount ? `${r.flaggedCount} to check` : null,
                    ].filter(Boolean);
                    return (
                      <tr key={r.person.id} className="border-b border-bdr last:border-0">
                        <td className="px-4 py-3">
                          <div className="text-paper font-medium">{r.person.display_name || r.person.email}</div>
                          {r.editedCount > 0 && <div className="text-[10px] text-dim">{r.editedCount} edited</div>}
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums text-muted">{r.days}</td>
                        <td className="px-3 py-3 text-right tabular-nums text-paper font-semibold">
                          {asHrs(r.worked)}
                          <div className="text-[10px] text-dim font-normal">{dec(r.worked)}</div>
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums text-muted">{dec(r.approvedMins)}</td>
                        <td className="px-3 py-3 text-right tabular-nums text-muted">{r.holiday || '—'}</td>
                        <td className="px-3 py-3 text-right tabular-nums text-muted">{r.sick || '—'}</td>
                        <td className="px-4 py-3">
                          {issues.length === 0 ? (
                            <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-emerald-100 text-emerald-700">Ready</span>
                          ) : (
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-[11px] text-amber-700">{issues.join(' · ')}</span>
                              {r.pendingIds.length > 0 && (
                                <button onClick={() => approveAll(r.pendingIds)} disabled={busy}
                                  className="text-[11px] text-ember hover:text-ember-deep font-semibold disabled:opacity-50">Approve</button>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {rows.length === 0 && (
                    <tr><td colSpan={7} className="px-4 py-8 text-center text-xs text-dim italic">Nothing recorded this month.</td></tr>
                  )}
                </tbody>
                {rows.length > 0 && (
                  <tfoot>
                    <tr className="border-t-2 border-bdr font-semibold">
                      <td className="px-4 py-3 text-paper">Total</td>
                      <td className="px-3 py-3 text-right tabular-nums text-muted">{rows.reduce((s, r) => s + r.days, 0)}</td>
                      <td className="px-3 py-3 text-right tabular-nums text-paper">
                        {asHrs(totalWorked)}
                        <div className="text-[10px] text-dim font-normal">{dec(totalWorked)}</div>
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-muted">{dec(rows.reduce((s, r) => s + r.approvedMins, 0))}</td>
                      <td className="px-3 py-3 text-right tabular-nums text-muted">{rows.reduce((s, r) => s + r.holiday, 0) || '—'}</td>
                      <td className="px-3 py-3 text-right tabular-nums text-muted">{rows.reduce((s, r) => s + r.sick, 0) || '—'}</td>
                      <td />
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>

          <div className="text-[11px] text-dim">
            Hours come from the clock, not the rota. The decimal column (7.50 rather than 7h 30m) is the one
            payroll usually wants. Holiday and sick count working days only, clipped to this period.
            {startDay > 1 && ' The period runs to your pay dates, not the calendar month.'}
            <span className="text-muted"> This reports hours, not pay — there are no pay rates in this system.</span>
          </div>
        </div>
      </div>
    </div>
  );
}

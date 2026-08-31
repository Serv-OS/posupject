import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { Play, Square, Coffee, AlertTriangle } from 'lucide-react';

// Your own clock. Everything that matters happens server-side: the punch() RPC
// stamps every time from the database clock and a trigger freezes the columns
// you are not allowed to move, so nothing here can be talked into lying — this
// component only ever says "in", "out", "break".

const hhmm = (ts, tz) => {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz || undefined });
  } catch { return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
};
const mins = (from, to) => Math.max(0, Math.round((new Date(to) - new Date(from)) / 60000));
const asHours = (m) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;

export default function ClockCard({ profile }) {
  const [punch, setPunch] = useState(undefined);   // undefined = loading, null = clocked out
  const [today, setToday] = useState([]);          // today's completed punches
  const [shift, setShift] = useState(null);        // today's rota row, if any
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    setError('');
    // business_today() resolves the date in the business timezone, so an
    // evening punch never lands on the wrong day.
    const { data: bd } = await supabase.rpc('business_today');
    const day = bd || new Date().toISOString().slice(0, 10);
    const [{ data: rows }, { data: sh }] = await Promise.all([
      supabase.from('shift_punches').select('*')
        .eq('user_id', profile.id).eq('business_date', day)
        .order('clock_in', { ascending: true }),
      supabase.from('shifts').select('id, date, start_time, finish_time, status')
        .eq('user_id', profile.id).eq('date', day).maybeSingle(),
    ]);
    const open = (rows || []).find(r => !r.clock_out) || null;
    setPunch(open);
    setToday((rows || []).filter(r => r.clock_out));
    setShift(sh || null);
  }, [profile.id]);

  useEffect(() => { load(); }, [load]);
  // Ticking clock while on shift, so the elapsed figure is alive.
  useEffect(() => {
    if (!punch) return undefined;
    const t = setInterval(() => setTick(v => v + 1), 30000);
    return () => clearInterval(t);
  }, [punch]);

  const act = async (action) => {
    setBusy(true); setError('');
    // Evidence the browser can honestly offer. No location: a coordinate from a
    // phone is trivially faked and disproportionate for this, and the column is
    // jsonb so one can be added later without a migration.
    const evidence = {
      ua: navigator.userAgent.slice(0, 120),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      at_device: new Date().toISOString(),   // recorded for comparison, never trusted
    };
    const { error: e } = await supabase.rpc('punch', { p_action: action, p_note: null, p_evidence: evidence });
    if (e) setError(e.message.replace(/^.*?:\s*/, ''));
    await load();
    setBusy(false);
  };

  if (punch === undefined) {
    return <div className="bg-card border border-bdr rounded-xl p-4 text-sm text-dim">Loading your clock…</div>;
  }

  const onBreak = !!punch?.break_open_at;
  const elapsed = punch ? mins(punch.clock_in, new Date()) - (punch.break_mins || 0) - (onBreak ? mins(punch.break_open_at, new Date()) : 0) : 0;
  const doneToday = today.reduce((s, r) => s + (r.worked_minutes || 0), 0);
  const btn = 'px-4 py-2.5 rounded-xl text-sm font-semibold transition disabled:opacity-50 flex items-center gap-2';

  return (
    <div className={`rounded-xl border p-4 ${punch ? 'bg-ember/5 border-ember/30' : 'bg-card border-bdr'}`}>
      <div className="flex items-start gap-4 flex-wrap">
        <div className="flex-1 min-w-[180px]">
          <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-dim">My shift</div>
          {punch ? (
            <>
              <div className="text-lg font-bold text-paper mt-0.5">
                {onBreak ? 'On a break' : 'Clocked in'} · {asHours(elapsed)}
              </div>
              <div className="text-xs text-muted">
                Since {hhmm(punch.clock_in)}
                {punch.break_mins > 0 && ` · ${punch.break_mins}m break`}
                {punch.scheduled_start_at && ` · rota ${hhmm(punch.scheduled_start_at)}–${hhmm(punch.scheduled_finish_at)}`}
              </div>
            </>
          ) : (
            <>
              <div className="text-lg font-bold text-paper mt-0.5">Not clocked in</div>
              <div className="text-xs text-muted">
                {shift ? `Today you're on ${shift.start_time}–${shift.finish_time}`
                       : 'No shift on the rota for you today'}
                {doneToday > 0 && ` · ${asHours(doneToday)} done today`}
              </div>
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          {!punch && (
            <button onClick={() => act('in')} disabled={busy}
              className={`${btn} bg-ember text-ink hover:bg-ember-deep`}>
              <Play size={15} /> Clock in
            </button>
          )}
          {punch && !onBreak && (
            <button onClick={() => act('break_start')} disabled={busy}
              className={`${btn} bg-card text-paper border border-bdr hover:border-ember`}>
              <Coffee size={15} /> Break
            </button>
          )}
          {punch && onBreak && (
            <button onClick={() => act('break_end')} disabled={busy}
              className={`${btn} bg-ember text-ink hover:bg-ember-deep`}>
              <Play size={15} /> End break
            </button>
          )}
          {punch && (
            <button onClick={() => act('out')} disabled={busy}
              className={`${btn} bg-card text-red-600 border border-red-200 hover:bg-red-50`}>
              <Square size={15} /> Clock out
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="mt-3 flex items-start gap-2 text-xs text-red-600">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" /> <span>{error}</span>
        </div>
      )}

      {/* An auto-closed punch is never quietly trusted — it asks for a human. */}
      {today.some(r => r.status === 'auto_closed') && (
        <div className="mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          A shift was closed automatically because it was left running. Tell your
          manager what time you actually finished so the record can be corrected.
        </div>
      )}
    </div>
  );
}

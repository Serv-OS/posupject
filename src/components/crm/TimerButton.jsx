import { useEffect, useState } from 'react';
import { Play, Square } from 'lucide-react';
import { getRunning, startTimer, stopTimer, fmtClock } from '../../lib/timer';

// Start/stop a time tracker for a specific record. Shows live elapsed when this
// record is the one being tracked.
export default function TimerButton({ subjectType, subjectId, label, profile }) {
  const [running, setRunning] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);

  const refresh = () => getRunning(profile.id).then(setRunning);

  useEffect(() => {
    refresh();
    const onChange = () => refresh();
    window.addEventListener('timer-changed', onChange);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { window.removeEventListener('timer-changed', onChange); clearInterval(tick); };
  }, [profile.id, subjectId]);

  const isThis = running && running.subject_type === subjectType && running.subject_id === subjectId;
  const elapsed = isThis ? (now - new Date(running.started_at).getTime()) / 1000 : 0;

  const toggle = async () => {
    setBusy(true);
    try {
      if (isThis) await stopTimer(profile.id);
      else await startTimer({ subjectType, subjectId, label, profileId: profile.id });
    } catch (e) {
      alert('Timer error: ' + (e.message || e));
    }
    setBusy(false);
  };

  return (
    <button onClick={toggle} disabled={busy} title={isThis ? 'Stop timer' : 'Start timer'}
      className={`inline-flex items-center gap-1.5 px-2.5 lg:px-3 py-1.5 lg:py-2 rounded-xl text-sm font-semibold transition disabled:opacity-50 ${
        isThis
          ? 'bg-red-500 text-white hover:bg-red-600'
          : 'bg-emerald-500/15 text-emerald-700 border border-emerald-500/30 hover:bg-emerald-500/25'
      }`}>
      {isThis ? <Square size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
      {/* The running clock always shows; the idle label is dropped on phones,
          where a full-width "Start timer" crowds out the record's own actions. */}
      {isThis ? <span className="font-mono tabular-nums">{fmtClock(elapsed)}</span> : <span className="hidden sm:inline">Start timer</span>}
    </button>
  );
}

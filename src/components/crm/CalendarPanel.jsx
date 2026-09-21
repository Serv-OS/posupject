import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { useGoogleConnection } from '../../lib/useGoogle';
import { Calendar as CalIcon, RefreshCw, ChevronLeft, ChevronRight, MapPin, Users, Video, ExternalLink } from 'lucide-react';
import ScheduleMeeting from './ScheduleMeeting.jsx';
import { toDayISO } from '../../lib/day';

const FN = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/google-calendar`;
const WINDOW_DAYS = 14;

const dayKey = (d) => toDayISO(d);
const fmtDayHeading = (iso) => {
  const d = new Date(iso + 'T00:00:00');
  const today = dayKey(new Date());
  const tomorrow = dayKey(new Date(Date.now() + 86400000));
  if (iso === today) return 'Today';
  if (iso === tomorrow) return 'Tomorrow';
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
};
const fmtTime = (d) => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

export default function CalendarPanel({ profile, onNavigate }) {
  const { connected, connect } = useGoogleConnection(profile.id);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [offset, setOffset] = useState(0); // window offset in WINDOW_DAYS blocks

  const rangeStart = new Date(); rangeStart.setHours(0, 0, 0, 0);
  rangeStart.setDate(rangeStart.getDate() + offset * WINDOW_DAYS);
  const rangeEnd = new Date(rangeStart); rangeEnd.setDate(rangeEnd.getDate() + WINDOW_DAYS);

  const callFn = useCallback(async (payload) => {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch(FN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify(payload),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Request failed');
    return d;
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const d = await callFn({ action: 'list', timeMin: rangeStart.toISOString(), timeMax: rangeEnd.toISOString() });
      setEvents(d.events || []);
    } catch (e) { setError(e.message); }
    setLoading(false);
  }, [callFn, offset]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (connected) load(); }, [connected, offset, load]);

  if (connected === null) return <div className="h-full flex items-center justify-center text-dim text-sm">Loading calendar…</div>;

  if (connected === false) return (
    <div className="h-full flex flex-col items-center justify-center text-center p-8">
      <div className="w-14 h-14 rounded-2xl glass-inner flex items-center justify-center mb-4"><CalIcon size={26} className="text-ember" /></div>
      <div className="text-lg font-bold text-paper mb-1">Connect your calendar</div>
      <div className="text-sm text-muted max-w-sm mb-4">Link your Google account to see your schedule and book meetings (with invites) right here.</div>
      <button onClick={connect} className="btn-glass px-5 py-2.5 rounded-xl text-sm font-semibold flex items-center gap-2">
        <CalIcon size={16} /> Connect Google
      </button>
      <div className="text-[11px] text-dim mt-2">Opens a Google sign-in window. Takes a few seconds.</div>
    </div>
  );

  // group events by day
  const groups = {};
  for (const ev of events) {
    const k = dayKey(ev.start);
    (groups[k] = groups[k] || []).push(ev);
  }
  const days = Object.keys(groups).sort();

  const rangeLabel = `${rangeStart.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${new Date(rangeEnd.getTime() - 1).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 py-4 border-b border-bdr flex items-center gap-3 shrink-0 flex-wrap">
        <CalIcon size={20} className="text-ember" />
        <div className="flex-1 min-w-0">
          <div className="text-lg font-bold text-paper leading-tight">Calendar</div>
          <div className="text-[11px] text-muted truncate">{connected.email}</div>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setOffset(o => o - 1)} className="btn-ghost p-2 rounded-xl"><ChevronLeft size={16} /></button>
          <button onClick={() => setOffset(0)} className={`px-3 py-1.5 rounded-xl text-sm ${offset === 0 ? 'bg-ember/10 text-ember-deep font-semibold' : 'btn-ghost'}`}>{rangeLabel}</button>
          <button onClick={() => setOffset(o => o + 1)} className="btn-ghost p-2 rounded-xl"><ChevronRight size={16} /></button>
        </div>
        <button onClick={load} title="Refresh" className="btn-ghost p-2 rounded-xl"><RefreshCw size={16} className={loading ? 'animate-spin' : ''} /></button>
        <ScheduleMeeting defaultTitle="Meeting" onScheduled={load} />
      </div>

      {error && <div className="mx-6 mt-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-2">{error}</div>}

      {/* Agenda */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-3xl mx-auto">
          {loading && !events.length ? (
            <div className="text-center text-dim text-sm py-10">Loading…</div>
          ) : days.length === 0 ? (
            <div className="text-center text-dim text-sm py-10">No events in this period.</div>
          ) : days.map(day => (
            <div key={day} className="mb-6">
              <div className="text-[11px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-2">{fmtDayHeading(day)}</div>
              <div className="space-y-2">
                {groups[day].sort((a, b) => new Date(a.start) - new Date(b.start)).map(ev => (
                  <EventRow key={ev.id} ev={ev} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function EventRow({ ev }) {
  return (
    <div className="glass-card rounded-2xl p-4 flex gap-4">
      <div className="w-20 shrink-0 text-right">
        {ev.allDay ? (
          <span className="text-xs font-semibold text-muted">All day</span>
        ) : (
          <>
            <div className="text-sm font-bold text-paper">{fmtTime(ev.start)}</div>
            {ev.end && <div className="text-xs text-dim">{fmtTime(ev.end)}</div>}
          </>
        )}
      </div>
      <div className="w-px bg-bdr shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-paper break-words">{ev.summary}</div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1 text-xs text-muted">
          {ev.location && <span className="flex items-center gap-1 truncate"><MapPin size={12} className="shrink-0" /> {ev.location}</span>}
          {ev.attendees?.length > 0 && <span className="flex items-center gap-1"><Users size={12} /> {ev.attendees.length} guest{ev.attendees.length > 1 ? 's' : ''}</span>}
          {ev.hangoutLink && <a href={ev.hangoutLink} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-emerald-600 hover:underline"><Video size={12} /> Join</a>}
          {ev.htmlLink && <a href={ev.htmlLink} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-ember hover:underline"><ExternalLink size={12} /> Open</a>}
        </div>
        {ev.description && <div className="text-xs text-dim mt-1.5 line-clamp-2 whitespace-pre-wrap break-words">{ev.description}</div>}
      </div>
    </div>
  );
}

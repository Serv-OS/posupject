import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useStickyState } from '../../lib/stickyState';
import { monthGrid, startOfWeek, addDays, dayKey } from '../../lib/planning';
import { PageTitle, Segmented, Card, SkeletonList, hair } from './ui.jsx';

// Screen 06 — due dates and bookings in one grid.
//
// Weekdays only by default, since almost nothing is dated to a weekend; a
// toggle adds Sat and Sun. Chips are coloured by OWNERSHIP (mine / team), not
// by status, and an overdue chip takes coral wherever it sits. Bookings come
// from the bookings table read-only, so this is the one place a due date and a
// site visit can be seen together. A day caps at three chips plus "+n more".
// Dragging a chip onto a day sets due_date.

const CHIP = {
  mine:    { bg: 'rgb(var(--c-primary) / .12)', bd: 'rgb(var(--c-primary) / .22)', fg: 'rgb(var(--c-primary-deep))' },
  team:    { bg: 'rgb(var(--c-uv) / .10)',      bd: 'rgb(var(--c-uv) / .22)',      fg: 'rgb(var(--c-uv-deep))' },
  booking: { bg: 'rgb(var(--c-amber) / .14)',   bd: 'rgb(var(--c-amber) / .32)',   fg: 'rgb(var(--c-amber-deep))' },
  overdue: { bg: 'rgb(var(--c-coral) / .12)',   bd: 'rgb(var(--c-coral) / .28)',   fg: 'rgb(var(--c-coral-deep))' },
};

export default function WorkCalendar({ profile, onNavigate }) {
  const [tasks, setTasks] = useState([]);
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useStickyState('calendar.mode', 'month');
  const [weekend, setWeekend] = useStickyState('calendar.weekend', false);
  const [cursor, setCursor] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [dragId, setDragId] = useState(null);
  const [expanded, setExpanded] = useState({});
  const canWrite = profile.role === 'owner' || profile.role === 'editor';
  const today = dayKey(new Date());

  useEffect(() => { load(); }, []);
  const load = async () => {
    const [t, b] = await Promise.all([
      supabase.from('tasks').select('id, title, owner_id, due_date, status, project_id').is('parent_task_id', null).not('due_date', 'is', null).neq('status', 'done'),
      supabase.from('bookings').select('id, name, company, starts_at, ends_at, status, host_user_id').neq('status', 'cancelled'),
    ]);
    setTasks(t.data || []); setBookings(b.data || []); setLoading(false);
  };

  const grid = useMemo(() => (mode === 'month'
    ? monthGrid(cursor.getFullYear(), cursor.getMonth(), weekend)
    : [Array.from({ length: weekend ? 7 : 5 }, (_, i) => { const d = addDays(weekStart, i); return { date: d, key: dayKey(d), inMonth: true }; })]),
  [mode, cursor, weekStart, weekend]);
  const dayNames = (weekend ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);

  const byDay = useMemo(() => {
    const m = {};
    for (const t of tasks) {
      const k = t.due_date;
      (m[k] ||= []).push({ id: t.id, kind: t.due_date < today ? 'overdue' : t.owner_id === profile.id ? 'mine' : 'team', label: t.title, task: t });
    }
    for (const b of bookings) {
      const k = dayKey(b.starts_at);
      const time = new Date(b.starts_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      (m[k] ||= []).push({ id: 'b' + b.id, kind: 'booking', label: `${b.name || b.company || 'Booking'} ${time}`, booking: b });
    }
    // Overdue first, then bookings by time, then the rest — the coral one is the one to read.
    for (const k of Object.keys(m)) m[k].sort((a, b) => (a.kind === 'overdue' ? -1 : b.kind === 'overdue' ? 1 : 0));
    return m;
  }, [tasks, bookings, profile.id, today]);

  const title = mode === 'month'
    ? cursor.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
    : `Week of ${weekStart.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}`;
  const step = (n) => (mode === 'month' ? setCursor(c => new Date(c.getFullYear(), c.getMonth() + n, 1)) : setWeekStart(w => addDays(w, n * 7)));
  const goToday = () => { const d = new Date(); setCursor(new Date(d.getFullYear(), d.getMonth(), 1)); setWeekStart(startOfWeek(d)); };

  const drop = async (dayKeyTo) => {
    if (!dragId || !canWrite) return;
    const id = dragId; setDragId(null);
    const before = tasks;
    setTasks(ts => ts.map(t => (t.id === id ? { ...t, due_date: dayKeyTo } : t)));
    const { error } = await supabase.from('tasks').update({ due_date: dayKeyTo }).eq('id', id);
    if (error) { setTasks(before); alert('Could not move the date: ' + error.message); }
  };

  const btn = 'px-[11px] py-1.5 rounded-[9px] border text-[13px] text-paper hover:border-ember/40';
  const btnStyle = { background: 'var(--panel-bg)', borderColor: 'var(--bdr)' };

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--scene)' }}>
      <div className="px-6 pt-5 pb-[14px] flex items-center gap-[14px] flex-wrap">
        <PageTitle>{title}</PageTitle>
        <div className="flex gap-1.5">
          <button onClick={() => step(-1)} className={btn} style={btnStyle}>←</button>
          <button onClick={() => step(1)} className={btn} style={btnStyle}>→</button>
          <button onClick={goToday} className={btn + ' !px-[13px]'} style={btnStyle}>Today</button>
        </div>
        <Segmented value={mode} options={[['month', 'Month'], ['week', 'Week']]} onChange={setMode} />
        <label className="flex items-center gap-1.5 text-[12px] text-muted cursor-pointer"><input type="checkbox" checked={weekend} onChange={e => setWeekend(e.target.checked)} className="accent-ember" /> Sat &amp; Sun</label>
        <div className="flex gap-[14px] items-center text-[12px] text-muted ml-auto">
          {[['mine', 'Mine', 'rgb(var(--c-primary))'], ['team', 'Team', 'rgb(var(--c-uv))'], ['booking', 'Booking', 'rgb(var(--c-amber))'], ['overdue', 'Overdue', 'rgb(var(--c-coral))']].map(([k, l, c]) => (
            <span key={k} className="flex items-center gap-1.5"><span className="w-[9px] h-[9px] rounded-[3px]" style={{ background: c }} />{l}</span>
          ))}
        </div>
      </div>

      <div className="flex-1 lg:overflow-hidden px-[14px] lg:px-6 pb-6">
        {loading ? <SkeletonList rows={4} /> : (
          <Card className="lg:h-full flex flex-col">
            <div className="grid border-b" style={{ gridTemplateColumns: `repeat(${dayNames.length}, minmax(0,1fr))`, borderColor: 'var(--ink-line)' }}>
              {dayNames.map((d, i) => <div key={d} className={`px-3 py-[9px] font-mono text-[9px] font-bold tracking-[.18em] uppercase text-dim ${i ? 'border-l' : ''}`} style={hair}>{d}</div>)}
            </div>
            <div className="flex-1 lg:overflow-y-auto grid" style={{ gridTemplateColumns: `repeat(${dayNames.length}, minmax(0,1fr))`, gridAutoRows: mode === 'week' ? '1fr' : 'minmax(110px, 1fr)' }}>
              {grid.flat().map((cell, i) => {
                const items = byDay[cell.key] || [];
                const isToday = cell.key === today;
                const cap = expanded[cell.key] ? items.length : 3;
                return (
                  <div key={cell.key}
                    onDragOver={e => { if (dragId) e.preventDefault(); }} onDrop={() => drop(cell.key)}
                    className={`px-2.5 py-2 flex flex-col gap-[5px] border-b ${i % dayNames.length ? 'border-l' : ''}`}
                    style={{ ...hair, background: isToday ? 'rgb(var(--c-primary) / .05)' : 'transparent', opacity: cell.inMonth ? 1 : 0.45 }}>
                    <span className="font-mono text-[11px]" style={{ color: isToday ? 'rgb(var(--c-primary-deep))' : 'rgb(var(--c-dim))', fontWeight: isToday ? 700 : 400 }}>
                      {cell.date.getDate()}{isToday ? ' · today' : ''}
                    </span>
                    {items.slice(0, cap).map(it => {
                      const c = CHIP[it.kind];
                      return (
                        <span key={it.id} draggable={!!it.task && canWrite}
                          onDragStart={() => it.task && setDragId(it.task.id)} onDragEnd={() => setDragId(null)}
                          onClick={() => (it.task ? onNavigate?.('task', it.task.id) : onNavigate?.('bookings'))}
                          title={it.label}
                          className="text-[11px] px-[7px] py-[3px] rounded-[6px] border truncate cursor-pointer"
                          style={{ background: c.bg, borderColor: c.bd, color: c.fg }}>{it.label}</span>
                      );
                    })}
                    {items.length > cap && <button onClick={() => setExpanded(e => ({ ...e, [cell.key]: true }))} className="text-[11px] text-dim text-left hover:text-paper">+{items.length - cap} more</button>}
                  </div>
                );
              })}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

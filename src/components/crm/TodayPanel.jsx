import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { groupTasks, DUE_LABEL, dueBucket } from '../../lib/taskGrouping';
import { priorityLabel } from '../../lib/priority';
import { useStickyState } from '../../lib/stickyState';
import QuickAddRow from './QuickAddRow.jsx';

// Screen 01 — the landing screen. Replaces MyWork.
//
// The one structural decision: groups come from the DUE DATE, not from status.
// MyWork listed by record type — tickets, then tasks, then deals — which
// answers "what kinds of thing do I own" when the actual question every
// morning is "what is late and what is today". A late ticket and a late task
// are the same problem and now sit together.
//
// It reads work_items rather than assembling per-module lists here, so when
// tickets and onboardings join the view this screen gains them without a
// change.

const LENSES = [['mine', 'My work'], ['requested', 'I asked for'], ['team', 'Team']];

export default function TodayPanel({ profile, onNavigate }) {
  const [items, setItems] = useState([]);
  const [members, setMembers] = useState([]);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [lens, setLens] = useStickyState('today.lens', 'mine');

  const load = useCallback(async () => {
    const [w, m, p] = await Promise.all([
      supabase.from('work_items').select('*').order('due_at', { ascending: true, nullsFirst: false }),
      supabase.from('profiles').select('id, email, display_name'),
      supabase.from('crm_projects').select('id, name, phases'),
    ]);
    setItems(w.data || []); setMembers(m.data || []); setProjects(p.data || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const ch = supabase.channel('today')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load]);

  const firstName = (profile.display_name || profile.email.split('@')[0]).split(' ')[0];
  const greeting = (() => {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  })();

  // work_items carries source_id, but the grouping and row code speak `id`.
  const asTask = (w) => ({ ...w, id: w.source_id, due_date: w.due_at ? String(w.due_at).slice(0, 10) : null });

  const open = useMemo(() => items.filter(w => w.status !== 'done').map(asTask), [items]);
  const mine = useMemo(() => {
    if (lens === 'team') return open;
    if (lens === 'requested') return open.filter(w => w.created_by === profile.id && w.owner_id !== profile.id);
    return open.filter(w => w.owner_id === profile.id);
  }, [open, lens, profile.id]);

  const groups = useMemo(() => groupTasks(mine, 'due', { projects, members }), [mine, projects, members]);
  const counts = useMemo(() => {
    const c = { overdue: 0, today: 0, week: 0 };
    for (const t of mine) {
      const b = dueBucket(t);
      if (b === 'overdue') c.overdue++;
      else if (b === 'today') c.today++;
      else if (b === 'this_week') c.week++;
    }
    return c;
  }, [mine]);

  // Waiting on others: assigned elsewhere but blocked, or blocked at all.
  const waiting = useMemo(() => open.filter(w => w.status === 'blocked'), [open]);
  const nameOf = (id) => { const m = members.find(x => x.id === id); return m ? (m.display_name || m.email?.split('@')[0]) : 'Unassigned'; };

  const go = (w) => onNavigate?.(w.link?.view === 'task_detail' ? 'task' : w.type, w.source_id || w.id);

  return (
    <div className="h-full flex flex-col">
      {/* Display face at 28/800 and the whole day in one mono line — the
          spec's header, not a shrunk version of it. */}
      <div className="pt-5 px-7 flex items-start gap-5">
        <div className="flex-1 min-w-0">
          <h3 className="font-display text-[28px] font-extrabold text-paper leading-none m-0 mb-1.5">
            {greeting}, {firstName}
          </h3>
          <div className="font-mono text-[10px] font-bold tracking-[0.18em] uppercase text-dim">
            {counts.overdue > 0 && <span className="text-coral-deep">{counts.overdue} overdue &middot; </span>}
            {counts.today} due today &middot; {counts.week} this week &middot; {waiting.length} waiting on others
          </div>
        </div>
        <button onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))}
          className="hidden md:flex items-center gap-2 px-3 py-2 rounded-[10px] border border-bdr text-[13px] text-dim w-[220px]"
          style={{ background: 'var(--panel-bg)' }}>
          Search or jump to&hellip;
          <span className="ml-auto font-mono text-[11px] text-dim">&#8984;K</span>
        </button>
        <div className="w-8 h-8 rounded-full bg-ember text-white text-xs font-bold flex items-center justify-center shrink-0">
          {firstName[0]?.toUpperCase()}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="px-7 pt-[18px] pb-6 grid lg:grid-cols-[minmax(0,1fr)_320px] gap-[18px]">
          <div className="flex flex-col gap-4 min-w-0">
            <QuickAddRow profile={profile} members={members} projects={projects}
              onCreated={load} onOpen={(id) => onNavigate?.('task', id)} />

            {/* The active pill is solid INK, not brand green. Green is already
                carrying progress, priority and every action on this page; a
                third meaning makes all three quieter. */}
            <div className="flex gap-1.5">
              {LENSES.map(([k, lbl]) => (
                <button key={k} onClick={() => setLens(k)}
                  className={`px-3.5 py-[7px] rounded-full text-[13px] font-semibold transition border ${
                    lens === k ? 'border-transparent' : 'border-bdr text-paper-soft hover:text-paper'}`}
                  style={lens === k
                    ? { background: 'rgb(var(--c-text))', color: 'var(--on-accent)' }
                    : { background: 'var(--panel-bg)' }}>
                  {lbl}
                </button>
              ))}
            </div>

            {loading ? (
              // A skeleton, not a spinner: the shape of what is coming reads as
              // progress, where a spinner reads as a stall.
              <div className="space-y-2">
                {[0, 1, 2, 3].map(i => <div key={i} className="h-12 rounded-xl bg-card/60 animate-pulse" />)}
              </div>
            ) : groups.length === 0 ? (
              <div className="glass-card rounded-2xl p-10 text-center">
                <div className="text-sm text-paper font-medium">Nothing waiting on you.</div>
                <div className="text-xs text-muted mt-1">Add the first thing above, or switch to Team.</div>
              </div>
            ) : groups.map(g => (
              <div key={g.key}>
                {/* Label, count, then a hairline to the edge. The group is not a
                    box: boxing each one made four cards where the eye wants one
                    list with breaks in it. */}
                <div className="flex items-center gap-2 mb-2">
                  <span className={`font-mono text-[10px] font-bold tracking-[0.18em] uppercase ${g.key === 'overdue' ? 'text-coral-deep' : 'text-dim'}`}>{g.label}</span>
                  <span className="font-mono text-[10px] text-dim">{g.tasks.length}</span>
                  <span className="flex-1 h-px" style={{ background: 'var(--ink-line)' }} />
                </div>
                <div className="rounded-2xl border border-bdr overflow-hidden"
                  style={{ background: 'var(--card-bg)', boxShadow: 'var(--shadow-card)' }}>
                  {g.tasks.map(w => (
                    <button key={w.id} onClick={() => go(w)}
                      className="w-full min-h-[44px] px-4 py-2.5 flex items-center gap-3 hover:bg-ember/5 transition text-left border-b last:border-b-0"
                      style={{ borderColor: 'var(--hair)' }}>
                      <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-ink-soft text-dim border border-bdr shrink-0">{w.type}</span>
                      <span className="flex-1 min-w-0 text-[15px] text-paper truncate">{w.title}</span>
                      {w.subtitle && <span className="text-[11px] text-muted truncate max-w-[180px] shrink-0">{w.subtitle}</span>}
                      {w.status === 'blocked' && <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-red-100 text-red-700 shrink-0">Blocked</span>}
                      <span className="text-[11px] text-dim shrink-0 w-16 text-right">{priorityLabel(w.priority)}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-4">
            <div className="glass-card rounded-2xl overflow-hidden">
              <div className="px-4 py-2.5 border-b border-bdr text-[11px] font-bold text-paper">Waiting on others</div>
              {waiting.length === 0
                ? <div className="px-4 py-4 text-xs text-dim italic">Nothing blocked.</div>
                : <div className="divide-y divide-bdr/60">
                    {waiting.slice(0, 8).map(w => (
                      <button key={w.id} onClick={() => go(w)} className="w-full px-4 py-2 text-left hover:bg-card/50">
                        <div className="text-xs text-paper truncate">{w.title}</div>
                        <div className="text-[11px] text-dim truncate">{w.blocked_reason || nameOf(w.owner_id)}</div>
                      </button>
                    ))}
                  </div>}
            </div>

            <div className="glass-card rounded-2xl p-4">
              <div className="text-[10px] font-mono font-bold uppercase tracking-[0.14em] text-dim mb-2">This week</div>
              {['overdue', 'today', 'this_week'].map(k => {
                const n = mine.filter(t => dueBucket(t) === k).length;
                return (
                  <div key={k} className="flex items-center justify-between py-1">
                    <span className={`text-xs ${k === 'overdue' && n > 0 ? 'text-red-600' : 'text-muted'}`}>{DUE_LABEL[k]}</span>
                    <span className="text-sm font-semibold tabular-nums text-paper">{n}</span>
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

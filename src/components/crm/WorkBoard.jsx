import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useStickyState } from '../../lib/stickyState';
import { workloadRows, STALL_DAYS, isStalled } from '../../lib/workload';
import { dueBucket } from '../../lib/taskGrouping';
import { PRIORITY_LABEL } from '../../lib/priority';
import { startOfWeek, addDays, dayKey } from '../../lib/planning';
import {
  Avatar, Tag, Pill, MetaLabel, Mono, PageTitle, Segmented, LabelledPill, LensPill, Card, SkeletonList, EmptyState, hair, dueLabel, fmtHM,
} from './ui.jsx';
import { MobileSheet, SheetRow, useLongPress } from './ui.jsx';

// Screens 03 and 07.
//
// Board: the four existing status values as columns, so a drag is a single
// field write and no data migrates. Swimlanes by project (or assignee, or
// none). Dropping into Blocked opens the same blocker prompt as the list.
// The in-progress limit is advisory — over it the header turns amber and
// nothing is prevented. Dropping a card onto an avatar reassigns it.
//
// People: load is a COUNT, not an estimate — overdue, in progress, to do — with
// the bar scaled against the busiest person so it needs no configuration. The
// capacity words are thresholds only: over capacity when anything is overdue
// or more than eight are open. Nudge posts an activity entry and a
// notification against the task; it does not email. Unassigned is always a
// row, so work cannot hide.

const COLUMNS = [['todo', 'To do', 'muted'], ['in_progress', 'In progress', 'amber'], ['blocked', 'Blocked', 'coral'], ['done', 'Done', 'primary']];
const WIP_LIMIT = 6;
const MAX_OPEN = 8;

export default function WorkBoard({ profile, onNavigate, initialTab }) {
  const [tasks, setTasks] = useState([]);
  const [members, setMembers] = useState([]);
  const [projects, setProjects] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [locations, setLocations] = useState([]);
  const [deals, setDeals] = useState([]);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useStickyState('work.tab', 'board');
  const [lanes, setLanes] = useStickyState('board.lanes', 'project');
  const [windowMode, setWindowMode] = useStickyState('people.window', 'week');
  const [lanesMenu, setLanesMenu] = useState(false);
  const [windowMenu, setWindowMenu] = useState(false);
  const [drag, setDrag] = useState(null);
  // Scope (owner's call, 3 Sep): the global board must stay usable at a thousand projects.
  // Mine/Team lens, an optional single project, and at most LANE_CAP lanes otherwise.
  const [lens, setLens] = useStickyState('board.lens', 'mine');
  const [rawProjectFilter, setProjectFilter] = useStickyState('board.project', '');
  const [projectMenu, setProjectMenu] = useState(false);
  const [projectQ, setProjectQ] = useState('');
  const [mCol, setMCol] = useState('in_progress');
  const [moving, setMoving] = useState(null);
  const [moveReason, setMoveReason] = useState('');
  const [swipeX, setSwipeX] = useState(null);
  const longPress = useLongPress((t) => { if (canWrite && t.status !== 'done') { setMoving(t); setMoveReason(''); } });
  const [err, setErr] = useState('');
  const canWrite = profile.role === 'owner' || profile.role === 'editor';
  useEffect(() => { if (initialTab) setTab(initialTab); }, [initialTab]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    const weekAgo = addDays(new Date(), -7).toISOString();
    const [t, m, p, c, l, d, te] = await Promise.all([
      // Open work, plus what was finished this week. Old done tasks never load.
      supabase.from('tasks').select('*').is('parent_task_id', null).or(`status.neq.done,completed_at.gte.${weekAgo}`).order('sort_order'),
      supabase.from('profiles').select('id, email, display_name, role'),
      supabase.from('crm_projects').select('*').eq('status', 'active').order('name'),
      supabase.from('companies').select('id, name'),
      supabase.from('locations').select('id, name, company_id'),
      supabase.from('deals').select('id, name, company_id'),
      supabase.from('time_entries').select('profile_id, subject_id, duration_seconds, started_at').gte('started_at', startOfWeek(new Date()).toISOString()),
    ]);
    setTasks(t.data || []); setMembers(m.data || []); setProjects(p.data || []);
    setCompanies(c.data || []); setLocations(l.data || []); setDeals(d.data || []); setEntries(te.data || []);
    setLoading(false);
  }, []);
  useEffect(() => {
    load();
    const ch = supabase.channel('workboard').on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, load).subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load]);

  const nameOf = (id) => { const m = members.find(u => u.id === id); return m ? (m.display_name || m.email.split('@')[0]) : ''; };
  const customerOf = (p) => {
    if (p.subject_type === 'ticket') return 'Support ticket';
    if (!p?.subject_type || !p?.subject_id) return null;
    if (p.subject_type === 'company') return companies.find(x => x.id === p.subject_id)?.name;
    if (p.subject_type === 'location') { const l = locations.find(x => x.id === p.subject_id); return companies.find(x => x.id === l?.company_id)?.name || l?.name; }
    if (p.subject_type === 'deal') { const dl = deals.find(x => x.id === p.subject_id); return companies.find(x => x.id === dl?.company_id)?.name || dl?.name; }
    return null;
  };
  const trackedFor = (t) => entries.filter(e => e.subject_id === t.id).reduce((s, e) => s + (e.duration_seconds || 0), 0);

  // ── Writes ─────────────────────────────────────────────────────────────────
  const patch = async (id, p) => {
    const before = tasks; setErr('');
    setTasks(ts => ts.map(t => (t.id === id ? { ...t, ...p } : t)));
    const { error } = await supabase.from('tasks').update(p).eq('id', id);
    if (error) { setTasks(before); setErr(error.message); return false; }
    return true;
  };
  const setStatus = async (t, status) => {
    if (t.status === status) return;
    const p = { status, completed_at: status === 'done' ? new Date().toISOString() : null };
    if (status === 'blocked') { const why = prompt('What is it waiting on?', t.blocked_reason || ''); if (why === null) return; p.blocked_reason = why.trim() || null; }
    else if (t.status === 'blocked') p.blocked_reason = null;
    await patch(t.id, p);
  };
  const reassign = (t, ownerId) => patch(t.id, { owner_id: ownerId });
  const nudge = async (t) => {
    const who = t.owner_id;
    const { error } = await supabase.from('crm_activities').insert({ type: 'note', subject_type: 'task', subject_id: t.id, actor_id: profile.id,
      subject: 'Nudge', body: `${profile.display_name || 'Someone'} nudged this — no movement in ${STALL_DAYS}+ days.`, occurred_at: new Date().toISOString(), direction: 'outbound', is_internal: true });
    if (error) { setErr(error.message); return; }
    if (who && who !== profile.id) await supabase.from('notifications').insert({ recipient_id: who, actor_id: profile.id, type: 'system', title: 'Nudge', body: `“${t.title}” has not moved in ${STALL_DAYS}+ days.`, entity_type: 'task', link_id: t.id });
    alert('Nudged.');
    load();
  };
  const assignUnassigned = async (list) => {
    const name = prompt('Assign to (name):'); if (!name?.trim()) return;
    const m = members.find(x => (x.display_name || x.email).toLowerCase().startsWith(name.trim().toLowerCase()));
    if (!m) { alert('No one by that name.'); return; }
    const { error } = await supabase.from('tasks').update({ owner_id: m.id }).in('id', list.map(t => t.id));
    if (error) { setErr(error.message); return; }
    load();
  };

  // ── Board data ─────────────────────────────────────────────────────────────
  const weekAgo = addDays(new Date(), -7).getTime();
  // A remembered project that is no longer active (completed, cancelled, deleted) falls back to All.
  const projectFilter = rawProjectFilter && projects.some(p => p.id === rawProjectFilter) ? rawProjectFilter : '';
  const scoped = useMemo(() => tasks.filter(t =>
    (!projectFilter || t.project_id === projectFilter) &&
    (lens !== 'mine' || t.owner_id === profile.id || !t.owner_id)
  ), [tasks, projectFilter, lens, profile.id]);
  const counts = useMemo(() => ({
    todo: scoped.filter(t => t.status === 'todo').length,
    in_progress: scoped.filter(t => t.status === 'in_progress').length,
    blocked: scoped.filter(t => t.status === 'blocked').length,
    doneWeek: scoped.filter(t => t.status === 'done' && t.completed_at && new Date(t.completed_at).getTime() >= weekAgo).length,
  }), [scoped, weekAgo]);
  const LANE_CAP = 20;
  const swimlanes = useMemo(() => {
    if (lanes === 'none') return [{ key: 'all', title: null, tasks: scoped }];
    if (lanes === 'assignee') {
      const ids = [...new Set(scoped.map(t => t.owner_id))];
      return ids.map(id => ({ key: id || 'none', title: id ? nameOf(id) : 'Unassigned', tasks: scoped.filter(t => t.owner_id === id) }))
        .sort((a, b) => (a.key === 'none') - (b.key === 'none') || a.title.localeCompare(b.title));
    }
    const all = projects.filter(p => !projectFilter || p.id === projectFilter)
      .map(p => ({ key: p.id, title: p.name, customer: customerOf(p), due: p.due_date, updated: p.updated_at, tasks: scoped.filter(t => t.project_id === p.id) }));
    // A picked project always shows, even with nothing in it yet: that is where its first task starts.
    const rows = all.filter(r => r.tasks.length || r.key === projectFilter)
      .sort((x, y) => (x.due || '9999').localeCompare(y.due || '9999') || String(y.updated).localeCompare(String(x.updated)));
    // Empty projects (mine, or everyone's under Team) fill the remaining room, newest first: a project
    // you just made is on the board with its "+ Add task" cell before it has a single task.
    const empty = projectFilter ? [] : all.filter(r => !r.tasks.length && (lens !== 'mine' || projects.find(p => p.id === r.key)?.owner_id === profile.id))
      .sort((x, y) => String(y.updated).localeCompare(String(x.updated)));
    const shown = projectFilter ? rows : rows.slice(0, LANE_CAP).concat(empty.slice(0, Math.max(0, LANE_CAP - Math.min(rows.length, LANE_CAP))));
    const loose = scoped.filter(t => !projects.some(p => p.id === t.project_id));
    if (loose.length && !projectFilter) shown.push({ key: 'none', title: 'No project', tasks: loose });
    return shown;
  }, [lanes, scoped, projects, members, companies, locations, deals, projectFilter, lens, profile.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const laneNote = useMemo(() => {
    if (lanes !== 'project' || projectFilter) return null;
    const active = projects.length;
    const withWork = projects.filter(p => scoped.some(t => t.project_id === p.id)).length;
    const shown = swimlanes.filter(l => l.key !== 'none').length;
    const hidden = Math.max(0, active - shown);
    if (!hidden) return null;
    return `${hidden} more project${hidden === 1 ? '' : 's'} not shown${withWork > LANE_CAP ? ' (some with work)' : ''} — pick one under Project, or search Projects`;
  }, [lanes, projectFilter, projects, scoped, swimlanes]);

  // ── People data ────────────────────────────────────────────────────────────
  const peopleRows = useMemo(() => {
    const today = dayKey(new Date()), weekEnd = dayKey(addDays(startOfWeek(new Date()), 7));
    const inWindow = windowMode === 'week'
      ? tasks.filter(t => t.status !== 'done' && (t.status === 'in_progress' || (t.due_date && t.due_date < weekEnd)))
      : tasks.filter(t => t.status !== 'done');
    const items = inWindow.map(t => ({ ...t, due_at: t.due_date ? t.due_date + 'T00:00:00' : null, source_id: t.id, type: 'task' }));
    return workloadRows(items, members).map(r => {
      const projectsN = new Set(r.items.map(i => i.project_id).filter(Boolean)).size;
      const trackedWeek = r.id ? entries.filter(e => e.profile_id === r.id).reduce((s, e) => s + (e.duration_seconds || 0), 0) : 0;
      const capacity = r.overdue > 0 || r.total > MAX_OPEN ? 'over' : r.total >= 3 ? 'balanced' : 'room';
      const untouched = r.items.filter(i => isStalled(i)).length;
      const waiting = r.blocked;
      return { ...r, projectsN, trackedWeek, capacity, untouched, waiting, role: members.find(m => m.id === r.id)?.role };
    });
  }, [tasks, members, entries, windowMode]);
  const stalled = useMemo(() => tasks.filter(t => t.status !== 'done' && isStalled(t)).sort((a, b) => new Date(a.updated_at) - new Date(b.updated_at)), [tasks]);
  const unassignedN = tasks.filter(t => t.status !== 'done' && !t.owner_id).length;
  const openN = tasks.filter(t => t.status !== 'done').length;

  const tone = (k) => k === 'amber' ? 'rgb(var(--c-amber-deep))' : k === 'coral' ? 'rgb(var(--c-coral-deep))' : k === 'primary' ? 'rgb(var(--c-primary-deep))' : 'rgb(var(--c-muted))';

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--scene)' }}>
      {tab === 'board' && (
        <div className="lg:hidden px-[18px] pt-3 pb-2.5">
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <div className="font-display text-[23px] font-extrabold text-paper">Work board</div>
              <Mono className="!tracking-[.18em] uppercase">Swipe between columns</Mono>
            </div>
            <button onClick={() => setTab('people')} className="text-[13px] text-muted pt-2">People →</button>
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            <LensPill on={lens === 'mine'} onClick={() => setLens('mine')}>Mine</LensPill>
            <LensPill on={lens === 'team'} onClick={() => setLens('team')}>Team</LensPill>
            <select value={projectFilter} onChange={e => setProjectFilter(e.target.value)} className="flex-1 min-w-0 px-2.5 py-[7px] rounded-full border text-[12px] text-paper" style={{ background: 'var(--panel-bg)', borderColor: 'var(--bdr)' }}>
              <option value="">All projects</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="mt-2.5 -mx-[4px] flex gap-1.5 overflow-x-auto [scrollbar-width:none] px-[4px]">
            {COLUMNS.map(([k, label]) => {
              const on = mCol === k; const n = k === 'done' ? counts.doneWeek : counts[k];
              return (
                <button key={k} onClick={() => setMCol(k)} className="shrink-0 px-[13px] py-2 rounded-full text-[13px] border"
                  style={on ? { background: 'rgb(var(--c-text))', color: 'var(--on-accent)', borderColor: 'transparent', fontWeight: 600 } : { background: 'var(--panel-bg)', borderColor: 'var(--bdr)', color: 'rgb(var(--c-muted))' }}>
                  {label}{k === 'done' ? '' : ` ${n}`}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {tab === 'board' ? (
        <div className="hidden lg:flex px-6 pt-5 items-center gap-4 flex-wrap">
          <PageTitle>Board</PageTitle>
          <Segmented value="board" options={[['list', 'List'], ['board', 'Board'], ['calendar', 'Calendar']]} onChange={(v) => { if (v === 'list') onNavigate?.('tasks'); if (v === 'calendar') onNavigate?.('work_calendar'); }} />
          <span className="relative">
            <LabelledPill label="Swimlanes:" value={lanes === 'project' ? 'Project' : lanes === 'assignee' ? 'Assignee' : 'None'} onClick={() => setLanesMenu(v => !v)} />
            {lanesMenu && (
              <div className="absolute left-0 top-full mt-1 z-40 min-w-[140px] menu-surface rounded-[10px] py-1" onMouseLeave={() => setLanesMenu(false)}>
                {[['project', 'Project'], ['assignee', 'Assignee'], ['none', 'None']].map(([k, l]) => <button key={k} onClick={() => { setLanes(k); setLanesMenu(false); }} className={`w-full px-3 py-2 text-left text-[13px] text-paper hover:bg-ember/10 ${lanes === k ? 'font-semibold' : ''}`}>{l}</button>)}
              </div>
            )}
          </span>
          <span className="flex items-center gap-1">
            <LensPill on={lens === 'mine'} onClick={() => setLens('mine')}>Mine</LensPill>
            <LensPill on={lens === 'team'} onClick={() => setLens('team')}>Team</LensPill>
          </span>
          <span className="relative">
            <LabelledPill label="Project:" value={projectFilter ? (projects.find(p => p.id === projectFilter)?.name || '…') : 'All'} onClick={() => { setProjectMenu(v => !v); setProjectQ(''); }} />
            {projectMenu && (
              <div className="absolute left-0 top-full mt-1 z-40 w-[300px] menu-surface rounded-[10px] py-1" onMouseLeave={() => setProjectMenu(false)}>
                <div className="px-2 pb-1"><input autoFocus value={projectQ} onChange={e => setProjectQ(e.target.value)} placeholder="Search projects…" className="w-full px-2.5 py-1.5 rounded-[8px] border bg-transparent text-[13px] text-paper placeholder-dim focus:outline-none" style={{ borderColor: 'var(--ink-line)' }} /></div>
                <button onClick={() => { setProjectFilter(''); setProjectMenu(false); }} className={`w-full px-3 py-2 text-left text-[13px] text-paper hover:bg-ember/10 ${!projectFilter ? 'font-semibold' : ''}`}>All projects</button>
                <div className="max-h-64 overflow-y-auto">
                  {projects.filter(p => !projectQ.trim() || `${p.name} ${customerOf(p) || ''}`.toLowerCase().includes(projectQ.trim().toLowerCase())).slice(0, 50).map(p => (
                    <button key={p.id} onClick={() => { setProjectFilter(p.id); setProjectMenu(false); }} className={`w-full px-3 py-2 text-left text-[13px] text-paper hover:bg-ember/10 ${projectFilter === p.id ? 'font-semibold' : ''}`}>
                      <span className="block truncate">{p.name}</span>{customerOf(p) && <span className="block text-[11px] text-dim truncate">{customerOf(p)}</span>}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </span>
          <Mono className="hidden xl:inline">Drag between columns to set status · drag onto an avatar to reassign</Mono>
          {canWrite && (
            <span className="flex items-center gap-1 ml-auto" title="Drop a card here to reassign">
              {members.map(m => (
                <span key={m.id} onDragOver={e => { if (drag) e.preventDefault(); }} onDrop={() => { if (drag) { reassign(drag, m.id); setDrag(null); } }}
                  className={`rounded-full transition ${drag ? 'ring-2 ring-ember/40 ring-offset-1' : ''}`}><Avatar id={m.id} name={m.display_name || m.email} size={26} /></span>
              ))}
            </span>
          )}
          <button onClick={() => setTab('people')} className="text-[13px] text-muted hover:text-paper">People →</button>
        </div>
      ) : (
        <div className="px-6 pt-5 flex items-start gap-4 flex-wrap">
          <div className="flex-1 min-w-0">
            <PageTitle className="mb-1">People</PageTitle>
            <MetaLabel>{members.length} people · {openN} open task{openN === 1 ? '' : 's'} · {unassignedN} unassigned</MetaLabel>
          </div>
          <span className="relative">
            <LabelledPill label="Window:" value={windowMode === 'week' ? 'This week' : 'All open'} onClick={() => setWindowMenu(v => !v)} />
            {windowMenu && (
              <div className="absolute right-0 top-full mt-1 z-40 min-w-[140px] menu-surface rounded-[10px] py-1" onMouseLeave={() => setWindowMenu(false)}>
                {[['week', 'This week'], ['all', 'All open']].map(([k, l]) => <button key={k} onClick={() => { setWindowMode(k); setWindowMenu(false); }} className={`w-full px-3 py-2 text-left text-[13px] text-paper hover:bg-ember/10 ${windowMode === k ? 'font-semibold' : ''}`}>{l}</button>)}
              </div>
            )}
          </span>
          <button onClick={() => setTab('board')} className="text-[13px] text-muted hover:text-paper">Board →</button>
        </div>
      )}
      {err && <div className="px-6 pt-2 text-[12px]" style={{ color: 'rgb(var(--c-coral-deep))' }}>Could not save: {err} <button className="underline ml-1" onClick={() => setErr('')}>dismiss</button></div>}

      {!loading && tab === 'board' && (
        <div className="lg:hidden flex-1 overflow-y-auto px-[14px] pb-[calc(70px+env(safe-area-inset-bottom))] flex flex-col gap-2.5"
          onTouchStart={e => setSwipeX(e.touches[0].clientX)}
          onTouchEnd={e => {
            if (swipeX == null) return; const dx = e.changedTouches[0].clientX - swipeX; setSwipeX(null);
            if (Math.abs(dx) < 60) return;
            const i = COLUMNS.findIndex(([k]) => k === mCol); const j = dx < 0 ? Math.min(i + 1, COLUMNS.length - 1) : Math.max(i - 1, 0);
            setMCol(COLUMNS[j][0]);
          }}>
          {(() => {
            const list = scoped.filter(t => t.status === mCol && (mCol !== 'done' || (t.completed_at && new Date(t.completed_at).getTime() >= weekAgo)));
            if (list.length === 0) return <Card className="px-4 py-6 text-center text-[14px] text-dim">Nothing {COLUMNS.find(([k]) => k === mCol)[1].toLowerCase()}.</Card>;
            return list.map(t => {
              const due = dueLabel(t.due_date, t.status); const tr = trackedFor(t); const p = projects.find(x => x.id === t.project_id);
              const sub = [p?.name, t.status === 'blocked' && t.blocked_reason ? `blocked by ${t.blocked_reason}` : null].filter(Boolean).join(' · ');
              return (
                <div key={t.id} {...longPress(t)} onClick={() => onNavigate?.('task', t.id)} className="rounded-[14px] px-[15px] py-[13px] border"
                  style={{ background: 'var(--surface-solid)', boxShadow: 'var(--shadow-tile)', borderColor: t.status === 'blocked' ? 'rgb(var(--c-coral) / .35)' : t.status === 'in_progress' ? 'rgb(var(--c-primary) / .35)' : 'var(--ink-line)' }}>
                  <div className="flex items-center gap-2">
                    <Pill tone="primary">Task</Pill>
                    {tr > 0 ? <Mono tone="primary" bold>{fmtHM(tr)}</Mono> : t.due_date ? <Mono tone={due.tone === 'coral' ? 'coral' : 'dim'} bold={due.tone === 'coral'}>{due.text}</Mono> : null}
                    <span className="ml-auto"><Avatar id={t.owner_id} name={nameOf(t.owner_id)} size={20} /></span>
                  </div>
                  <div className="text-[15px] font-medium text-paper mt-1">{t.title}</div>
                  {sub && <div className="text-[12px] text-muted mt-0.5 truncate">{sub}</div>}
                </div>
              );
            });
          })()}
          <div className="text-[12px] text-dim text-center pt-1">Hold a card to move it</div>
        </div>
      )}
      {moving && (
        <MobileSheet title={`Move “${moving.title}”`} sub="Fewer taps than a desktop drag" onClose={() => setMoving(null)}>
          {COLUMNS.filter(([k]) => k !== moving.status).map(([k, label]) => (
            <SheetRow key={k} sub={k === 'blocked' ? 'asks what it is blocked by' : undefined} active={k === 'blocked' && moveReason !== ''}
              onClick={async () => {
                if (k === 'blocked' && !moveReason.trim()) { setMoveReason(' '); return; }
                await (k === 'blocked' ? patch(moving.id, { status: 'blocked', blocked_reason: moveReason.trim() }) : setStatus(moving, k));
                setMoving(null);
              }}>{label}</SheetRow>
          ))}
          {moveReason !== '' && (
            <div className="px-[15px] py-2.5 rounded-[12px] border" style={{ background: 'var(--surface-solid)', borderColor: 'rgb(var(--c-coral) / .35)' }}>
              <input autoFocus value={moveReason.trim()} onChange={e => setMoveReason(e.target.value || ' ')} placeholder="Blocked by…" className="w-full bg-transparent text-[15px] text-paper placeholder-dim focus:outline-none"
                onKeyDown={async e => { if (e.key === 'Enter' && moveReason.trim()) { await patch(moving.id, { status: 'blocked', blocked_reason: moveReason.trim() }); setMoving(null); } }} />
              <div className="text-[11px] text-dim mt-1">Enter to move it to Blocked</div>
            </div>
          )}
        </MobileSheet>
      )}
      {loading ? <div className="p-6"><SkeletonList rows={4} /></div> : tab === 'board' ? (
        <div className="hidden lg:flex flex-1 overflow-auto px-6 pt-[18px] pb-6 flex-col gap-[14px]">
          {/* Column headers */}
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(4, minmax(0,1fr))' }}>
            {COLUMNS.map(([k, label, tn]) => {
              const over = k === 'in_progress' && counts.in_progress > WIP_LIMIT;
              return (
                <div key={k} className="flex items-center gap-2">
                  <MetaLabel tone={over ? 'amber' : tn === 'muted' ? 'muted' : tn}>{label}</MetaLabel>
                  <Mono size={10}>{k === 'done' ? `this week ${counts.doneWeek}` : counts[k]}</Mono>
                  {k === 'in_progress' && <Tag tone="amber" className="!text-[10px] !px-1.5">limit {WIP_LIMIT}{over ? ' · over' : ''}</Tag>}
                </div>
              );
            })}
          </div>
          {scoped.length === 0 && !projectFilter && <EmptyState title={lens === 'mine' ? 'Nothing of yours on the board' : 'Nothing to do yet'} body={lens === 'mine' ? 'Switch to Team to see everyone, or pick a project.' : 'Tasks appear here in four columns as soon as there are any.'} primary={canWrite ? 'Add a task' : null} onPrimary={() => onNavigate?.('tasks')} />}
          {scoped.length === 0 && projectFilter && lanes !== 'project' && (
            <EmptyState title="Nothing in this project yet" body="Add its first task, or switch Swimlanes to Project to see the lane." primary={canWrite ? 'Add a task' : null}
              onPrimary={() => { try { sessionStorage.setItem('project.openAdd', projectFilter); } catch { /* fine */ } onNavigate?.('project', projectFilter); }} />
          )}
          {laneNote && <Mono>{laneNote}</Mono>}
          {swimlanes.map(lane => {
            const gl = lane.due ? dueLabel(lane.due, 'todo') : null;
            const daysTo = lane.due ? Math.round((new Date(lane.due + 'T00:00:00') - new Date(new Date().toDateString())) / 86400000) : null;
            const doneAll = lane.tasks.filter(t => t.status === 'done');
            const doneWeek = doneAll.filter(t => t.completed_at && new Date(t.completed_at).getTime() >= weekAgo);
            return (
              <Card key={lane.key} className="p-[14px] flex flex-col gap-2.5">
                {lane.title && (
                  <div className="flex items-center gap-2.5">
                    <span className="text-[14px] font-bold text-paper truncate cursor-pointer" onClick={() => lanes === 'project' && lane.key !== 'none' && onNavigate?.('project', lane.key)}>{lane.title}</span>
                    {lane.customer && <Tag>{lane.customer}</Tag>}
                    {gl && (daysTo <= 14
                      ? <Mono tone="coral" bold>Go live {new Date(lane.due + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</Mono>
                      : <Mono>Due {new Date(lane.due + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</Mono>)}
                  </div>
                )}
                <div className="grid gap-3 items-start" style={{ gridTemplateColumns: 'repeat(4, minmax(0,1fr))' }}>
                  {COLUMNS.map(([k]) => {
                    const list = k === 'done' ? doneWeek : lane.tasks.filter(t => t.status === k);
                    return (
                      <div key={k} onDragOver={e => { if (drag) e.preventDefault(); }} onDrop={() => { if (drag) { setStatus(drag, k); setDrag(null); } }}
                        className={`flex flex-col gap-2 min-h-[44px] rounded-[12px] transition ${drag ? 'outline-dashed outline-1 outline-[var(--dash-line)]' : ''}`}>
                        {list.map(t => {
                          const due = dueLabel(t.due_date, t.status);
                          const tr = trackedFor(t);
                          const isDone = t.status === 'done';
                          return (
                            <div key={t.id} draggable={canWrite && !isDone} onDragStart={() => setDrag(t)} onDragEnd={() => setDrag(null)}
                              onClick={() => onNavigate?.('task', t.id)}
                              className={`rounded-[12px] px-3 py-[11px] cursor-pointer border ${canWrite && !isDone ? 'active:cursor-grabbing' : ''}`}
                              style={isDone
                                ? { background: 'var(--panel-bg)', borderColor: 'var(--hair)' }
                                : { background: 'var(--surface-solid)', boxShadow: 'var(--shadow-tile)',
                                    borderColor: t.status === 'blocked' ? 'rgb(var(--c-coral) / .35)' : t.status === 'in_progress' ? 'rgb(var(--c-primary) / .35)' : 'var(--ink-line)' }}>
                              <div className={`text-[13px] ${isDone ? 'text-dim line-through' : 'font-medium text-paper'}`}>{t.title}</div>
                              {!isDone && t.status === 'blocked' && t.blocked_reason && <div className="text-[11px] mt-0.5" style={{ color: 'rgb(var(--c-coral-deep))' }}>{t.blocked_reason}</div>}
                              {!isDone && (
                                <div className="flex items-center gap-1.5 mt-1.5">
                                  {t.priority && <Pill tone={t.priority === 'P0' || t.priority === 'P1' ? 'coral' : 'ink'} className="!px-[7px] !py-[2px] !rounded-[5px] !border-0">{PRIORITY_LABEL[t.priority]}</Pill>}
                                  {tr > 0 ? <Mono size={10} tone="primary">{fmtHM(tr)}</Mono>
                                    : t.due_date ? <Mono size={10} tone={due.tone === 'coral' ? 'coral' : 'dim'}>{due.tone === 'coral' ? `-${due.text.replace(/ days? late/, '')}d` : due.text}</Mono> : null}
                                  <span className="ml-auto"><Avatar id={t.owner_id} name={nameOf(t.owner_id)} size={20} /></span>
                                </div>
                              )}
                            </div>
                          );
                        })}
                        {k === 'todo' && canWrite && lanes === 'project' && lane.key !== 'none' && (
                          <button onClick={() => { try { sessionStorage.setItem('project.openAdd', lane.key); } catch { /* fine */ } onNavigate?.('project', lane.key); }} className="text-left text-[13px] text-dim px-3 py-2.5 rounded-[12px] border border-dashed hover:text-paper" style={{ borderColor: 'var(--dash-line)' }}>+ Add task</button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </Card>
            );
          })}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-6 pt-[18px] pb-6 flex flex-col gap-3">
          {peopleRows.filter(r => r.id).map(r => {
            const w = (n) => `${r.total ? (n / r.total) * 100 * r.scale : 0}%`;
            const cap = r.capacity === 'over' ? ['Over capacity', 'rgb(var(--c-coral))', 'Reassign · View tasks']
              : r.capacity === 'balanced' ? ['Balanced', 'rgb(var(--c-primary-deep))', 'Assign work'] : ['Has room', 'rgb(var(--c-muted))', 'Assign work'];
            return (
              <Card key={r.id} className="px-[18px] py-4 grid gap-[18px] items-center" style={{ gridTemplateColumns: '190px minmax(0,1fr) 150px' }}>
                <div className="flex items-center gap-2.5 min-w-0">
                  <Avatar id={r.id} name={r.name} size={34} />
                  <div className="min-w-0"><div className="text-[15px] font-semibold text-paper truncate">{r.name}</div><div className="text-[11px] text-dim capitalize">{r.role || 'member'}</div></div>
                </div>
                <div className="min-w-0">
                  <div className="flex h-[26px] rounded-[8px] overflow-hidden border" style={{ borderColor: 'var(--ink-line)' }}>
                    {r.overdue > 0 && <div className="flex items-center justify-center text-[11px] font-bold px-1 truncate" style={{ width: w(r.overdue), background: 'rgb(var(--c-coral))', color: 'var(--on-accent)' }}>{r.overdue} overdue</div>}
                    {r.blocked > 0 && <div className="flex items-center justify-center text-[11px] font-bold px-1 truncate" style={{ width: w(r.blocked), background: 'rgb(var(--c-coral) / .55)', color: 'var(--on-accent)' }}>{r.blocked} blocked</div>}
                    {r.inProgress > 0 && <div className="flex items-center justify-center text-[11px] font-bold px-1 truncate" style={{ width: w(r.inProgress), background: 'rgb(var(--c-amber))', color: 'rgb(var(--c-ink))' }}>{r.inProgress} doing</div>}
                    {r.todo > 0 && <div className="flex items-center justify-center text-[11px] font-semibold px-1 truncate" style={{ width: w(r.todo), background: 'rgb(var(--c-primary) / .35)' }}>{r.todo} to do</div>}
                    <div className="flex-1" style={{ background: 'var(--ink-soft)' }} />
                  </div>
                  <div className="text-[12px] text-muted mt-1.5 truncate">
                    {r.total} open{r.projectsN ? ` across ${r.projectsN} project${r.projectsN === 1 ? '' : 's'}` : ''}
                    {r.trackedWeek ? ` · ${fmtHM(r.trackedWeek)} tracked this week` : ''}
                    {r.waiting ? ` · ${r.waiting} waiting` : ''}{r.untouched && !r.waiting ? ` · ${r.untouched} untouched ${STALL_DAYS}+ days` : ''}
                    {!r.total ? ' · nothing dated this week' : ''}
                  </div>
                </div>
                <div>
                  <div className="font-mono text-[11px] font-bold" style={{ color: cap[1] }}>{cap[0]}</div>
                  <div className="text-[12px] text-muted">
                    {r.capacity === 'over'
                      ? <><button onClick={() => { setTab('board'); setLanes('assignee'); setLens('team'); }} className="hover:text-paper">Reassign</button> · <button onClick={() => onNavigate?.('tasks')} className="hover:text-paper">View tasks</button></>
                      : <button onClick={() => onNavigate?.('tasks')} className="hover:text-paper">Assign work</button>}
                  </div>
                </div>
              </Card>
            );
          })}
          {(() => {
            const u = peopleRows.find(r => !r.id);
            return (
              <Card panel className="px-[18px] py-4 grid gap-[18px] items-center border-dashed" style={{ gridTemplateColumns: '190px minmax(0,1fr) 150px', borderStyle: 'dashed', borderColor: 'var(--dash-line)' }}>
                <div className="flex items-center gap-2.5">
                  <Avatar id={null} size={34} />
                  <div><div className="text-[15px] font-semibold text-paper">Unassigned</div><div className="text-[11px] text-dim">Needs an owner</div></div>
                </div>
                <div className="text-[13px] text-paper-soft truncate">{u?.items?.length ? u.items.map(i => i.title).join(' · ') : 'Nothing waiting for an owner.'}</div>
                <div>{u?.items?.length > 0 && canWrite && <button onClick={() => assignUnassigned(u.items)} className="text-[12px] font-semibold" style={{ color: 'rgb(var(--c-primary-deep))' }}>Assign {u.items.length === 2 ? 'both' : 'all'}</button>}</div>
              </Card>
            );
          })()}
          <Card className="px-[18px] py-4">
            <div className="font-mono text-[9px] font-bold tracking-[.18em] uppercase text-dim mb-2.5">Stalled — no movement in {STALL_DAYS} days or more</div>
            {stalled.length === 0 && <div className="text-[13px] text-dim">Everything has moved recently.</div>}
            <div className="flex flex-col gap-2.5">
              {stalled.slice(0, 8).map(t => {
                const days = Math.floor((Date.now() - new Date(t.updated_at).getTime()) / 86400000);
                const p = projects.find(x => x.id === t.project_id);
                return (
                  <div key={t.id} className="flex items-center gap-2.5 text-[14px]">
                    <Avatar id={t.owner_id} name={nameOf(t.owner_id)} size={22} />
                    <span className="text-paper truncate cursor-pointer" onClick={() => onNavigate?.('task', t.id)}>{t.title}</span>
                    {t.status === 'blocked' ? <Tag tone="coral">Blocked</Tag> : p ? <Tag tone="uv">{p.name}</Tag> : null}
                    <Mono tone="coral" bold>{days} days</Mono>
                    {canWrite && <button onClick={() => nudge(t)} className="text-[12px] font-semibold ml-auto" style={{ color: 'rgb(var(--c-primary-deep))' }}>Nudge</button>}
                  </div>
                );
              })}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

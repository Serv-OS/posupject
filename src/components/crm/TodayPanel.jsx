import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { groupTasks, DUE_LABEL, dueBucket } from '../../lib/taskGrouping';
import { useStickyState } from '../../lib/stickyState';
import { dayKey, addDays } from '../../lib/planning';
import { priorityLabel } from '../../lib/priority';
import QuickAddRow from './QuickAddRow.jsx';
import {
  Avatar, TypeChip, StatusPill, MetaLabel, Mono, PageTitle, LensPill, Card, SkeletonList, EmptyState, PrimaryBtn, GhostBtn, SolidChipBtn,
  MobileDock, DockField, useSwipeRow, StatusMenu, MobileSheet, SheetRow, STATUS_LABEL, STATUS_ORDER, hair, dueLabel, fmtRel,
} from './ui.jsx';
import { getRunning, fmtClock } from '../../lib/timer';

// Screens 01 and 13 — the landing screen, across every module.
//
// Groups are computed from the DUE DATE against today, never from status:
// Overdue, Due today, Later this week, then No date at the bottom. A late
// ticket and a late task are the same problem and sit together. Type is a
// filter, never a separate screen: the row is the one from screen 02 with a
// type chip in the leading slot and the type's primary verb in the trailing
// slot — Approve for a bill, the status pill for a task.

const LENSES = [['mine', 'My work', 'Mine'], ['requested', 'Requested by me', 'Asked for'], ['team', 'Team', 'Team']];
const TYPES = [['all', 'Everything'], ['ticket', 'Tickets'], ['task', 'Tasks'], ['onboarding', 'Onboarding'], ['approval', 'Approvals'], ['request', 'Requests']];

export default function TodayPanel({ profile, onNavigate }) {
  const [items, setItems] = useState([]);
  const [members, setMembers] = useState([]);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [lens, setLens] = useStickyState('today.lens', 'mine');
  const [type, setType] = useStickyState('today.type', 'all');
  const [err, setErr] = useState('');
  const isApprover = profile.role === 'owner' || profile.role === 'editor';
  const [running, setRunning] = useState(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const refresh = () => getRunning(profile.id).then(setRunning);
    refresh(); window.addEventListener('timer-changed', refresh);
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => { window.removeEventListener('timer-changed', refresh); clearInterval(t); };
  }, [profile.id]);
  const [menuFor, setMenuFor] = useState(null);
  // Swipe-left on a phone opens a sheet: a dropdown inside the row is clipped by it.
  const [statusFor, setStatusFor] = useState(null);

  const load = useCallback(async () => {
    const [w, m, p] = await Promise.all([
      supabase.from('work_items').select('*').order('due_at', { ascending: true, nullsFirst: false }),
      supabase.from('profiles').select('id, email, display_name'),
      supabase.from('crm_projects').select('id, name, phases').eq('status', 'active'),
    ]);
    setItems(w.data || []); setMembers(m.data || []); setProjects(p.data || []);
    setLoading(false);
  }, []);
  useEffect(() => {
    load();
    const ch = supabase.channel('today').on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, load).subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load]);

  const firstName = (profile.display_name || profile.email.split('@')[0]).split(' ')[0];
  const greeting = (() => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; })();
  const nameOf = (id) => { const m = members.find(x => x.id === id); return m ? (m.display_name || m.email?.split('@')[0]) : ''; };

  // work_items carries source_id; grouping and rows speak `id` and `due_date`.
  const asRow = (w) => {
    // A deadline carrying a time of day (an SLA) is late the moment it passes.
    // A plain date is late the day after, and is read off the string: pushing a
    // date-only value through a Date shifts it a day in half the world's zones.
    // Approvals and requests carry no deadline at all, so they are never late.
    const iso = w.due_at ? String(w.due_at) : null;
    const undated = w.type === 'approval' || w.type === 'request';
    const midnight = !iso || /T00:00:00(\.\d+)?(Z|\+00:00)?$/.test(iso);
    let key = iso && !undated ? iso.slice(0, 10) : null;
    if (key && !midnight && new Date(iso) < Date.now()) key = dayKey(addDays(new Date(), -1));
    return { ...w, id: `${w.type}:${w.source_id}`, due_date: key, raised_at: undated ? w.due_at : null };
  };
  const open = useMemo(() => items.filter(w => w.status !== 'done').map(asRow), [items]);

  // Approvals and requests have no single owner: they are for whoever can
  // approve, so they sit in My work for approvers and in Team for everyone.
  const byLens = useMemo(() => {
    if (lens === 'team') return open;
    if (lens === 'requested') return open.filter(w => w.created_by === profile.id && w.owner_id !== profile.id);
    return open.filter(w => w.owner_id === profile.id
      || (isApprover && (w.type === 'approval' || w.type === 'request') && !w.owner_id && w.created_by !== profile.id));
  }, [open, lens, profile.id, isApprover]);
  const typeCounts = useMemo(() => { const c = {}; for (const w of byLens) c[w.type] = (c[w.type] || 0) + 1; return c; }, [byLens]);
  const shown = useMemo(() => (type === 'all' ? byLens : byLens.filter(w => w.type === type)), [byLens, type]);

  const groups = useMemo(() => groupTasks(shown, 'due', { projects, members }), [shown, projects, members]);
  const counts = useMemo(() => {
    const c = { overdue: 0, today: 0, week: 0 };
    for (const w of shown) { const b = dueBucket(w); if (b === 'overdue') c.overdue++; else if (b === 'today') c.today++; else if (b === 'this_week') c.week++; }
    return c;
  }, [shown]);
  // Blocked work that is actually yours, not everything blocked anywhere.
  const waiting = useMemo(() => byLens.filter(w => w.status === 'blocked'), [byLens]);
  const asked = useMemo(() => open.filter(w => w.created_by === profile.id && w.owner_id !== profile.id), [open, profile.id]);

  const go = (w) => onNavigate?.(w.type === 'approval' ? (w.source_table === 'expenses' ? 'expense' : w.source_table === 'bills' ? 'bill' : 'quote') : w.type === 'request' ? 'feature_request' : w.type, w.source_id);

  // The type's primary verb: approve an expense right here.
  const approve = async (w) => {
    if (w.source_table !== 'expenses') { go(w); return; }
    if (!confirm(`Approve ${w.title}${w.subtitle ? ` (${w.subtitle})` : ''}?`)) return;
    const { error } = await supabase.from('expenses').update({ status: 'approved', approver_id: profile.id, approved_at: new Date().toISOString() }).eq('id', w.source_id);
    if (error) { setErr(error.message); return; }
    load();
  };

  const setTaskStatus = async (w, status) => {
    if (w.type !== 'task') { go(w); return; }
    const patch = { status, completed_at: status === 'done' ? new Date().toISOString() : null };
    if (status === 'blocked') { const why = prompt('What is it waiting on?', w.blocked_reason || ''); if (why === null) return; patch.blocked_reason = why.trim() || null; }
    setMenuFor(null);
    const { error } = await supabase.from('tasks').update(patch).eq('id', w.source_id);
    if (error) { setErr(error.message); return; }
    load();
  };

  const trailing = (w) => {
    const due = dueLabel(w.due_date, w.status);
    if (w.type === 'ticket' && w.due_date) {
      const mins = Math.round((new Date(w.due_at) - Date.now()) / 60000);
      const late = mins < 0;
      const txt = Math.abs(mins) < 60 ? `${Math.abs(mins)}m` : Math.abs(mins) < 1440 ? `${Math.round(Math.abs(mins) / 60)}h` : `${Math.round(Math.abs(mins) / 1440)}d`;
      return <Mono tone={late ? 'coral' : 'muted'} bold={late}>SLA {late ? '-' : ''}{txt}</Mono>;
    }
    if (w.raised_at) return <Mono tone="muted">Raised {fmtRel(w.raised_at)}</Mono>;
    if (w.type === 'onboarding' && w.due_date) return <Mono tone={due.tone === 'coral' ? 'coral' : 'muted'} bold={due.tone === 'coral'}>Live {new Date(w.due_date + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</Mono>;
    return <Mono tone={due.tone === 'coral' ? 'coral' : due.tone === 'primary' ? 'primary' : 'dim'} bold={due.tone !== 'dim'}>{due.text}</Mono>;
  };

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--scene-bg)' }}>
      {/* Header: display face at 28/800 and the whole day in one mono line. */}
      <div className="px-[18px] lg:px-7 pt-3 lg:pt-5 flex items-start gap-3 lg:gap-5">
        <div className="flex-1 min-w-0">
          <PageTitle size={28} className="mb-1.5 hidden lg:block">{greeting}, {firstName}</PageTitle>
          <PageTitle size={23} className="mb-1 lg:hidden">Today</PageTitle>
          <MetaLabel>
            {counts.overdue > 0 && <span style={{ color: 'rgb(var(--c-coral))' }}>{counts.overdue} overdue &middot; </span>}
            {counts.today} due today<span className="hidden lg:inline"> &middot; {counts.week} this week &middot; {waiting.length} waiting on others</span>
          </MetaLabel>
        </div>
        {running && (
          <span className="lg:hidden inline-flex items-center gap-[7px] px-[11px] py-[7px] rounded-full border font-mono text-[11px] font-bold shrink-0"
            style={{ background: 'rgb(var(--c-primary) / .12)', borderColor: 'rgb(var(--c-primary) / .30)', color: 'rgb(var(--c-primary-deep))' }}>
            {fmtClock((now - new Date(running.started_at).getTime()) / 1000).replace(/^0:/, '')}
          </span>
        )}
        <button onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))}
          className="hidden md:flex items-center gap-2 px-3 py-2 rounded-[10px] border text-[13px] text-dim w-[220px]" style={{ background: 'var(--panel-bg)', borderColor: 'var(--bdr)' }}>
          Search or jump to&hellip;<span className="ml-auto font-mono text-[11px] text-dim">&#8984;K</span>
        </button>
        <span className="hidden lg:inline-flex"><Avatar id={profile.id} name={profile.display_name || firstName} size={32} /></span>
      </div>

      <div className="hidden lg:block px-7 pt-[18px]">
        <QuickAddRow profile={profile} members={members} projects={projects} onCreated={load} onOpen={(id) => onNavigate?.('task', id)} />
      </div>

      {/* Lenses, then type pills. Type is a filter, never a separate screen. */}
      <div className="px-[14px] lg:px-7 pt-3 lg:pt-4 flex items-center gap-1.5 flex-wrap">
        {LENSES.map(([k, l, short]) => <LensPill key={k} on={lens === k} onClick={() => setLens(k)} count={k === 'requested' && asked.length ? asked.length : undefined}><span className="lg:hidden">{short}</span><span className="hidden lg:inline">{l}</span></LensPill>)}
      </div>
      <div className="px-[14px] lg:px-7 pt-2.5 flex items-center gap-1.5 overflow-x-auto lg:flex-wrap [scrollbar-width:none]">
        {TYPES.filter(([k]) => k === 'all' || typeCounts[k]).map(([k, l]) => (
          <LensPill key={k} on={type === k} onClick={() => setType(k)} count={k === 'all' ? byLens.length : typeCounts[k]}>{l}</LensPill>
        ))}
        <Mono className="ml-1 hidden lg:inline">Type is a filter, never a separate screen</Mono>
      </div>
      {err && <div className="px-7 pt-2 text-[12px]" style={{ color: 'rgb(var(--c-coral-deep))' }}>Could not save: {err} <button className="underline ml-1" onClick={() => setErr('')}>dismiss</button></div>}

      <div className="flex-1 overflow-y-auto">
        <div className="px-[14px] lg:px-7 pt-[14px] lg:pt-[18px] pb-4 lg:pb-6 grid gap-[18px] lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="flex flex-col gap-4 min-w-0">
            {loading ? <SkeletonList rows={4} /> : groups.length === 0 ? (
              <EmptyState title={lens === 'mine' ? 'Nothing waiting on you.' : 'Nothing here.'} body="Add the first thing above, or switch to Team." />
            ) : groups.map(g => (
              <div key={g.key}>
                {/* Label, count, a hairline to the edge. Not a box: boxing each
                    group made four cards where the eye wants one list with breaks. */}
                <div className="flex items-center gap-2 mb-2">
                  <MetaLabel tone={g.key === 'overdue' ? 'coral' : g.key === 'today' ? 'primary' : undefined}>{g.label}</MetaLabel>
                  <Mono size={10}>{g.tasks.length}</Mono>
                  <span className="flex-1 h-px" style={{ background: 'var(--ink-line)' }} />
                </div>
                <Card>
                  {g.tasks.map((w, i) => (
                    <Row key={w.id} w={w} last={i === g.tasks.length - 1} late={g.key === 'overdue'} go={go} approve={approve} nameOf={nameOf} isApprover={isApprover}
                      trailing={trailing} menuFor={menuFor} setMenuFor={setMenuFor} onStatus={(s) => setTaskStatus(w, s)} onComplete={() => setTaskStatus(w, 'done')}
                      openStatus={() => setStatusFor(w)} />
                  ))}
                </Card>
              </div>
            ))}
          </div>

          <div className="hidden lg:flex flex-col gap-4">
            <Card>
              <div className="px-4 py-2.5 border-b text-[11px] font-bold text-paper" style={hair}>Waiting on others</div>
              {waiting.length === 0 ? <div className="px-4 py-4 text-xs text-dim italic">Nothing blocked.</div> : waiting.slice(0, 8).map((w, i) => (
                <button key={w.id} onClick={() => go(w)} className={`w-full px-4 py-2 text-left hover:bg-card/50 ${i < Math.min(waiting.length, 8) - 1 ? 'border-b' : ''}`} style={hair}>
                  <div className="text-xs text-paper truncate">{w.title}</div>
                  <div className="text-[11px] text-dim truncate">{w.blocked_reason || nameOf(w.owner_id) || 'Unassigned'}</div>
                </button>
              ))}
            </Card>
            <Card>
              <div className="px-4 py-2.5 border-b text-[11px] font-bold text-paper" style={hair}>I asked for</div>
              {asked.length === 0 ? <div className="px-4 py-4 text-xs text-dim italic">Nothing assigned to others.</div> : asked.slice(0, 6).map((w, i) => {
                const stale = w.updated_at && (Date.now() - new Date(w.updated_at).getTime()) / 86400000 >= 5;
                return (
                  <button key={w.id} onClick={() => go(w)} className={`w-full px-4 py-2 text-left hover:bg-card/50 ${i < Math.min(asked.length, 6) - 1 ? 'border-b' : ''}`} style={hair}>
                    <div className="text-xs text-paper truncate">{w.title}</div>
                    <div className="text-[11px] truncate" style={{ color: stale ? 'rgb(var(--c-coral))' : 'rgb(var(--c-dim))' }}>{nameOf(w.owner_id)} · {stale ? `untouched ${Math.floor((Date.now() - new Date(w.updated_at).getTime()) / 86400000)} days` : `moved ${fmtRel(w.updated_at)}`}</div>
                  </button>
                );
              })}
            </Card>
            <Card className="p-4">
              <div className="font-mono text-[9px] font-bold uppercase tracking-[.18em] text-dim mb-2">This week</div>
              {[['overdue', DUE_LABEL.overdue, counts.overdue], ['today', DUE_LABEL.today, counts.today], ['this_week', DUE_LABEL.this_week, counts.week]].map(([k, l, n]) => (
                <div key={k} className="flex items-center justify-between py-1">
                  <span className="text-xs" style={{ color: k === 'overdue' && n > 0 ? 'rgb(var(--c-coral))' : 'rgb(var(--c-muted))' }}>{l}</span>
                  <span className="text-sm font-semibold tabular-nums text-paper">{n}</span>
                </div>
              ))}
            </Card>
          </div>
          <div className="lg:hidden text-[12px] text-dim px-1.5 -mt-2">Swipe right to complete · swipe left for status</div>
        </div>
      </div>
      {statusFor && (
        <MobileSheet title={statusFor.title} sub="Set status" onClose={() => setStatusFor(null)}>
          {STATUS_ORDER.map(st => (
            <SheetRow key={st} active={statusFor.status === st} onClick={() => { setTaskStatus(statusFor, st); setStatusFor(null); }}>{STATUS_LABEL[st]}</SheetRow>
          ))}
        </MobileSheet>
      )}
      <MobileDock>
        <DockField onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))}>Add task, note or photo</DockField>
      </MobileDock>
    </div>
  );
}

// One row, swipeable on a phone: right completes, left opens status. On
// desktop the checkbox and the pill do those jobs, so mouse drags are ignored.
function Row({ w, last, late, go, approve, nameOf, isApprover, trailing, menuFor, setMenuFor, onStatus, onComplete, openStatus }) {
  const { dx, handlers } = useSwipeRow(() => w.type === 'task' && onComplete(), () => w.type === 'task' && openStatus());
  const revealRight = dx > 24, revealLeft = dx < -24;
  return (
    <div className="relative overflow-hidden" style={{ borderBottom: last ? 'none' : '1px solid var(--hair)' }}>
      {revealRight && <div className="absolute inset-y-0 left-0 w-[64px] flex items-center justify-center text-[12px] font-bold" style={{ background: 'rgb(var(--c-primary))', color: 'rgb(var(--c-ink))' }}>Done</div>}
      {revealLeft && <div className="absolute inset-y-0 right-0 w-[72px] flex items-center justify-center text-[12px] font-bold" style={{ background: 'var(--ink-strong)', color: 'rgb(var(--c-text))' }}>Status</div>}
      <div {...handlers} className="relative sm:flex sm:items-center sm:gap-3 px-[14px] sm:px-4 py-[13px] sm:py-3"
        style={{ transform: dx ? `translateX(${dx}px)` : undefined, transition: dx ? 'none' : 'transform .15s', background: 'var(--surface-solid)',
          borderLeft: late ? '3px solid rgb(var(--c-coral))' : '3px solid transparent' }}>
        {/* Phone: chip and the trailing fact on one line, title under, subtitle under that (15).
            Desktop: one line, chip · title/subtitle · trailing · status · avatar (01/13). */}
        <div className="flex items-center gap-2 sm:contents">
          <TypeChip type={w.type} />
          <span className="sm:hidden">{trailing(w)}</span>
          {/* the phone row said nothing about state; the pill is small and it earns its place */}
          {w.type !== 'approval' && w.type !== 'request' && <span className="sm:hidden ml-auto"><StatusPill status={w.status} caret={false} /></span>}
        </div>
        <div className="flex-1 min-w-0 cursor-pointer mt-1.5 sm:mt-0" onClick={() => go(w)}>
          <div className="text-[15px] font-medium text-paper truncate">{w.title}</div>
          <div className="text-[12px] sm:text-[11px] text-muted truncate">
            {[w.subtitle, w.blocked_reason ? `blocked by ${w.blocked_reason}` : null, w.type === 'ticket' && w.priority ? priorityLabel(w.priority) : null].filter(Boolean).join(' · ')}
          </div>
        </div>
        <span className="hidden sm:inline-flex">{trailing(w)}</span>
        {w.type === 'approval'
          ? (isApprover && (
              <div className="flex gap-2 mt-2.5 sm:mt-0 sm:contents">
                <PrimaryBtn small onClick={() => approve(w)} className="flex-1 sm:flex-none justify-center">Approve</PrimaryBtn>
                <span className="sm:hidden flex-1"><GhostBtn onClick={() => go(w)} className="w-full justify-center">Open</GhostBtn></span>
              </div>))
          : w.type === 'request'
            ? <span className="inline-flex mt-2 sm:mt-0"><SolidChipBtn onClick={() => go(w)}>Triage</SolidChipBtn></span>
            : <span className="relative hidden sm:inline-flex"><StatusPill status={w.status} caret={false} onClick={w.type === 'task' ? () => setMenuFor(menuFor === w.id ? null : w.id) : undefined} />
                {menuFor === w.id && <StatusMenu current={w.status} onPick={onStatus} onClose={() => setMenuFor(null)} />}</span>}
        <span className="hidden sm:inline-flex"><Avatar id={w.owner_id} name={nameOf(w.owner_id)} /></span>
      </div>
    </div>
  );
}

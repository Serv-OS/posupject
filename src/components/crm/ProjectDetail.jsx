import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import AttachmentsCard from './AttachmentsCard.jsx';
import { getRunning, startTimer, stopTimer, fmtClock } from '../../lib/timer';
import { parseQuickAdd, quickAddRow } from '../../lib/quickAdd';
import { PRIORITY_LABEL } from '../../lib/priority';
import {
  Avatar, Check, Pill, StatusPill, LinkChip, SectionLabel, Mono, PageTitle,
  PrimaryBtn, GhostBtn, SolidChipBtn, Card, DashedAdd, SkeletonList, MobileDock, DockField, hair, dueLabel, MetaLabel, Segmented, fmtShort, fmtRel, STATUS_ORDER, STATUS_LABEL,
} from './ui.jsx';
import { weekColumns, rangeLabel, spanPercent, phaseSpans, addDays, startOfWeek } from '../../lib/planning';
import { useStickyState } from '../../lib/stickyState';
import { useIsMobile } from '../../lib/useMedia';

// Screen 04 — a project reads as a plan, not a pile.
//
// The structure is the design: phases are cards with their tasks INSIDE them,
// so "where are we" is read top to bottom without opening anything. A task
// with no phase collects in an unnamed group at the bottom, which means an
// instance that never names a phase sees exactly the flat list it has today.
//
// The rail has three things and only three: who is on it, what just happened,
// and one row for everything that could be added. Empty cards are gone —
// a "Linked to: nothing" panel told you only that the page had room for one.

const SUBJECT_LABEL = { company: 'Company', location: 'Site', deal: 'Deal', onboarding: 'Onboarding', ticket: 'Ticket' };
const PROJECT_STATUSES = ['active', 'completed', 'cancelled'];

export default function ProjectDetail({ projectId, profile, onClose, onSelectTask, onNavigate }) {
  const [project, setProject] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [members, setMembers] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [locations, setLocations] = useState([]);
  const [deals, setDeals] = useState([]);
  const [onboardings, setOnboardings] = useState([]);
  const [activity, setActivity] = useState([]);
  const [attachmentCount, setAttachmentCount] = useState(0);
  const [showAttachments, setShowAttachments] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const [addingTo, setAddingTo] = useState(null);
  // The project's own views (owner's call, 3 Sep): phases, the same tasks as a board, or a timeline.
  const [view, setView] = useStickyState('project.view', 'phases');
  const isMobile = useIsMobile();
  const effView = isMobile ? 'phases' : view;
  const [drag, setDrag] = useState(null);   // phase key the inline add is open for
  const [addText, setAddText] = useState('');
  const [statusMenu, setStatusMenu] = useState(null); // task id with the status popover open
  const [err, setErr] = useState('');
  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  useEffect(() => { load(); }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Tasks added elsewhere (⌘K, the board, a colleague) appear without leaving the page.
  useEffect(() => {
    const ch = supabase.channel(`project-${projectId}-tasks`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks', filter: `project_id=eq.${projectId}` }, () => load())
      // Deletes carry only the old row's id, so they are heard unfiltered.
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'tasks' }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  // The board's "+ Add task" lands here with the add row already open.
  useEffect(() => {
    try { const want = sessionStorage.getItem('project.openAdd'); if (want) sessionStorage.removeItem('project.openAdd'); if (want === projectId) setAddingTo('__open'); } catch { /* fine */ }
  }, [projectId]);

  const load = async () => {
    const [p, t, m, c, l, d, ob] = await Promise.all([
      supabase.from('crm_projects').select('*').eq('id', projectId).single(),
      supabase.from('tasks').select('*').eq('project_id', projectId).is('parent_task_id', null).order('sort_order'),
      supabase.from('profiles').select('id, email, display_name'),
      supabase.from('companies').select('id, name'),
      supabase.from('locations').select('id, name, company_id'),
      supabase.from('deals').select('id, name, company_id'),
      supabase.from('onboardings').select('id, company_id, deal_id, location_id, stage'),
    ]);
    setProject(p.data); setTasks(t.data || []); setMembers(m.data || []);
    setCompanies(c.data || []); setLocations(l.data || []); setDeals(d.data || []); setOnboardings(ob.data || []);
    const ids = (t.data || []).map(x => x.id);
    const [act, att] = await Promise.all([
      supabase.from('crm_activities').select('id, type, subject, body, actor_id, occurred_at, subject_type, subject_id')
        .or(`and(subject_type.eq.project,subject_id.eq.${projectId})${ids.length ? `,and(subject_type.eq.task,subject_id.in.(${ids.join(',')}))` : ''}`)
        .order('occurred_at', { ascending: false }).limit(8),
      supabase.from('attachments').select('id', { count: 'exact', head: true }).eq('subject_type', 'project').eq('subject_id', projectId),
    ]);
    setActivity(act.data || []);
    setAttachmentCount(att.count || 0);
  };

  // ── Timer (header button reads the same running entry as the sidebar card) ──
  const [running, setRunning] = useState(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const refresh = () => getRunning(profile.id).then(setRunning);
    refresh();
    window.addEventListener('timer-changed', refresh);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { window.removeEventListener('timer-changed', refresh); clearInterval(tick); };
  }, [profile.id]);
  const timerHere = running && running.subject_type === 'project' && running.subject_id === projectId;
  const toggleTimer = async () => {
    try { if (timerHere) await stopTimer(profile.id); else await startTimer({ subjectType: 'project', subjectId: projectId, label: project?.name, profileId: profile.id }); }
    catch (e) { setErr(e.message || String(e)); }
  };

  // ── Derived ────────────────────────────────────────────────────────────────
  const nameOf = (id) => { const m = members.find(u => u.id === id); return m ? (m.display_name || m.email.split('@')[0]) : ''; };

  const linked = useMemo(() => {
    if (!project?.subject_type || !project?.subject_id) return null;
    const t = project.subject_type, id = project.subject_id;
    if (t === 'location') { const loc = locations.find(x => x.id === id); const co = companies.find(x => x.id === loc?.company_id); return { type: t, name: loc?.name, companyName: co?.name, companyId: co?.id }; }
    if (t === 'deal') { const deal = deals.find(x => x.id === id); const co = companies.find(x => x.id === deal?.company_id); return { type: t, name: deal?.name, companyName: co?.name, companyId: co?.id }; }
    if (t === 'company') { const co = companies.find(x => x.id === id); return { type: t, name: co?.name, companyName: co?.name, companyId: id }; }
    if (t === 'onboarding') {
      const o = onboardings.find(x => x.id === id);
      const loc = locations.find(x => x.id === o?.location_id); const deal = deals.find(x => x.id === o?.deal_id);
      const co = companies.find(x => x.id === (o?.company_id || deal?.company_id || loc?.company_id));
      return { type: t, name: loc?.name || deal?.name || co?.name, companyName: co?.name, companyId: co?.id };
    }
    if (t === 'ticket') return { type: t, name: 'Ticket' };
    return { type: t, name: id.slice(0, 8) };
  }, [project, locations, companies, deals, onboardings]);

  const open = tasks.filter(t => t.status !== 'done');
  const done = tasks.filter(t => t.status === 'done');
  const inProg = tasks.filter(t => t.status === 'in_progress');
  const blocked = tasks.filter(t => t.status === 'blocked');
  const pct = (n) => tasks.length ? `${(n / tasks.length) * 100}%` : '0%';

  // Phases in the project's order; unphased last as an unnamed group.
  const phases = project?.phases || [];
  const groups = useMemo(() => {
    const out = phases.map((name, i) => ({ key: name, label: `Phase ${i + 1} — ${name}`, name, tasks: tasks.filter(t => t.phase === name) }));
    const rest = tasks.filter(t => !t.phase || !phases.includes(t.phase));
    if (rest.length || !phases.length) out.push({ key: '__none', label: phases.length ? 'Tasks' : null, name: null, tasks: rest });
    return out;
  }, [tasks, phases]);

  const goLive = (() => {
    if (!project?.due_date) return null;
    const d = dueLabel(project.due_date, project.status === 'completed' ? 'done' : 'todo');
    const days = Math.round((new Date(project.due_date + 'T00:00:00') - new Date(new Date().toDateString())) / 86400000);
    const text = days < 0 ? `Go live ${fmtShort(project.due_date)} · ${-days} days late` : days === 0 ? 'Go live today' : `Go live ${fmtShort(project.due_date)} · ${days} days`;
    return { text, tone: days <= 14 ? 'coral' : 'muted' };
  })();

  const team = useMemo(() => {
    const ids = [...new Set([project?.owner_id, ...tasks.map(t => t.owner_id)].filter(Boolean))];
    return ids.map(id => ({ id, name: nameOf(id), open: open.filter(t => t.owner_id === id).length }))
      .sort((a, b) => b.open - a.open);
  }, [project, tasks, members]); // eslint-disable-line react-hooks/exhaustive-deps

  const feed = useMemo(() => {
    const rows = activity.map(a => ({
      at: a.occurred_at,
      who: nameOf(a.actor_id),
      text: a.type === 'note' ? `Note: ${a.subject || a.body || ''}`
        : a.type === 'status' ? (a.subject || a.body || 'Status changed')
        : `${a.type}: ${a.subject || a.body || ''}`,
    }));
    for (const t of done) if (t.completed_at) rows.push({ at: t.completed_at, who: nameOf(t.owner_id), text: null, strong: t.title, verb: 'completed' });
    return rows.sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 4);
  }, [activity, done, members]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Writes (optimistic, put back on failure) ───────────────────────────────
  const patchTask = async (id, patch) => {
    const before = tasks;
    setTasks(ts => ts.map(t => (t.id === id ? { ...t, ...patch } : t)));
    const { error } = await supabase.from('tasks').update(patch).eq('id', id);
    if (error) { setTasks(before); setErr(error.message); return false; }
    load();
    return true;
  };
  const toggleTask = (t) => patchTask(t.id, t.status === 'done'
    ? { status: 'todo', completed_at: null }
    : { status: 'done', completed_at: new Date().toISOString() });
  const setStatus = async (t, status) => {
    const patch = { status, completed_at: status === 'done' ? new Date().toISOString() : null };
    if (status === 'blocked') {
      const why = prompt('What is it waiting on?', t.blocked_reason || '');
      if (why === null) return;
      patch.blocked_reason = why.trim() || null;
    } else if (t.status === 'blocked') patch.blocked_reason = null;
    setStatusMenu(null);
    await patchTask(t.id, patch);
  };

  const [adding, setAdding] = useState(false);
  const addTask = async (phaseName) => {
    const title = addText.trim();
    if (!title || adding) return;
    setAdding(true);
    const parsed = parseQuickAdd(title, { members, projects: [project], presets: { project_id: projectId, phase: phaseName || null } });
    const row = { ...quickAddRow(parsed, profile.id), project_id: projectId, phase: phaseName || null, sort_order: tasks.length,
      subject_type: project.subject_type || null, subject_id: project.subject_id || null };
    const { error } = await supabase.from('tasks').insert(row);
    setAdding(false);
    if (error) { setErr(error.message); return; }
    setAddText('');
    load();
  };
  const addPhase = async () => {
    const name = prompt('Phase name (e.g. Account setup)');
    if (!name?.trim()) return;
    const next = [...phases, name.trim()];
    const { error } = await supabase.from('crm_projects').update({ phases: next }).eq('id', projectId);
    if (error) { setErr(error.message); return; }
    load();
  };

  const postNote = async () => {
    if (!note.trim()) return;
    const { error } = await supabase.from('crm_activities').insert({
      type: 'note', subject_type: 'project', subject_id: projectId, actor_id: profile.id,
      subject: note.trim().slice(0, 120), body: note.trim(), occurred_at: new Date().toISOString(), direction: 'outbound', is_internal: true,
    });
    if (error) { setErr(error.message); return; }
    setNote(''); setNoteOpen(false); load();
  };

  // Save as template: the project's tasks become a template, phases kept as
  // the task order. Wires straight to the existing ProjectTemplates tables.
  const saveAsTemplate = async () => {
    const name = prompt('Template name', project.name);
    if (!name?.trim()) return;
    const { data: nt, error } = await supabase.from('project_templates').insert({ name: name.trim(), description: project.description || null }).select().single();
    if (error) { setErr(error.message); return; }
    const ordered = groups.flatMap(g => g.tasks);
    const rows = ordered.map((t, i) => ({ project_template_id: nt.id, title: t.title, description: t.description || null, priority: t.priority || 'P2', sort_order: i }));
    if (rows.length) await supabase.from('task_templates').insert(rows);
    alert(`Saved as template “${name.trim()}” (${rows.length} task${rows.length === 1 ? '' : 's'}). Find it under Project templates.`);
  };

  const startEdit = () => { setDraft({ ...project }); setEditing(true); };
  const set = (k, v) => setDraft(d => ({ ...d, [k]: v }));
  const save = async () => {
    const patch = { name: draft.name, description: draft.description || null, status: draft.status, owner_id: draft.owner_id || null,
      due_date: draft.due_date || null, subject_type: draft.subject_type || null, subject_id: draft.subject_id || null };
    const { error } = await supabase.from('crm_projects').update(patch).eq('id', projectId);
    if (error) { setErr(error.message); return; }
    setEditing(false); load();
  };
  const deleteRecord = async () => {
    if (!confirm(`Delete project "${project?.name}" and all its tasks?\n\nThis cannot be undone.`)) return;
    await supabase.from('crm_projects').delete().eq('id', projectId);
    onClose();
  };

  if (!project) return <div className="p-6"><SkeletonList rows={4} /></div>;

  const input = 'w-full px-3 py-2 rounded-[10px] text-sm text-paper placeholder-dim focus:outline-none border';
  const inputStyle = { background: 'var(--surface-solid)', borderColor: 'var(--ink-line)' };
  const label = 'font-mono text-[9px] font-bold uppercase tracking-[.18em] text-dim mb-1 block';

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--scene)' }}>
      {/* ── Header ── */}
      <div className="px-[18px] lg:px-6 pt-3 lg:pt-5 pb-[14px] lg:pb-[18px] border-b" style={hair}>
        <div className="flex items-start gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-[9px] mb-1">
              <button onClick={onClose} className="text-[13px] text-dim hover:text-paper">&larr; Projects</button>
              <Pill tone={project.status === 'active' ? 'primary' : project.status === 'completed' ? 'ink' : 'coral'} className="!text-[11px] !px-2 !py-[2px]">{project.status}</Pill>
            </div>
            <PageTitle size={28} className="mb-2 truncate hidden lg:block">{project.name}</PageTitle>
            <PageTitle size={22} className="mb-1 truncate lg:hidden">{project.name}</PageTitle>
            <div className="flex items-center gap-2 flex-wrap">
              {linked?.companyName && (
                <LinkChip tone="ink" onClick={() => linked.companyId && onNavigate?.('company', linked.companyId)}>{linked.companyName}</LinkChip>
              )}
              {linked?.name && linked.type !== 'company' && (
                <LinkChip tone="primary" onClick={() => onNavigate?.(project.subject_type, project.subject_id)}>
                  {SUBJECT_LABEL[linked.type] || linked.type}: {linked.name}
                </LinkChip>
              )}
              {project.owner_id && <span className="text-[12px] text-muted">Owner {nameOf(project.owner_id)}</span>}
              {goLive && <span className="text-[12px] font-semibold" style={{ color: goLive.tone === 'coral' ? 'rgb(var(--c-coral))' : 'rgb(var(--c-muted))' }}>{goLive.text}</span>}
            </div>
          </div>
          {!editing && (
            <div className="hidden lg:flex gap-2 items-center shrink-0">
              <Segmented value={view} options={[['phases', 'Phases'], ['board', 'Board'], ['timeline', 'Timeline']]} onChange={setView} />
              <GhostBtn onClick={toggleTimer} active={!!timerHere}>
                {timerHere ? `Pause · ${fmtClock((now - new Date(running.started_at).getTime()) / 1000)}` : 'Start timer'}
              </GhostBtn>
              {canWrite && <GhostBtn onClick={startEdit}>Edit</GhostBtn>}
              {canWrite && <PrimaryBtn onClick={() => { setAddingTo(groups[groups.length - 1].key); setAddText(''); }}>Add task</PrimaryBtn>}
            </div>
          )}
        </div>

        {/* Three segments: done, in progress, blocked. One segment cannot tell
            a project that is moving from one that is stuck. */}
        {tasks.length > 0 && (
          <div className="flex items-center gap-3 mt-3">
            <div className="flex-1 h-[10px] rounded-full overflow-hidden flex" style={{ background: 'var(--ink-soft)' }}>
              <div style={{ width: pct(done.length), background: 'rgb(var(--c-primary))' }} />
              <div style={{ width: pct(inProg.length), background: 'rgb(var(--c-amber))' }} />
              <div style={{ width: pct(blocked.length), background: 'rgb(var(--c-coral))' }} />
            </div>
            <Mono tone="muted">{done.length}/{tasks.length} done{inProg.length ? ` · ${inProg.length} in progress` : ''}{blocked.length ? ` · ${blocked.length} blocked` : ''}</Mono>
          </div>
        )}
        {err && <div className="mt-2 text-[12px]" style={{ color: 'rgb(var(--c-coral-deep))' }}>Could not save: {err} <button className="underline ml-1" onClick={() => setErr('')}>dismiss</button></div>}
      </div>

      {/* ── Body ── */}
      <div className="flex-1 overflow-y-auto">
        {editing ? (
          <div className="p-6 max-w-3xl">
            <Card className="p-5">
              <div className="space-y-3">
                <div><label className={label}>Name</label><input className={input} style={inputStyle} value={draft.name || ''} onChange={e => set('name', e.target.value)} /></div>
                <div><label className={label}>Description</label><textarea className={input + ' resize-none'} style={inputStyle} rows={3} value={draft.description || ''} onChange={e => set('description', e.target.value)} /></div>
                <div className="grid grid-cols-2 gap-3">
                  <div><label className={label}>Status</label>
                    <select className={input} style={inputStyle} value={draft.status} onChange={e => set('status', e.target.value)}>{PROJECT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}</select></div>
                  <div><label className={label}>Owner</label>
                    <select className={input} style={inputStyle} value={draft.owner_id || ''} onChange={e => set('owner_id', e.target.value || null)}>
                      <option value="">Unassigned</option>{members.map(m => <option key={m.id} value={m.id}>{m.display_name || m.email}</option>)}</select></div>
                  <div><label className={label}>Go live</label><input className={input} style={inputStyle} type="date" value={draft.due_date || ''} onChange={e => set('due_date', e.target.value || null)} /></div>
                </div>
                <div className={label + ' mt-3'}>Link a record</div>
                <div className="grid grid-cols-2 gap-3">
                  {[['location', 'Site', locations.map(l => ({ id: l.id, name: `${l.name} (${companies.find(c => c.id === l.company_id)?.name || '?'})` }))],
                    ['company', 'Company', companies],
                    ['deal', 'Deal', deals.map(d => ({ id: d.id, name: `${d.name} (${companies.find(c => c.id === d.company_id)?.name || '?'})` }))],
                    ['onboarding', 'Onboarding', onboardings.map(o => ({ id: o.id, name: `${companies.find(c => c.id === o.company_id)?.name || '?'} onboarding` }))],
                  ].map(([type, lbl, rows]) => (
                    <div key={type}><label className={label}>{lbl}</label>
                      <select className={input} style={inputStyle} value={draft.subject_type === type ? (draft.subject_id || '') : ''}
                        onChange={e => setDraft(d => ({ ...d, subject_type: e.target.value ? type : null, subject_id: e.target.value || null }))}>
                        <option value="">None</option>{rows.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                      </select></div>
                  ))}
                </div>
                <div className="flex gap-2 pt-1 items-center">
                  <PrimaryBtn onClick={save}>Save</PrimaryBtn>
                  <GhostBtn onClick={() => setEditing(false)}>Cancel</GhostBtn>
                  {profile.role === 'owner' && <button onClick={deleteRecord} className="ml-auto text-[13px]" style={{ color: 'rgb(var(--c-coral-deep))' }}>Delete project</button>}
                </div>
              </div>
            </Card>
          </div>
        ) : (
          <div className="px-[14px] lg:px-6 pt-[14px] lg:pt-[18px] pb-4 lg:pb-6 grid gap-[14px] lg:gap-[18px] lg:grid-cols-[minmax(0,1fr)_300px]">
            {/* LEFT — phases */}
            <div className="flex flex-col gap-[14px] min-w-0">
              {effView === 'board' ? (
                <ProjectBoard groups={groups} canWrite={canWrite} drag={drag} setDrag={setDrag} onStatus={setStatus} onOpen={(id) => onSelectTask?.(id)} nameOf={nameOf} onAdd={(g) => { setAddingTo(g.name ? g.name : '__none'); setAddText(''); }} />
              ) : effView === 'timeline' ? (
                <ProjectTimeline project={project} tasks={tasks} />
              ) : (<>
              {tasks.length === 0 && addingTo == null && (
                <Card className="px-7 py-9 text-center">
                  <div className="font-display text-[20px] font-extrabold text-paper">Nothing to do yet</div>
                  <div className="text-[14px] text-muted mt-1 mb-[18px]">Add the first task, or name a phase if this is a job you run often.</div>
                  <div className="flex gap-[9px] justify-center">
                    {canWrite && <PrimaryBtn onClick={() => { setAddingTo('__none'); setAddText(''); }} className="!px-4 !py-[9px]">Add a task</PrimaryBtn>}
                    {canWrite && <SolidChipBtn onClick={addPhase}><span className="text-[13px] font-semibold px-1 py-0.5 inline-block">Add a phase</span></SolidChipBtn>}
                  </div>
                </Card>
              )}
              {groups.filter(g => g.tasks.length || g.name).map((g) => {
                const gd = g.tasks.filter(t => t.status === 'done').length;
                const gb = g.tasks.filter(t => t.status === 'blocked').length;
                const tone = g.tasks.length && gd === g.tasks.length ? 'primary' : gb || g.tasks.some(t => t.status === 'in_progress') ? 'amber' : gd ? 'primary' : undefined;
                const dates = (() => {
                  const starts = g.tasks.map(t => t.start_date || String(t.created_at).slice(0, 10)).filter(Boolean).sort();
                  const ends = g.tasks.map(t => t.due_date).filter(Boolean).sort();
                  if (!starts.length || !ends.length) return null;
                  const a = new Date(starts[0] + 'T00:00:00'), b = new Date(ends[ends.length - 1] + 'T00:00:00');
                  const sameMonth = a.getMonth() === b.getMonth();
                  return sameMonth ? `${a.getDate()}–${b.getDate()} ${b.toLocaleDateString('en-GB', { month: 'short' })}` : `${fmtShort(starts[0])} – ${fmtShort(ends[ends.length - 1])}`;
                })();
                return (
                  <Card key={g.key}>
                    {g.label && (
                      <div className="px-4 py-3 flex items-center gap-2.5 border-b" style={hair}>
                        <SectionLabel tone={tone} className="!text-[10px]">{g.label}</SectionLabel>
                        <Mono size={10}>{gd}/{g.tasks.length}</Mono>
                        {dates && <span className="hidden lg:inline"><Mono size={10}>{dates}</Mono></span>}
                        {gb > 0 && <Mono size={10} tone="coral" bold className="ml-auto">{gb} blocked</Mono>}
                      </div>
                    )}
                    {g.tasks.map((t, i) => {
                      const waits = t.depends_on_id ? tasks.find(x => x.id === t.depends_on_id) : null;
                      const due = dueLabel(t.due_date, t.status);
                      const isDone = t.status === 'done';
                      const isBlocked = t.status === 'blocked';
                      const sub = isBlocked ? (t.blocked_reason ? `Blocked by ${t.blocked_reason}` : 'Blocked') : waits ? `Waits on “${waits.title}”` : null;
                      return (
                        <div key={t.id} className={`flex items-center gap-3 px-4 py-[11px] ${i < g.tasks.length - 1 ? 'border-b' : ''}`}
                          style={{ ...hair, borderLeft: isBlocked ? '3px solid rgb(var(--c-coral))' : '3px solid transparent' }}>
                          <Check done={isDone} active={t.status === 'in_progress'} onClick={() => canWrite && toggleTask(t)} disabled={!canWrite} />
                          <div className="flex-1 min-w-0 cursor-pointer" onClick={() => onSelectTask?.(t.id)}>
                            <div className={`text-[15px] truncate ${isDone ? 'text-dim line-through' : 'text-paper font-medium'}`}>{t.title}</div>
                            {sub && <div className="text-[11px] truncate" style={{ color: isBlocked ? 'rgb(var(--c-coral))' : 'rgb(var(--c-dim))' }}>{sub}</div>}
                            {!sub && !isDone && <div className="sm:hidden text-[11px] text-dim truncate">{STATUS_LABEL[t.status]}{due.text ? ` · ${due.text.toLowerCase()}` : ''}</div>}
                          </div>
                          {!isDone && <span className={isBlocked ? '' : 'hidden sm:inline-flex'}><Mono tone={due.tone === 'coral' ? 'coral' : due.tone === 'primary' ? 'primary' : 'dim'} bold={due.tone !== 'dim'}>{due.text}</Mono></span>}
                          {!isDone && !isBlocked && t.status === 'in_progress' && (
                            <span className="relative hidden sm:inline-flex">
                              <StatusPill status={t.status} onClick={() => canWrite && setStatusMenu(statusMenu === t.id ? null : t.id)} caret={false} />
                              {statusMenu === t.id && <StatusMenu task={t} onPick={(s) => setStatus(t, s)} onClose={() => setStatusMenu(null)} />}
                            </span>
                          )}
                          {(isBlocked || t.status === 'todo') && !isDone && canWrite && (
                            <span className="relative">
                              <button onClick={() => setStatusMenu(statusMenu === t.id ? null : t.id)} className="text-[11px] text-dim hover:text-paper px-1" title="Change status">&#9662;</button>
                              {statusMenu === t.id && <StatusMenu task={t} onPick={(s) => setStatus(t, s)} onClose={() => setStatusMenu(null)} />}
                            </span>
                          )}
                          <Avatar id={t.owner_id} name={nameOf(t.owner_id)} />
                        </div>
                      );
                    })}
                    {g.tasks.length === 0 && g.name && <div className="px-4 py-3 text-[13px] text-dim">Nothing in this phase yet.</div>}
                  </Card>
                );
              })}

              </>)}
              {/* Add row: dashed, names the last phase, and offers a new phase. */}
              {canWrite && (addingTo != null || tasks.length > 0) && (() => {
                const last = groups[groups.length - 1];
                const target = addingTo == null || addingTo === '__open' ? last.key : addingTo;
                const targetName = target === '__none' ? null : target;
                const inlineOpen = addingTo != null;
                return inlineOpen ? (
                  <div className="flex items-center gap-2.5 px-[14px] py-[9px] rounded-[12px] border" style={{ background: 'var(--surface-solid)', borderColor: 'rgb(var(--c-primary) / .5)' }}>
                    <span className="text-[18px] leading-none text-dim">+</span>
                    <input autoFocus value={addText} onChange={e => setAddText(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTask(targetName); } if (e.key === 'Escape') setAddingTo(null); }}
                      placeholder={`Add a task${targetName ? ` to ${targetName}` : ''} — @person !priority fri`}
                      className="flex-1 min-w-0 bg-transparent text-[14px] text-paper placeholder-dim focus:outline-none" />
                    {phases.length > 0 && (
                      <select value={target} onChange={e => setAddingTo(e.target.value)} className="text-[12px] bg-transparent text-muted focus:outline-none">
                        {phases.map(p => <option key={p} value={p}>{p}</option>)}<option value="__none">No phase</option>
                      </select>
                    )}
                    <button onClick={() => addTask(targetName)} disabled={!addText.trim()} className="text-[13px] font-semibold disabled:opacity-40" style={{ color: 'rgb(var(--c-primary-deep))' }}>Add</button>
                    <button onClick={() => setAddingTo(null)} className="text-[13px] text-dim">Cancel</button>
                  </div>
                ) : (
                  <DashedAdd onClick={() => { setAddingTo(last.key); setAddText(''); }}
                    trailing={<button onClick={(e) => { e.stopPropagation(); addPhase(); }} className="text-[13px] font-semibold shrink-0" style={{ color: 'rgb(var(--c-primary-deep))' }}>+ Add phase</button>}>
                    Add task{last.name ? ` to ${last.name}` : ''}
                  </DashedAdd>
                );
              })()}
            </div>

            {/* RIGHT — rail */}
            <div className="flex flex-col gap-[14px]">
              <Card className="px-4 py-[14px]">
                <SectionLabel className="mb-2.5">Team on this project</SectionLabel>
                <div className="flex flex-col gap-[10px]">
                  {team.length === 0 && <div className="text-[13px] text-dim">Nobody assigned yet.</div>}
                  {team.map(m => (
                    <div key={m.id} className="flex items-center gap-[9px]">
                      <Avatar id={m.id} name={m.name} />
                      <span className="text-[13px] text-paper flex-1 truncate">{m.name}</span>
                      <Mono tone="muted">{m.open} open</Mono>
                    </div>
                  ))}
                </div>
              </Card>

              <Card className="px-4 py-[14px]">
                <SectionLabel className="mb-2.5">Latest activity</SectionLabel>
                <div className="flex flex-col gap-[11px]">
                  {feed.length === 0 && <div className="text-[13px] text-dim">Nothing yet.</div>}
                  {feed.map((f, i) => (
                    <div key={i}>
                      <div className="text-[13px] text-paper leading-snug">
                        {f.verb ? <>{f.who || 'Someone'} {f.verb} <strong className="font-semibold">{f.strong}</strong></> : f.text}
                      </div>
                      <div className="text-[11px] text-dim">{f.verb ? '' : f.who ? `${f.who} · ` : ''}{fmtRel(f.at)}</div>
                    </div>
                  ))}
                </div>
              </Card>

              {noteOpen && (
                <Card className="px-4 py-[14px]">
                  <SectionLabel className="mb-2">Note</SectionLabel>
                  <textarea autoFocus rows={3} value={note} onChange={e => setNote(e.target.value)} placeholder="What happened?"
                    className="w-full px-3 py-2 rounded-[10px] text-[14px] text-paper placeholder-dim focus:outline-none border resize-none" style={inputStyle} />
                  <div className="flex gap-2 mt-2"><PrimaryBtn small onClick={postNote} disabled={!note.trim()}>Post</PrimaryBtn><GhostBtn onClick={() => { setNoteOpen(false); setNote(''); }}>Cancel</GhostBtn></div>
                </Card>
              )}

              {(showAttachments || attachmentCount > 0) && (
                <AttachmentsCard subjectType="project" subjectId={projectId} profile={profile} />
              )}

              {canWrite && (
                <Card panel className="px-4 py-[14px]">
                  <SectionLabel className="mb-2.5">Add to project</SectionLabel>
                  <div className="flex gap-[7px] flex-wrap">
                    <SolidChipBtn onClick={() => setShowAttachments(true)}>Attachment</SolidChipBtn>
                    <SolidChipBtn onClick={() => setNoteOpen(true)}>Note</SolidChipBtn>
                    <SolidChipBtn onClick={startEdit}>Link a record</SolidChipBtn>
                    <SolidChipBtn onClick={saveAsTemplate} disabled={!tasks.length}>Save as template</SolidChipBtn>
                  </div>
                </Card>
              )}
              {project.description && (
                <div className="text-[13px] text-paper-soft px-1 whitespace-pre-wrap leading-relaxed">{project.description}</div>
              )}
            </div>
          </div>
        )}
      </div>
      {canWrite && !editing && (
        <MobileDock>
          <DockField onClick={() => { setAddingTo(groups[groups.length - 1].key); setAddText(''); setTimeout(() => document.querySelector('input[placeholder^="Add a task"]')?.scrollIntoView({ block: 'center' }), 50); }}>
            Add task{groups[groups.length - 1]?.name ? ` to ${groups[groups.length - 1].name}` : ''}
          </DockField>
        </MobileDock>
      )}
    </div>
  );
}

// The four-item status popover. menu-surface, not glass: a popover inside a
// card cannot rely on backdrop-filter and comes out see-through.
function StatusMenu({ task, onPick, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const away = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [onClose]);
  return (
    <div ref={ref} className="absolute right-0 top-full mt-1 z-40 min-w-[160px] menu-surface rounded-[10px] py-1">
      {STATUS_ORDER.map((s, i) => (
        <button key={s} onClick={() => onPick(s)}
          className="w-full px-3 py-2 text-left text-[13px] text-paper hover:bg-ember/10 flex items-center justify-between gap-3">
          <span className={s === task.status ? 'font-semibold' : ''}>{STATUS_LABEL[s]}</span>
          <Mono size={10}>{i + 1}</Mono>
        </button>
      ))}
    </div>
  );
}

const BOARD_COLS = [['todo', 'To do', 'muted'], ['in_progress', 'In progress', 'amber'], ['blocked', 'Blocked', 'coral'], ['done', 'Done', 'primary']];
/** The project as a board: one lane per phase, four status columns, drag a card to change its status. */
function ProjectBoard({ groups, canWrite, drag, setDrag, onStatus, onOpen, nameOf, onAdd }) {
  const lanes = groups.filter(g => g.tasks.length || g.name);
  const all = groups.flatMap(g => g.tasks);
  if (lanes.length === 0) return <Card className="px-7 py-9 text-center text-[14px] text-dim">Nothing on the board yet. Add a task and it lands in To do.</Card>;
  return (
    <div className="flex flex-col gap-[14px]">
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(4, minmax(0,1fr))' }}>
        {BOARD_COLS.map(([k, label, tone]) => (
          <div key={k} className="flex items-center gap-2"><MetaLabel tone={tone === 'muted' ? 'muted' : tone}>{label}</MetaLabel><Mono size={10}>{all.filter(t => t.status === k).length}</Mono></div>
        ))}
      </div>
      {lanes.map(g => (
        <Card key={g.key} className="p-[14px] flex flex-col gap-2.5">
          {g.label && <div className="flex items-center gap-2"><SectionLabel className="!text-[10px]">{g.label}</SectionLabel><Mono size={10}>{g.tasks.filter(t => t.status === 'done').length}/{g.tasks.length}</Mono></div>}
          <div className="grid gap-3 items-start" style={{ gridTemplateColumns: 'repeat(4, minmax(0,1fr))' }}>
            {BOARD_COLS.map(([k]) => (
              <div key={k} onDragOver={e => { if (drag) e.preventDefault(); }} onDrop={() => { if (drag && drag.status !== k) onStatus(drag, k); setDrag(null); }}
                className={`flex flex-col gap-2 min-h-[44px] rounded-[12px] transition ${drag ? 'outline-dashed outline-1 outline-[var(--dash-line)]' : ''}`}>
                {g.tasks.filter(t => t.status === k).map(t => {
                  const due = dueLabel(t.due_date, t.status); const isDone = t.status === 'done';
                  return (
                    <div key={t.id} draggable={canWrite && !isDone} onDragStart={() => setDrag(t)} onDragEnd={() => setDrag(null)} onClick={() => onOpen(t.id)}
                      className="rounded-[12px] px-3 py-[11px] cursor-pointer border"
                      style={isDone ? { background: 'var(--panel-bg)', borderColor: 'var(--hair)' } : { background: 'var(--surface-solid)', boxShadow: 'var(--shadow-tile)', borderColor: t.status === 'blocked' ? 'rgb(var(--c-coral) / .35)' : t.status === 'in_progress' ? 'rgb(var(--c-primary) / .35)' : 'var(--ink-line)' }}>
                      <div className={`text-[13px] ${isDone ? 'text-dim line-through' : 'font-medium text-paper'}`}>{t.title}</div>
                      {!isDone && t.status === 'blocked' && t.blocked_reason && <div className="text-[11px] mt-0.5" style={{ color: 'rgb(var(--c-coral-deep))' }}>{t.blocked_reason}</div>}
                      {!isDone && (
                        <div className="flex items-center gap-1.5 mt-1.5">
                          {t.due_date && <Mono size={10} tone={due.tone === 'coral' ? 'coral' : 'dim'}>{due.text}</Mono>}
                          <span className="ml-auto"><Avatar id={t.owner_id} name={nameOf(t.owner_id)} size={20} /></span>
                        </div>
                      )}
                    </div>
                  );
                })}
                {k === 'todo' && canWrite && (
                  <button onClick={() => onAdd(g)} className="text-left text-[13px] text-dim px-3 py-2.5 rounded-[12px] border border-dashed hover:text-paper" style={{ borderColor: 'var(--dash-line)' }}>+ Add task</button>
                )}
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}

/** The project as a timeline: one derived bar per phase across eight weeks, today marked. */
function ProjectTimeline({ project, tasks }) {
  const cols = weekColumns(addDays(startOfWeek(new Date()), -7), 8);
  const r0 = cols[0].start.getTime(), r1 = cols[cols.length - 1].end.getTime();
  const spans = phaseSpans(project, tasks);
  const now = Date.now(); const today = spanPercent(now, now + 1, r0, r1);
  const fill = { coral: 'rgb(var(--c-coral) / .18)', done: 'var(--ink-soft)', primary: 'rgb(var(--c-primary) / .22)', amber: 'rgb(var(--c-amber) / .2)', none: 'transparent' };
  return (
    <Card className="overflow-hidden">
      <div className="px-4 py-2.5 border-b flex items-center gap-2" style={hair}><span className="text-[13px] font-bold text-paper">Timeline</span><Mono>{rangeLabel(cols)}</Mono></div>
      <div className="grid border-b" style={{ gridTemplateColumns: `200px repeat(${cols.length}, minmax(0,1fr))`, ...hair }}>
        <div />
        {cols.map(c => <div key={c.label} className="px-2 py-1.5 font-mono text-[10px] text-dim border-l" style={{ borderColor: 'var(--hair)', background: c.now ? 'rgb(var(--c-primary) / .08)' : undefined }}>{c.label}</div>)}
      </div>
      {spans.map((sp, i) => {
        const pos = spanPercent(sp.start.getTime(), sp.end.getTime(), r0, r1);
        return (
          <div key={sp.name} className={`grid ${i < spans.length - 1 ? 'border-b' : ''}`} style={{ gridTemplateColumns: '200px minmax(0,1fr)', ...hair }}>
            <div className="px-4 py-2.5 min-w-0"><div className="text-[13px] text-paper truncate">{sp.name}</div><div className="text-[11px] text-dim">{sp.done}/{sp.count} done{sp.blocked ? ` · ${sp.blocked} blocked` : ''}</div></div>
            <div className="relative h-[48px]">
              {today && <div className="absolute inset-y-0 w-px" style={{ left: `${today.left}%`, background: 'rgb(var(--c-primary))' }} />}
              {pos && (
                <div className="absolute top-[12px] h-[24px] rounded-[7px] px-2 text-[11px] font-medium flex items-center overflow-hidden whitespace-nowrap"
                  style={{ left: `${pos.left}%`, width: `${Math.max(pos.width, 2)}%`, background: fill[sp.tone] || fill.none, color: sp.tone === 'coral' ? 'rgb(var(--c-coral-deep))' : 'rgb(var(--c-text))', border: sp.tone === 'none' ? '1px dashed var(--dash-line)' : '1px solid transparent' }}>{sp.label}</div>
              )}
              {!pos && <div className="absolute inset-y-0 left-2 flex items-center text-[11px] text-dim">Outside this window</div>}
            </div>
          </div>
        );
      })}
      <div className="px-4 py-2 text-[11px] text-dim">Bars come from each phase's task dates. Give tasks a start and a due date to move them.</div>
    </Card>
  );
}

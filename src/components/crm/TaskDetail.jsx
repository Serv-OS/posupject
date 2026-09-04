import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import AttachmentsCard from './AttachmentsCard.jsx';
import { getRunning, startTimer, stopTimer, fmtClock, fmtDuration } from '../../lib/timer';
import { PRIORITY_LABEL, PRIORITY_SLA } from '../../lib/priority';
import {
  Avatar, Check, LinkChip, SectionLabel, Mono, PageTitle, PrimaryBtn, GhostBtn, SolidChipBtn, Card, SkeletonList, MobileDock, MobileSheet, SheetRow,
  hair, dueLabel, fmtShort, fmtRel, STATUS_ORDER, STATUS_LABEL, initialsOf,
} from './ui.jsx';

// Screen 08 — two columns, no edit mode.
//
// Every chip in the header strip is a popover that writes one field, which
// removes the Edit / Save round trip entirely. Cards render only when they have
// something in them; the Add row is the single home for everything absent, so
// a fresh task is a header, a description prompt and an activity box rather
// than four empty panels. Blocks is the reverse side of the dependency.

const STATUS_COLOR = { todo: 'rgb(var(--c-muted))', in_progress: 'rgb(var(--c-amber-deep))', blocked: 'rgb(var(--c-coral-deep))', done: 'rgb(var(--c-primary-deep))' };
const PRIORITY_COLOR = { P0: 'rgb(var(--c-coral-deep))', P1: 'rgb(var(--c-coral-deep))', P2: 'rgb(var(--c-text))', P3: 'rgb(var(--c-muted))' };
const SUBJECT_LABEL = { company: 'Company', location: 'Site', deal: 'Deal', onboarding: 'Onboarding', ticket: 'Ticket' };

export default function TaskDetail({ taskId, profile, onClose, onNavigate }) {
  const [task, setTask] = useState(null);
  const [subtasks, setSubtasks] = useState([]);
  const [blocks, setBlocks] = useState([]);       // tasks that wait on this one
  const [members, setMembers] = useState([]);
  const [projects, setProjects] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [locations, setLocations] = useState([]);
  const [deals, setDeals] = useState([]);
  const [tickets, setTickets] = useState([]);
  const [activities, setActivities] = useState([]);
  const [entries, setEntries] = useState([]);
  const [attachCount, setAttachCount] = useState(0);
  const [showAttachments, setShowAttachments] = useState(false);
  const [openChip, setOpenChip] = useState(null);
  const [menu, setMenu] = useState(false);
  const [tab, setTab] = useState('all');
  const [noteText, setNoteText] = useState('');
  const [descEdit, setDescEdit] = useState(false);
  const [descDraft, setDescDraft] = useState('');
  const [titleEdit, setTitleEdit] = useState(false);
  const [sheet, setSheet] = useState(false); // the phone's "…"
  const [titleDraft, setTitleDraft] = useState('');
  const [newSub, setNewSub] = useState('');
  const [subOpen, setSubOpen] = useState(false);
  const [err, setErr] = useState('');
  const subRef = useRef(null);
  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  useEffect(() => { load(); }, [taskId]);
  const load = async () => {
    const [t, st, bl, m, p, c, l, d, tk, act, te, att] = await Promise.all([
      supabase.from('tasks').select('*').eq('id', taskId).single(),
      supabase.from('tasks').select('*').eq('parent_task_id', taskId).order('sort_order'),
      supabase.from('tasks').select('id, title, status, phase, due_date, owner_id').eq('depends_on_id', taskId),
      supabase.from('profiles').select('id, email, display_name'),
      supabase.from('crm_projects').select('*').order('name'),
      supabase.from('companies').select('id, name'),
      supabase.from('locations').select('id, name, company_id'),
      supabase.from('deals').select('id, name, company_id'),
      supabase.from('tickets').select('id, ticket_number, subject'),
      supabase.from('crm_activities').select('*').eq('subject_type', 'task').eq('subject_id', taskId).order('occurred_at', { ascending: false }).limit(50),
      supabase.from('time_entries').select('*').eq('subject_type', 'task').eq('subject_id', taskId).order('started_at', { ascending: false }),
      supabase.from('attachments').select('id', { count: 'exact', head: true }).eq('subject_type', 'task').eq('subject_id', taskId),
    ]);
    setTask(t.data); setSubtasks(st.data || []); setBlocks(bl.data || []); setMembers(m.data || []); setProjects(p.data || []);
    setCompanies(c.data || []); setLocations(l.data || []); setDeals(d.data || []); setTickets(tk.data || []);
    setActivities(act.data || []); setEntries(te.data || []); setAttachCount(att.count || 0);
  };

  // ── Timer ──────────────────────────────────────────────────────────────────
  const [running, setRunning] = useState(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const refresh = () => getRunning(profile.id).then(setRunning);
    refresh(); window.addEventListener('timer-changed', refresh);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { window.removeEventListener('timer-changed', refresh); clearInterval(tick); };
  }, [profile.id]);
  const timerHere = running && running.subject_type === 'task' && running.subject_id === taskId;
  const toggleTimer = async () => {
    try { if (timerHere) await stopTimer(profile.id); else await startTimer({ subjectType: 'task', subjectId: taskId, label: task?.title, profileId: profile.id }); load(); }
    catch (e) { setErr(e.message || String(e)); }
  };
  const trackedSecs = entries.reduce((s, e) => s + (e.duration_seconds || 0), 0) + (timerHere ? (now - new Date(running.started_at).getTime()) / 1000 : 0);

  // ── Derived ────────────────────────────────────────────────────────────────
  const nameOf = (id) => { const m = members.find(u => u.id === id); return m ? (m.display_name || m.email.split('@')[0]) : ''; };
  const project = projects.find(p => p.id === task?.project_id);
  const linked = useMemo(() => {
    const resolve = (type, id) => {
      if (!type || !id) return null;
      if (type === 'company') { const c = companies.find(x => x.id === id); return c ? { type, label: 'Company', name: c.name, companyId: c.id, companyName: c.name } : null; }
      if (type === 'location') { const l = locations.find(x => x.id === id); const c = companies.find(x => x.id === l?.company_id); return l ? { type, label: 'Site', name: l.name, companyId: c?.id, companyName: c?.name } : null; }
      if (type === 'deal') { const dl = deals.find(x => x.id === id); const c = companies.find(x => x.id === dl?.company_id); return dl ? { type, label: 'Deal', name: dl.name, companyId: c?.id, companyName: c?.name } : null; }
      if (type === 'ticket') { const tk = tickets.find(x => x.id === id); return tk ? { type, label: 'Ticket', name: `#${tk.ticket_number}`, ticket: tk } : null; }
      return null;
    };
    return resolve(task?.subject_type, task?.subject_id) || (project ? resolve(project.subject_type, project.subject_id) : null);
  }, [task, project, companies, locations, deals, tickets]);

  const feed = useMemo(() => {
    const rows = [];
    for (const a of activities) rows.push({ kind: a.type === 'note' ? 'notes' : 'notes', at: a.occurred_at, who: a.actor_id, text: a.body || a.subject, label: a.type === 'note' ? 'added a note' : `logged ${a.type}` });
    for (const e of entries) rows.push({ kind: 'time', at: e.started_at, who: e.profile_id, sys: true, text: e.ended_at ? `Logged ${fmtDuration(e.duration_seconds)}` : 'Timer started' });
    if (task?.completed_at) rows.push({ kind: 'status', at: task.completed_at, who: task.owner_id, sys: true, text: 'Marked done' });
    if (task?.created_at) rows.push({ kind: 'status', at: task.created_at, who: task.created_by, sys: !task.created_by, text: linked?.ticket ? `Created from ticket #${linked.ticket.ticket_number}` : 'Created' });
    return rows.sort((a, b) => new Date(b.at) - new Date(a.at)).filter(r => tab === 'all' || r.kind === tab);
  }, [activities, entries, task, tab, linked]);

  // ── Writes ─────────────────────────────────────────────────────────────────
  const setField = async (patch) => {
    if (!canWrite) return false;
    const before = task;
    setTask(t => ({ ...t, ...patch }));
    const { error } = await supabase.from('tasks').update(patch).eq('id', taskId);
    if (error) { setTask(before); setErr(error.message); return false; }
    load(); return true;
  };
  const setStatus = async (status) => {
    const patch = { status, completed_at: status === 'done' ? new Date().toISOString() : null };
    if (status === 'blocked') { const why = prompt('What is it waiting on?', task.blocked_reason || ''); if (why === null) return; patch.blocked_reason = why.trim() || null; }
    else if (task.status === 'blocked') patch.blocked_reason = null;
    if (status === 'done') {
      const openSubs = subtasks.filter(s => s.status !== 'done').length;
      if (openSubs > 0 && !confirm(`${openSubs} subtask${openSubs > 1 ? 's are' : ' is'} still open. Complete anyway?`)) return;
    }
    setOpenChip(null);
    const ok = await setField(patch);
    // Completing a task that blocks another clears the blocker and tells its owner.
    if (ok && status === 'done' && blocks.length) {
      const waiting = blocks.filter(b => b.status === 'blocked');
      if (waiting.length) {
        await supabase.from('tasks').update({ status: 'todo', blocked_reason: null }).in('id', waiting.map(b => b.id));
        const notes = waiting.filter(b => b.owner_id).map(b => ({ recipient_id: b.owner_id, actor_id: profile.id, type: 'system',
          title: 'Blocker cleared', body: `“${task.title}” is done, so “${b.title}” can start.`, entity_type: 'task', link_id: b.id }));
        if (notes.length) await supabase.from('notifications').insert(notes);
      }
    }
  };
  const postNote = async () => {
    if (!noteText.trim()) return;
    const { error } = await supabase.from('crm_activities').insert({ type: 'note', subject_type: 'task', subject_id: taskId, actor_id: profile.id,
      subject: noteText.trim().slice(0, 120), body: noteText.trim(), occurred_at: new Date().toISOString(), direction: 'outbound', is_internal: true });
    if (error) { setErr(error.message); return; }
    setNoteText(''); load();
  };
  const addSubtask = async () => {
    if (!newSub.trim()) return;
    const { error } = await supabase.from('tasks').insert({ title: newSub.trim(), parent_task_id: taskId, project_id: task.project_id, phase: task.phase,
      subject_type: task.subject_type, subject_id: task.subject_id, sort_order: subtasks.length, created_by: profile.id });
    if (error) { setErr(error.message); return; }
    setNewSub(''); load();
  };
  const toggleSub = (s) => supabase.from('tasks').update(s.status === 'done' ? { status: 'todo', completed_at: null } : { status: 'done', completed_at: new Date().toISOString() }).eq('id', s.id).then(load);
  const duplicate = async () => {
    const { id, created_at, updated_at, completed_at, ...rest } = task;
    const { data, error } = await supabase.from('tasks').insert({ ...rest, title: `${task.title} (copy)`, status: 'todo', created_by: profile.id }).select('id').single();
    if (error) { setErr(error.message); return; }
    onNavigate?.('task', data.id);
  };
  const deleteTask = async () => {
    const openSubs = subtasks.filter(s => s.status !== 'done').length;
    if (!confirm(`Delete this task?${openSubs ? `\n\n${openSubs} open subtask${openSubs > 1 ? 's' : ''} will also be deleted.` : ''}`)) return;
    await supabase.from('tasks').delete().eq('id', taskId); onClose();
  };

  if (!task) return <div className="p-6"><SkeletonList rows={3} /></div>;

  const due = dueLabel(task.due_date, task.status);
  const doneSubs = subtasks.filter(s => s.status === 'done').length;
  const inputCls = 'w-full px-3 py-2 rounded-[10px] text-[14px] text-paper placeholder-dim focus:outline-none border';
  const inputStyle = { background: 'var(--surface-solid)', borderColor: 'var(--ink-line)' };
  const phases = project?.phases || [];

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--scene)' }}>
      {/* ── Header ── */}
      <div className="px-[18px] lg:px-6 pt-3 lg:pt-5 pb-3 lg:pb-4 border-b" style={hair}>
        <div className="flex items-start gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <button onClick={onClose} className="text-[13px] text-dim hover:text-paper">&larr; Tasks</button>
              {project && <LinkChip tone="uv" onClick={() => onNavigate?.('project', project.id)}>{project.name}{task.phase ? ` · ${task.phase}` : ''}</LinkChip>}
              {linked?.type === 'ticket' && <LinkChip tone="primary" onClick={() => onNavigate?.('ticket', task.subject_id)}>Ticket {linked.name}</LinkChip>}
              {linked && linked.type !== 'ticket' && linked.name && <LinkChip tone="ink" onClick={() => linked.companyId && onNavigate?.('company', linked.companyId)}>{linked.companyName || linked.name}</LinkChip>}
            </div>
            {titleEdit ? (
              <input autoFocus value={titleDraft} onChange={e => setTitleDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { setField({ title: titleDraft.trim() || task.title }); setTitleEdit(false); } if (e.key === 'Escape') setTitleEdit(false); }}
                onBlur={() => { if (titleDraft.trim() && titleDraft !== task.title) setField({ title: titleDraft.trim() }); setTitleEdit(false); }}
                className="font-display text-[28px] font-extrabold text-paper bg-transparent w-full focus:outline-none border-b" style={{ borderColor: 'rgb(var(--c-primary))' }} />
            ) : (
              <PageTitle size={28} className={`cursor-text ${task.status === 'done' ? 'line-through text-dim' : ''}`}>
                <span onClick={() => { if (canWrite) { setTitleDraft(task.title); setTitleEdit(true); } }}>{task.title}</span>
              </PageTitle>
            )}
          </div>
          <div className="hidden lg:flex gap-2 items-center shrink-0">
            <GhostBtn onClick={toggleTimer} active={!!timerHere}>{timerHere ? `Pause · ${fmtClock((now - new Date(running.started_at).getTime()) / 1000)}` : 'Start timer'}</GhostBtn>
            {canWrite && (task.status === 'done'
              ? <GhostBtn onClick={() => setStatus('todo')}>Reopen</GhostBtn>
              : <PrimaryBtn onClick={() => setStatus('done')}>Complete</PrimaryBtn>)}
            <span className="relative">
              <GhostBtn onClick={() => setMenu(v => !v)} className="!px-[11px]">…</GhostBtn>
              {menu && (
                <div className="absolute right-0 top-full mt-1 z-40 min-w-[170px] menu-surface rounded-[10px] py-1" onMouseLeave={() => setMenu(false)}>
                  {canWrite && <button onClick={() => { setMenu(false); setTitleDraft(task.title); setTitleEdit(true); }} className="w-full px-3 py-2 text-left text-[13px] text-paper hover:bg-ember/10">Rename</button>}
                  {canWrite && <button onClick={() => { setMenu(false); duplicate(); }} className="w-full px-3 py-2 text-left text-[13px] text-paper hover:bg-ember/10">Duplicate</button>}
                  {profile.role === 'owner' && <button onClick={() => { setMenu(false); deleteTask(); }} className="w-full px-3 py-2 text-left text-[13px] hover:bg-ember/10" style={{ color: 'rgb(var(--c-coral-deep))' }}>Delete</button>}
                </div>
              )}
            </span>
          </div>
        </div>

        {/* Chip strip: each one writes one field. */}
        <div className="flex items-center gap-2 mt-3 flex-wrap">
          <HeaderChip label="Status" open={openChip === 'status'} onToggle={() => setOpenChip(openChip === 'status' ? null : 'status')} disabled={!canWrite}
            value={<span style={{ color: STATUS_COLOR[task.status] }}>{STATUS_LABEL[task.status]}</span>}>
            {STATUS_ORDER.map((s, i) => <MenuRow key={s} onClick={() => setStatus(s)} bold={s === task.status} hint={i + 1}>{STATUS_LABEL[s]}</MenuRow>)}
          </HeaderChip>
          <HeaderChip label="Priority" open={openChip === 'priority'} onToggle={() => setOpenChip(openChip === 'priority' ? null : 'priority')} disabled={!canWrite}
            value={<span style={{ color: PRIORITY_COLOR[task.priority] }}>{PRIORITY_LABEL[task.priority] || '—'}</span>}>
            {['P0', 'P1', 'P2', 'P3'].map(p => <MenuRow key={p} onClick={() => { setField({ priority: p }); setOpenChip(null); }} bold={p === task.priority} hint={PRIORITY_SLA[p]?.resolve}>{PRIORITY_LABEL[p]}</MenuRow>)}
          </HeaderChip>
          <HeaderChip label="Assignee" open={openChip === 'owner'} onToggle={() => setOpenChip(openChip === 'owner' ? null : 'owner')} disabled={!canWrite}
            value={task.owner_id ? <span className="inline-flex items-center gap-[7px]"><Avatar id={task.owner_id} name={nameOf(task.owner_id)} size={20} />{nameOf(task.owner_id)}</span> : <span className="text-muted">Unassigned</span>}>
            <MenuRow onClick={() => { setField({ owner_id: null }); setOpenChip(null); }} bold={!task.owner_id}>Unassigned</MenuRow>
            {members.map(m => <MenuRow key={m.id} onClick={() => { setField({ owner_id: m.id }); setOpenChip(null); }} bold={m.id === task.owner_id}><span className="inline-flex items-center gap-2"><Avatar id={m.id} name={m.display_name || m.email} size={18} />{m.display_name || m.email}</span></MenuRow>)}
          </HeaderChip>
          <HeaderChip label="Due" open={openChip === 'due'} onToggle={() => setOpenChip(openChip === 'due' ? null : 'due')} disabled={!canWrite}
            value={<span style={{ color: due.tone === 'coral' ? 'rgb(var(--c-coral-deep))' : due.tone === 'primary' ? 'rgb(var(--c-primary-deep))' : due.tone === 'dim' && !task.due_date ? 'rgb(var(--c-muted))' : 'rgb(var(--c-text))' }}>{due.text}</span>}>
            <div className="p-2 space-y-2">
              <input type="date" value={task.due_date || ''} onChange={e => { setField({ due_date: e.target.value || null }); }} className={inputCls} style={inputStyle} />
              {task.due_date && <button onClick={() => { setField({ due_date: null }); setOpenChip(null); }} className="text-[12px] text-dim hover:text-paper">Clear date</button>}
            </div>
          </HeaderChip>
          <HeaderChip label="Tracked" open={openChip === 'tracked'} onToggle={() => setOpenChip(openChip === 'tracked' ? null : 'tracked')}
            value={trackedSecs > 0 ? fmtDuration(trackedSecs) : <span className="text-muted">none</span>}>
            <div className="p-2 text-[13px] text-muted">{entries.length} entr{entries.length === 1 ? 'y' : 'ies'}.{' '}
              <button onClick={() => { toggleTimer(); setOpenChip(null); }} className="font-semibold" style={{ color: 'rgb(var(--c-primary-deep))' }}>{timerHere ? 'Stop timer' : 'Start timer'}</button></div>
          </HeaderChip>
          {project && phases.length > 0 && (
            <HeaderChip label="Phase" open={openChip === 'phase'} onToggle={() => setOpenChip(openChip === 'phase' ? null : 'phase')} disabled={!canWrite}
              value={task.phase || <span className="text-muted">Unphased</span>}>
              <MenuRow onClick={() => { setField({ phase: null }); setOpenChip(null); }} bold={!task.phase}>Unphased</MenuRow>
              {phases.map(ph => <MenuRow key={ph} onClick={() => { setField({ phase: ph }); setOpenChip(null); }} bold={ph === task.phase}>{ph}</MenuRow>)}
            </HeaderChip>
          )}
          {canWrite && (
            <>
              <DashedChip open={openChip === 'label'} onToggle={() => setOpenChip(openChip === 'label' ? null : 'label')} text={(task.labels || []).length ? (task.labels || []).join(', ') : '+ Label'}>
                <LabelEditor labels={task.labels || []} onChange={(labels) => setField({ labels })} />
              </DashedChip>
              <DashedChip open={openChip === 'blocked'} onToggle={() => setOpenChip(openChip === 'blocked' ? null : 'blocked')}
                text={task.depends_on_id ? `Blocked by · ${projects.length ? '' : ''}${allTitle(task.depends_on_id)}` : '+ Blocked by'}>
                <BlockedByPicker taskId={taskId} projectId={task.project_id} current={task.depends_on_id} onPick={(id) => { setField({ depends_on_id: id }); setOpenChip(null); }} />
              </DashedChip>
            </>
          )}
        </div>
        {task.status === 'blocked' && task.blocked_reason && <div className="mt-2 text-[12px]" style={{ color: 'rgb(var(--c-coral))' }}>Blocked by {task.blocked_reason}</div>}
        {err && <div className="mt-2 text-[12px]" style={{ color: 'rgb(var(--c-coral-deep))' }}>Could not save: {err} <button className="underline ml-1" onClick={() => setErr('')}>dismiss</button></div>}
      </div>

      {/* ── Body ── */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-[14px] lg:px-6 pt-[14px] lg:pt-[18px] pb-4 lg:pb-6 grid gap-[12px] lg:gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
          {/* LEFT */}
          <div className="flex flex-col gap-[14px] min-w-0">
            <Card className="px-[18px] py-4">
              {descEdit ? (
                <div>
                  <textarea autoFocus rows={4} value={descDraft} onChange={e => setDescDraft(e.target.value)} className={inputCls + ' resize-y'} style={inputStyle} placeholder="What needs doing, and why." />
                  <div className="flex gap-2 mt-2"><PrimaryBtn small onClick={() => { setField({ description: descDraft.trim() || null }); setDescEdit(false); }}>Save</PrimaryBtn><GhostBtn onClick={() => setDescEdit(false)}>Cancel</GhostBtn></div>
                </div>
              ) : (
                <div onClick={() => { if (canWrite) { setDescDraft(task.description || ''); setDescEdit(true); } }}
                  className={`text-[15px] whitespace-pre-wrap leading-relaxed ${task.description ? 'text-paper-soft' : 'text-dim'} ${canWrite ? 'cursor-text' : ''}`}>
                  {task.description || 'Add a description — what needs doing, and why.'}
                </div>
              )}
            </Card>

            {(subtasks.length > 0 || subOpen) && (
              <Card>
                <div className="px-[18px] py-3 flex items-center gap-[9px] border-b" style={hair}>
                  <span className="text-[14px] font-bold text-paper">Checklist</span>
                  <Mono>{doneSubs}/{subtasks.length}</Mono>
                  <div className="w-[90px] h-[5px] rounded-full overflow-hidden" style={{ background: 'var(--ink-soft)' }}>
                    <div className="h-full" style={{ width: `${subtasks.length ? (doneSubs / subtasks.length) * 100 : 0}%`, background: 'rgb(var(--c-primary))' }} />
                  </div>
                </div>
                <div className="px-[18px] pt-1.5 pb-3 flex flex-col">
                  {subtasks.map((s, i) => (
                    <div key={s.id} className={`flex items-center gap-[11px] py-[9px] ${i < subtasks.length - 1 || canWrite ? 'border-b' : ''}`} style={hair}>
                      <Check size={18} done={s.status === 'done'} onClick={() => canWrite && toggleSub(s)} disabled={!canWrite} />
                      <span className={`flex-1 text-[14px] cursor-pointer ${s.status === 'done' ? 'text-dim line-through' : 'text-paper'}`} onClick={() => onNavigate?.('task', s.id)}>{s.title}</span>
                      {s.owner_id && <Avatar id={s.owner_id} name={nameOf(s.owner_id)} size={22} />}
                    </div>
                  ))}
                  {canWrite && (
                    <div className="flex items-center gap-[11px] py-[9px]">
                      <span className="w-[18px] h-[18px] rounded-[6px] border-2 border-dashed shrink-0" style={{ borderColor: 'var(--dash-line)' }} />
                      <input ref={subRef} value={newSub} onChange={e => setNewSub(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addSubtask(); } }}
                        placeholder="Add an item" className="flex-1 bg-transparent text-[14px] text-paper placeholder-dim focus:outline-none" />
                    </div>
                  )}
                </div>
              </Card>
            )}

            <Card className="flex flex-col min-h-[320px]">
              <div className="px-[18px] py-3 flex items-center gap-[14px] border-b" style={hair}>
                <span className="text-[14px] font-bold text-paper">Activity</span>
                <div className="flex gap-3 text-[13px]">
                  {[['all', 'All'], ['notes', 'Notes'], ['status', 'Status changes'], ['time', 'Time']].map(([k, l]) => (
                    <button key={k} onClick={() => setTab(k)} className="pb-0.5 border-b-2" style={tab === k ? { color: 'rgb(var(--c-text))', fontWeight: 600, borderColor: 'rgb(var(--c-primary))' } : { color: 'rgb(var(--c-muted))', borderColor: 'transparent' }}>{l}</button>
                  ))}
                </div>
              </div>
              <div className="flex-1 px-[18px] py-[14px] flex flex-col gap-[14px]">
                {feed.length === 0 && <div className="text-[13px] text-dim">Nothing here yet.</div>}
                {feed.map((r, i) => (
                  <div key={i} className="flex gap-[11px]">
                    {r.sys ? <span className="w-[26px] h-[26px] rounded-full shrink-0 border" style={{ background: 'var(--ink-soft)', borderColor: 'var(--ink-line)' }} /> : <Avatar id={r.who} name={nameOf(r.who)} />}
                    <div className="min-w-0">
                      <div className="text-[13px] text-muted">
                        {r.sys ? <>{r.text}{r.who ? <> by <strong className="font-semibold text-paper">{nameOf(r.who)}</strong></> : ''} · {fmtRel(r.at)}</>
                          : <><strong className="font-semibold text-paper">{nameOf(r.who) || 'Someone'}</strong> {r.label} · {fmtRel(r.at)}</>}
                      </div>
                      {!r.sys && <div className="text-[14px] text-paper whitespace-pre-wrap">{r.text}</div>}
                    </div>
                  </div>
                ))}
              </div>
              {canWrite && (
                <div className="px-[18px] py-3 border-t flex items-center gap-2.5" style={hair}>
                  <input value={noteText} onChange={e => setNoteText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); postNote(); } }}
                    placeholder="Write a note — @ to mention someone" className="flex-1 px-[13px] py-[10px] rounded-[11px] text-[14px] text-paper placeholder-dim focus:outline-none border" style={inputStyle} />
                  <PrimaryBtn onClick={postNote} disabled={!noteText.trim()} className="!rounded-[11px] !py-[9px]">Post</PrimaryBtn>
                </div>
              )}
            </Card>
          </div>

          {/* RIGHT rail — cards only when populated */}
          <div className="flex flex-col gap-[14px]">
            {blocks.length > 0 && (
              <Card className="px-[17px] py-[15px]">
                <SectionLabel className="mb-2.5">Blocks</SectionLabel>
                <div className="flex flex-col gap-2">
                  {blocks.map(b => {
                    const bd = dueLabel(b.due_date, b.status);
                    return (
                      <button key={b.id} onClick={() => onNavigate?.('task', b.id)} className="text-left px-3 py-[11px] rounded-[11px] border hover:border-ember/40" style={{ background: 'var(--surface-solid)', borderColor: 'var(--ink-line)' }}>
                        <div className="text-[14px] font-medium text-paper">{b.title}</div>
                        <div className="text-[12px]" style={{ color: b.status === 'blocked' ? 'rgb(var(--c-coral))' : 'rgb(var(--c-muted))' }}>
                          {STATUS_LABEL[b.status]}{bd.tone === 'coral' ? ` · ${bd.text}` : ''}{b.phase ? ` · ${b.phase} phase` : ''}
                        </div>
                      </button>
                    );
                  })}
                </div>
                <div className="text-[13px] text-muted mt-2.5">Completing this task clears that blocker and its owner is notified.</div>
              </Card>
            )}

            {(attachCount > 0 || showAttachments) && <AttachmentsCard subjectType="task" subjectId={taskId} profile={profile} title="Attachment" />}

            {canWrite && (
              <Card panel className="px-[17px] py-[15px]">
                <SectionLabel className="mb-2.5">Add</SectionLabel>
                <div className="flex gap-[7px] flex-wrap">
                  <SolidChipBtn onClick={() => { setSubOpen(true); setTimeout(() => subRef.current?.focus(), 30); }}>Subtask</SolidChipBtn>
                  <SolidChipBtn onClick={() => setShowAttachments(true)}>Attachment</SolidChipBtn>
                  <SolidChipBtn onClick={() => setOpenChip('link')}>Link a record</SolidChipBtn>
                  <SolidChipBtn onClick={toggleTimer}>{timerHere ? 'Stop timer' : 'Log time'}</SolidChipBtn>
                  <SolidChipBtn onClick={duplicate}>Duplicate</SolidChipBtn>
                </div>
                {openChip === 'link' && (
                  <div className="mt-3">
                    <LinkPicker task={task} companies={companies} locations={locations} deals={deals} tickets={tickets}
                      onPick={(type, id) => { setField({ subject_type: type, subject_id: id }); setOpenChip(null); }} onClose={() => setOpenChip(null)} />
                  </div>
                )}
              </Card>
            )}

            <div className="text-[12px] text-dim px-1">
              Created {fmtRel(task.created_at)}{task.created_by ? ` by ${nameOf(task.created_by)}` : ''} · last updated {fmtRel(task.updated_at)} · ID {String(task.id).slice(0, 6)}
            </div>
          </div>
        </div>
      </div>
      {canWrite && (
        <MobileDock>
          <div className="flex gap-[9px]">
            {task.status === 'done'
              ? <button onClick={() => setStatus('todo')} className="flex-1 py-[14px] rounded-[12px] text-[15px] font-semibold border" style={{ background: 'var(--surface-solid)', borderColor: 'var(--ink-line)' }}>Reopen</button>
              : <button onClick={() => setStatus('done')} className="flex-1 py-[14px] rounded-[12px] text-[15px] font-semibold" style={{ background: 'linear-gradient(180deg, rgb(var(--c-primary)), rgb(var(--c-primary-deep)))', color: 'rgb(var(--c-ink))' }}>Complete</button>}
            <button onClick={() => { const el = document.querySelector('input[placeholder^="Write a note"]'); el?.scrollIntoView({ block: 'center', behavior: 'smooth' }); el?.focus(); }} className="px-[18px] py-[14px] rounded-[12px] text-[15px] font-semibold border" style={{ background: 'var(--surface-solid)', borderColor: 'var(--ink-line)' }}>Note</button>
            <button onClick={() => setSheet(true)} className="px-4 py-[14px] rounded-[12px] text-[15px] border" style={{ background: 'var(--surface-solid)', borderColor: 'var(--ink-line)' }}>…</button>
          </div>
        </MobileDock>
      )}
      {/* The phone's "…": the same actions as the desktop menu, plus the timer,
          which otherwise had no control below lg. */}
      {sheet && (
        <MobileSheet title={task.title} sub={project?.name || 'Task'} onClose={() => setSheet(false)}>
          <SheetRow onClick={() => { setSheet(false); toggleTimer(); }} sub={timerHere ? 'Stop tracking time on this task' : 'Start tracking time on this task'}>
            {timerHere ? `Pause · ${fmtClock((now - new Date(running.started_at).getTime()) / 1000)}` : 'Start timer'}
          </SheetRow>
          {canWrite && <SheetRow onClick={() => { setSheet(false); setTitleDraft(task.title); setTitleEdit(true); }}>Rename</SheetRow>}
          {canWrite && <SheetRow onClick={() => { setSheet(false); duplicate(); }} sub="A copy in the same project">Duplicate</SheetRow>}
          {profile.role === 'owner' && <SheetRow tone="coral" onClick={() => { setSheet(false); deleteTask(); }}>Delete task</SheetRow>}
        </MobileSheet>
      )}
    </div>
  );

  function allTitle(id) { return subtasks.find(s => s.id === id)?.title || blocks.find(b => b.id === id)?.title || 'another task'; }
}

/** Header chip: surface-solid, 6px 11px, radius 9, 9px mono label + 13px 600 value. Opens a popover. */
function HeaderChip({ label, value, open, onToggle, disabled, children }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const away = (e) => { if (ref.current && !ref.current.contains(e.target)) onToggle(); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open, onToggle]);
  return (
    <span className="relative" ref={ref}>
      <button type="button" onClick={() => !disabled && onToggle()} disabled={disabled}
        className="inline-flex items-center gap-[7px] px-[11px] py-[6px] rounded-[9px] border text-[13px] transition hover:border-ember/40 disabled:cursor-default"
        style={{ background: 'var(--surface-solid)', borderColor: 'var(--ink-line)' }}>
        <span className="hidden lg:inline font-mono text-[9px] font-bold tracking-[.16em] uppercase text-dim">{label}</span>
        <span className="font-semibold text-paper">{value}</span>
      </button>
      {open && <div className="absolute left-0 top-full mt-1 z-40 min-w-[200px] menu-surface rounded-[10px] py-1 max-h-72 overflow-y-auto">{children}</div>}
    </span>
  );
}
function DashedChip({ text, open, onToggle, children }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const away = (e) => { if (ref.current && !ref.current.contains(e.target)) onToggle(); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open, onToggle]);
  return (
    <span className="relative" ref={ref}>
      <button type="button" onClick={onToggle} className="inline-flex items-center gap-[7px] px-[11px] py-[6px] rounded-[9px] border border-dashed text-[13px] text-muted hover:text-paper"
        style={{ background: 'var(--panel-bg)', borderColor: 'var(--dash-line)' }}>{text}</button>
      {open && <div className="absolute left-0 top-full mt-1 z-40 min-w-[240px] menu-surface rounded-[10px] p-2">{children}</div>}
    </span>
  );
}
function MenuRow({ children, onClick, bold, hint }) {
  return (
    <button type="button" onClick={onClick} className="w-full px-3 py-2 text-left text-[13px] text-paper hover:bg-ember/10 flex items-center justify-between gap-3">
      <span className={bold ? 'font-semibold' : ''}>{children}</span>{hint != null && <Mono size={10} className="shrink-0 max-w-[140px] truncate">{hint}</Mono>}
    </button>
  );
}
function LabelEditor({ labels, onChange }) {
  const [text, setText] = useState('');
  return (
    <div>
      <div className="flex flex-wrap gap-1 mb-2">{labels.map(l => <span key={l} className="text-[11px] px-2 py-0.5 rounded-[6px] border flex items-center gap-1" style={{ background: 'var(--ink-soft)', borderColor: 'var(--ink-line)' }}>{l}<button onClick={() => onChange(labels.filter(x => x !== l))} className="text-dim">&times;</button></span>)}</div>
      <input autoFocus value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && text.trim()) { onChange([...new Set([...labels, text.trim()])]); setText(''); } }}
        placeholder="Type a label, Enter to add" className="w-full px-2 py-1.5 rounded-[8px] text-[13px] text-paper placeholder-dim focus:outline-none border" style={{ background: 'var(--surface-solid)', borderColor: 'var(--ink-line)' }} />
    </div>
  );
}
function BlockedByPicker({ taskId, projectId, current, onPick }) {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    let q = supabase.from('tasks').select('id, title, status').neq('id', taskId).is('parent_task_id', null).neq('status', 'done').order('title').limit(60);
    if (projectId) q = q.eq('project_id', projectId);
    q.then(r => setRows(r.data || []));
  }, [taskId, projectId]);
  return (
    <div className="max-h-64 overflow-y-auto">
      <div className="text-[11px] text-dim px-1 pb-1">Waits on…</div>
      {current && <button onClick={() => onPick(null)} className="w-full px-2 py-1.5 text-left text-[13px] text-muted hover:bg-ember/10 rounded">Clear</button>}
      {rows.map(r => <button key={r.id} onClick={() => onPick(r.id)} className={`w-full px-2 py-1.5 text-left text-[13px] text-paper hover:bg-ember/10 rounded ${r.id === current ? 'font-semibold' : ''}`}>{r.title}</button>)}
      {rows.length === 0 && <div className="text-[13px] text-dim px-2 py-1">No other open tasks{projectId ? ' in this project' : ''}.</div>}
    </div>
  );
}
function LinkPicker({ task, companies, locations, deals, tickets, onPick, onClose }) {
  const [type, setType] = useState(task.subject_type || 'company');
  const rows = type === 'company' ? companies : type === 'location' ? locations : type === 'deal' ? deals : tickets.map(t => ({ id: t.id, name: `#${t.ticket_number} ${t.subject || ''}` }));
  return (
    <div className="space-y-2">
      <div className="flex gap-1 flex-wrap">{['company', 'location', 'deal', 'ticket'].map(t => <button key={t} onClick={() => setType(t)} className="text-[11px] px-2 py-1 rounded-[6px] border" style={type === t ? { background: 'rgb(var(--c-primary) / .12)', borderColor: 'rgb(var(--c-primary) / .3)', color: 'rgb(var(--c-primary-deep))' } : { borderColor: 'var(--ink-line)' }}>{SUBJECT_LABEL[t]}</button>)}</div>
      <select className="w-full px-2 py-1.5 rounded-[8px] text-[13px] text-paper border" style={{ background: 'var(--surface-solid)', borderColor: 'var(--ink-line)' }}
        value={task.subject_type === type ? (task.subject_id || '') : ''} onChange={e => e.target.value ? onPick(type, e.target.value) : onPick(null, null)}>
        <option value="">None</option>{rows.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
      </select>
      <button onClick={onClose} className="text-[12px] text-dim">Close</button>
    </div>
  );
}

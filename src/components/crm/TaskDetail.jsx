import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import TimerButton from './TimerButton.jsx';
import AttachmentsCard from './AttachmentsCard.jsx';

import { PRIORITY_LABEL, PRIORITY_SLA, priorityLabel } from '../../lib/priority';
import ActivityTimeline from './ActivityTimeline.jsx';
import FieldChip from './FieldChip.jsx';
const STATUS_OPTIONS = ['todo', 'in_progress', 'blocked', 'done'];
const STATUS_LABEL = { todo: 'To do', in_progress: 'In progress', blocked: 'Blocked', done: 'Done' };
const STATUS_STYLES = {
  todo: 'bg-blue-100 text-blue-700 border border-blue-200',
  in_progress: 'bg-orange-100 text-orange-700 border border-orange-200',
  blocked: 'bg-red-100 text-red-700 border border-red-200',
  done: 'bg-emerald-100 text-emerald-700 border border-emerald-200',
};

export default function TaskDetail({ taskId, profile, onClose, onNavigate }) {
  const [task, setTask] = useState(null);
  const [subtasks, setSubtasks] = useState([]);
  const [members, setMembers] = useState([]);
  const [projects, setProjects] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [locations, setLocations] = useState([]);
  const [deals, setDeals] = useState([]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const [newSubtask, setNewSubtask] = useState('');

  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  useEffect(() => { load(); }, [taskId]);

  const load = async () => {
    const [t, st, m, p, c, l, d] = await Promise.all([
      supabase.from('tasks').select('*').eq('id', taskId).single(),
      supabase.from('tasks').select('*').eq('parent_task_id', taskId).order('sort_order'),
      supabase.from('profiles').select('id, email, display_name'),
      supabase.from('crm_projects').select('*').order('name'),
      supabase.from('companies').select('id, name'),
      supabase.from('locations').select('id, name, company_id'),
      supabase.from('deals').select('id, name, company_id'),
    ]);
    setTask(t.data);
    setSubtasks(st.data || []);
    setMembers(m.data || []);
    setProjects(p.data || []);
    setCompanies(c.data || []);
    setLocations(l.data || []);
    setDeals(d.data || []);
  };

  // One field, one write, no mode. The Edit button stays for the description
  // and title, where a textarea is genuinely the right control.
  const setField = async (patch) => {
    if (!canWrite) return;
    const before = task;
    setTask(t => ({ ...t, ...patch }));            // optimistic
    const { error } = await supabase.from('tasks').update(patch).eq('id', taskId);
    if (error) { setTask(before); alert('Could not save: ' + error.message); return; }
    load();
  };

  const startEdit = () => { setDraft({ ...task }); setEditing(true); };

  const save = async () => {
    const { id, created_at, updated_at, ...patch } = draft;
    if (patch.status === 'done' && task.status !== 'done') patch.completed_at = new Date().toISOString();
    if (patch.status !== 'done') patch.completed_at = null;
    const { error } = await supabase.from('tasks').update(patch).eq('id', taskId);
    if (error) { alert('Could not save: ' + error.message); return; }
    setEditing(false);
    load();
  };

  const set = (k, v) => setDraft({ ...draft, [k]: v });

  const addSubtask = async (e) => {
    e.preventDefault();
    if (!newSubtask.trim()) return;
    await supabase.from('tasks').insert({
      title: newSubtask.trim(),
      parent_task_id: taskId,
      project_id: task.project_id,
      subject_type: task.subject_type,
      subject_id: task.subject_id,
      sort_order: subtasks.length,
    });
    setNewSubtask('');
    load();
  };

  const toggleSubtask = async (st) => {
    const newStatus = st.status === 'done' ? 'todo' : 'done';
    await supabase.from('tasks').update({
      status: newStatus,
      completed_at: newStatus === 'done' ? new Date().toISOString() : null,
    }).eq('id', st.id);
    load();
  };

  const deleteTask = async () => {
    const openSubs = subtasks.filter(s => s.status !== 'done').length;
    let msg = 'Delete this task?';
    if (openSubs > 0) msg += `\n\n${openSubs} open subtask${openSubs > 1 ? 's' : ''} will also be deleted.`;
    if (!confirm(msg)) return;
    await supabase.from('tasks').delete().eq('id', taskId);
    onClose();
  };

  const changeStatus = async (status) => {
    const patch = { status };
    // "Blocked" with no reason tells the next person nothing. Asking once, here,
    // is what makes the Waiting rail on Today worth reading.
    if (status === 'blocked') {
      const why = prompt('What is it waiting on?', task.blocked_reason || '');
      if (why === null) return;
      patch.blocked_reason = why.trim() || null;
    } else if (task.status === 'blocked') {
      patch.blocked_reason = null;   // unblocked: the old reason is no longer true
    }
    if (status === 'done') {
      const openSubs = subtasks.filter(s => s.status !== 'done').length;
      if (openSubs > 0 && !confirm(`${openSubs} subtask${openSubs > 1 ? 's are' : ' is'} still open. Complete anyway?`)) return;
      patch.completed_at = new Date().toISOString();
    } else {
      patch.completed_at = null;
    }
    await supabase.from('tasks').update(patch).eq('id', taskId);
    load();
  };

  // Resolve linked context
  const getLinkedContext = () => {
    if (!task) return {};
    let subjectName = '', companyName = '', companyId = null, subjectLabel = '';

    const resolve = (type, id) => {
      if (type === 'company') { const c = companies.find(x => x.id === id); return c ? { label: 'Company', name: c.name, companyName: c.name, companyId: c.id } : {}; }
      if (type === 'location') { const l = locations.find(x => x.id === id); const c = companies.find(x => x.id === l?.company_id); return l ? { label: 'Location', name: l.name, companyName: c?.name, companyId: c?.id } : {}; }
      if (type === 'deal') { const d = deals.find(x => x.id === id); const c = companies.find(x => x.id === d?.company_id); return d ? { label: 'Deal', name: d.name, companyName: c?.name, companyId: c?.id } : {}; }
      return {};
    };

    // Try task's own subject first
    let ctx = resolve(task.subject_type, task.subject_id);
    // Fall back to project's subject
    if (!ctx.name && task.project_id) {
      const proj = projects.find(p => p.id === task.project_id);
      if (proj) ctx = resolve(proj.subject_type, proj.subject_id);
    }
    return ctx;
  };

  if (!task) return <div className="h-full flex items-center justify-center text-dim text-sm">Loading...</div>;

  const ownerName = (id) => {
    const m = members.find(u => u.id === id);
    return m ? (m.display_name || m.email.split('@')[0]) : 'Unassigned';
  };

  const linkedProject = projects.find(p => p.id === task.project_id);
  const ctx = getLinkedContext();
  const openSubs = subtasks.filter(s => s.status !== 'done');
  const doneSubs = subtasks.filter(s => s.status === 'done');

  const input = "w-full px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper placeholder-dim focus:outline-none focus:border-ember";
  const label = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block";

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 py-5 border-b border-bdr flex items-center gap-4">
        <button onClick={onClose} className="text-muted hover:text-paper text-lg">&larr;</button>
        <div className="flex-1 min-w-0">
          <div className={`text-xl font-bold truncate ${task.status === 'done' ? 'text-dim line-through' : 'text-paper'}`}>{task.title}</div>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span className={`badge-status ${STATUS_STYLES[task.status]}`}>{task.status.replace('_', ' ')}</span>
            <span className="text-xs text-dim font-mono">{priorityLabel(task.priority)}</span>
            {task.due_date && (
              <span className={`text-xs ${new Date(task.due_date) < new Date() && task.status !== 'done' ? 'text-red-600 font-bold' : 'text-dim'}`}>
                Due {new Date(task.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
              </span>
            )}
          </div>
        </div>
        {!editing && (
          <div className="flex gap-2 shrink-0 items-center">
            <TimerButton subjectType="task" subjectId={taskId} label={task.title} profile={profile} />
            {canWrite && <button onClick={startEdit} className="btn-ghost px-3 py-1.5 rounded-xl text-xs">Edit text</button>}
            {profile.role === 'owner' && (
              <button onClick={deleteTask} className="px-3 py-1.5 text-xs text-red-600 border border-red-200 rounded-xl hover:bg-red-50 transition">Delete</button>
            )}
          </div>
        )}
      </div>

      {/* Every field that is a choice, edited where it is displayed. Replaces
          an edit MODE that made moving a due date a four-step job. */}
      {!editing && (
        <div className="px-6 py-2.5 border-b border-bdr flex items-center gap-2 flex-wrap">
          <FieldChip label="Status" disabled={!canWrite}
            value={STATUS_LABEL[task.status] || task.status}
            tone={task.status === 'blocked' ? 'red' : task.status === 'done' ? 'green' : task.status === 'in_progress' ? 'ember' : 'default'}
            options={STATUS_OPTIONS.map(v => ({ value: v, label: STATUS_LABEL[v] || v.replace('_', ' ') }))}
            onPick={(v) => changeStatus(v)} />

          <FieldChip label="Priority" disabled={!canWrite}
            value={PRIORITY_LABEL[task.priority] || '—'}
            tone={task.priority === 'P0' ? 'red' : task.priority === 'P1' ? 'amber' : 'muted'}
            options={['P0', 'P1', 'P2', 'P3'].map(v => ({ value: v, label: PRIORITY_LABEL[v], hint: PRIORITY_SLA[v]?.resolve }))}
            onPick={(v) => setField({ priority: v })} />

          <FieldChip label="Owner" disabled={!canWrite}
            value={ownerName(task.owner_id) || 'Unassigned'}
            tone={task.owner_id ? 'default' : 'muted'}
            options={[{ value: null, label: 'Unassigned' }, ...members.map(m => ({ value: m.id, label: m.display_name || m.email }))]}
            onPick={(v) => setField({ owner_id: v })} />

          <FieldChip label="Due" disabled={!canWrite}
            value={task.due_date ? new Date(task.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : 'No date'}
            tone={task.due_date && new Date(task.due_date) < new Date(new Date().toDateString()) && task.status !== 'done' ? 'red' : 'muted'}>
            <div className="space-y-2">
              <input type="date" value={task.due_date || ''} onChange={e => setField({ due_date: e.target.value || null })}
                className="w-full px-2 py-1 bg-card border border-bdr rounded-lg text-xs text-paper" />
              {task.due_date && (
                <button onClick={() => setField({ due_date: null })} className="text-[11px] text-dim hover:text-red-600">Clear date</button>
              )}
            </div>
          </FieldChip>

          <FieldChip label="Project" disabled={!canWrite}
            value={projects.find(p => p.id === task.project_id)?.name || 'None'}
            tone={task.project_id ? 'ember' : 'muted'}
            options={[{ value: null, label: 'No project' }, ...projects.map(p => ({ value: p.id, label: p.name }))]}
            onPick={(v) => setField({ project_id: v, phase: null })} />

          {/* Phase only exists once a project does, and only if it uses them. */}
          {task.project_id && (projects.find(p => p.id === task.project_id)?.phases || []).length > 0 && (
            <FieldChip label="Phase" disabled={!canWrite}
              value={task.phase || 'Unphased'}
              tone={task.phase ? 'ember' : 'muted'}
              options={[{ value: null, label: 'Unphased' },
                ...(projects.find(p => p.id === task.project_id)?.phases || []).map(x => ({ value: x, label: x }))]}
              onPick={(v) => setField({ phase: v })} />
          )}

          {task.status === 'blocked' && (
            <span className="text-[11px] text-red-600">
              {task.blocked_reason ? `Blocked — ${task.blocked_reason}` : 'Blocked'}
            </span>
          )}
        </div>
      )}

      {/* Card grid layout */}
      <div className="flex-1 overflow-y-auto p-6">
        {editing ? (
          <div className="max-w-3xl">
            <Card title="Edit Task">
              <div className="space-y-3">
                <div><label className={label}>Title</label><input className={input} value={draft.title || ''} onChange={e => set('title', e.target.value)} /></div>
                <div><label className={label}>Description</label><textarea className={input + ' resize-none'} rows={4} value={draft.description || ''} onChange={e => set('description', e.target.value)} /></div>
                <div className="grid grid-cols-2 gap-3">
                  <div><label className={label}>Status</label><select className={input} value={draft.status} onChange={e => set('status', e.target.value)}>
                    {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}</select></div>
                  <div><label className={label}>Priority</label><select className={input} value={draft.priority} onChange={e => set('priority', e.target.value)}>
                    <option value="P0">{PRIORITY_LABEL.P0}</option><option value="P1">{PRIORITY_LABEL.P1}</option><option value="P2">{PRIORITY_LABEL.P2}</option><option value="P3">{PRIORITY_LABEL.P3}</option></select></div>
                  <div><label className={label}>Assignee</label><select className={input} value={draft.owner_id || ''} onChange={e => set('owner_id', e.target.value || null)}>
                    <option value="">Unassigned</option>{members.map(m => <option key={m.id} value={m.id}>{m.display_name || m.email}</option>)}</select></div>
                  <div><label className={label}>Due date</label><input className={input} type="date" value={draft.due_date || ''} onChange={e => set('due_date', e.target.value || null)} /></div>
                  <div><label className={label}>Project</label><select className={input} value={draft.project_id || ''} onChange={e => set('project_id', e.target.value || null)}>
                    <option value="">No project</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
                </div>
                <div className="flex gap-2 pt-2">
                  <button onClick={save} className="btn-glass px-5 py-2 rounded-xl text-sm">Save</button>
                  <button onClick={() => setEditing(false)} className="btn-ghost px-4 py-2 rounded-xl text-sm">Cancel</button>
                </div>
              </div>
            </Card>
          </div>
        ) : (
          <div className="grid grid-cols-12 gap-4 max-w-[1200px]">

            {/* LEFT: Details + Description */}
            <div className="col-span-4 space-y-4">
              <Card title="Details">
                <div className="space-y-3">
                  <Field label="Assignee" value={
                    task.owner_id ? (
                      <span className="flex items-center gap-2">
                        <span className="w-6 h-6 rounded-full bg-ember text-white text-[10px] font-bold flex items-center justify-center">
                          {ownerName(task.owner_id)[0]?.toUpperCase()}
                        </span>
                        {ownerName(task.owner_id)}
                      </span>
                    ) : null
                  } />
                  <Field label="Priority" value={task.priority} />
                  <Field label="Due date" value={task.due_date ? new Date(task.due_date).toLocaleDateString('en-GB') : null} />
                  {task.completed_at && <Field label="Completed" value={new Date(task.completed_at).toLocaleDateString('en-GB')} />}
                  <Field label="Created" value={new Date(task.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })} />
                </div>
              </Card>

              {task.description && (
                <Card title="Description">
                  <div className="text-sm text-paper whitespace-pre-wrap leading-relaxed">{task.description}</div>
                </Card>
              )}
            </div>

            {/* MIDDLE: Subtasks */}
            <div className="col-span-4 space-y-4">
              <Card title="Subtasks" count={subtasks.length}>
                {/* Open subtasks */}
                {openSubs.length > 0 && (
                  <div className="space-y-1.5 mb-3">
                    {openSubs.map(st => (
                      <div key={st.id} className="flex items-center gap-2 py-2 px-3 glass-inner rounded-xl">
                        {canWrite && (
                          <button onClick={() => toggleSubtask(st)}
                            className="w-5 h-5 rounded border-2 border-slate-300 hover:border-ember shrink-0 transition" />
                        )}
                        <span className="text-sm text-paper flex-1">{st.title}</span>
                        {st.owner_id && (
                          <span className="w-5 h-5 rounded-full bg-ember text-white text-[8px] font-bold flex items-center justify-center shrink-0">
                            {ownerName(st.owner_id)[0]?.toUpperCase()}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Done subtasks */}
                {doneSubs.length > 0 && (
                  <div className="space-y-1 mb-3">
                    {doneSubs.map(st => (
                      <div key={st.id} className="flex items-center gap-2 py-1.5 px-3 rounded-xl opacity-60">
                        {canWrite && (
                          <button onClick={() => toggleSubtask(st)}
                            className="w-5 h-5 rounded bg-emerald-100 border-2 border-emerald-400 text-emerald-600 text-[10px] flex items-center justify-center shrink-0">&#x2713;</button>
                        )}
                        <span className="text-sm text-dim line-through flex-1">{st.title}</span>
                      </div>
                    ))}
                  </div>
                )}

                {subtasks.length === 0 && <div className="text-xs text-dim italic py-2 text-center">No subtasks</div>}

                {/* Add subtask */}
                {canWrite && (
                  <form onSubmit={addSubtask} className="flex gap-2 mt-2">
                    <input className={input + ' flex-1 !rounded-xl'} value={newSubtask} onChange={e => setNewSubtask(e.target.value)}
                      placeholder="Add subtask..." />
                    <button type="submit" disabled={!newSubtask.trim()}
                      className="btn-glass px-3 py-2 rounded-xl text-xs disabled:opacity-50 shrink-0">Add</button>
                  </form>
                )}
              </Card>

              {/* Notes, calls and emails against the task itself. Everything
                  else with a detail page already had this; tasks were the one
                  place where the reasoning behind a job had nowhere to live, so
                  it ended up on the ticket, or nowhere. Attachments already use
                  subjectType="task", so this is the same pattern. */}
              <Card title="Notes &amp; activity">
                <ActivityTimeline subjectType="task" subjectId={taskId} profile={profile} />
              </Card>
            </div>

            {/* RIGHT: Linked context */}
            <div className="col-span-4 space-y-4">
              {/* Project */}
              {/* A card only exists once it has something in it. An empty
                  "Project" card told you nothing except that the page had room
                  for one; five of them turned the rail into a list of absences.
                  What is missing is offered once, at the bottom, as an Add row. */}
              {linkedProject && (
                <Card title="Project">
                  <div onClick={() => onNavigate?.('project', linkedProject.id)}
                    className="p-3 glass-inner rounded-xl cursor-pointer">
                    <div className="text-sm font-medium text-paper">{linkedProject.name}</div>
                    <div className="text-xs text-muted mt-0.5">{linkedProject.status}</div>
                  </div>
                </Card>
              )}

              {/* Linked company */}
              {ctx.companyName && (
                <Card title="Company">
                  <div onClick={() => ctx.companyId && onNavigate?.('company', ctx.companyId)}
                    className="p-3 glass-inner rounded-xl cursor-pointer flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-ember/15 border border-ember/25 flex items-center justify-center text-lg shrink-0">{'\u{1F3E2}'}</div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold text-paper">{ctx.companyName}</div>
                      <div className="text-xs text-muted">Company</div>
                    </div>
                  </div>
                </Card>
              )}

              {/* Linked record (if not company) */}
              {ctx.label && ctx.label !== 'Company' && (
                <Card title={ctx.label}>
                  <div className="p-3 glass-inner rounded-xl">
                    <div className="text-sm font-medium text-paper">{ctx.name}</div>
                    <div className="text-xs text-muted">{ctx.label}</div>
                  </div>
                </Card>
              )}

              <AttachmentsCard subjectType="task" subjectId={taskId} profile={profile} />

              {/* Everything this task has NOT got, in one row rather than one
                  empty card each. */}
              {canWrite && (() => {
                const missing = [];
                if (!linkedProject) missing.push(['Project', () => document.querySelector('[data-chip="project"]')?.click()]);
                if (!task.owner_id) missing.push(['Owner', null]);
                if (!task.due_date) missing.push(['Due date', null]);
                if (!ctx.companyName) missing.push(['Customer', null]);
                if (!missing.length) return null;
                return (
                  <div className="glass-card rounded-2xl px-4 py-3">
                    <div className="text-[10px] font-mono font-bold uppercase tracking-[0.14em] text-dim mb-1.5">Not set</div>
                    <div className="flex flex-wrap gap-1.5">
                      {missing.map(([lbl]) => (
                        <span key={lbl} className="px-2 py-0.5 rounded-lg border border-dashed border-bdr text-[11px] text-dim">
                          {lbl}
                        </span>
                      ))}
                    </div>
                    <div className="text-[11px] text-dim mt-1.5">Set these from the chips at the top.</div>
                  </div>
                );
              })()}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Card({ title, count, children }) {
  return (
    <div className="glass-card rounded-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-bdr flex items-center gap-2">
        <h3 className="text-sm font-bold text-paper">{title}</h3>
        {count !== undefined && <span className="text-xs text-dim font-mono">({count})</span>}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div>
      <div className="text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-0.5">{label}</div>
      <div className="text-sm text-paper">{value || <span className="text-dim italic">--</span>}</div>
    </div>
  );
}

function Empty({ children }) {
  return <div className="text-xs text-dim italic py-3 text-center">{children}</div>;
}

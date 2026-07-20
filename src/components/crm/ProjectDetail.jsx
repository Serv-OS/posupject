import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import TimerButton from './TimerButton.jsx';

const STATUS_STYLES = {
  todo: 'bg-blue-100 text-blue-700 border border-blue-200',
  in_progress: 'bg-orange-100 text-orange-700 border border-orange-200',
  blocked: 'bg-red-100 text-red-700 border border-red-200',
  done: 'bg-emerald-100 text-emerald-700 border border-emerald-200',
};

const SUBJECT_TYPES = [
  { key: '', label: 'None' },
  { key: 'company', label: 'Company', table: 'companies', nameField: 'name' },
  { key: 'location', label: 'Location', table: 'locations', nameField: 'name' },
  { key: 'deal', label: 'Deal', table: 'deals', nameField: 'name' },
  { key: 'onboarding', label: 'Onboarding', table: 'onboardings', nameField: null },
  { key: 'ticket', label: 'Ticket', table: 'tickets', nameField: 'subject' },
];

export default function ProjectDetail({ projectId, profile, onClose, onSelectTask, onNavigate }) {
  const [project, setProject] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [members, setMembers] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [locations, setLocations] = useState([]);
  const [deals, setDeals] = useState([]);
  const [onboardings, setOnboardings] = useState([]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const [newTask, setNewTask] = useState('');
  const [newPriority, setNewPriority] = useState('P2');
  const [subjectRecords, setSubjectRecords] = useState([]);

  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  useEffect(() => { load(); }, [projectId]);

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
    setProject(p.data);
    setTasks(t.data || []);
    setMembers(m.data || []);
    setOnboardings(ob.data || []);
    setCompanies(c.data || []);
    setLocations(l.data || []);
    setDeals(d.data || []);
  };

  // Resolve linked record and auto-derive company
  const getLinkedContext = () => {
    if (!project?.subject_type || !project?.subject_id) return null;
    const t = project.subject_type;
    const id = project.subject_id;
    if (t === 'location') {
      const loc = locations.find(x => x.id === id);
      const co = loc ? companies.find(x => x.id === loc.company_id) : null;
      return { type: 'Location', name: loc?.name, companyName: co?.name, companyId: co?.id, locationId: id };
    }
    if (t === 'deal') {
      const deal = deals.find(x => x.id === id);
      const co = deal ? companies.find(x => x.id === deal.company_id) : null;
      return { type: 'Deal', name: deal?.name, companyName: co?.name, companyId: co?.id };
    }
    if (t === 'company') {
      const co = companies.find(x => x.id === id);
      return { type: 'Company', name: co?.name, companyId: id };
    }
    if (t === 'onboarding') {
      // Show the venue the job is for: install location, else deal, else company.
      const o = onboardings.find(x => x.id === id);
      const loc = locations.find(x => x.id === o?.location_id);
      const deal = deals.find(x => x.id === o?.deal_id);
      const co = companies.find(x => x.id === (o?.company_id || deal?.company_id || loc?.company_id));
      return { type: 'Onboarding', name: loc?.name || deal?.name || co?.name, companyName: co?.name, companyId: co?.id };
    }
    return { type: t, name: id?.slice(0, 8) };
  };

  const loadSubjectRecords = async (type) => {
    if (type === 'location') {
      // Show locations grouped by company for easier picking
      setSubjectRecords(locations.map(l => {
        const co = companies.find(c => c.id === l.company_id);
        return { id: l.id, name: `${l.name} (${co?.name || 'Unknown'})` };
      }));
    } else if (type === 'deal') {
      setSubjectRecords(deals.map(d => {
        const co = companies.find(c => c.id === d.company_id);
        return { id: d.id, name: `${d.name} (${co?.name || 'Unknown'})` };
      }));
    } else if (type === 'company') {
      setSubjectRecords(companies.map(c => ({ id: c.id, name: c.name })));
    } else {
      const cfg = SUBJECT_TYPES.find(s => s.key === type);
      if (!cfg?.table) { setSubjectRecords([]); return; }
      const { data } = await supabase.from(cfg.table).select('*').order(cfg.nameField || 'created_at').limit(200);
      setSubjectRecords((data || []).map(r => ({ id: r.id, name: cfg.nameField ? r[cfg.nameField] : r.id.slice(0, 8) })));
    }
  };

  const deleteRecord = async () => {
    if (!confirm(`Delete project "${project?.name}" and all its tasks?\n\nThis cannot be undone.`)) return;
    await supabase.from('crm_projects').delete().eq('id', projectId);
    onClose();
  };

  const startEdit = () => {
    setDraft({ ...project });
    setEditing(true);
    if (project.subject_type) loadSubjectRecords(project.subject_type);
  };

  const save = async () => {
    const patch = {
      name: draft.name,
      description: draft.description || null,
      status: draft.status,
      owner_id: draft.owner_id || null,
      due_date: draft.due_date || null,
      subject_type: draft.subject_type || null,
      subject_id: draft.subject_id || null,
      template_id: draft.template_id || null,
    };
    const { error } = await supabase.from('crm_projects').update(patch).eq('id', projectId);
    if (error) { alert('Save failed: ' + error.message); return; }
    setEditing(false);
    load();
  };

  const set = (k, v) => setDraft({ ...draft, [k]: v });

  const addTask = async (e) => {
    e.preventDefault();
    if (!newTask.trim()) return;
    await supabase.from('tasks').insert({
      title: newTask.trim(),
      project_id: projectId,
      priority: newPriority,
      sort_order: tasks.length,
    });
    setNewTask('');
    load();
  };

  const toggleTask = async (task) => {
    const newStatus = task.status === 'done' ? 'todo' : 'done';
    await supabase.from('tasks').update({
      status: newStatus,
      completed_at: newStatus === 'done' ? new Date().toISOString() : null,
    }).eq('id', task.id);
    load();
  };

  if (!project) return <div className="h-full flex items-center justify-center text-dim text-sm">Loading...</div>;

  const ownerName = (id) => {
    const m = members.find(u => u.id === id);
    return m ? (m.display_name || m.email.split('@')[0]) : '';
  };

  const openTasks = tasks.filter(t => t.status !== 'done');
  const doneTasks = tasks.filter(t => t.status === 'done');
  const pct = tasks.length ? Math.round((doneTasks.length / tasks.length) * 100) : 0;

  const input = "w-full px-3 py-2 bg-card border border-bdr rounded text-sm text-paper placeholder-dim focus:outline-none focus:border-ember";
  const label = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block";

  const PROJECT_STATUSES = ['active', 'completed', 'cancelled'];

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-bdr flex items-center gap-3">
        <button onClick={onClose} className="text-muted hover:text-paper text-sm">&larr;</button>
        <div className="flex-1 min-w-0">
          <div className="text-lg font-bold text-paper truncate">{project.name}</div>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span className="text-[10px] text-dim font-mono uppercase tracking-[0.18em]">
              {project.status} / {doneTasks.length}/{tasks.length} tasks done ({pct}%)
            </span>
            {(() => {
              const ctx = getLinkedContext();
              if (!ctx) return null;
              return (
                <>
                  {ctx.companyName && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] rounded-lg bg-slate-100 text-slate-600 border border-slate-200 cursor-pointer hover:border-slate-300"
                      onClick={(e) => { e.stopPropagation(); onNavigate?.('company', ctx.companyId); }}>
                      {'\u{1F3E2}'} {ctx.companyName}
                    </span>
                  )}
                  {ctx.type !== 'Company' && ctx.name && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] rounded-lg bg-ember/10 text-ember-deep border border-ember/20 cursor-pointer hover:border-ember/40"
                      onClick={(e) => { e.stopPropagation(); onNavigate?.(project.subject_type, project.subject_id); }}>
                      {ctx.type}: {ctx.name}
                    </span>
                  )}
                </>
              );
            })()}
          </div>
        </div>
        {!editing && (
          <div className="flex gap-2 items-center">
            <TimerButton subjectType="project" subjectId={projectId} label={project.name} profile={profile} />
            {canWrite && <button onClick={startEdit} className="btn-ghost px-4 py-2 rounded-xl text-sm">Edit</button>}
            {profile.role === 'owner' && (
              <button onClick={deleteRecord} className="px-3 py-2 text-xs text-red-600 border border-red-200 rounded-xl hover:bg-red-50 transition">Delete</button>
            )}
          </div>
        )}
      </div>

      {/* Progress bar */}
      {tasks.length > 0 && (
        <div className="px-6 py-2 border-b border-bdr">
          <div className="h-2 bg-ink rounded-full overflow-hidden">
            <div className="h-full bg-ember rounded-full transition-all" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-3xl space-y-6">

          {editing ? (
            <div className="space-y-3">
              <div><label className={label}>Name</label><input className={input} value={draft.name || ''} onChange={e => set('name', e.target.value)} /></div>
              <div><label className={label}>Description</label><textarea className={input + ' resize-none'} rows={3} value={draft.description || ''} onChange={e => set('description', e.target.value)} /></div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={label}>Status</label>
                  <select className={input} value={draft.status} onChange={e => set('status', e.target.value)}>
                    {PROJECT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div>
                  <label className={label}>Owner</label>
                  <select className={input} value={draft.owner_id || ''} onChange={e => set('owner_id', e.target.value || null)}>
                    <option value="">Unassigned</option>
                    {members.map(m => <option key={m.id} value={m.id}>{m.display_name || m.email}</option>)}
                  </select>
                </div>
                <div><label className={label}>Due date</label><input className={input} type="date" value={draft.due_date || ''} onChange={e => set('due_date', e.target.value || null)} /></div>
              </div>

              <div className={label + ' mt-3 mb-1'}>Link to</div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={label}>Location</label>
                  <select className={input} value={draft.subject_type === 'location' ? (draft.subject_id || '') : ''} onChange={e => {
                    setDraft(prev => ({
                      ...prev,
                      subject_type: e.target.value ? 'location' : null,
                      subject_id: e.target.value || null,
                    }));
                  }}>
                    <option value="">None</option>
                    {locations.map(l => {
                      const co = companies.find(c => c.id === l.company_id);
                      return <option key={l.id} value={l.id}>{l.name} ({co?.name || '?'})</option>;
                    })}
                  </select>
                </div>
                <div>
                  <label className={label}>Company</label>
                  <select className={input} value={draft.subject_type === 'company' ? (draft.subject_id || '') : ''} onChange={e => {
                    setDraft(prev => ({
                      ...prev,
                      subject_type: e.target.value ? 'company' : null,
                      subject_id: e.target.value || null,
                    }));
                  }}>
                    <option value="">None</option>
                    {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className={label}>Deal</label>
                  <select className={input} value={draft.subject_type === 'deal' ? (draft.subject_id || '') : ''} onChange={e => {
                    setDraft(prev => ({
                      ...prev,
                      subject_type: e.target.value ? 'deal' : null,
                      subject_id: e.target.value || null,
                    }));
                  }}>
                    <option value="">None</option>
                    {deals.map(d => {
                      const co = companies.find(c => c.id === d.company_id);
                      return <option key={d.id} value={d.id}>{d.name} ({co?.name || '?'})</option>;
                    })}
                  </select>
                </div>
                <div>
                  <label className={label}>Onboarding</label>
                  <select className={input} value={draft.subject_type === 'onboarding' ? (draft.subject_id || '') : ''} onChange={e => {
                    setDraft(prev => ({
                      ...prev,
                      subject_type: e.target.value ? 'onboarding' : null,
                      subject_id: e.target.value || null,
                    }));
                  }}>
                    <option value="">None</option>
                    {onboardings.map(o => {
                      const co = companies.find(c => c.id === o.company_id);
                      return <option key={o.id} value={o.id}>{co?.name || '?'} Onboarding</option>;
                    })}
                  </select>
                </div>
              </div>
              {/* Show which link is active */}
              {draft.subject_type && draft.subject_id && (
                <div className="mt-2 px-3 py-2 bg-emerald-50 border border-emerald-200 rounded text-xs text-emerald-700 flex items-center gap-2">
                  Linked to: {draft.subject_type === 'location' ? '\u{1F4CD}' : draft.subject_type === 'deal' ? '\u{1F4B0}' : draft.subject_type === 'onboarding' ? '\u{1F680}' : '\u{1F3E2}'}
                  {' '}{draft.subject_type}
                </div>
              )}
              <div className="flex gap-2 pt-1">
                <button onClick={save} className="px-4 py-2 bg-ember text-ink text-sm font-semibold rounded">Save</button>
                <button onClick={() => setEditing(false)} className="px-4 py-2 text-sm text-muted border border-bdr rounded">Cancel</button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-12 gap-4 max-w-[1400px]">

              {/* LEFT: Details + Description */}
              <div className="col-span-4 space-y-4">
                <Card title="Details">
                  <div className="space-y-3">
                    <Field label="Status" value={project.status} />
                    <Field label="Owner" value={ownerName(project.owner_id) || null} />
                    <Field label="Due date" value={project.due_date ? new Date(project.due_date).toLocaleDateString('en-GB') : null} />
                    <Field label="Created" value={new Date(project.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })} />
                  </div>
                </Card>

                {project.description && (
                  <Card title="Description">
                    <div className="text-sm text-paper whitespace-pre-wrap leading-relaxed">{project.description}</div>
                  </Card>
                )}

                {/* Linked To card */}
                {(() => {
                  const ctx = getLinkedContext();
                  if (!ctx) return (
                    <Card title="Linked To">
                      <div className="text-xs text-dim italic py-2 text-center">Not linked to any record</div>
                    </Card>
                  );
                  return (
                    <Card title="Linked To">
                      <div className="space-y-2">
                        {/* Linked record */}
                        <div onClick={() => onNavigate?.(project.subject_type, project.subject_id)}
                          className="p-3 glass-inner rounded-xl cursor-pointer flex items-center gap-3">
                          <div className="w-9 h-9 rounded-xl bg-ember/15 border border-ember/25 flex items-center justify-center text-sm shrink-0">
                            {project.subject_type === 'location' ? '\u{1F4CD}' : project.subject_type === 'deal' ? '\u{1F4B0}' : project.subject_type === 'onboarding' ? '\u{1F680}' : project.subject_type === 'ticket' ? '\u{1F3AB}' : '\u{1F3E2}'}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-semibold text-paper">{ctx.name || ctx.companyName}</div>
                            <div className="text-xs text-muted">{ctx.type}</div>
                          </div>
                        </div>
                        {/* Auto-derived company (if linked to location/deal) */}
                        {ctx.companyName && ctx.type !== 'Company' && (
                          <div onClick={() => ctx.companyId && onNavigate?.('company', ctx.companyId)}
                            className="p-3 glass-inner rounded-xl cursor-pointer flex items-center gap-3">
                            <div className="w-9 h-9 rounded-xl bg-slate-100 border border-slate-200 flex items-center justify-center text-sm shrink-0">{'\u{1F3E2}'}</div>
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-semibold text-paper">{ctx.companyName}</div>
                              <div className="text-xs text-muted">Company</div>
                            </div>
                          </div>
                        )}
                      </div>
                    </Card>
                  );
                })()}
              </div>

              {/* MIDDLE: Tasks */}
              <div className="col-span-8 space-y-4">
                <Card title="Tasks" count={tasks.length}>
                  {/* Open tasks */}
                  {openTasks.length > 0 && (
                    <div className="space-y-1.5 mb-3">
                      {openTasks.map(t => (
                        <div key={t.id} className="flex items-center gap-2 py-2 px-3 glass-inner rounded-xl group">
                          {canWrite && (
                            <button onClick={() => toggleTask(t)}
                              className="w-5 h-5 rounded border-2 border-slate-300 hover:border-ember shrink-0 transition" />
                          )}
                          <span className="text-sm text-paper flex-1 cursor-pointer hover:text-ember"
                            onClick={() => onSelectTask?.(t.id)}>{t.title}</span>
                          <span className={`px-1.5 py-0.5 text-[8px] font-bold rounded ${STATUS_STYLES[t.status]}`}>{t.status.replace('_',' ')}</span>
                          {t.due_date && (
                            <span className={`text-[10px] ${new Date(t.due_date) < new Date() ? 'text-red-600 font-bold' : 'text-dim'}`}>
                              {new Date(t.due_date).toLocaleDateString('en-GB', { day:'numeric', month:'short' })}
                            </span>
                          )}
                          {t.owner_id && (
                            <span className="w-5 h-5 rounded-full bg-ember text-white text-[9px] font-bold flex items-center justify-center shrink-0">
                              {ownerName(t.owner_id)[0]?.toUpperCase() || '?'}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Add task */}
                  {canWrite && (
                    <form onSubmit={addTask} className="flex gap-2 mb-3">
                      <input className={input + ' flex-1'} value={newTask} onChange={e => setNewTask(e.target.value)}
                        placeholder="Add a task..." />
                      <select className="px-2 py-2 bg-card border border-bdr rounded text-sm text-paper"
                        value={newPriority} onChange={e => setNewPriority(e.target.value)}>
                        <option value="P0">P0</option><option value="P1">P1</option>
                        <option value="P2">P2</option><option value="P3">P3</option>
                      </select>
                      <button type="submit" disabled={!newTask.trim()}
                        className="px-3 py-2 bg-ember text-white text-xs font-semibold rounded disabled:opacity-50">Add</button>
                    </form>
                  )}

                  {/* Done tasks */}
                  {doneTasks.length > 0 && (
                    <div className="space-y-1 opacity-60">
                      {doneTasks.map(t => (
                        <div key={t.id} className="flex items-center gap-2 py-1.5 px-3 rounded-xl">
                          {canWrite && (
                            <button onClick={() => toggleTask(t)}
                              className="w-5 h-5 rounded bg-emerald-100 border-2 border-emerald-400 text-emerald-600 text-[10px] flex items-center justify-center shrink-0">&#x2713;</button>
                          )}
                          <span className="text-sm text-dim line-through flex-1">{t.title}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {tasks.length === 0 && <div className="text-xs text-dim italic py-3 text-center">No tasks yet</div>}
                </Card>
              </div>
            </div>
          )}
        </div>
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

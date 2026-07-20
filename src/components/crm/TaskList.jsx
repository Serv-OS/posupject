import { useEffect, useState, useMemo } from 'react';
import { supabase } from '../../lib/supabase';

const STATUS_STYLES = {
  todo: 'bg-blue-100 text-blue-700 border border-blue-200',
  in_progress: 'bg-orange-100 text-orange-700 border border-orange-200',
  blocked: 'bg-red-100 text-red-700 border border-red-200',
  done: 'bg-emerald-100 text-emerald-700 border border-emerald-200',
};
const PRIORITY_STYLES = {
  P0: 'bg-red-100 text-red-700 border border-red-200',
  P1: 'bg-orange-100 text-orange-700 border border-orange-200',
  P2: 'bg-blue-100 text-blue-700 border border-blue-200',
  P3: 'bg-slate-100 text-slate-600 border border-slate-200',
};

export default function TaskList({ profile, onSelect }) {
  const [allTasks, setAllTasks] = useState([]);
  const [members, setMembers] = useState([]);
  const [projects, setProjects] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [locations, setLocations] = useState([]);
  const [deals, setDeals] = useState([]);
  const [onboardings, setOnboardings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ status: 'open', assignee: 'all', search: '' });
  const [expanded, setExpanded] = useState({});
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [priority, setPriority] = useState('P2');
  const [assignee, setAssignee] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [projectId, setProjectId] = useState('');

  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    const [t, m, p, c, l, d, ob] = await Promise.all([
      supabase.from('tasks').select('*').order('sort_order'),
      supabase.from('profiles').select('id, email, display_name'),
      supabase.from('crm_projects').select('*').order('name'),
      supabase.from('companies').select('id, name'),
      supabase.from('locations').select('id, name, company_id'),
      supabase.from('deals').select('id, name, company_id'),
      supabase.from('onboardings').select('id, company_id, deal_id, location_id'),
    ]);
    setAllTasks(t.data || []);
    setMembers(m.data || []);
    setProjects(p.data || []);
    setCompanies(c.data || []);
    setLocations(l.data || []);
    setDeals(d.data || []);
    setOnboardings(ob.data || []);
    setLoading(false);
  };

  // Build parent/child lookup
  const childMap = useMemo(() => {
    const map = {};
    allTasks.forEach(t => {
      if (t.parent_task_id) {
        if (!map[t.parent_task_id]) map[t.parent_task_id] = [];
        map[t.parent_task_id].push(t);
      }
    });
    return map;
  }, [allTasks]);

  // Top-level tasks only for the main list
  const topLevelTasks = useMemo(() => allTasks.filter(t => !t.parent_task_id), [allTasks]);

  const filtered = useMemo(() => {
    let result = topLevelTasks;
    if (filter.status === 'open') result = result.filter(t => t.status !== 'done');
    else if (filter.status !== 'all') result = result.filter(t => t.status === filter.status);
    if (filter.assignee === 'me') result = result.filter(t => t.owner_id === profile.id);
    if (filter.assignee === 'unassigned') result = result.filter(t => !t.owner_id);
    if (filter.search) {
      const q = filter.search.toLowerCase();
      result = result.filter(t => t.title.toLowerCase().includes(q));
    }
    return result;
  }, [topLevelTasks, filter, profile.id]);

  const ownerName = (id) => {
    const m = members.find(u => u.id === id);
    return m ? (m.display_name || m.email.split('@')[0]) : '';
  };

  const projectName = (id) => projects.find(p => p.id === id)?.name || '';

  // Resolve what a task or its project is linked to
  const getTaskContext = (task) => {
    const badges = [];

    // Direct subject link on the task
    const resolveSubject = (type, id) => {
      if (!type || !id) return null;
      if (type === 'company') { const c = companies.find(x => x.id === id); return c ? { label: 'Company', name: c.name } : null; }
      if (type === 'location') { const l = locations.find(x => x.id === id); return l ? { label: 'Location', name: l.name, companyId: l.company_id } : null; }
      if (type === 'deal') { const d = deals.find(x => x.id === id); return d ? { label: 'Deal', name: d.name, companyId: d.company_id } : null; }
      if (type === 'onboarding') {
        // Show the venue the job is for: install location, else deal, else company.
        const o = onboardings.find(x => x.id === id);
        if (!o) return { label: 'Onboarding', name: '' };
        const loc = locations.find(x => x.id === o.location_id);
        const dl = deals.find(x => x.id === o.deal_id);
        const name = loc?.name || dl?.name || companies.find(x => x.id === o.company_id)?.name || '';
        return { label: 'Onboarding', name, companyId: o.company_id || dl?.company_id || loc?.company_id };
      }
      if (type === 'ticket') return { label: 'Ticket', name: '' };
      return null;
    };

    // Check task's own subject
    let subject = resolveSubject(task.subject_type, task.subject_id);

    // If no direct subject, check the project's subject
    if (!subject && task.project_id) {
      const proj = projects.find(p => p.id === task.project_id);
      if (proj) subject = resolveSubject(proj.subject_type, proj.subject_id);
    }

    if (subject) {
      badges.push({ type: 'link', label: subject.label, name: subject.name });
      // Resolve company from location/deal
      if (subject.companyId) {
        const c = companies.find(x => x.id === subject.companyId);
        if (c) badges.push({ type: 'company', name: c.name });
      }
    }

    return badges;
  };

  const create = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    const { data } = await supabase.from('tasks').insert({
      title: title.trim(),
      description: newDescription.trim() || null,
      priority,
      owner_id: assignee || null,
      due_date: dueDate || null,
      project_id: projectId || null,
    }).select().single();
    setTitle(''); setNewDescription(''); setPriority('P2'); setAssignee(''); setDueDate(''); setProjectId('');
    setShowCreate(false);
    if (data) onSelect(data.id);
    else load();
  };

  const toggleDone = async (e, task) => {
    e.stopPropagation();
    const newStatus = task.status === 'done' ? 'todo' : 'done';
    await supabase.from('tasks').update({
      status: newStatus,
      completed_at: newStatus === 'done' ? new Date().toISOString() : null,
    }).eq('id', task.id);
    load();
  };

  const toggleExpand = (e, taskId) => {
    e.stopPropagation();
    setExpanded(prev => ({ ...prev, [taskId]: !prev[taskId] }));
  };

  const isOverdue = (t) => t.due_date && t.status !== 'done' && new Date(t.due_date) < new Date();

  const subtaskSummary = (taskId) => {
    const kids = childMap[taskId] || [];
    if (!kids.length) return null;
    const done = kids.filter(k => k.status === 'done').length;
    return { total: kids.length, done };
  };

  const input = "w-full px-3 py-2 bg-card border border-bdr rounded text-sm text-paper placeholder-dim focus:outline-none focus:border-ember";

  const renderTask = (t, depth = 0) => {
    const kids = childMap[t.id] || [];
    const hasKids = kids.length > 0;
    const isExpanded = expanded[t.id];
    const sub = subtaskSummary(t.id);
    const context = depth === 0 ? getTaskContext(t) : [];

    return (
      <div key={t.id}>
        <div
          onClick={() => onSelect(t.id)}
          className={`px-6 py-3 border-b border-bdr hover:bg-card/50 cursor-pointer transition flex items-center gap-3`}
          style={{ paddingLeft: `${24 + depth * 28}px` }}>

          {/* Expand/collapse toggle */}
          {hasKids ? (
            <button onClick={(e) => toggleExpand(e, t.id)}
              className="w-5 h-5 flex items-center justify-center text-muted hover:text-paper shrink-0 text-xs transition"
              title={isExpanded ? 'Collapse subtasks' : 'Expand subtasks'}>
              <span className={`inline-block transition-transform ${isExpanded ? 'rotate-90' : ''}`}>&#x25B6;</span>
            </button>
          ) : (
            <div className="w-5 shrink-0" />
          )}

          {/* Checkbox */}
          {canWrite && (
            <button onClick={(e) => toggleDone(e, t)}
              className={`w-5 h-5 rounded border-2 shrink-0 flex items-center justify-center transition ${
                t.status === 'done' ? 'bg-emerald-100 border-emerald-500 text-emerald-600' : 'border-slate-300 hover:border-ember'
              }`}>
              {t.status === 'done' && <span className="text-xs">&#x2713;</span>}
            </button>
          )}

          {/* Title + meta */}
          <div className="flex-1 min-w-0">
            <div className={`text-sm ${t.status === 'done' ? 'text-dim line-through' : 'text-paper'}`}>
              {t.title}
            </div>
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
              {projectName(t.project_id) && (
                <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] rounded bg-purple-50 text-purple-700 border border-purple-200">
                  {'\u{1F4C1}'} {projectName(t.project_id)}
                </span>
              )}
              {context.map((b, i) => (
                <span key={i} className={`inline-flex items-center px-1.5 py-0.5 text-[10px] rounded ${
                  b.type === 'company' ? 'bg-slate-100 text-slate-600 border border-slate-200' : 'bg-ember/10 text-ember-deep border border-ember/20'
                }`}>
                  {b.type === 'company' ? '\u{1F3E2}' : ''} {b.label ? `${b.label}: ` : ''}{b.name}
                </span>
              ))}
              {sub && !isExpanded && (
                <span className="text-[10px] text-muted">
                  {sub.done}/{sub.total} subtasks
                </span>
              )}
            </div>
          </div>

          {/* Subtask progress pill */}
          {sub && (
            <span className={`px-1.5 py-0.5 text-[9px] font-bold rounded ${
              sub.done === sub.total ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'
            }`}>
              {sub.done}/{sub.total}
            </span>
          )}

          <span className={`px-1.5 py-0.5 text-[9px] font-bold rounded border ${PRIORITY_STYLES[t.priority]}`}>{t.priority}</span>
          <span className={`px-1.5 py-0.5 text-[9px] font-bold uppercase rounded ${STATUS_STYLES[t.status]}`}>{t.status.replace('_', ' ')}</span>
          {t.due_date && (
            <span className={`text-xs ${isOverdue(t) ? 'text-red-600 font-bold' : 'text-dim'}`}>
              {new Date(t.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
            </span>
          )}
          {t.owner_id && (
            <span className="w-6 h-6 rounded-full bg-ember text-white text-[10px] font-bold flex items-center justify-center shrink-0"
              title={ownerName(t.owner_id)}>
              {ownerName(t.owner_id)[0]?.toUpperCase() || '?'}
            </span>
          )}
        </div>

        {/* Subtasks (indented, collapsible) */}
        {hasKids && isExpanded && (
          <div className="bg-ink-soft/50">
            {kids.map(kid => renderTask(kid, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-bdr flex items-center justify-between">
        <div>
          <div className="text-lg font-bold text-paper">Tasks</div>
          <div className="text-[10px] text-dim font-mono uppercase tracking-[0.18em]">
            {topLevelTasks.filter(t => t.status !== 'done').length} open / {topLevelTasks.filter(t => t.status === 'done').length} done
            {allTasks.length !== topLevelTasks.length && ` / ${allTasks.length - topLevelTasks.length} subtasks`}
          </div>
        </div>
        {canWrite && (
          <button onClick={() => setShowCreate(true)}
            className="px-3 py-1.5 bg-ember text-white text-sm font-semibold rounded hover:bg-ember-deep transition">
            + Add task
          </button>
        )}
      </div>

      <div className="px-6 py-3 border-b border-bdr flex items-center gap-2 flex-wrap">
        <input value={filter.search} onChange={e => setFilter({ ...filter, search: e.target.value })}
          placeholder="Search tasks..."
          className="px-3 py-1.5 bg-card border border-bdr rounded text-sm text-paper placeholder-dim focus:outline-none focus:border-ember w-56" />
        <select value={filter.status} onChange={e => setFilter({ ...filter, status: e.target.value })}
          className="px-2 py-1.5 bg-card border border-bdr rounded text-sm text-paper focus:outline-none focus:border-ember">
          <option value="open">Open</option>
          <option value="all">All</option>
          <option value="todo">To do</option>
          <option value="in_progress">In progress</option>
          <option value="blocked">Blocked</option>
          <option value="done">Done</option>
        </select>
        <select value={filter.assignee} onChange={e => setFilter({ ...filter, assignee: e.target.value })}
          className="px-2 py-1.5 bg-card border border-bdr rounded text-sm text-paper focus:outline-none focus:border-ember">
          <option value="all">Everyone</option>
          <option value="me">My tasks</option>
          <option value="unassigned">Unassigned</option>
        </select>
      </div>

      {showCreate && (
        <div className="px-6 py-3 border-b border-bdr max-h-[70vh] overflow-y-auto">
          <form onSubmit={create} className="space-y-2">
            <div className="flex gap-2">
              <input className={input + ' flex-1'} value={title} onChange={e => setTitle(e.target.value)}
                placeholder="Task title" autoFocus />
              <select className="px-2 py-2 bg-card border border-bdr rounded text-sm text-paper" value={priority} onChange={e => setPriority(e.target.value)}>
                <option value="P0">P0</option><option value="P1">P1</option>
                <option value="P2">P2</option><option value="P3">P3</option>
              </select>
            </div>
            <textarea className={input + ' resize-none'} rows={2} value={newDescription} onChange={e => setNewDescription(e.target.value)}
              placeholder="Description / details (optional)" />
            <div className="flex gap-2">
              <select className={input + ' w-40'} value={assignee} onChange={e => setAssignee(e.target.value)}>
                <option value="">Unassigned</option>
                {members.map(m => <option key={m.id} value={m.id}>{m.display_name || m.email}</option>)}
              </select>
              <input type="date" className={input + ' w-40'} value={dueDate} onChange={e => setDueDate(e.target.value)} />
              <select className={input + ' w-48'} value={projectId} onChange={e => setProjectId(e.target.value)}>
                <option value="">No project</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <button type="submit" className="px-4 py-2 bg-ember text-white text-sm font-semibold rounded shrink-0">Create</button>
              <button type="button" onClick={() => setShowCreate(false)}
                className="px-3 py-2 text-sm text-muted border border-bdr rounded shrink-0">Cancel</button>
            </div>
          </form>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {loading && <div className="px-6 py-8 text-center text-dim text-sm">Loading...</div>}
        {!loading && filtered.map(t => renderTask(t))}
        {!loading && filtered.length === 0 && (
          <div className="px-6 py-8 text-center text-dim text-sm">
            {filter.search || filter.status !== 'open' || filter.assignee !== 'all'
              ? 'No tasks match your filters.' : 'No tasks yet.'}
          </div>
        )}
      </div>
    </div>
  );
}

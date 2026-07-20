import { useEffect, useState, useMemo } from 'react';
import { supabase } from '../../lib/supabase';

// Project templates: design a project once (tasks, sub-tasks, due-date offsets,
// assignment), then stamp it onto jobs — automatically via the automations
// engine (076) when an onboarding job is created / typed, or manually from a
// job's detail screen. Templates + automations are owner-editable (RLS, 005).

const PRIORITY_STYLES = {
  P0: 'bg-red-100 text-red-700 border border-red-200',
  P1: 'bg-orange-100 text-orange-700 border border-orange-200',
  P2: 'bg-blue-100 text-blue-700 border border-blue-200',
  P3: 'bg-slate-100 text-slate-600 border border-slate-200',
};

export default function ProjectTemplates({ profile }) {
  const [templates, setTemplates] = useState([]);
  const [taskTemplates, setTaskTemplates] = useState([]); // all rows, all templates
  const [automations, setAutomations] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const isOwner = profile.role === 'owner';

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    const [t, tt, a] = await Promise.all([
      supabase.from('project_templates').select('*').order('name'),
      supabase.from('task_templates').select('*').order('sort_order'),
      supabase.from('automations').select('*'),
    ]);
    setTemplates(t.data || []);
    setTaskTemplates(tt.data || []);
    setAutomations(a.data || []);
    setLoading(false);
  };

  const selected = templates.find(t => t.id === selectedId) || null;
  const rows = useMemo(() => taskTemplates.filter(t => t.project_template_id === selectedId), [taskTemplates, selectedId]);
  const parents = useMemo(() => rows.filter(r => !r.parent_template_id).sort((a, b) => a.sort_order - b.sort_order), [rows]);
  const childrenOf = (pid) => rows.filter(r => r.parent_template_id === pid).sort((a, b) => a.sort_order - b.sort_order);
  const auto = automations.find(a => a.template_id === selectedId && a.event === 'onboarding_created') || null;

  // Known job types (from every automation) — suggested in the type filter box.
  const knownJobTypes = useMemo(() => {
    const s = new Set();
    automations.forEach(a => { const jt = a.condition?.job_type; if (jt) s.add(jt); });
    return [...s].sort();
  }, [automations]);

  const statsFor = (tplId) => {
    const ts = taskTemplates.filter(t => t.project_template_id === tplId);
    const subs = ts.filter(t => t.parent_template_id).length;
    const span = ts.length ? Math.max(...ts.map(t => t.due_offset_days || 0)) : 0;
    return { tasks: ts.length - subs, subs, span };
  };

  // ── Template CRUD ──────────────────────────────────────────────────────────
  const createTemplate = async () => {
    const { data, error } = await supabase.from('project_templates')
      .insert({ name: 'New template', description: null }).select().single();
    if (error) { alert(error.message); return; }
    setTemplates(prev => [...prev, data]);
    setSelectedId(data.id);
  };

  const patchTemplate = async (patch) => {
    setTemplates(prev => prev.map(t => t.id === selectedId ? { ...t, ...patch } : t));
    await supabase.from('project_templates').update(patch).eq('id', selectedId);
  };

  const duplicateTemplate = async () => {
    if (!selected) return;
    setSaving(true);
    const { data: nt } = await supabase.from('project_templates')
      .insert({ name: `${selected.name} (copy)`, description: selected.description }).select().single();
    if (nt) {
      // Copy parents first so children can point at the new parent ids.
      const idMap = {};
      for (const r of [...parents, ...rows.filter(r => r.parent_template_id)]) {
        const { data: nr } = await supabase.from('task_templates').insert({
          project_template_id: nt.id, title: r.title, description: r.description,
          priority: r.priority, due_offset_days: r.due_offset_days,
          default_assignee_role: r.default_assignee_role, sort_order: r.sort_order,
          parent_template_id: r.parent_template_id ? idMap[r.parent_template_id] || null : null,
        }).select().single();
        if (nr) idMap[r.id] = nr.id;
      }
    }
    setSaving(false);
    await load();
    if (nt) setSelectedId(nt.id);
  };

  const deleteTemplate = async () => {
    if (!selected) return;
    if (!confirm(`Delete template "${selected.name}"? Projects already created from it are kept.`)) return;
    await supabase.from('automations').delete().eq('template_id', selected.id);
    await supabase.from('project_templates').delete().eq('id', selected.id);
    setSelectedId(null);
    load();
  };

  // ── Automation rule ────────────────────────────────────────────────────────
  const setAutoEnabled = async (on) => {
    if (on) {
      const { data } = await supabase.from('automations').insert({
        name: `Auto: ${selected.name}`, event: 'onboarding_created',
        condition: {}, template_id: selected.id, enabled: true,
      }).select().single();
      if (data) setAutomations(prev => [...prev, data]);
    } else if (auto) {
      await supabase.from('automations').delete().eq('id', auto.id);
      setAutomations(prev => prev.filter(a => a.id !== auto.id));
    }
  };

  const setAutoJobType = async (jt) => {
    if (!auto) return;
    const condition = jt.trim() ? { job_type: jt.trim() } : {};
    setAutomations(prev => prev.map(a => a.id === auto.id ? { ...a, condition } : a));
    await supabase.from('automations').update({ condition }).eq('id', auto.id);
  };

  // ── Task rows ──────────────────────────────────────────────────────────────
  const addTask = async (parentId = null) => {
    const siblings = parentId ? childrenOf(parentId) : parents;
    const { data, error } = await supabase.from('task_templates').insert({
      project_template_id: selectedId, title: '', priority: 'P2',
      parent_template_id: parentId, due_offset_days: 0,
      sort_order: (siblings.at(-1)?.sort_order ?? -1) + 1,
    }).select().single();
    if (error) { alert(error.message); return; }
    setTaskTemplates(prev => [...prev, data]);
  };

  const patchTask = async (id, patch) => {
    setTaskTemplates(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t));
    await supabase.from('task_templates').update(patch).eq('id', id);
  };

  const deleteTask = async (row) => {
    const kids = childrenOf(row.id);
    if (kids.length && !confirm(`Delete "${row.title || 'this task'}" and its ${kids.length} sub-task${kids.length > 1 ? 's' : ''}?`)) return;
    await supabase.from('task_templates').delete().eq('id', row.id); // cascades to children
    setTaskTemplates(prev => prev.filter(t => t.id !== row.id && t.parent_template_id !== row.id));
  };

  const moveTask = async (row, dir) => {
    const siblings = row.parent_template_id ? childrenOf(row.parent_template_id) : parents;
    const i = siblings.findIndex(s => s.id === row.id);
    const j = i + dir;
    if (j < 0 || j >= siblings.length) return;
    const other = siblings[j];
    setTaskTemplates(prev => prev.map(t =>
      t.id === row.id ? { ...t, sort_order: other.sort_order }
      : t.id === other.id ? { ...t, sort_order: row.sort_order } : t));
    await Promise.all([
      supabase.from('task_templates').update({ sort_order: other.sort_order }).eq('id', row.id),
      supabase.from('task_templates').update({ sort_order: row.sort_order }).eq('id', other.id),
    ]);
  };

  const input = "w-full px-3 py-2 bg-card border border-bdr rounded text-sm text-paper placeholder-dim focus:outline-none focus:border-ember";
  const smallInput = "px-2 py-1.5 bg-card border border-bdr rounded text-xs text-paper placeholder-dim focus:outline-none focus:border-ember";

  const TaskRow = ({ row, isChild }) => (
    <div className={`glass-inner rounded-xl p-3 ${isChild ? 'ml-8' : ''}`}>
      <div className="flex items-center gap-2">
        <div className="flex flex-col shrink-0">
          <button onClick={() => moveTask(row, -1)} disabled={!isOwner} className="text-[10px] text-dim hover:text-paper leading-none py-0.5" title="Move up">▲</button>
          <button onClick={() => moveTask(row, 1)} disabled={!isOwner} className="text-[10px] text-dim hover:text-paper leading-none py-0.5" title="Move down">▼</button>
        </div>
        <input className={smallInput + ' flex-1'} value={row.title} disabled={!isOwner}
          onChange={e => setTaskTemplates(prev => prev.map(t => t.id === row.id ? { ...t, title: e.target.value } : t))}
          onBlur={e => patchTask(row.id, { title: e.target.value })}
          placeholder={isChild ? 'Sub-task title' : 'Task title'} />
        <select className={smallInput + ' shrink-0 ' + (PRIORITY_STYLES[row.priority] || '')} value={row.priority} disabled={!isOwner}
          onChange={e => patchTask(row.id, { priority: e.target.value })} title="Priority">
          {['P0', 'P1', 'P2', 'P3'].map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <label className="flex items-center gap-1 text-[10px] text-muted shrink-0" title="Due this many days after the job starts">
          +<input type="number" min="0" className={smallInput + ' w-14 text-center'} value={row.due_offset_days ?? 0} disabled={!isOwner}
            onChange={e => setTaskTemplates(prev => prev.map(t => t.id === row.id ? { ...t, due_offset_days: parseInt(e.target.value || '0', 10) } : t))}
            onBlur={e => patchTask(row.id, { due_offset_days: parseInt(e.target.value || '0', 10) })} />d
        </label>
        <label className="flex items-center gap-1 text-[10px] text-muted shrink-0 cursor-pointer" title="Assign to the job's owner when created">
          <input type="checkbox" className="accent-ember" checked={row.default_assignee_role === 'owner'} disabled={!isOwner}
            onChange={e => patchTask(row.id, { default_assignee_role: e.target.checked ? 'owner' : null })} />
          owner
        </label>
        {isOwner && <button onClick={() => deleteTask(row)} className="text-red-500 hover:text-red-600 text-sm shrink-0" title="Delete">×</button>}
      </div>
      <div className="mt-1.5 flex items-start gap-2 pl-6">
        <input className={smallInput + ' flex-1 !text-dim'} value={row.description || ''} disabled={!isOwner}
          onChange={e => setTaskTemplates(prev => prev.map(t => t.id === row.id ? { ...t, description: e.target.value } : t))}
          onBlur={e => patchTask(row.id, { description: e.target.value || null })}
          placeholder="Notes / instructions for whoever does this (optional)" />
        {!isChild && isOwner && (
          <button onClick={() => addTask(row.id)} className="text-[10px] text-ember hover:text-ember-deep font-medium shrink-0 py-1.5">+ Sub-task</button>
        )}
      </div>
    </div>
  );

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-bdr flex items-center justify-between">
        <div>
          <div className="text-lg font-bold text-paper">Project templates</div>
          <div className="text-[10px] text-dim font-mono uppercase tracking-[0.18em]">
            Design once — auto-create on new jobs
          </div>
        </div>
        {isOwner && (
          <button onClick={createTemplate}
            className="px-3 py-1.5 bg-ember text-white text-sm font-semibold rounded hover:bg-ember-deep transition">
            + New template
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* Template list */}
        <div className="w-72 shrink-0 border-r border-bdr overflow-y-auto p-3 space-y-2">
          {loading && <div className="py-8 text-center text-dim text-sm">Loading...</div>}
          {!loading && templates.length === 0 && (
            <div className="py-8 px-2 text-center text-dim text-xs">
              No templates yet.{isOwner ? ' Create one to design your first reusable project.' : ''}
            </div>
          )}
          {templates.map(t => {
            const s = statsFor(t.id);
            const a = automations.find(x => x.template_id === t.id && x.event === 'onboarding_created');
            return (
              <div key={t.id} onClick={() => setSelectedId(t.id)}
                className={`rounded-xl p-3 cursor-pointer border transition ${selectedId === t.id ? 'glass-card border-ember/40' : 'glass-inner border-transparent hover:border-ember/20'}`}>
                <div className="text-sm font-semibold text-paper truncate">{t.name}</div>
                <div className="text-[10px] text-dim mt-0.5">
                  {s.tasks} task{s.tasks === 1 ? '' : 's'}{s.subs ? ` · ${s.subs} sub` : ''}{s.span ? ` · ${s.span}d span` : ''}
                </div>
                {a && (
                  <div className="mt-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold uppercase rounded bg-emerald-100 text-emerald-700 border border-emerald-200">
                    ⚡ Auto{a.condition?.job_type ? `: ${a.condition.job_type}` : ': every job'}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Editor */}
        <div className="flex-1 min-w-0 overflow-y-auto p-6">
          {!selected && (
            <div className="h-full flex items-center justify-center text-center text-dim text-sm px-8">
              <div>
                <div className="text-3xl mb-3">📋</div>
                Select a template on the left{isOwner ? ', or create a new one.' : '.'}<br />
                <span className="text-xs">A template is a reusable project: its tasks and sub-tasks are stamped onto a job automatically (or by hand) with due dates offset from the day the job starts.</span>
              </div>
            </div>
          )}
          {selected && (
            <div className="max-w-3xl space-y-4">
              {/* Name / description */}
              <div className="glass-card rounded-2xl p-4 space-y-2">
                <input className={input + ' !text-base !font-semibold'} value={selected.name} disabled={!isOwner}
                  onChange={e => setTemplates(prev => prev.map(t => t.id === selectedId ? { ...t, name: e.target.value } : t))}
                  onBlur={e => patchTemplate({ name: e.target.value.trim() || 'Untitled template' })}
                  placeholder="Template name (becomes the project name)" />
                <textarea className={input + ' resize-none'} rows={2} value={selected.description || ''} disabled={!isOwner}
                  onChange={e => setTemplates(prev => prev.map(t => t.id === selectedId ? { ...t, description: e.target.value } : t))}
                  onBlur={e => patchTemplate({ description: e.target.value.trim() || null })}
                  placeholder="What is this project for? (becomes the project description)" />
                {isOwner && (
                  <div className="flex gap-2 pt-1">
                    <button onClick={duplicateTemplate} disabled={saving}
                      className="px-3 py-1.5 text-xs text-muted border border-bdr rounded hover:text-paper transition disabled:opacity-50">
                      {saving ? 'Copying…' : 'Duplicate'}
                    </button>
                    <button onClick={deleteTemplate}
                      className="px-3 py-1.5 text-xs text-red-500 border border-red-200 rounded hover:bg-red-50 transition">
                      Delete template
                    </button>
                  </div>
                )}
              </div>

              {/* Auto-create rule */}
              <div className="glass-card rounded-2xl p-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" className="accent-ember" checked={!!auto} disabled={!isOwner}
                    onChange={e => setAutoEnabled(e.target.checked)} />
                  <span className="text-sm font-semibold text-paper">⚡ Auto-create this project when a job is created</span>
                </label>
                {auto && (
                  <div className="mt-3 pl-6 flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-muted">Only for job type</span>
                    <input list="pt-job-types" className={smallInput + ' w-56'} disabled={!isOwner}
                      defaultValue={auto.condition?.job_type || ''} key={auto.id}
                      onBlur={e => setAutoJobType(e.target.value)}
                      placeholder="(blank = every job)" />
                    <datalist id="pt-job-types">
                      {knownJobTypes.map(jt => <option key={jt} value={jt} />)}
                    </datalist>
                    <span className="text-[10px] text-dim w-full pl-0.5">
                      Jobs get a type on their onboarding record. Blank fires for every new job; a type fires when a job is created with (or changed to) that type. The same template is never applied twice to one job.
                    </span>
                  </div>
                )}
              </div>

              {/* Task tree */}
              <div className="glass-card rounded-2xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="text-sm font-bold text-paper">Tasks</div>
                  <div className="text-[10px] text-dim">+Nd = due N days after the job starts · “owner” assigns to the job owner</div>
                </div>
                <div className="space-y-2">
                  {parents.map(p => (
                    <div key={p.id} className="space-y-2">
                      <TaskRow row={p} isChild={false} />
                      {childrenOf(p.id).map(c => <TaskRow key={c.id} row={c} isChild />)}
                    </div>
                  ))}
                  {parents.length === 0 && (
                    <div className="text-xs text-dim italic py-3 text-center">No tasks yet — add the steps this project should always contain.</div>
                  )}
                </div>
                {isOwner && (
                  <button onClick={() => addTask(null)}
                    className="mt-3 px-3 py-1.5 text-xs font-semibold text-ember border border-ember/30 rounded-lg hover:bg-ember/10 transition">
                    + Task
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

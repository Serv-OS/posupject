import { useEffect, useState, useMemo } from 'react';
import { supabase } from '../lib/supabase';

const FEATURE_COLORS = [
  '#E8743C', '#C75A29', '#ef4444', '#3b82f6', '#10b981', '#a855f7', '#ec4899', '#eab308', '#948A7A', '#6B6359',
];

export default function FeaturesPanel({ project, profile }) {
  const [features, setFeatures] = useState([]);
  const [items, setItems]       = useState([]);
  const [adding, setAdding]     = useState(false);
  const [name, setName]         = useState('');
  const [color, setColor]       = useState(FEATURE_COLORS[0]);
  const [desc, setDesc]         = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName]   = useState('');
  const [editColor, setEditColor] = useState('');
  const [editDesc, setEditDesc]   = useState('');
  const [defaultType, setDefaultType] = useState(project.default_item_type || 'task');

  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  useEffect(() => { load(); }, [project.id]);

  const load = async () => {
    // Features are a single shared pool across ALL App Build projects (not per-project),
    // and counts span every project's items so a feature shows all its bugs/tasks anywhere.
    const [f, i] = await Promise.all([
      supabase.from('features').select('*').order('name'),
      supabase.from('backlog_items').select('id, type, feature_id, bucket_id, closed_at'),
    ]);
    setFeatures(f.data || []);
    setItems(i.data || []);
    setDefaultType(project.default_item_type || 'task');
  };

  const stats = useMemo(() => {
    const map = {};
    features.forEach(f => {
      map[f.id] = { total: 0, bugs: 0, open_bugs: 0, features: 0, tasks: 0, chores: 0, closed: 0 };
    });
    items.forEach(i => {
      if (!i.feature_id || !map[i.feature_id]) return;
      const s = map[i.feature_id];
      s.total++;
      if (i.type === 'bug') { s.bugs++; if (!i.closed_at) s.open_bugs++; }
      if (i.type === 'feature') s.features++;
      if (i.type === 'task') s.tasks++;
      if (i.type === 'chore') s.chores++;
      if (i.closed_at) s.closed++;
    });
    return map;
  }, [features, items]);

  const untagged = useMemo(() => items.filter(i => !i.feature_id).length, [items]);

  const create = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    await supabase.from('features').insert({
      project_id: project.id,
      name: name.trim(),
      color,
      description: desc.trim() || null,
    });
    setName(''); setColor(FEATURE_COLORS[0]); setDesc(''); setAdding(false);
    load();
  };

  const startEdit = (f) => {
    setEditingId(f.id);
    setEditName(f.name);
    setEditColor(f.color);
    setEditDesc(f.description || '');
  };

  const saveEdit = async (e) => {
    e?.preventDefault();
    if (!editName.trim()) return;
    await supabase.from('features').update({
      name: editName.trim(),
      color: editColor,
      description: editDesc.trim() || null,
    }).eq('id', editingId);
    setEditingId(null);
    load();
  };

  const deleteFeature = async (f) => {
    const count = stats[f.id]?.total || 0;
    let msg = `Delete feature "${f.name}"?`;
    if (count > 0) msg += `\n\n${count} item${count === 1 ? '' : 's'} tagged with this feature will be untagged (not deleted).`;
    if (!confirm(msg)) return;
    await supabase.from('backlog_items').update({ feature_id: null }).eq('feature_id', f.id);
    await supabase.from('features').delete().eq('id', f.id);
    load();
  };

  const updateDefaultType = async (type) => {
    setDefaultType(type);
    await supabase.from('backlog_projects').update({ default_item_type: type }).eq('id', project.id);
  };

  const input = "w-full px-3 py-2 bg-card border border-bdr rounded text-sm text-paper placeholder-dim focus:outline-none focus:border-ember";
  const label = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block";

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-bdr flex items-center justify-between">
        <div>
          <div className="text-lg font-bold text-paper">Features</div>
          <div className="text-[10px] text-dim font-mono uppercase tracking-[0.18em]">Shared across all App Build projects · {features.length} features · {untagged} items untagged</div>
        </div>
        {canWrite && !adding && (
          <button onClick={() => setAdding(true)}
            className="px-3 py-1.5 bg-ember text-ink text-sm font-semibold rounded hover:bg-ember-deep transition">
            + Add feature
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-4xl space-y-4">

          {canWrite && (
            <div className="bg-card border border-bdr rounded-xl p-4">
              <div className="text-sm font-semibold text-paper mb-3">Project settings</div>
              <div>
                <label className={label}>Default item type for new items</label>
                <select value={defaultType} onChange={e => updateDefaultType(e.target.value)} className={input + ' max-w-xs'}>
                  <option value="feature">Feature</option>
                  <option value="bug">Bug</option>
                  <option value="task">Task</option>
                  <option value="chore">Chore</option>
                </select>
                <div className="text-xs text-dim mt-1">New items in this project will default to this type.</div>
              </div>
            </div>
          )}

          {adding && (
            <form onSubmit={create} className="bg-card border border-ember/30 rounded-xl p-5 space-y-3">
              <div className="text-sm font-semibold text-paper mb-1">New feature</div>
              <div>
                <label className={label}>Name</label>
                <input className={input} value={name} onChange={e => setName(e.target.value)} autoFocus placeholder="e.g. Online Ordering, KDS, Payments"/>
              </div>
              <div>
                <label className={label}>Colour</label>
                <div className="flex flex-wrap gap-1.5">
                  {FEATURE_COLORS.map(c => (
                    <button key={c} type="button" onClick={() => setColor(c)}
                      className={`w-7 h-7 rounded-full transition ${color === c ? 'ring-2 ring-offset-2 ring-offset-card ring-paper' : 'hover:scale-110'}`}
                      style={{ backgroundColor: c }}/>
                  ))}
                </div>
              </div>
              <div>
                <label className={label}>Description (optional)</label>
                <textarea className={input + ' resize-none'} rows={2} value={desc} onChange={e => setDesc(e.target.value)} placeholder="What does this feature cover?"/>
              </div>
              <div className="flex gap-2 pt-1">
                <button type="submit" className="px-4 py-2 bg-ember text-ink rounded text-sm font-semibold hover:bg-ember-deep transition">Create feature</button>
                <button type="button" onClick={() => { setAdding(false); setName(''); setDesc(''); }}
                  className="px-4 py-2 bg-card border border-bdr rounded text-sm text-muted">Cancel</button>
              </div>
            </form>
          )}

          {features.length === 0 && !adding && (
            <div className="text-center py-12 text-dim">
              <div className="text-3xl mb-3 text-ember">&#x25C6;</div>
              <div className="text-sm">No features yet. Add one to start tagging items.</div>
            </div>
          )}

          {features.map(f => {
            const s = stats[f.id] || { total:0, bugs:0, open_bugs:0, features:0, tasks:0, chores:0, closed:0 };
            const isEditing = editingId === f.id;

            if (isEditing) {
              return (
                <form key={f.id} onSubmit={saveEdit} className="bg-card border border-ember/30 rounded-xl p-5 space-y-3">
                  <div className="text-sm font-semibold text-paper mb-1">Edit feature</div>
                  <div>
                    <label className={label}>Name</label>
                    <input className={input} value={editName} onChange={e => setEditName(e.target.value)} autoFocus/>
                  </div>
                  <div>
                    <label className={label}>Colour</label>
                    <div className="flex flex-wrap gap-1.5">
                      {FEATURE_COLORS.map(c => (
                        <button key={c} type="button" onClick={() => setEditColor(c)}
                          className={`w-7 h-7 rounded-full transition ${editColor === c ? 'ring-2 ring-offset-2 ring-offset-card ring-paper' : 'hover:scale-110'}`}
                          style={{ backgroundColor: c }}/>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className={label}>Description</label>
                    <textarea className={input + ' resize-none'} rows={2} value={editDesc} onChange={e => setEditDesc(e.target.value)}/>
                  </div>
                  <div className="flex gap-2 pt-1">
                    <button type="submit" className="px-4 py-2 bg-ember text-ink rounded text-sm font-semibold">Save</button>
                    <button type="button" onClick={() => setEditingId(null)} className="px-4 py-2 bg-card border border-bdr rounded text-sm text-muted">Cancel</button>
                  </div>
                </form>
              );
            }

            return (
              <div key={f.id} className="bg-card border border-bdr rounded-xl overflow-hidden">
                <div className="px-5 py-4 flex items-center gap-3" style={{ borderLeft: `4px solid ${f.color}` }}>
                  <div className="flex-1 min-w-0">
                    <div className="text-base font-semibold text-paper">{f.name}</div>
                    {f.description && <div className="text-xs text-muted mt-0.5">{f.description}</div>}
                  </div>
                  {canWrite && (
                    <div className="flex gap-1.5 shrink-0">
                      <button onClick={() => startEdit(f)} className="px-2 py-1 text-xs text-muted hover:text-paper border border-bdr rounded">Edit</button>
                      <button onClick={() => deleteFeature(f)} className="px-2 py-1 text-xs text-red-600 hover:text-red-600 border border-red-500/30 rounded">Delete</button>
                    </div>
                  )}
                </div>
                <div className="px-5 py-3 border-t border-bdr grid grid-cols-6 gap-3 text-center">
                  <StatCell label="Total" value={s.total}/>
                  <StatCell label="Bugs" value={s.bugs} highlight={s.open_bugs > 0}/>
                  <StatCell label="Open bugs" value={s.open_bugs} highlight={s.open_bugs > 0}/>
                  <StatCell label="Features" value={s.features}/>
                  <StatCell label="Tasks" value={s.tasks}/>
                  <StatCell label="Closed" value={s.closed}/>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function StatCell({ label, value, highlight }) {
  return (
    <div>
      <div className={`text-lg font-bold ${highlight ? 'text-red-600' : 'text-paper'}`}>{value}</div>
      <div className="text-[9px] font-mono uppercase tracking-[0.18em] text-dim">{label}</div>
    </div>
  );
}

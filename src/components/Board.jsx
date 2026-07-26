import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';

const PRIORITY_STYLES = {
  P0: 'bg-red-100 text-red-700 border border-red-200 border-red-500/30',
  P1: 'bg-orange-100 text-orange-700 border border-orange-200 border-orange-500/30',
  P2: 'bg-blue-100 text-blue-700 border border-blue-200 border-blue-500/30',
  P3: 'bg-slate-100 text-slate-600 border border-slate-200 border-slate-500/30',
};
const TYPE_ICON = { feature:'✨', bug:'🐛', task:'📋', chore:'🧹' };

const BUCKET_COLORS = [
  { name:'Muted',  value:'#948A7A' },
  { name:'Ember',  value:'#E8743C' },
  { name:'Deep',   value:'#C75A29' },
  { name:'Dim',    value:'#6B6359' },
  { name:'Red',    value:'#ef4444' },
  { name:'Blue',   value:'#3b82f6' },
  { name:'Green',  value:'#10b981' },
  { name:'Purple', value:'#a855f7' },
];

const PRIORITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };

// Short date for cards ("12 Jul", or "12 Jul 25" once it's a different year).
function shortDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: '2-digit' }) });
}

export default function Board({ project, profile, onOpenItem }) {
  const [buckets, setBuckets] = useState([]);
  const [items, setItems]     = useState([]);
  const [members, setMembers] = useState([]);
  const [features, setFeatures] = useState([]);
  const [filter, setFilter]   = useState({ priority:'all', type:'all', assignee:'all', feature:'all', search:'' });
  const [sort, setSort]       = useState(() => localStorage.getItem('board-sort') || 'manual');
  const [dragItem, setDragItem] = useState(null);
  const [dropHint, setDropHint] = useState(null);   // { itemId, edge } | { bucketId: 'end' }
  const [bucketEditor, setBucketEditor] = useState(null);
  const [creating, setCreating] = useState(null);

  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  useEffect(() => { load(); }, [project.id]);
  useEffect(() => { localStorage.setItem('board-sort', sort); }, [sort]);

  useEffect(() => {
    const ch = supabase.channel('board-' + project.id)
      .on('postgres_changes', { event:'*', schema:'public', table:'backlog_items', filter:`backlog_project_id=eq.${project.id}` }, load)
      .on('postgres_changes', { event:'*', schema:'public', table:'buckets', filter:`backlog_project_id=eq.${project.id}` }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [project.id]);

  const load = async () => {
    const [b, i, m, f] = await Promise.all([
      supabase.from('buckets').select('*').eq('backlog_project_id', project.id).order('position'),
      supabase.from('backlog_items').select('*').eq('backlog_project_id', project.id).order('position'),
      supabase.from('profiles').select('id, email, display_name'),
      supabase.from('features').select('*').order('name'), // shared pool across all App Build projects
    ]);
    setBuckets(b.data || []);
    setItems(i.data || []);
    setMembers(m.data || []);
    setFeatures(f.data || []);
  };

  const filtered = useMemo(() => items.filter(i => {
    if (filter.priority !== 'all' && i.priority !== filter.priority) return false;
    if (filter.type     !== 'all' && i.type     !== filter.type)     return false;
    if (filter.assignee === 'me'  && i.assignee_id !== profile.id)   return false;
    if (filter.assignee === 'unassigned' && i.assignee_id)           return false;
    if (filter.feature  !== 'all' && i.feature_id !== filter.feature) return false;
    if (filter.search && !i.title.toLowerCase().includes(filter.search.toLowerCase())) return false;
    return true;
  }), [items, filter, profile.id]);

  // Card order within each bucket. 'manual' keeps the hand-set position (the
  // drag order); every other mode is a live sort so new work surfaces itself.
  const SORTERS = {
    manual:   (a, b) => (a.position ?? 0) - (b.position ?? 0),
    newest:   (a, b) => new Date(b.created_at) - new Date(a.created_at),
    oldest:   (a, b) => new Date(a.created_at) - new Date(b.created_at),
    updated:  (a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at),
    priority: (a, b) => (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9)
                        || new Date(a.created_at) - new Date(b.created_at),
    title:    (a, b) => (a.title || '').localeCompare(b.title || ''),
  };

  const itemsByBucket = useMemo(() => {
    const map = {};
    buckets.forEach(b => { map[b.id] = []; });
    filtered.forEach(i => { if (map[i.bucket_id]) map[i.bucket_id].push(i); });
    const cmp = SORTERS[sort] || SORTERS.manual;
    Object.values(map).forEach(list => list.sort(cmp));
    return map;
  }, [buckets, filtered, sort]);

  const openCreateModal = (bucketId) => {
    setCreating({
      bucket_id: bucketId,
      title: '',
      description: '',
      type: project.default_item_type || 'task',
      priority: 'P2',
      assignee_id: '',
      labels: '',
      feature_id: '',
      github_ref: '',
      version_seen: '',
      version_fixed: '',
      images: [],
    });
  };

  const submitCreate = async (draft) => {
    if (!draft.title.trim()) return;
    const pos = (itemsByBucket[draft.bucket_id]?.length || 0);
    const { data: item } = await supabase.from('backlog_items').insert({
      backlog_project_id: project.id,
      bucket_id: draft.bucket_id,
      title: draft.title.trim(),
      description: draft.description || null,
      type: draft.type,
      priority: draft.priority,
      assignee_id: draft.assignee_id || null,
      labels: draft.labels ? draft.labels.split(',').map(s => s.trim()).filter(Boolean) : [],
      feature_id: draft.feature_id || null,
      github_ref: draft.github_ref || null,
      version_seen: draft.version_seen || null,
      version_fixed: draft.version_fixed || null,
      images: draft.images || [],
      position: pos,
      created_by: profile.id,
    }).select().single();
    if (item) {
      await supabase.from('activity').insert({
        item_id: item.id, backlog_project_id: project.id, actor_id: profile.id, action: 'created',
        detail: { title: item.title },
      });
    }
    setCreating(null);
    load();
  };

  const saveBucket = async (data) => {
    if (bucketEditor.mode === 'new') {
      const pos = buckets.length;
      await supabase.from('buckets').insert({
        backlog_project_id: project.id,
        name: data.name.trim(),
        color: data.color,
        is_done: data.is_done,
        position: pos,
      });
    } else {
      await supabase.from('buckets').update({
        name: data.name.trim(),
        color: data.color,
        is_done: data.is_done,
      }).eq('id', bucketEditor.bucket.id);
    }
    setBucketEditor(null);
    load();
  };

  const deleteBucket = async (bucket) => {
    const itemCount = itemsByBucket[bucket.id]?.length || 0;
    let msg = `Delete bucket "${bucket.name}"?`;
    if (itemCount > 0) {
      msg += `\n\nThis bucket contains ${itemCount} item${itemCount === 1 ? '' : 's'}. Those items will be moved to the first bucket instead of deleted.`;
    }
    if (!confirm(msg)) return;

    if (itemCount > 0) {
      const fallback = buckets.find(b => b.id !== bucket.id);
      if (fallback) {
        await supabase.from('backlog_items').update({ bucket_id: fallback.id }).eq('bucket_id', bucket.id);
      } else {
        alert('Cannot delete the only bucket. Create another bucket first.');
        return;
      }
    }
    await supabase.from('buckets').delete().eq('id', bucket.id);
    load();
  };

  const moveBucket = async (bucket, delta) => {
    const idx = buckets.findIndex(b => b.id === bucket.id);
    const newIdx = idx + delta;
    if (newIdx < 0 || newIdx >= buckets.length) return;
    const other = buckets[newIdx];
    await Promise.all([
      supabase.from('buckets').update({ position: other.position }).eq('id', bucket.id),
      supabase.from('buckets').update({ position: bucket.position }).eq('id', other.id),
    ]);
    load();
  };

  const onDragStart = (e, item) => {
    setDragItem(item);
    e.dataTransfer.effectAllowed = 'move';
  };
  const onDragOver = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; };
  const onDragEnd = () => { setDragItem(null); setDropHint(null); };

  // Hovering a card shows where the drop will land (above or below it).
  const onCardDragOver = (e, item) => {
    e.preventDefault(); e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (!dragItem || dragItem.id === item.id) return;
    const r = e.currentTarget.getBoundingClientRect();
    setDropHint({ itemId: item.id, edge: e.clientY < r.top + r.height / 2 ? 'top' : 'bottom' });
  };

  // Write the new running order for a bucket, then move/insert the dragged card.
  // Positions are rewritten 0..n so the manual order is stable and persists.
  const commitOrder = async (bucketId, orderedIds, movedAcross) => {
    const bucket = buckets.find(b => b.id === bucketId);
    if (movedAcross) {
      await supabase.from('backlog_items').update({
        bucket_id: bucketId,
        closed_at: bucket?.is_done ? new Date().toISOString() : null,
      }).eq('id', dragItem.id);
      await supabase.from('activity').insert({
        item_id: dragItem.id, backlog_project_id: project.id, actor_id: profile.id, action: 'moved',
        detail: { from: dragItem.bucket_id, to: bucketId, bucket_name: bucket?.name },
      });
    }
    await Promise.all(orderedIds.map((id, idx) =>
      supabase.from('backlog_items').update({ position: idx }).eq('id', id)));
    setDragItem(null); setDropHint(null);
    load();
  };

  // Every card in a bucket, in display order — the basis for renumbering.
  // Uses unfiltered items so a card hidden by a filter keeps its place.
  const bucketOrder = (bucketId) => items
    .filter(i => i.bucket_id === bucketId)
    .sort(SORTERS[sort] || SORTERS.manual);

  // Drop onto a card: insert the dragged card immediately above or below it.
  const onDropOnCard = async (e, target) => {
    e.preventDefault(); e.stopPropagation();
    const hint = dropHint;
    setDropHint(null);
    if (!dragItem || dragItem.id === target.id) { setDragItem(null); return; }
    const bucketId = target.bucket_id;
    const movedAcross = dragItem.bucket_id !== bucketId;
    const list = bucketOrder(bucketId).filter(i => i.id !== dragItem.id);
    let idx = list.findIndex(i => i.id === target.id);
    if (idx < 0) idx = list.length;
    if (hint?.itemId === target.id && hint.edge === 'bottom') idx += 1;
    list.splice(idx, 0, dragItem);
    // A hand-made order only shows in manual mode, so honour the intent.
    if (sort !== 'manual') setSort('manual');
    setItems(prev => prev.map(i => i.id === dragItem.id ? { ...i, bucket_id: bucketId } : i));
    await commitOrder(bucketId, list.map(i => i.id), movedAcross);
  };

  // Drop on empty space in a column: send the card to the bottom of it.
  const onDrop = async (e, bucketId) => {
    e.preventDefault();
    setDropHint(null);
    if (!dragItem) return;
    const movedAcross = dragItem.bucket_id !== bucketId;
    const list = bucketOrder(bucketId).filter(i => i.id !== dragItem.id);
    list.push(dragItem);
    if (sort !== 'manual') setSort('manual');
    if (movedAcross) setItems(prev => prev.map(i => i.id === dragItem.id ? { ...i, bucket_id: bucketId } : i));
    await commitOrder(bucketId, list.map(i => i.id), movedAcross);
  };

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-bdr flex items-center gap-3">
        <div className="text-2xl">{project.icon}</div>
        <div className="flex-1 min-w-0">
          <div className="text-lg font-bold text-paper truncate">{project.name}</div>
          <div className="text-[10px] text-dim font-mono uppercase tracking-[0.18em]">{items.length} items · {buckets.length} buckets</div>
        </div>
      </div>

      <div className="px-6 py-3 border-b border-bdr flex items-center gap-2 flex-wrap">
        <input value={filter.search} onChange={e => setFilter({ ...filter, search: e.target.value })}
          placeholder="Search items…"
          className="px-3 py-1.5 bg-card border border-bdr rounded text-sm text-paper placeholder-dim focus:outline-none focus:border-ember w-48"/>
        <Select value={filter.priority} onChange={v => setFilter({ ...filter, priority: v })}
          options={[['all','All priorities'],['P0','P0'],['P1','P1'],['P2','P2'],['P3','P3']]}/>
        <Select value={filter.type} onChange={v => setFilter({ ...filter, type: v })}
          options={[['all','All types'],['feature','Features'],['bug','Bugs'],['task','Tasks'],['chore','Chores']]}/>
        <Select value={filter.assignee} onChange={v => setFilter({ ...filter, assignee: v })}
          options={[['all','Everyone'],['me','Mine only'],['unassigned','Unassigned']]}/>
        {features.length > 0 && (
          <Select value={filter.feature} onChange={v => setFilter({ ...filter, feature: v })}
            options={[['all','All features'], ...features.map(f => [f.id, f.name])]}/>
        )}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-dim">Sort</span>
          <Select value={sort} onChange={setSort}
            options={[['manual','Manual (drag order)'],['newest','Newest first'],['oldest','Oldest first'],['updated','Recently updated'],['priority','Priority (P0 first)'],['title','A → Z']]}/>
        </div>
        {(filter.priority!=='all' || filter.type!=='all' || filter.assignee!=='all' || filter.feature!=='all' || filter.search) && (
          <button onClick={() => setFilter({ priority:'all', type:'all', assignee:'all', feature:'all', search:'' })}
            className="px-2 py-1.5 text-xs text-muted hover:text-paper">clear</button>
        )}
      </div>

      <div className="flex-1 overflow-x-auto overflow-y-hidden">
        <div className="h-full flex gap-3 px-6 py-4 min-w-max">
          {buckets.map((b, i) => (
            <BucketColumn
              key={b.id}
              bucket={b}
              items={itemsByBucket[b.id] || []}
              members={members}
              features={features}
              canWrite={canWrite}
              sort={sort}
              onAddItem={() => openCreateModal(b.id)}
              onEdit={() => setBucketEditor({ mode:'edit', bucket: b })}
              onDelete={() => deleteBucket(b)}
              onMoveLeft={i > 0 ? () => moveBucket(b, -1) : null}
              onMoveRight={i < buckets.length - 1 ? () => moveBucket(b, 1) : null}
              canDelete={buckets.length > 1}
              onDragStart={onDragStart}
              onDragOver={onDragOver}
              onDrop={onDrop}
              onDragEnd={onDragEnd}
              onCardDragOver={onCardDragOver}
              onDropOnCard={onDropOnCard}
              dropHint={dropHint}
              dragItemId={dragItem?.id}
              onOpenItem={onOpenItem}
            />
          ))}

          {canWrite && (
            <button onClick={() => setBucketEditor({ mode:'new' })}
              className="w-72 shrink-0 self-start mt-0 h-12 flex items-center justify-center gap-2 bg-card/30 hover:bg-card/60 border-2 border-dashed border-bdr hover:border-dim rounded-xl text-sm text-muted hover:text-paper transition">
              <span className="text-base">+</span> Add bucket
            </button>
          )}
        </div>
      </div>

      {bucketEditor && (
        <BucketEditorModal
          mode={bucketEditor.mode}
          bucket={bucketEditor.bucket}
          onSave={saveBucket}
          onClose={() => setBucketEditor(null)}
        />
      )}

      {creating && (
        <CreateItemModal
          draft={creating}
          buckets={buckets}
          members={members}
          features={features}
          project={project}
          profile={profile}
          onSave={submitCreate}
          onClose={() => setCreating(null)}
        />
      )}
    </div>
  );
}

function BucketColumn({ bucket, items, members, features, canWrite, sort, onAddItem, onEdit, onDelete, onMoveLeft, onMoveRight, canDelete, onDragStart, onDragOver, onDrop, onDragEnd, onCardDragOver, onDropOnCard, dropHint, dragItemId, onOpenItem }) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="w-72 shrink-0 flex flex-col glass-card rounded-2xl overflow-hidden"
      onDragOver={onDragOver} onDrop={e => onDrop(e, bucket.id)}
      onClick={() => setMenuOpen(false)}>
      <div className="px-3 py-2.5 border-b border-bdr flex items-center gap-2 relative" style={{ borderLeft: `3px solid ${bucket.color}` }}>
        <div className="text-xs font-bold uppercase tracking-wide text-paper">{bucket.name}</div>
        {bucket.is_done && <span className="text-[9px] px-1 py-0.5 bg-emerald-100 text-emerald-700 rounded font-mono">DONE</span>}
        <div className="text-xs text-dim">{items.length}</div>
        {canWrite && (
          <>
            <button onClick={onAddItem} className="ml-auto text-muted hover:text-paper text-sm" title="Add item">+</button>
            <button onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); }}
              className="text-muted hover:text-paper text-sm px-1" title="Bucket options">&#x22EF;</button>
          </>
        )}
        {menuOpen && (
          <div className="absolute right-1 top-full mt-0.5 z-10 w-40 bg-card border border-bdr rounded-lg shadow-lg overflow-hidden"
            onClick={e => e.stopPropagation()}>
            <button onClick={() => { onEdit(); setMenuOpen(false); }}
              className="w-full px-3 py-2 text-left text-xs text-paper hover:bg-ink-soft flex items-center gap-2">
              Edit bucket
            </button>
            {onMoveLeft && (
              <button onClick={() => { onMoveLeft(); setMenuOpen(false); }}
                className="w-full px-3 py-2 text-left text-xs text-paper hover:bg-ink-soft flex items-center gap-2 border-t border-bdr">
                &#x2190; Move left
              </button>
            )}
            {onMoveRight && (
              <button onClick={() => { onMoveRight(); setMenuOpen(false); }}
                className="w-full px-3 py-2 text-left text-xs text-paper hover:bg-ink-soft flex items-center gap-2 border-t border-bdr">
                &#x2192; Move right
              </button>
            )}
            {canDelete && (
              <button onClick={() => { onDelete(); setMenuOpen(false); }}
                className="w-full px-3 py-2 text-left text-xs text-red-600 hover:bg-red-500/10 flex items-center gap-2 border-t border-bdr">
                Delete
              </button>
            )}
          </div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {items.map(i => (
          <Card key={i.id} item={i} members={members} features={features} sort={sort}
            onClick={() => onOpenItem(i.id)}
            onDragStart={e => onDragStart(e, i)}
            onDragOver={e => onCardDragOver(e, i)}
            onDrop={e => onDropOnCard(e, i)}
            onDragEnd={onDragEnd}
            hint={dropHint?.itemId === i.id ? dropHint.edge : null}
            dragging={dragItemId === i.id}
            draggable={canWrite}/>
        ))}
        {!items.length && (
          <div className="text-xs text-dim italic px-2 py-4 text-center">Empty</div>
        )}
      </div>
    </div>
  );
}

function BucketEditorModal({ mode, bucket, onSave, onClose }) {
  const [name, setName]       = useState(bucket?.name || '');
  const [color, setColor]     = useState(bucket?.color || BUCKET_COLORS[0].value);
  const [isDone, setIsDone]   = useState(bucket?.is_done || false);

  const submit = (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    onSave({ name, color, is_done: isDone });
  };

  return (
    <div className="fixed inset-0 bg-black/20 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <form onSubmit={submit} onClick={e => e.stopPropagation()}
        className="w-96 glass-raised rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-bdr">
          <div className="text-base font-bold text-paper">{mode === 'new' ? 'New bucket' : 'Edit bucket'}</div>
        </div>
        <div className="px-5 py-4 space-y-4">
          <div>
            <label className="block text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1.5">Name</label>
            <input value={name} onChange={e => setName(e.target.value)} autoFocus
              placeholder="e.g. Ready to test"
              className="w-full px-3 py-2 bg-card border border-bdr rounded text-sm text-paper placeholder-dim focus:outline-none focus:border-ember"/>
          </div>
          <div>
            <label className="block text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1.5">Colour</label>
            <div className="flex flex-wrap gap-1.5">
              {BUCKET_COLORS.map(c => (
                <button key={c.value} type="button" onClick={() => setColor(c.value)}
                  className={`w-8 h-8 rounded transition ${color === c.value ? 'ring-2 ring-offset-2 ring-offset-ink-soft ring-paper' : 'hover:scale-110'}`}
                  style={{ backgroundColor: c.value }}
                  title={c.name}/>
              ))}
            </div>
          </div>
          <div>
            <label className="flex items-start gap-2 cursor-pointer">
              <input type="checkbox" checked={isDone} onChange={e => setIsDone(e.target.checked)}
                className="mt-0.5 accent-ember"/>
              <div className="flex-1">
                <div className="text-sm text-paper">Items in this bucket are considered done</div>
                <div className="text-xs text-dim">Moving an item here closes it (sets closed_at).</div>
              </div>
            </label>
          </div>
        </div>
        <div className="px-5 py-3 border-t border-bdr flex justify-end gap-2">
          <button type="button" onClick={onClose}
            className="px-3 py-1.5 text-sm text-muted hover:text-paper border border-bdr rounded">Cancel</button>
          <button type="submit"
            className="px-4 py-1.5 bg-ember text-ink text-sm font-semibold rounded hover:bg-ember-deep transition">
            {mode === 'new' ? 'Create bucket' : 'Save changes'}
          </button>
        </div>
      </form>
    </div>
  );
}

function CreateItemModal({ draft: initial, buckets, members, features, project, profile, onSave, onClose }) {
  const [draft, setDraft] = useState(initial);
  const [uploading, setUploading] = useState(false);
  const set = (k, v) => setDraft({ ...draft, [k]: v });
  const input = "w-full px-3 py-2 bg-card border border-bdr rounded text-sm text-paper placeholder-dim focus:outline-none focus:border-ember";
  const label = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block";

  const handleImageUpload = async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    setUploading(true);
    const urls = [...(draft.images || [])];
    for (const file of files) {
      const ext = file.name.split('.').pop();
      const path = `items/${crypto.randomUUID()}.${ext}`;
      const { error } = await supabase.storage.from('item-images').upload(path, file);
      if (!error) {
        const { data } = supabase.storage.from('item-images').getPublicUrl(path);
        urls.push(data.publicUrl);
      }
    }
    set('images', urls);
    setUploading(false);
  };

  const removeImage = (idx) => {
    set('images', draft.images.filter((_, i) => i !== idx));
  };

  return (
    <div className="fixed inset-0 bg-black/20 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <div className="w-[640px] max-w-[90vw] max-h-[85vh] glass-raised rounded-2xl overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-bdr flex items-center justify-between">
          <div className="text-base font-bold text-paper">New item</div>
          <button onClick={onClose} className="text-muted hover:text-paper text-lg px-2">&#x00D7;</button>
        </div>
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          <div>
            <label className={label}>Title</label>
            <input className={input} value={draft.title} onChange={e => set('title', e.target.value)} autoFocus placeholder="What needs to be done?"/>
          </div>
          <div>
            <label className={label}>Description (markdown)</label>
            <textarea className={input + ' resize-none font-mono'} rows={5} value={draft.description} onChange={e => set('description', e.target.value)}
              placeholder="Steps to reproduce, expected behaviour, context…"/>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>Bucket</label>
              <select className={input} value={draft.bucket_id} onChange={e => set('bucket_id', e.target.value)}>
                {buckets.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div>
              <label className={label}>Type</label>
              <select className={input} value={draft.type} onChange={e => set('type', e.target.value)}>
                <option value="feature">Feature</option>
                <option value="bug">Bug</option>
                <option value="task">Task</option>
                <option value="chore">Chore</option>
              </select>
            </div>
            <div>
              <label className={label}>Priority</label>
              <select className={input} value={draft.priority} onChange={e => set('priority', e.target.value)}>
                <option value="P0">P0 — critical</option>
                <option value="P1">P1 — high</option>
                <option value="P2">P2 — normal</option>
                <option value="P3">P3 — low</option>
              </select>
            </div>
            <div>
              <label className={label}>Assignee</label>
              <select className={input} value={draft.assignee_id} onChange={e => set('assignee_id', e.target.value)}>
                <option value="">Unassigned</option>
                {members.map(m => <option key={m.id} value={m.id}>{m.display_name || m.email}</option>)}
              </select>
            </div>
            {features.length > 0 && (
              <div>
                <label className={label}>Feature</label>
                <select className={input} value={draft.feature_id} onChange={e => set('feature_id', e.target.value)}>
                  <option value="">No feature</option>
                  {features.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </div>
            )}
            <div>
              <label className={label}>Version seen</label>
              <input className={input} value={draft.version_seen} onChange={e => set('version_seen', e.target.value)} placeholder="e.g. 4.6.25"/>
            </div>
          </div>
          <div>
            <label className={label}>Labels (comma-separated)</label>
            <input className={input} value={draft.labels} onChange={e => set('labels', e.target.value)} placeholder="bug, kds, printing"/>
          </div>
          <div>
            <label className={label}>Github ref</label>
            <input className={input} value={draft.github_ref} onChange={e => set('github_ref', e.target.value)} placeholder="pwar2804aio/possystem#123 or @sha"/>
          </div>
          <div>
            <label className={label}>Images</label>
            <label className={`inline-flex items-center gap-2 px-3 py-2 bg-card border border-bdr rounded text-sm text-muted hover:text-paper hover:border-ember cursor-pointer transition ${uploading ? 'opacity-50 pointer-events-none' : ''}`}>
              {uploading ? 'Uploading…' : 'Upload images'}
              <input type="file" accept="image/*" multiple onChange={handleImageUpload} className="hidden"/>
            </label>
            {draft.images?.length > 0 && (
              <div className="flex gap-2 mt-2 flex-wrap">
                {draft.images.map((url, idx) => (
                  <div key={idx} className="relative group w-20 h-20 rounded overflow-hidden border border-bdr">
                    <img src={url} className="w-full h-full object-cover"/>
                    <button onClick={() => removeImage(idx)}
                      className="absolute top-0.5 right-0.5 w-5 h-5 bg-black/70 text-white text-xs rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100">&#x00D7;</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="px-6 py-4 border-t border-bdr flex justify-end gap-2">
          <button onClick={onClose}
            className="px-4 py-2 text-sm text-muted hover:text-paper border border-bdr rounded">Cancel</button>
          <button onClick={() => onSave(draft)} disabled={!draft.title.trim()}
            className="px-5 py-2 bg-ember text-ink text-sm font-semibold rounded hover:bg-ember-deep transition disabled:opacity-50">
            Create item
          </button>
        </div>
      </div>
    </div>
  );
}

function Card({ item, members, features, onClick, onDragStart, onDragOver, onDrop, onDragEnd, draggable, sort, hint, dragging }) {
  const assignee = members.find(m => m.id === item.assignee_id);
  const feature = features.find(f => f.id === item.feature_id);
  return (
    <div draggable={draggable} onDragStart={onDragStart} onDragOver={onDragOver} onDrop={onDrop} onDragEnd={onDragEnd} onClick={onClick}
      className={`glass-inner rounded-xl p-3 cursor-pointer transition-shadow ${dragging ? 'opacity-40' : ''} ${
        hint === 'top' ? 'shadow-[inset_0_3px_0_0_var(--acc,#f97316)]'
        : hint === 'bottom' ? 'shadow-[inset_0_-3px_0_0_var(--acc,#f97316)]' : ''}`}>
      <div className="flex items-start gap-2 mb-2">
        <span className="text-sm">{TYPE_ICON[item.type] || TYPE_ICON.task}</span>
        <div className="text-sm text-paper flex-1 min-w-0 leading-snug">{item.title}</div>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`px-1.5 py-0.5 text-[9px] font-bold rounded border ${PRIORITY_STYLES[item.priority]}`}>{item.priority}</span>
        {feature && (
          <span className="px-1.5 py-0.5 text-[9px] rounded border font-mono"
            style={{ borderColor: feature.color + '50', color: feature.color, backgroundColor: feature.color + '15' }}>
            {feature.name}
          </span>
        )}
        {(item.labels || []).slice(0,2).map(l => (
          <span key={l} className="px-1.5 py-0.5 text-[9px] bg-card border border-bdr rounded text-muted">{l}</span>
        ))}
        {item.images?.length > 0 && (
          <span className="text-[9px] text-dim">&#x1F4CE; {item.images.length}</span>
        )}
        <span className="text-[9px] text-dim font-mono" title={sort === 'updated'
          ? `Updated ${new Date(item.updated_at || item.created_at).toLocaleString()}`
          : `Added ${new Date(item.created_at).toLocaleString()}`}>
          {sort === 'updated' ? '\u{21BB} ' : ''}{shortDate(sort === 'updated' ? (item.updated_at || item.created_at) : item.created_at)}
        </span>
        {assignee && (
          <span className="ml-auto w-5 h-5 rounded-full bg-ember text-ink text-[10px] font-bold flex items-center justify-center" title={assignee.display_name || assignee.email}>
            {(assignee.display_name || assignee.email)[0].toUpperCase()}
          </span>
        )}
      </div>
    </div>
  );
}

function Select({ value, onChange, options }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      className="px-2 py-1.5 bg-card border border-bdr rounded text-sm text-paper focus:outline-none focus:border-ember">
      {options.map(([v,l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}

import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { supabase } from '../lib/supabase';

import { PRIORITY_LABEL, priorityLabel } from '../lib/priority';
export default function ItemDetail({ itemId, profile, onClose }) {
  const [item, setItem]       = useState(null);
  const [buckets, setBuckets] = useState([]);
  const [members, setMembers] = useState([]);
  const [features, setFeatures] = useState([]);
  const [comments, setComments] = useState([]);
  const [activity, setActivity] = useState([]);
  const [editing, setEditing]   = useState(false);
  const [draft, setDraft]       = useState({});
  const [newComment, setNewComment] = useState('');
  const [uploading, setUploading] = useState(false);

  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  useEffect(() => { load(); }, [itemId]);

  const load = async () => {
    const { data: i } = await supabase.from('backlog_items').select('*').eq('id', itemId).single();
    setItem(i);
    if (i) {
      const [b, m, f, c, a] = await Promise.all([
        supabase.from('buckets').select('*').eq('backlog_project_id', i.backlog_project_id).order('position'),
        supabase.from('profiles').select('id, email, display_name'),
        supabase.from('features').select('*').order('name'), // shared pool across all App Build projects
        supabase.from('comments').select('*').eq('item_id', itemId).order('created_at'),
        supabase.from('activity').select('*').eq('item_id', itemId).order('created_at', { ascending: false }),
      ]);
      setBuckets(b.data || []);
      setMembers(m.data || []);
      setFeatures(f.data || []);
      setComments(c.data || []);
      setActivity(a.data || []);
    }
  };

  const startEdit = () => {
    setDraft({
      title: item.title,
      description: item.description || '',
      type: item.type,
      priority: item.priority,
      bucket_id: item.bucket_id,
      assignee_id: item.assignee_id || '',
      labels: (item.labels || []).join(', '),
      feature_id: item.feature_id || '',
      github_ref: item.github_ref || '',
      version_seen: item.version_seen || '',
      version_fixed: item.version_fixed || '',
      images: item.images || [],
    });
    setEditing(true);
  };

  const save = async () => {
    const patch = {
      title: draft.title,
      description: draft.description,
      type: draft.type,
      priority: draft.priority,
      bucket_id: draft.bucket_id,
      assignee_id: draft.assignee_id || null,
      labels: draft.labels.split(',').map(s => s.trim()).filter(Boolean),
      feature_id: draft.feature_id || null,
      github_ref: draft.github_ref || null,
      version_seen: draft.version_seen || null,
      version_fixed: draft.version_fixed || null,
      images: draft.images || [],
    };
    const bucketChanged = patch.bucket_id !== item.bucket_id;
    const newBucket = buckets.find(b => b.id === patch.bucket_id);
    if (bucketChanged && newBucket?.is_done) patch.closed_at = new Date().toISOString();
    if (bucketChanged && !newBucket?.is_done) patch.closed_at = null;

    await supabase.from('backlog_items').update(patch).eq('id', itemId);
    await supabase.from('activity').insert({
      item_id: itemId, backlog_project_id: item.backlog_project_id, actor_id: profile.id,
      action: bucketChanged ? 'moved' : 'edited', detail: { fields: Object.keys(patch) },
    });
    setEditing(false);
    load();
  };

  const del = async () => {
    if (!confirm('Delete this item? This cannot be undone.')) return;
    await supabase.from('backlog_items').delete().eq('id', itemId);
    onClose();
  };

  const addComment = async () => {
    if (!newComment.trim()) return;
    await supabase.from('comments').insert({
      item_id: itemId, author_id: profile.id, body: newComment.trim(),
    });
    await supabase.from('activity').insert({
      item_id: itemId, backlog_project_id: item.backlog_project_id, actor_id: profile.id, action: 'commented',
    });
    setNewComment('');
    load();
  };

  if (!item) return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center" onClick={onClose}>
      <div className="text-muted text-sm">Loading…</div>
    </div>
  );

  const currentBucket = buckets.find(b => b.id === item.bucket_id);
  const assignee = members.find(m => m.id === item.assignee_id);
  const feature = features.find(f => f.id === item.feature_id);

  return (
    <div className="fixed inset-0 z-50 bg-black/15 backdrop-blur-sm flex justify-end" onClick={onClose}>
      <div className="w-[640px] max-w-full h-full glass border-l border-bdr flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-bdr flex items-center gap-3">
          <div className="text-xs text-dim font-mono">#{item.id.slice(0,8)}</div>
          <div className="flex-1"/>
          {canWrite && !editing && (
            <button onClick={startEdit} className="px-3 py-1.5 bg-card border border-bdr rounded text-xs text-muted hover:text-paper">Edit</button>
          )}
          {canWrite && (
            <button onClick={del} className="px-3 py-1.5 bg-card border border-red-200 rounded text-xs text-red-600 hover:bg-red-50">Delete</button>
          )}
          <button onClick={onClose} className="text-muted hover:text-paper text-lg px-2">&#x00D7;</button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {editing ? (
            <EditForm draft={draft} setDraft={setDraft} buckets={buckets} members={members} features={features} uploading={uploading} setUploading={setUploading} onSave={save} onCancel={() => setEditing(false)}/>
          ) : (
            <>
              <div>
                <h1 className="text-xl font-bold text-paper mb-3">{item.title}</h1>
                <div className="flex items-center gap-2 flex-wrap text-xs">
                  <Pill>{currentBucket?.name || '—'}</Pill>
                  <Pill>{item.type}</Pill>
                  <Pill>{priorityLabel(item.priority)}</Pill>
                  {assignee && <Pill>&#x1F464; {assignee.display_name || assignee.email}</Pill>}
                  {feature && <Pill style={{ borderColor: feature.color + '50', color: feature.color }}>&#x25C6; {feature.name}</Pill>}
                  {item.version_seen && <Pill>Seen {item.version_seen}</Pill>}
                  {item.version_fixed && <Pill>Fixed {item.version_fixed}</Pill>}
                  {item.github_ref && <Pill>&#x1F517; {item.github_ref}</Pill>}
                </div>
                {(item.labels||[]).length > 0 && (
                  <div className="mt-2 flex gap-1 flex-wrap">
                    {item.labels.map(l => (
                      <span key={l} className="px-1.5 py-0.5 text-[10px] bg-card border border-bdr rounded text-muted">{l}</span>
                    ))}
                  </div>
                )}
              </div>

              {item.images?.length > 0 && (
                <div>
                  <div className="text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-2">Images ({item.images.length})</div>
                  <div className="flex gap-2 flex-wrap">
                    {item.images.map((url, idx) => (
                      <a key={idx} href={url} target="_blank" rel="noopener noreferrer"
                        className="w-32 h-24 rounded-lg overflow-hidden border border-bdr hover:border-ember transition block">
                        <img src={url} className="w-full h-full object-cover"/>
                      </a>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <div className="text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-2">Description</div>
                <div className="text-sm text-paper prose-tight">
                  {item.description ? (
                    <ReactMarkdown>{item.description}</ReactMarkdown>
                  ) : (
                    <div className="text-dim italic">No description yet.</div>
                  )}
                </div>
              </div>

              <div>
                <div className="text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-2">Comments ({comments.length})</div>
                <div className="space-y-3">
                  {comments.map(c => {
                    const a = members.find(m => m.id === c.author_id);
                    return (
                      <div key={c.id} className="bg-card rounded-lg p-3">
                        <div className="flex items-center gap-2 mb-1.5">
                          <div className="w-5 h-5 rounded-full bg-ember text-ink text-[10px] font-bold flex items-center justify-center">
                            {(a?.display_name || a?.email || '?')[0].toUpperCase()}
                          </div>
                          <div className="text-xs text-paper">{a?.display_name || a?.email || 'Unknown'}</div>
                          <div className="text-xs text-dim">&#xB7; {timeAgo(c.created_at)}</div>
                        </div>
                        <div className="text-sm text-paper prose-tight pl-7">
                          <ReactMarkdown>{c.body}</ReactMarkdown>
                        </div>
                      </div>
                    );
                  })}
                  {canWrite && (
                    <div className="space-y-2">
                      <textarea value={newComment} onChange={e => setNewComment(e.target.value)}
                        rows={3} placeholder="Leave a comment… markdown supported"
                        className="w-full px-3 py-2 bg-card border border-bdr rounded text-sm text-paper placeholder-dim focus:outline-none focus:border-ember resize-none"/>
                      <button onClick={addComment} disabled={!newComment.trim()}
                        className="px-3 py-1.5 bg-ember text-ink rounded text-xs font-semibold disabled:opacity-50">Post</button>
                    </div>
                  )}
                </div>
              </div>

              <div>
                <div className="text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-2">Activity</div>
                <div className="space-y-1.5">
                  {activity.map(a => {
                    const who = members.find(m => m.id === a.actor_id);
                    return (
                      <div key={a.id} className="text-xs text-muted flex gap-2">
                        <span className="text-paper">{who?.display_name || who?.email || '?'}</span>
                        <span>{a.action}{a.detail?.bucket_name ? ` → ${a.detail.bucket_name}` : ''}</span>
                        <span className="text-dim ml-auto">{timeAgo(a.created_at)}</span>
                      </div>
                    );
                  })}
                  {activity.length === 0 && <div className="text-xs text-dim italic">No activity yet.</div>}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Pill({ children, style }) {
  return <span className="px-2 py-0.5 bg-card border border-bdr rounded text-muted text-[10px]" style={style}>{children}</span>;
}

function timeAgo(ts) {
  const d = (Date.now() - new Date(ts).getTime()) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return Math.floor(d/60) + 'm ago';
  if (d < 86400) return Math.floor(d/3600) + 'h ago';
  return Math.floor(d/86400) + 'd ago';
}

function EditForm({ draft, setDraft, buckets, members, features, uploading, setUploading, onSave, onCancel }) {
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
    <div className="space-y-4">
      <div>
        <label className={label}>Title</label>
        <input className={input} value={draft.title} onChange={e => set('title', e.target.value)}/>
      </div>
      <div>
        <label className={label}>Description (markdown)</label>
        <textarea className={input + ' resize-none font-mono'} rows={8} value={draft.description} onChange={e => set('description', e.target.value)}/>
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
            <option value="P0">{PRIORITY_LABEL.P0}</option>
            <option value="P1">{PRIORITY_LABEL.P1}</option>
            <option value="P2">{PRIORITY_LABEL.P2}</option>
            <option value="P3">{PRIORITY_LABEL.P3}</option>
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
        <div>
          <label className={label}>Version fixed</label>
          <input className={input} value={draft.version_fixed} onChange={e => set('version_fixed', e.target.value)}/>
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
      <div className="flex gap-2 pt-2">
        <button onClick={onSave} className="flex-1 px-4 py-2 bg-ember text-ink rounded text-sm font-semibold hover:bg-ember-deep transition">Save</button>
        <button onClick={onCancel} className="flex-1 px-4 py-2 bg-card border border-bdr rounded text-sm text-muted">Cancel</button>
      </div>
    </div>
  );
}

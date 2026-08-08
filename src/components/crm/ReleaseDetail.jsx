import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';

const STATUSES = ['planned', 'in_dev', 'released'];

export default function ReleaseDetail({ releaseId, profile, onClose }) {
  const [release, setRelease] = useState(null);
  const [targetedItems, setTargetedItems] = useState([]);
  const [shippedItems, setShippedItems] = useState([]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});

  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  useEffect(() => { load(); }, [releaseId]);

  const load = async () => {
    const [r, ti, si] = await Promise.all([
      supabase.from('releases').select('*').eq('id', releaseId).single(),
      supabase.from('backlog_items').select('id, title, type, priority, closed_at').eq('target_release_id', releaseId),
      supabase.from('backlog_items').select('id, title, type, priority, closed_at').eq('released_in_release_id', releaseId),
    ]);
    setRelease(r.data);
    setTargetedItems(ti.data || []);
    setShippedItems(si.data || []);
  };

  const startEdit = () => { setDraft({ ...release }); setEditing(true); };
  const save = async () => {
    const { id, created_at, updated_at, ...patch } = draft;
    if (patch.status === 'released' && !release.released_at) patch.released_at = new Date().toISOString();
    const { error } = await supabase.from('releases').update(patch).eq('id', releaseId);
    if (error) { alert('Could not save: ' + error.message); return; }
    setEditing(false); load();
  };
  const set = (k, v) => setDraft({ ...draft, [k]: v });

  const markReleased = async () => {
    await supabase.from('releases').update({
      status: 'released', released_at: new Date().toISOString(),
    }).eq('id', releaseId);
    // Move all targeted items to shipped
    for (const item of targetedItems) {
      await supabase.from('backlog_items').update({ released_in_release_id: releaseId }).eq('id', item.id);
    }
    load();
  };

  if (!release) return <div className="h-full flex items-center justify-center text-dim text-sm">Loading...</div>;

  const TYPE_ICON = { feature: '\u{2728}', bug: '\u{1F41B}', task: '\u{1F4CB}', chore: '\u{1F9F9}' };
  const input = "w-full px-3 py-2 bg-card border border-bdr rounded text-sm text-paper placeholder-dim focus:outline-none focus:border-ember";
  const label = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block";

  // Derive changelog from shipped items
  const changelog = shippedItems.length > 0
    ? shippedItems.map(i => `${TYPE_ICON[i.type] || ''} ${i.title}`).join('\n')
    : targetedItems.length > 0
    ? targetedItems.map(i => `${TYPE_ICON[i.type] || ''} ${i.title}`).join('\n')
    : '';

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-bdr flex items-center gap-3">
        <button onClick={onClose} className="text-muted hover:text-paper text-sm">&larr;</button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono font-bold text-ember uppercase">{release.product}</span>
            <span className="text-lg font-bold text-paper">{release.version}</span>
            {release.name && <span className="text-lg text-muted">{release.name}</span>}
          </div>
          <div className="text-[10px] text-dim font-mono uppercase tracking-[0.18em]">
            {release.status}{release.released_at ? ` / ${new Date(release.released_at).toLocaleDateString('en-GB')}` : ''}
            {' / '}{targetedItems.length} targeted / {shippedItems.length} shipped
          </div>
        </div>
        {canWrite && release.status !== 'released' && (
          <button onClick={markReleased}
            className="px-3 py-1.5 bg-green-600 text-white text-xs font-semibold rounded hover:bg-green-700">Ship it</button>
        )}
        {canWrite && !editing && (
          <button onClick={startEdit} className="px-3 py-1.5 bg-card border border-bdr rounded text-xs text-muted hover:text-paper">Edit</button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-3xl space-y-6">
          {editing ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div><label className={label}>Version</label><input className={input} value={draft.version || ''} onChange={e => set('version', e.target.value)} /></div>
                <div><label className={label}>Name</label><input className={input} value={draft.name || ''} onChange={e => set('name', e.target.value)} /></div>
                <div><label className={label}>Product</label><select className={input} value={draft.product} onChange={e => set('product', e.target.value)}>
                  <option value="pos">POS</option><option value="crm">CRM</option></select></div>
                <div><label className={label}>Status</label><select className={input} value={draft.status} onChange={e => set('status', e.target.value)}>
                  {STATUSES.map(s => <option key={s} value={s}>{s === 'in_dev' ? 'In Dev' : s}</option>)}</select></div>
              </div>
              <div><label className={label}>Changelog</label><textarea className={input + ' resize-none font-mono'} rows={6} value={draft.changelog || ''} onChange={e => set('changelog', e.target.value)} /></div>
              <div className="flex gap-2"><button onClick={save} className="px-4 py-2 bg-ember text-ink text-sm font-semibold rounded">Save</button>
                <button onClick={() => setEditing(false)} className="px-4 py-2 text-sm text-muted border border-bdr rounded">Cancel</button></div>
            </div>
          ) : (
            <>
              {/* Targeted items */}
              <div>
                <div className={label}>Targeted items ({targetedItems.length})</div>
                <div className="space-y-1">
                  {targetedItems.map(i => (
                    <div key={i.id} className="flex items-center gap-2 py-1.5 px-3 bg-card/50 border border-bdr rounded-lg">
                      <span className="text-sm">{TYPE_ICON[i.type]}</span>
                      <span className={`text-sm flex-1 ${i.closed_at ? 'text-dim line-through' : 'text-paper'}`}>{i.title}</span>
                      <span className="text-[9px] text-dim font-mono">{i.priority}</span>
                    </div>
                  ))}
                  {targetedItems.length === 0 && <div className="text-xs text-dim italic py-3">No items targeted for this release.</div>}
                </div>
              </div>

              {/* Shipped items (if different from targeted) */}
              {shippedItems.length > 0 && shippedItems.length !== targetedItems.length && (
                <div>
                  <div className={label}>Shipped items ({shippedItems.length})</div>
                  <div className="space-y-1">
                    {shippedItems.map(i => (
                      <div key={i.id} className="flex items-center gap-2 py-1.5 px-3 bg-green-500/5 border border-green-500/20 rounded-lg">
                        <span className="text-sm">{TYPE_ICON[i.type]}</span>
                        <span className="text-sm text-paper flex-1">{i.title}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Changelog */}
              <div>
                <div className={label}>Changelog</div>
                <div className="text-sm text-paper whitespace-pre-wrap bg-card/50 border border-bdr rounded-lg p-4 font-mono">
                  {release.changelog || changelog || <span className="text-dim italic">No changelog yet. Edit to add one, or it will be derived from shipped items.</span>}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

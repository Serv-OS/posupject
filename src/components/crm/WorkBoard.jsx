import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { workloadRows, STALL_DAYS } from '../../lib/workload';
import { priorityLabel } from '../../lib/priority';
import { useStickyState } from '../../lib/stickyState';

// Screens 03 and 07 behind one destination, because they answer the same
// question from two directions: where is everything, and who is carrying it.
//
// Status changes were the fiddly part, so the board writes status on drop and
// the row keeps a four-item popover for people not dragging. The in-progress
// limit is advisory on purpose: the header turns amber and nothing is blocked.
// A hard limit on someone else's day is a rule you route around, not a help.

const COLUMNS = [
  ['todo', 'To do'], ['in_progress', 'In progress'], ['blocked', 'Blocked'], ['done', 'Done'],
];
const WIP_ADVISORY = 5;

export default function WorkBoard({ profile, onNavigate }) {
  const [items, setItems] = useState([]);
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useStickyState('work.tab', 'board');
  const [drag, setDrag] = useState(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    const [w, m] = await Promise.all([
      supabase.from('work_items').select('*').order('due_at', { ascending: true, nullsFirst: false }),
      supabase.from('profiles').select('id, email, display_name'),
    ]);
    setItems(w.data || []); setMembers(m.data || []); setLoading(false);
  }, []);
  useEffect(() => {
    load();
    const ch = supabase.channel('workboard')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, load).subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load]);

  const nameOf = (id) => { const m = members.find(x => x.id === id); return m ? (m.display_name || m.email?.split('@')[0]) : 'Unassigned'; };
  const go = (w) => onNavigate?.(w.type, w.source_id);

  // Only tasks can be moved from here. A ticket's stage means something its own
  // screen enforces (SLA clocks, customer replies), and a board that silently
  // rewrote it would be editing a record it does not understand.
  const setStatus = async (item, status) => {
    if (item.type !== 'task' || item.status === status) return;
    setErr('');
    const before = items;
    // Optimistic: the row moves now, and puts itself back if the write fails.
    setItems(cur => cur.map(x => (x.source_id === item.source_id ? { ...x, status } : x)));
    const { error } = await supabase.from('tasks').update({
      status,
      completed_at: status === 'done' ? new Date().toISOString() : null,
    }).eq('id', item.source_id);
    if (error) { setItems(before); setErr(error.message); return; }
    load();
  };

  const week = Date.now() - 7 * 86400000;
  const columns = useMemo(() => COLUMNS.map(([key, label]) => {
    let list = items.filter(i => i.status === key);
    // Done is a record of the week, not an archive that grows for ever.
    if (key === 'done') list = list.filter(i => new Date(i.updated_at).getTime() >= week);
    return { key, label, list };
  }), [items]);

  const rows = useMemo(() => workloadRows(items, members), [items, members]);

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-bdr flex items-center gap-3 flex-wrap">
        <div className="text-xl font-bold text-paper">Work</div>
        <div className="flex items-center gap-0.5 bg-card rounded-xl p-0.5">
          {[['board', 'Board'], ['people', 'People']].map(([k, lbl]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${tab === k ? 'bg-ember text-white' : 'text-muted hover:text-paper'}`}>{lbl}</button>
          ))}
        </div>
        {err && <span className="text-xs text-red-600">Could not save: {err}</span>}
      </div>

      {loading ? (
        <div className="p-6 grid grid-cols-4 gap-3">
          {[0, 1, 2, 3].map(i => <div key={i} className="h-64 rounded-2xl bg-card/60 animate-pulse" />)}
        </div>
      ) : tab === 'board' ? (
        <div className="flex-1 overflow-auto p-6">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 min-w-0">
            {columns.map(col => {
              const over = col.key === 'in_progress' && col.list.length > WIP_ADVISORY;
              return (
                <div key={col.key}
                  onDragOver={e => e.preventDefault()}
                  onDrop={() => { if (drag) setStatus(drag, col.key); setDrag(null); }}
                  className="glass-card rounded-2xl overflow-hidden flex flex-col min-h-[200px]">
                  <div className={`px-4 py-2.5 border-b border-bdr flex items-center gap-2 ${over ? 'bg-amber/10' : ''}`}>
                    <span className={`text-[11px] font-bold ${over ? 'text-amber' : 'text-paper'}`}>{col.label}</span>
                    <span className="text-[10px] text-dim font-mono">{col.list.length}</span>
                    {col.key === 'done' && <span className="text-[10px] text-dim">this week</span>}
                    {over && <span className="ml-auto text-[10px] text-amber">over {WIP_ADVISORY}</span>}
                  </div>
                  <div className="p-2 space-y-2 flex-1">
                    {col.list.length === 0 && <div className="py-6 text-center text-[11px] text-dim italic">Nothing here</div>}
                    {col.list.map(w => (
                      <div key={`${w.type}-${w.source_id}`}
                        draggable={w.type === 'task'}
                        onDragStart={() => setDrag(w)}
                        onDragEnd={() => setDrag(null)}
                        onClick={() => go(w)}
                        title={w.type === 'task' ? 'Drag to change status' : `Open the ${w.type} to change its stage`}
                        className={`p-2.5 rounded-xl bg-card border border-bdr hover:border-ember/30 transition ${w.type === 'task' ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'}`}>
                        <div className="flex items-start gap-1.5 mb-1">
                          <span className="text-[9px] font-bold uppercase px-1 py-0.5 rounded bg-ink-soft text-dim border border-bdr shrink-0">{w.type}</span>
                          <span className="text-xs text-paper flex-1 min-w-0 line-clamp-2">{w.title}</span>
                        </div>
                        <div className="flex items-center gap-2 text-[10px] text-dim">
                          <span className="truncate flex-1">{w.subtitle || nameOf(w.owner_id)}</span>
                          <span>{priorityLabel(w.priority)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="max-w-4xl space-y-3">
            {rows.map(r => (
              <div key={r.id || 'none'} className="glass-card rounded-2xl p-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className={`text-sm font-semibold ${r.id ? 'text-paper' : 'text-muted italic'}`}>{r.name}</span>
                  <span className="text-[11px] text-dim font-mono">{r.total} open</span>
                  {r.overdue > 0 && <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-red-100 text-red-700">{r.overdue} overdue</span>}
                  {r.blocked > 0 && <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-amber/15 text-amber">{r.blocked} blocked</span>}
                </div>
                {/* Scaled against the busiest person, so the bars compare. */}
                {/* Blocked gets its own segment. Without it, someone whose work
                    is ENTIRELY blocked drew an empty bar and read as having
                    nothing on — the exact opposite of the truth, and on this
                    data that was Duncan with two blocked items. */}
                <div className="h-2.5 rounded-full bg-bdr overflow-hidden flex" style={{ width: `${Math.max(4, r.scale * 100)}%` }}>
                  {r.overdue > 0 && <span className="h-full bg-red-500" title={`${r.overdue} overdue`} style={{ width: `${(r.overdue / r.total) * 100}%` }} />}
                  {r.blocked > 0 && <span className="h-full bg-amber" title={`${r.blocked} blocked`} style={{ width: `${(r.blocked / r.total) * 100}%` }} />}
                  {r.inProgress > 0 && <span className="h-full bg-ember" title={`${r.inProgress} in progress`} style={{ width: `${(r.inProgress / r.total) * 100}%` }} />}
                  {r.todo > 0 && <span className="h-full bg-slate-300" title={`${r.todo} to do`} style={{ width: `${(r.todo / r.total) * 100}%` }} />}
                </div>
                {r.stalled.length > 0 && (
                  <div className="mt-2.5 pt-2.5 border-t border-bdr">
                    <div className="text-[10px] font-mono uppercase tracking-wider text-dim mb-1">
                      No movement in {STALL_DAYS}+ days ({r.stalled.length})
                    </div>
                    {r.stalled.slice(0, 3).map(w => (
                      <button key={`${w.type}-${w.source_id}`} onClick={() => go(w)}
                        className="w-full text-left text-xs text-muted hover:text-paper truncate py-0.5">
                        {w.title}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

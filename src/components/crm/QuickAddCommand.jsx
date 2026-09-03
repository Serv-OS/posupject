import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { supabase } from '../../lib/supabase';
import { parseQuickAdd, quickAddRow } from '../../lib/quickAdd';

// ⌘K / Ctrl+K — add a task from anywhere without leaving the screen you are on.
//
// The same parser as the inline row, deliberately. Two parsers would mean
// "@duncan" doing one thing in a list and another in the command bar, which is
// how people stop trusting either. It also shows its working, for the same
// reason it does inline: a guess you cannot see is a guess you cannot correct.

const CHIP = {
  owner: 'bg-uv/10 text-uv-deep border-uv/25',
  project: 'bg-ember/10 text-ember-deep border-ember/25',
  phase: 'bg-ember/5 text-ember-deep border-ember/20',
  priority: 'bg-amber/15 text-amber border-amber/30',
  due: 'bg-emerald-100 text-emerald-700 border-emerald-200',
};

export default function QuickAddCommand({ profile, onNavigate }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [members, setMembers] = useState([]);
  const [projects, setProjects] = useState([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen(v => !v); }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Loaded when it first opens, not on every keystroke and not on mount: the
  // command bar must not cost anything on a page nobody opened it from.
  useEffect(() => {
    if (!open || members.length) return;
    Promise.all([
      supabase.from('profiles').select('id, email, display_name'),
      supabase.from('crm_projects').select('id, name, phases'),
    ]).then(([m, p]) => { setMembers(m.data || []); setProjects(p.data || []); });
  }, [open, members.length]);

  const parsed = useMemo(() => parseQuickAdd(text, { members, projects }), [text, members, projects]);

  const create = async (openIt) => {
    if (!parsed.title.trim() || busy) return;
    setBusy(true);
    const { data, error } = await supabase.from('tasks')
      .insert(quickAddRow(parsed, profile.id)).select('id, title').single();
    setBusy(false);
    if (error) { setDone({ error: error.message }); return; }
    setText('');
    if (openIt) { setOpen(false); onNavigate?.('task', data.id); return; }
    setDone({ id: data.id, title: data.title });
  };

  const undo = async () => { if (done?.id) await supabase.from('tasks').delete().eq('id', done.id); setDone(null); };

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[15vh] px-4 bg-black/40"
      onClick={() => setOpen(false)}>
      <div onClick={e => e.stopPropagation()} className="w-full max-w-xl menu-surface rounded-2xl overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-bdr">
          <span className="text-dim text-sm">+</span>
          <input autoFocus value={text} onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); create(e.shiftKey); } }}
            placeholder="Add a task…  @person  #project  !priority  fri"
            className="flex-1 bg-transparent text-sm text-paper placeholder-dim focus:outline-none" />
          <kbd className="text-[10px] text-dim font-mono">esc</kbd>
        </div>

        {parsed.matched.length > 0 && (
          <div className="px-4 py-2 flex flex-wrap items-center gap-1.5 border-b border-bdr">
            {parsed.matched.map((m, i) => (
              <span key={i} className={`px-2 py-0.5 rounded-lg text-[11px] font-medium border ${CHIP[m.type]}`}>{m.label}</span>
            ))}
          </div>
        )}

        <div className="px-4 py-2.5 flex items-center gap-3 text-[11px] text-dim">
          {done?.error ? <span className="text-red-600 flex-1">{done.error}</span>
            : done ? (
              <>
                <span className="text-paper flex-1 truncate">Added &ldquo;{done.title}&rdquo;</span>
                <button onClick={() => { setOpen(false); onNavigate?.('task', done.id); }} className="text-ember font-medium">Open</button>
                <button onClick={undo} className="text-muted hover:text-red-600">Undo</button>
              </>
            ) : (
              <>
                <span className="flex-1">{parsed.title ? `Creates "${parsed.title}"` : 'Type a title'}</span>
                <span><kbd className="font-mono">enter</kbd> add · <kbd className="font-mono">shift+enter</kbd> add &amp; open</span>
              </>
            )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

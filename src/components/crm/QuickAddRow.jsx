import { useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { parseQuickAdd, quickAddRow } from '../../lib/quickAdd';

// One line of typing and one keystroke — the acceptance criterion for the
// whole redesign.
//
// What is parsed is shown as chips UNDER the field while typing, so the guess
// is visible before Enter rather than discovered afterwards. A parser that
// quietly reassigns a task is worse than a form; showing its working is what
// makes it trustworthy enough to use without looking.
//
// Enter creates and stays here (you are usually adding several). Shift+Enter
// creates and opens it. Both surface an Undo, because the fastest way to add a
// task has to be a safe one.

const CHIP = {
  owner:    'bg-uv/10 text-uv-deep border-uv/25',
  project:  'bg-ember/10 text-ember-deep border-ember/25',
  phase:    'bg-ember/5 text-ember-deep border-ember/20',
  priority: 'bg-amber/15 text-amber border-amber/30',
  due:      'bg-emerald-100 text-emerald-700 border-emerald-200',
};

export default function QuickAddRow({ profile, members, projects, presets, onCreated, onOpen, placeholder }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);

  const parsed = useMemo(
    () => parseQuickAdd(text, { members, projects, presets }),
    [text, members, projects, presets],
  );

  const create = async (open) => {
    const title = parsed.title.trim();
    if (!title || busy) return;
    setBusy(true);
    const { data, error } = await supabase.from('tasks')
      .insert(quickAddRow(parsed, profile.id)).select('id, title').single();
    setBusy(false);
    if (error) { setToast({ error: error.message }); return; }
    setText('');
    setToast({ id: data.id, title: data.title });
    onCreated?.(data);
    if (open) onOpen?.(data.id);
  };

  // Undo means the row goes away. A task created by mistake in a hurry should
  // not need a second visit to clean up.
  const undo = async () => {
    if (!toast?.id) return;
    await supabase.from('tasks').delete().eq('id', toast.id);
    setToast(null);
    onCreated?.(null);
  };

  return (
    <div>
      <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-dashed border-bdr hover:border-ember/40 focus-within:border-ember transition bg-card/30">
        <span className="text-dim text-sm shrink-0">+</span>
        <input
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); create(e.shiftKey); }
            if (e.key === 'Escape') setText('');
          }}
          disabled={busy}
          placeholder={placeholder || 'Add a task…  @person  #project  !priority  fri'}
          className="flex-1 bg-transparent text-sm text-paper placeholder-dim focus:outline-none disabled:opacity-50"
        />
        {text.trim() && (
          <button onClick={() => create(false)} disabled={busy || !parsed.title.trim()}
            className="btn-glass px-3 py-1 rounded-lg text-xs font-semibold disabled:opacity-40 shrink-0">
            {busy ? '…' : 'Add'}
          </button>
        )}
      </div>

      {/* The parser showing its working. */}
      {parsed.matched.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mt-1.5 px-3">
          {parsed.matched.map((m, i) => (
            <span key={i} className={`px-2 py-0.5 rounded-lg text-[11px] font-medium border ${CHIP[m.type]}`}>
              {m.label}
            </span>
          ))}
          <span className="text-[11px] text-dim">Shift+Enter to open it</span>
        </div>
      )}

      {toast && (
        <div className="flex items-center gap-3 mt-2 px-3 py-2 rounded-xl bg-card border border-bdr text-xs">
          {toast.error ? (
            <>
              <span className="text-red-600 flex-1">Could not add that: {toast.error}</span>
              <button onClick={() => setToast(null)} className="text-dim hover:text-paper">Dismiss</button>
            </>
          ) : (
            <>
              <span className="text-paper flex-1 truncate">Added &ldquo;{toast.title}&rdquo;</span>
              <button onClick={() => onOpen?.(toast.id)} className="text-ember hover:text-ember-deep font-medium">Open</button>
              <button onClick={undo} className="text-muted hover:text-red-600">Undo</button>
              <button onClick={() => setToast(null)} className="text-dim hover:text-paper">&times;</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

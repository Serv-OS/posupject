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
      {/* A raised row with a real checkbox square on the left, not a dashed
          placeholder with a plus. It reads as the first row of the list you are
          about to add to, which is the point: the fastest add is the one that
          looks like it is already part of the thing. */}
      <div className="flex items-center gap-2.5 px-4 py-[13px] rounded-[14px] border border-bdr focus-within:border-ember transition"
        style={{ background: 'var(--raised-bg)', boxShadow: 'var(--shadow-card)' }}>
        <span className="w-[18px] h-[18px] rounded-[5px] shrink-0 border-2"
          style={{ borderColor: 'var(--check-bdr)' }} />
        <input
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); create(e.shiftKey); }
            if (e.key === 'Escape') setText('');
          }}
          disabled={busy}
          placeholder={placeholder || 'Add a task — try @peter #adyen fri !high'}
          className="flex-1 min-w-0 bg-transparent text-[15px] text-paper placeholder-dim focus:outline-none disabled:opacity-50"
        />
        {text.trim() ? (
          <button onClick={() => create(false)} disabled={busy || !parsed.title.trim()}
            className="px-3 py-1 rounded-lg text-xs font-semibold bg-ember text-white disabled:opacity-40 shrink-0">
            {busy ? '…' : 'Add'}
          </button>
        ) : (
          <span className="hidden sm:block font-mono text-[11px] text-dim shrink-0">
            Enter to add &middot; &#8679;Enter to open
          </span>
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

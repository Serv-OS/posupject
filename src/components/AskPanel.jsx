import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { supabase } from '../lib/supabase';
import { Sparkles, X, CornerDownLeft } from 'lucide-react';

const FN = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

// Ask the CRM what is going on. It answers from a snapshot of the real data
// for whatever you are looking at, so the same question gives a different
// answer on a ticket than on the dashboard.
//
// Portalled, because .glass-card uses backdrop-filter and that makes it the
// containing block for position:fixed children — a panel rendered inside one
// would be trapped in the card.

const SUGGESTIONS = {
  support: [
    'What needs actioning first, and why?',
    'Which customers are waiting on us?',
    'Summarise where support is at right now',
  ],
  overview: [
    'What needs my attention today?',
    'What is overdue?',
    'Summarise where the business is at',
  ],
  ticket: [
    'Summarise what happened on this ticket',
    'What is the customer actually waiting for?',
    'What should the next reply say?',
  ],
  company: [
    'Summarise our history with this customer',
    'Is anything outstanding for them?',
  ],
};

const SCOPE_LABEL = { support: 'Support', overview: 'Everything', ticket: 'This ticket', company: 'This customer' };

export default function AskPanel({ open, onClose, scope }) {
  const [q, setQ] = useState('');
  const [thread, setThread] = useState([]);   // { role, content }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const boxRef = useRef(null);
  const inputRef = useRef(null);

  const kind = scope?.type || 'overview';

  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 80); }, [open]);
  useEffect(() => { boxRef.current?.scrollTo(0, boxRef.current.scrollHeight); }, [thread, busy]);
  // A new scope is a new subject — don't carry a ticket's answers onto a company.
  useEffect(() => { setThread([]); setError(''); }, [kind, scope?.id]);

  const ask = async (question) => {
    const text = (question ?? q).trim();
    if (!text || busy) return;
    setQ(''); setError('');
    const next = [...thread, { role: 'user', content: text }];
    setThread(next);
    setBusy(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`${FN}/ai-ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ question: text, scope, history: thread }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'The assistant could not answer.');
      setThread([...next, { role: 'assistant', content: d.answer || '(no answer)' }]);
    } catch (e) {
      setError(e.message);
      setThread(next);
    }
    setBusy(false);
  };

  if (!open) return null;

  return createPortal((
    <div className="fixed inset-0 z-[70] flex justify-end" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="absolute inset-0 bg-black/30" />
      <div style={{ background: 'var(--scene, var(--card))' }}
        className="relative w-full sm:max-w-lg h-full flex flex-col border-l border-bdr shadow-2xl">

        <div className="px-4 py-3 border-b border-bdr flex items-center gap-2 shrink-0">
          <Sparkles size={16} className="text-ember" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold text-paper">Ask</div>
            <div className="text-[11px] text-muted truncate">
              Answers from your live data · {SCOPE_LABEL[kind] || kind}
            </div>
          </div>
          <button onClick={onClose} className="text-muted hover:text-paper p-1"><X size={18} /></button>
        </div>

        <div ref={boxRef} className="flex-1 overflow-y-auto p-4 space-y-3">
          {thread.length === 0 && (
            <div className="space-y-2">
              <div className="text-xs text-muted">Try:</div>
              {(SUGGESTIONS[kind] || SUGGESTIONS.overview).map(s => (
                <button key={s} onClick={() => ask(s)}
                  className="block w-full text-left px-3 py-2 rounded-xl bg-card border border-bdr text-sm text-paper hover:border-ember transition">
                  {s}
                </button>
              ))}
            </div>
          )}

          {thread.map((m, i) => (
            <div key={i} className={m.role === 'user' ? 'flex justify-end' : ''}>
              <div className={m.role === 'user'
                ? 'max-w-[85%] px-3 py-2 rounded-2xl bg-ember text-ink text-sm'
                : 'max-w-full px-3 py-2 rounded-2xl bg-card border border-bdr text-sm text-paper whitespace-pre-wrap leading-relaxed'}>
                {m.content}
              </div>
            </div>
          ))}

          {busy && <div className="text-xs text-dim italic px-1">Reading your data…</div>}
          {error && <div className="text-xs text-red-600 px-1">{error}</div>}
        </div>

        <div className="p-3 border-t border-bdr shrink-0">
          <div className="relative">
            <textarea ref={inputRef} rows={2} value={q}
              onChange={e => setQ(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } }}
              placeholder="Ask about what you're looking at…"
              className="w-full px-3 py-2 pr-11 bg-card border border-bdr rounded-xl text-base sm:text-sm text-paper placeholder-dim focus:outline-none focus:border-ember resize-none" />
            <button onClick={() => ask()} disabled={busy || !q.trim()}
              className="absolute bottom-2 right-2 p-1.5 rounded-lg bg-ember text-ink disabled:opacity-40">
              <CornerDownLeft size={14} />
            </button>
          </div>
          <div className="text-[10px] text-dim mt-1.5">
            Reads only what you can see, and cannot change anything.
          </div>
        </div>
      </div>
    </div>
  ), document.body);
}

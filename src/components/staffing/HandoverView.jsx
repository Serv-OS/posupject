import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { Plus, Check, Trash2, Sparkles, Eye, X } from 'lucide-react';

const FN = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

// Handover: what the next person needs to know.
//
// The things that never belong on a ticket — "waiting on the landlord, don't
// chase again", "the reader for CSC is in my car", "Mike's off Thursday, I've
// got his tickets". Written to be read once by whoever comes next.

const when = (ts) => {
  const d = Math.floor((Date.now() - new Date(ts).getTime()) / 86400000);
  return d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
};
const fmtDate = (s) => new Date(s + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

export default function HandoverView({ profile, onNavigate }) {
  const [rows, setRows] = useState([]);
  const [reads, setReads] = useState([]);
  const [people, setPeople] = useState([]);
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [writing, setWriting] = useState(false);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [drafting, setDrafting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [h, r, p, t] = await Promise.all([
      supabase.from('handovers').select('*').order('shift_date', { ascending: false }).order('created_at', { ascending: false }).limit(60),
      supabase.from('handover_reads').select('*'),
      supabase.from('profiles').select('id, display_name, email'),
      supabase.from('tickets').select('id, ticket_number, subject').not('stage', 'in', '("closed")').order('updated_at', { ascending: false }).limit(80),
    ]);
    setRows(h.data || []); setReads(r.data || []); setPeople(p.data || []); setTickets(t.data || []);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const name = (id) => people.find(x => x.id === id)?.display_name || people.find(x => x.id === id)?.email?.split('@')[0] || 'Someone';
  const readersOf = (id) => reads.filter(r => r.handover_id === id);
  const haveRead = (id) => readersOf(id).some(r => r.profile_id === profile.id);

  const blank = () => ({ title: '', body: '', actions: [], ticket_ids: [], for_user_id: '' });

  const markRead = async (id) => {
    // The point of a handover is that someone actually picked it up.
    await supabase.from('handover_reads').insert({ handover_id: id, profile_id: profile.id });
    load();
  };

  const save = async () => {
    if (!draft.body.trim()) { alert('Write what the next person needs to know.'); return; }
    setBusy(true);
    const payload = {
      author_id: profile.id,
      title: draft.title.trim() || null,
      body: draft.body.trim(),
      actions: draft.actions.filter(a => a.text.trim()),
      ticket_ids: draft.ticket_ids,
      for_user_id: draft.for_user_id || null,
    };
    const { error } = draft.id
      ? await supabase.from('handovers').update({ ...payload, updated_at: new Date().toISOString() }).eq('id', draft.id)
      : await supabase.from('handovers').insert(payload);
    if (error) alert(error.message);
    setBusy(false); setWriting(false); setDraft(null); load();
  };

  const del = async (id) => {
    if (!confirm('Delete this handover?')) return;
    await supabase.from('handovers').delete().eq('id', id);
    load();
  };

  const toggleAction = async (h, i) => {
    const next = (h.actions || []).map((a, j) => j === i ? { ...a, done: !a.done } : a);
    await supabase.from('handovers').update({ actions: next }).eq('id', h.id);
    load();
  };

  // Start from what is actually outstanding rather than a blank box — the
  // assistant reads the live support picture and writes the first draft.
  const draftFromData = async () => {
    setDrafting(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`${FN}/ai-ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({
          scope: { type: 'support' },
          question: 'Write a shift handover for the colleague taking over. Cover: what happened, where each ' +
            'open thing has got to, and what needs actioning next with ticket numbers. Plain prose, short ' +
            'paragraphs, no headings, no preamble. Only mention what is in the data.',
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Could not draft');
      setDraft(v => ({ ...(v || blank()), body: d.answer || '' }));
    } catch (e) { alert(e.message); }
    setDrafting(false);
  };

  if (loading) return <div className="p-8 text-dim text-sm">Loading handovers…</div>;

  const input = 'w-full px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper placeholder-dim focus:outline-none focus:border-ember';
  const label = 'text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block';

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 lg:px-6 py-4 border-b border-bdr flex items-center gap-3">
        <div>
          <div className="text-lg font-bold text-paper">Handover</div>
          <div className="text-[11px] text-muted">What the next person needs to know</div>
        </div>
        {!writing && (
          <button onClick={() => { setDraft(blank()); setWriting(true); }}
            className="ml-auto px-3 py-1.5 rounded-xl bg-ember text-ink text-sm font-semibold hover:bg-ember-deep flex items-center gap-1.5">
            <Plus size={15} /> Write handover
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4 lg:p-6">
        <div className="max-w-3xl space-y-4">

          {writing && draft && (
            <div className="bg-card border border-ember/40 rounded-xl p-4 space-y-3">
              <div className="flex items-center gap-2">
                <div className="text-sm font-bold text-paper">{draft.id ? 'Edit handover' : 'New handover'}</div>
                <button onClick={draftFromData} disabled={drafting}
                  className="ml-auto text-xs font-semibold text-ember-deep bg-ember/15 border border-ember/25 px-2.5 py-1 rounded-lg hover:bg-ember/25 disabled:opacity-50 flex items-center gap-1.5">
                  <Sparkles size={13} /> {drafting ? 'Reading…' : 'Draft from what’s open'}
                </button>
              </div>

              <input className={input} value={draft.title} placeholder="Headline (optional) — e.g. Friday evening"
                onChange={e => setDraft({ ...draft, title: e.target.value })} />

              <textarea className={input + ' resize-none'} rows={9} value={draft.body}
                placeholder={'What happened, where things got to, anything the next person would be annoyed not to know.'}
                onChange={e => setDraft({ ...draft, body: e.target.value })} />

              <div>
                <span className={label}>Needs actioning</span>
                {draft.actions.map((a, i) => (
                  <div key={i} className="flex gap-2 mb-1.5">
                    <input className={input} value={a.text} placeholder="e.g. Call the landlord back before 10"
                      onChange={e => setDraft({ ...draft, actions: draft.actions.map((x, j) => j === i ? { ...x, text: e.target.value } : x) })} />
                    <button onClick={() => setDraft({ ...draft, actions: draft.actions.filter((_, j) => j !== i) })}
                      className="text-dim hover:text-red-600 px-1"><X size={15} /></button>
                  </div>
                ))}
                <button onClick={() => setDraft({ ...draft, actions: [...draft.actions, { text: '', done: false }] })}
                  className="text-xs text-ember hover:text-ember-deep font-medium">+ Add an action</button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <span className={label}>Aimed at</span>
                  <select className={input} value={draft.for_user_id} onChange={e => setDraft({ ...draft, for_user_id: e.target.value })}>
                    <option value="">Everyone</option>
                    {people.filter(p => p.id !== profile.id).map(p => <option key={p.id} value={p.id}>{p.display_name || p.email}</option>)}
                  </select>
                </div>
                <div>
                  <span className={label}>Tickets it is about</span>
                  <select className={input} value=""
                    onChange={e => { const id = e.target.value; if (id && !draft.ticket_ids.includes(id)) setDraft({ ...draft, ticket_ids: [...draft.ticket_ids, id] }); }}>
                    <option value="">+ Link a ticket…</option>
                    {tickets.filter(t => !draft.ticket_ids.includes(t.id)).map(t => (
                      <option key={t.id} value={t.id}>#{t.ticket_number} {t.subject?.slice(0, 50)}</option>
                    ))}
                  </select>
                </div>
              </div>
              {draft.ticket_ids.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {draft.ticket_ids.map(id => {
                    const t = tickets.find(x => x.id === id);
                    return (
                      <span key={id} className="text-[11px] px-2 py-1 rounded-lg bg-ink-soft border border-bdr text-paper flex items-center gap-1.5">
                        #{t?.ticket_number || '?'}
                        <button onClick={() => setDraft({ ...draft, ticket_ids: draft.ticket_ids.filter(x => x !== id) })}
                          className="text-dim hover:text-red-600"><X size={11} /></button>
                      </span>
                    );
                  })}
                </div>
              )}

              <div className="flex gap-2 pt-1">
                <button onClick={save} disabled={busy}
                  className="px-4 py-2 rounded-xl bg-ember text-ink text-sm font-semibold hover:bg-ember-deep disabled:opacity-50">
                  {busy ? 'Saving…' : 'Post handover'}
                </button>
                <button onClick={() => { setWriting(false); setDraft(null); }} className="px-4 py-2 rounded-xl btn-ghost text-sm">Cancel</button>
              </div>
            </div>
          )}

          {rows.length === 0 && !writing && (
            <div className="text-center py-12 text-sm text-dim italic">
              No handovers yet. Write one at the end of a shift and whoever picks up next will know where things stand.
            </div>
          )}

          {rows.map(h => {
            const mine = h.author_id === profile.id;
            const readers = readersOf(h).filter(r => r.profile_id !== h.author_id);
            const forMe = h.for_user_id === profile.id;
            return (
              <div key={h.id} className={`bg-card border rounded-xl overflow-hidden ${forMe && !haveRead(h.id) ? 'border-ember/50' : 'border-bdr'}`}>
                <div className="px-4 py-3 border-b border-bdr flex items-center gap-2 flex-wrap">
                  <div className="w-7 h-7 rounded-full bg-ember/15 text-ember-deep text-[11px] font-bold flex items-center justify-center">
                    {name(h.author_id)[0]?.toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-paper truncate">
                      {h.title || `${name(h.author_id)}’s handover`}
                    </div>
                    <div className="text-[11px] text-muted">
                      {name(h.author_id)} · {fmtDate(h.shift_date)} · {when(h.created_at)}
                      {h.for_user_id && ` · for ${name(h.for_user_id)}`}
                    </div>
                  </div>
                  <div className="ml-auto flex items-center gap-2">
                    {readers.length > 0 && (
                      <span className="text-[10px] text-dim flex items-center gap-1" title={readers.map(r => name(r.profile_id)).join(', ')}>
                        <Eye size={12} /> {readers.length}
                      </span>
                    )}
                    {!mine && !haveRead(h.id) && (
                      <button onClick={() => markRead(h.id)}
                        className="text-[11px] font-semibold text-ember hover:text-ember-deep">Mark read</button>
                    )}
                    {mine && (
                      <>
                        <button onClick={() => { setDraft({ id: h.id, title: h.title || '', body: h.body, actions: h.actions || [], ticket_ids: h.ticket_ids || [], for_user_id: h.for_user_id || '' }); setWriting(true); }}
                          className="text-[11px] text-muted hover:text-paper">Edit</button>
                        <button onClick={() => del(h.id)} className="text-dim hover:text-red-600"><Trash2 size={13} /></button>
                      </>
                    )}
                  </div>
                </div>

                <div className="px-4 py-3 space-y-3">
                  <div className="text-sm text-paper whitespace-pre-wrap leading-relaxed">{h.body}</div>

                  {(h.actions || []).length > 0 && (
                    <div className="space-y-1">
                      <div className="text-[10px] font-mono uppercase tracking-wider text-dim">Needs actioning</div>
                      {h.actions.map((a, i) => (
                        <button key={i} onClick={() => toggleAction(h, i)}
                          className="flex items-start gap-2 text-left w-full group">
                          <span className={`mt-0.5 w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                            a.done ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-bdr group-hover:border-ember'}`}>
                            {a.done && <Check size={11} />}
                          </span>
                          <span className={`text-sm ${a.done ? 'text-dim line-through' : 'text-paper'}`}>{a.text}</span>
                        </button>
                      ))}
                    </div>
                  )}

                  {(h.ticket_ids || []).length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {h.ticket_ids.map(id => {
                        const t = tickets.find(x => x.id === id);
                        return (
                          <button key={id} onClick={() => onNavigate?.('ticket', id)}
                            className="text-[11px] px-2 py-1 rounded-lg bg-ink-soft border border-bdr text-paper hover:border-ember">
                            #{t?.ticket_number || 'ticket'}{t?.subject ? ` ${t.subject.slice(0, 40)}` : ''}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

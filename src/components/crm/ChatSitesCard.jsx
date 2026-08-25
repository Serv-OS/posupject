import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';

// Website / POS support-chat settings: the embeds (site keys) and the playbook
// that decides what the assistant asks, refuses, and escalates.
// See posupcrm/AI_CHATBOT_PLAN.md.

const lines = (a) => (a || []).join('\n');
const toArr = (s) => (s || '').split('\n').map(x => x.trim()).filter(Boolean);
const newKey = () => 'chat_' + Array.from(crypto.getRandomValues(new Uint8Array(10)))
  .map(b => b.toString(16).padStart(2, '0')).join('');

export default function ChatSitesCard({ profile }) {
  const [pb, setPb] = useState(null);
  const [sites, setSites] = useState([]);
  const [locations, setLocations] = useState([]);
  const [adding, setAdding] = useState(null);
  const [kbCount, setKbCount] = useState(null);
  const [learning, setLearning] = useState(false);
  const [learned, setLearned] = useState('');
  const [modules, setModules] = useState([]);
  const [teach, setTeach] = useState({ url: '', text: '', module: '' });
  const [teaching, setTeaching] = useState(false);
  const [docs, setDocs] = useState([]);
  const [showDocs, setShowDocs] = useState(false);
  const [copied, setCopied] = useState('');
  const [err, setErr] = useState('');

  const canWrite = profile.role === 'owner' || profile.role === 'editor';
  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  useEffect(() => { load(); }, []);

  const load = async () => {
    const [p, s, l] = await Promise.all([
      supabase.from('chat_playbook').select('*').eq('id', 1).maybeSingle(),
      supabase.from('chat_sites').select('*').order('created_at'),
      supabase.from('locations').select('id, name').order('name'),
    ]);
    if (p.error) setErr(p.error.message);
    const { count } = await supabase.from('kb_docs').select('id', { count: 'exact', head: true }).eq('active', true);
    setKbCount(count ?? 0);
    const { data: mods } = await supabase.from('modules').select('name').order('name');
    setModules((mods || []).map(m => m.name));
    const { data: kd } = await supabase.from('kb_docs')
      .select('id,title,question,module,category,first_line,internal_only,source')
      .order('first_line', { ascending: false }).order('created_at', { ascending: false }).limit(200);
    setDocs(kd || []);
    setPb(p.data || null);
    setSites(s.data || []);
    setLocations(l.data || []);
  };

  const savePb = async (patch) => {
    const next = { ...pb, ...patch };
    setPb(next);
    const { error } = await supabase.from('chat_playbook').update({
      enabled: next.enabled, greeting: next.greeting, tone: next.tone,
      ask_location: next.ask_location, never_answer: next.never_answer,
      always_escalate: next.always_escalate, persona_names: next.persona_names,
      unknown_reply: next.unknown_reply, business_context: next.business_context,
      updated_at: new Date().toISOString(),
    }).eq('id', 1);
    if (error) setErr(error.message);
  };

  const saveSite = async (id, patch) => {
    setSites(ss => ss.map(s => s.id === id ? { ...s, ...patch } : s));
    const { error } = await supabase.from('chat_sites').update(patch).eq('id', id);
    if (error) setErr(error.message);
  };

  const addSite = async () => {
    const a = adding;
    if (!a?.label?.trim()) { setErr('Give the embed a name.'); return; }
    const { error } = await supabase.from('chat_sites').insert({
      site_key: newKey(),
      label: a.label.trim(),
      allowed_origins: toArr(a.origins),
      location_id: a.location_id || null,
      mode: a.mode || 'popup',
    });
    if (error) { setErr(error.message); return; }
    setAdding(null); setErr(''); load();
  };

  const removeSite = async (s) => {
    if (!confirm(`Delete the "${s.label}" embed?\n\nAny site still using this key will stop working.`)) return;
    await supabase.from('chat_sites').delete().eq('id', s.id);
    load();
  };

  // Distil resolved tickets into reusable answers (runs server-side).
  const learn = async () => {
    setLearning(true); setLearned(''); setErr('');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/kb-ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ limit: 25 }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Could not read the tickets.');
      setLearned(`Learned ${d.learned} new answer${d.learned === 1 ? '' : 's'} from ${d.considered} ticket${d.considered === 1 ? '' : 's'}.` +
        (d.skipped_no_answer ? ` ${d.skipped_no_answer} had no reply to learn from.` : ''));
      load();
    } catch (e) { setErr(e.message); }
    setLearning(false);
  };

  // Read a supplier doc (or pasted text) and turn it into answers.
  const teachFrom = async () => {
    if (!teach.url.trim() && !teach.text.trim()) { setErr('Paste a documentation link or the text itself.'); return; }
    setTeaching(true); setLearned(''); setErr('');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/kb-learn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({
          url: teach.url.trim() || undefined,
          text: teach.text.trim() || undefined,
          module: teach.module || undefined,
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Could not read that.');
      setLearned(d.learned
        ? `Learned ${d.learned} answer${d.learned === 1 ? '' : 's'}${teach.module ? ` for ${teach.module}` : ''}.`
        : (d.note || 'Nothing useful found there.'));
      setTeach({ url: '', text: '', module: teach.module });
      load();
    } catch (e) { setErr(e.message); }
    setTeaching(false);
  };

  const saveDoc = async (id, patch) => {
    setDocs(ds => ds.map(d => d.id === id ? { ...d, ...patch } : d));
    const { error } = await supabase.from('kb_docs').update(patch).eq('id', id);
    if (error) setErr(error.message);
  };
  const removeDoc = async (d) => {
    if (!confirm(`Delete "${d.title || d.question}"?`)) return;
    await supabase.from('kb_docs').delete().eq('id', d.id);
    load();
  };

  const copy = (text, tag) => {
    navigator.clipboard?.writeText(text);
    setCopied(tag);
    setTimeout(() => setCopied(''), 1800);
  };

  const snippet = (s) => `<script src="${origin}/chat.js" data-site-key="${s.site_key}" defer></script>`;
  const posLink = (s) => `${origin}/support-chat.html?key=${s.site_key}`;

  const input = "w-full px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper placeholder-dim focus:outline-none focus:border-ember disabled:opacity-60";
  const label = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block";

  // Don't vanish silently if the playbook row can't be read — say so.
  if (!pb) {
    return (
      <div className="glass-card rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-bdr flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-ember/15 border border-ember/25 flex items-center justify-center text-lg">{'\u{1F4AD}'}</div>
          <div><div className="text-base font-bold text-paper">Support chat</div>
            <div className="text-xs text-muted">Loading…</div></div>
        </div>
        {err && <div className="p-5 text-xs text-red-600">{err}</div>}
      </div>
    );
  }

  return (
    <div className="glass-card rounded-2xl overflow-hidden">
      <div className="px-5 py-4 border-b border-bdr flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-ember/15 border border-ember/25 flex items-center justify-center text-lg">{'\u{1F4AD}'}</div>
        <div className="flex-1">
          <div className="text-base font-bold text-paper">Support chat</div>
          <div className="text-xs text-muted">The assistant on your website and on POS screens</div>
        </div>
        <button type="button" disabled={!canWrite} onClick={() => savePb({ enabled: !pb.enabled })}
          className="flex items-center gap-2 disabled:opacity-60" title={pb.enabled ? 'Turn chat off' : 'Turn chat on'}>
          <span className={`text-[10px] font-bold uppercase ${pb.enabled ? 'text-emerald-600' : 'text-dim'}`}>{pb.enabled ? 'On' : 'Off'}</span>
          <div className={`relative w-10 h-6 rounded-full transition ${pb.enabled ? 'bg-emerald-500' : 'bg-slate-300'}`}>
            <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${pb.enabled ? 'left-[18px]' : 'left-0.5'}`} />
          </div>
        </button>
      </div>

      <div className="p-5 space-y-6">
        {err && <div className="text-xs text-red-600">{err}</div>}

        {/* ── Embeds ─────────────────────────────────────────────────────── */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <div className="text-sm font-medium text-paper">Embeds</div>
            <span className="text-xs text-dim font-mono">({sites.length})</span>
            {canWrite && !adding && (
              <button onClick={() => setAdding({ label: '', origins: '', mode: 'popup', location_id: '' })}
                className="ml-auto text-xs text-ember hover:text-ember-deep font-medium">+ New embed</button>
            )}
          </div>

          {adding && (
            <div className="glass-inner rounded-xl p-3 space-y-2 mb-3">
              <div className="grid grid-cols-2 gap-2">
                <div><label className={label}>Name</label>
                  <input className={input} value={adding.label} placeholder="e.g. Main website"
                    onChange={e => setAdding({ ...adding, label: e.target.value })} /></div>
                <div><label className={label}>Venue (optional)</label>
                  <select className={input} value={adding.location_id}
                    onChange={e => setAdding({ ...adding, location_id: e.target.value })}>
                    <option value="">Ask the customer</option>
                    {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select></div>
              </div>
              <div><label className={label}>Allowed domains — one per line (blank = any)</label>
                <textarea rows={2} className={input + ' resize-none font-mono text-xs'} value={adding.origins}
                  placeholder={'serv-os.app\nwww.mysite.co.uk'}
                  onChange={e => setAdding({ ...adding, origins: e.target.value })} /></div>
              <div className="flex gap-2">
                <button onClick={addSite} className="btn-glass px-4 py-2 rounded-xl text-sm font-semibold">Create</button>
                <button onClick={() => { setAdding(null); setErr(''); }} className="btn-ghost px-4 py-2 rounded-xl text-sm">Cancel</button>
              </div>
            </div>
          )}

          <div className="space-y-2">
            {sites.length === 0 && !adding && (
              <div className="text-xs text-dim italic py-3 text-center">No embeds yet — create one to get your website snippet.</div>
            )}
            {sites.map(s => (
              <div key={s.id} className="glass-inner rounded-xl p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <input className={input + ' !py-1 flex-1 font-medium'} value={s.label} disabled={!canWrite}
                    onChange={e => setSites(ss => ss.map(x => x.id === s.id ? { ...x, label: e.target.value } : x))}
                    onBlur={e => saveSite(s.id, { label: e.target.value })} />
                  <button onClick={() => saveSite(s.id, { active: !s.active })} disabled={!canWrite}
                    className={`px-2 py-1 text-[10px] font-bold uppercase rounded-lg shrink-0 ${s.active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}`}>
                    {s.active ? 'Live' : 'Paused'}
                  </button>
                  {canWrite && <button onClick={() => removeSite(s)} className="text-red-500 hover:text-red-600 text-sm shrink-0" title="Delete">×</button>}
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div><label className={label}>Venue</label>
                    <select className={input + ' !py-1 text-xs'} value={s.location_id || ''} disabled={!canWrite}
                      onChange={e => saveSite(s.id, { location_id: e.target.value || null })}>
                      <option value="">Ask the customer</option>
                      {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                    </select>
                    <div className="text-[10px] text-dim mt-0.5">Set this for a POS till so it never asks.</div>
                    <button onClick={() => saveSite(s.id, { trust: s.trust === 'internal' ? 'public' : 'internal' })}
                      disabled={!canWrite}
                      title="Trusted embeds can be given admin codes and deeper technical steps"
                      className={`mt-1.5 px-2 py-0.5 text-[9px] font-bold uppercase rounded ${s.trust === 'internal' ? 'bg-amber-500 text-white' : 'bg-card text-dim border border-bdr'}`}>
                      {s.trust === 'internal' ? 'Trusted — staff screen' : 'Public website'}
                    </button>
                  </div>
                  <div><label className={label}>Allowed domains</label>
                    <textarea rows={2} className={input + ' !py-1 resize-none font-mono text-[11px]'} disabled={!canWrite}
                      value={lines(s.allowed_origins)} placeholder="blank = any"
                      onChange={e => setSites(ss => ss.map(x => x.id === s.id ? { ...x, allowed_origins: e.target.value.split('\n') } : x))}
                      onBlur={e => saveSite(s.id, { allowed_origins: toArr(e.target.value) })} /></div>
                </div>

                <div className="flex flex-wrap gap-2 pt-1">
                  <button onClick={() => copy(snippet(s), 'w' + s.id)}
                    className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-ember/15 text-ember-deep border border-ember/25 hover:bg-ember/25">
                    {copied === 'w' + s.id ? '✓ Copied' : 'Copy website snippet'}
                  </button>
                  <button onClick={() => copy(posLink(s), 'p' + s.id)}
                    className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-card border border-bdr text-muted hover:text-paper">
                    {copied === 'p' + s.id ? '✓ Copied' : 'Copy POS link'}
                  </button>
                  <a href={posLink(s)} target="_blank" rel="noreferrer"
                    className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-card border border-bdr text-muted hover:text-paper">Open ↗</a>
                  <span className="text-[10px] text-dim font-mono self-center ml-auto">{s.site_key}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Knowledge ──────────────────────────────────────────────────── */}
        <div className="pt-1 border-t border-bdr">
          <div className="flex items-center gap-2 mt-4 mb-1">
            <div className="text-sm font-medium text-paper">What it knows</div>
            <span className="text-xs text-dim font-mono">({kbCount ?? '…'} answers)</span>
            {canWrite && (
              <button onClick={learn} disabled={learning}
                className="ml-auto text-xs text-ember hover:text-ember-deep font-medium disabled:opacity-50">
                {learning ? 'Reading tickets…' : 'Learn from resolved tickets'}
              </button>
            )}
          </div>
          <div className="text-xs text-muted">
            It can only answer from what it has learned — anything else goes to a person. Every resolved
            ticket with a real reply becomes a reusable answer.
          </div>
          {learned && <div className="text-xs text-emerald-600 mt-1">{learned}</div>}

          {docs.length > 0 && (
            <div className="mt-2">
              <button onClick={() => setShowDocs(v => !v)} className="text-xs text-ember hover:text-ember-deep font-medium">
                {showDocs ? 'Hide' : 'Review'} what it knows ({docs.length})
              </button>
              {showDocs && (
                <div className="mt-2 max-h-72 overflow-y-auto space-y-1">
                  {docs.map(d => (
                    <div key={d.id} className="glass-inner rounded-xl px-3 py-2 flex items-center gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-paper truncate">{d.title || d.question}</div>
                        <div className="text-[10px] text-dim truncate">
                          {[d.module, d.category, d.source === 'ticket' ? 'from a ticket' : d.source === 'doc' ? 'from docs' : 'added by hand'].filter(Boolean).join(' · ')}
                        </div>
                      </div>
                      <button onClick={() => saveDoc(d.id, { first_line: !d.first_line })} disabled={!canWrite}
                        title="Try this first for that symptom"
                        className={`px-2 py-0.5 text-[9px] font-bold uppercase rounded shrink-0 ${d.first_line ? 'bg-ember text-white' : 'bg-card text-dim'}`}>
                        Try first
                      </button>
                      <button onClick={() => saveDoc(d.id, { internal_only: !d.internal_only })} disabled={!canWrite}
                        title="Staff only — never said to a customer"
                        className={`px-2 py-0.5 text-[9px] font-bold uppercase rounded shrink-0 ${d.internal_only ? 'bg-amber-500 text-white' : 'bg-card text-dim'}`}>
                        Staff only
                      </button>
                      {canWrite && <button onClick={() => removeDoc(d)} className="text-red-500 hover:text-red-600 text-xs shrink-0">×</button>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {canWrite && (
            <div className="glass-inner rounded-xl p-3 mt-3 space-y-2">
              <div className="text-xs font-medium text-paper">Teach it from supplier documentation</div>
              <div className="grid grid-cols-3 gap-2">
                <input className={input + ' !py-1.5 text-xs col-span-2'} placeholder="https://… supplier help page"
                  value={teach.url} onChange={e => setTeach({ ...teach, url: e.target.value })} />
                <select className={input + ' !py-1.5 text-xs'} value={teach.module}
                  onChange={e => setTeach({ ...teach, module: e.target.value })}>
                  <option value="">Which product?</option>
                  {modules.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <textarea rows={3} className={input + ' resize-none text-xs'} placeholder="…or paste the documentation / your own notes here"
                value={teach.text} onChange={e => setTeach({ ...teach, text: e.target.value })} />
              <div className="flex items-center gap-2">
                <button onClick={teachFrom} disabled={teaching}
                  className="btn-glass px-4 py-1.5 rounded-xl text-xs font-semibold disabled:opacity-50">
                  {teaching ? 'Reading…' : 'Learn from this'}
                </button>
                <span className="text-[10px] text-dim">
                  Tag it with the product so sites only get fixes for the software they actually run.
                </span>
              </div>
            </div>
          )}
        </div>

        {/* ── Playbook ───────────────────────────────────────────────────── */}
        <div className="pt-1 border-t border-bdr">
          <div className="text-sm font-medium text-paper mt-4 mb-2">What it says</div>
          <div className="space-y-2">
            <div><label className={label}>Who you are</label>
              <textarea rows={3} className={input + ' resize-none'} value={pb.business_context || ''} disabled={!canWrite}
                placeholder="Leave blank to use your business name and module list automatically."
                onChange={e => setPb({ ...pb, business_context: e.target.value })}
                onBlur={e => savePb({ business_context: e.target.value })} />
              <div className="text-[10px] text-dim mt-1">
                Stops it inventing a company or product. Blank = built from your business name and the modules you support.
              </div></div>
            <div><label className={label}>Greeting</label>
              <input className={input} value={pb.greeting || ''} disabled={!canWrite}
                onChange={e => setPb({ ...pb, greeting: e.target.value })}
                onBlur={e => savePb({ greeting: e.target.value })} /></div>
            <div><label className={label}>Tone</label>
              <input className={input} value={pb.tone || ''} disabled={!canWrite}
                onChange={e => setPb({ ...pb, tone: e.target.value })}
                onBlur={e => savePb({ tone: e.target.value })} /></div>
            <div><label className={label}>When it doesn't know</label>
              <textarea rows={2} className={input + ' resize-none'} value={pb.unknown_reply || ''} disabled={!canWrite}
                onChange={e => setPb({ ...pb, unknown_reply: e.target.value })}
                onBlur={e => savePb({ unknown_reply: e.target.value })} />
              <div className="text-[10px] text-dim mt-1">Said whenever it isn't sure — and a ticket is raised at the same time.</div></div>
            <div><label className={label}>Names it can sign off as — one per line</label>
              <textarea rows={3} className={input + ' resize-none'} value={lines(pb.persona_names)} disabled={!canWrite}
                placeholder={'Sarah\nJames\nPriya'}
                onChange={e => setPb({ ...pb, persona_names: e.target.value.split('\n') })}
                onBlur={e => savePb({ persona_names: toArr(e.target.value) })} /></div>
          </div>

          <div className="text-sm font-medium text-paper mt-5 mb-2">What it must not do</div>
          <button type="button" disabled={!canWrite} onClick={() => savePb({ ask_location: !pb.ask_location })}
            className="w-full flex items-center gap-3 p-3 glass-inner rounded-xl text-left disabled:opacity-60 mb-2">
            <div className="flex-1">
              <div className="text-sm font-medium text-paper">Always find out the venue first</div>
              <div className="text-xs text-muted">Answers nothing until it knows which site — unless the embed is tied to one</div>
            </div>
            <div className={`relative w-10 h-6 rounded-full transition shrink-0 ${pb.ask_location ? 'bg-emerald-500' : 'bg-slate-300'}`}>
              <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${pb.ask_location ? 'left-[18px]' : 'left-0.5'}`} />
            </div>
          </button>
          <div className="grid grid-cols-2 gap-2">
            <div><label className={label}>Never answer — hand to a person</label>
              <textarea rows={4} className={input + ' resize-none text-xs'} value={lines(pb.never_answer)} disabled={!canWrite}
                placeholder={'pricing\ncontracts\nrefunds'}
                onChange={e => setPb({ ...pb, never_answer: e.target.value.split('\n') })}
                onBlur={e => savePb({ never_answer: toArr(e.target.value) })} /></div>
            <div><label className={label}>Urgent — escalate immediately</label>
              <textarea rows={4} className={input + ' resize-none text-xs'} value={lines(pb.always_escalate)} disabled={!canWrite}
                placeholder={'system down\npayments failing'}
                onChange={e => setPb({ ...pb, always_escalate: e.target.value.split('\n') })}
                onBlur={e => savePb({ always_escalate: toArr(e.target.value) })} /></div>
          </div>
          <div className="text-[11px] text-dim mt-1">Matched against what the customer types. A hit means it never even asks the AI — it raises a ticket.</div>
        </div>
      </div>
    </div>
  );
}

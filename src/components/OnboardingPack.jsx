import { useEffect, useMemo, useState } from 'react';
import { GROUPS, SECTIONS, sectionsIn, visibleFields, missingRequired, summarize, allFiles } from '../lib/onboardingForm';
import BookingInvite from './BookingInvite.jsx';

// The customer's onboarding pack. No login: the token in the URL is the way in.
//
// Shape of the thing: three tabs, one per group, and everything in that group on
// a single scrolling page. An earlier version put all fifteen sections across the
// top as chips, which turned the first thing you see into a wall of navigation.
// Three tabs is the whole map, and scrolling beats hunting.
//
// Written for someone filling this in on a phone between services: it saves as
// they go, and files upload the moment they are picked so a 20MB menu is never
// stuck behind the send button.

const FN_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/onboarding-form`;
const call = async (payload) => {
  const res = await fetch(FN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Something went wrong.');
  return d;
};

export default function OnboardingPack({ token }) {
  const [state, setState] = useState({ loading: true, error: '', venue: '', submitted: false });
  const [answers, setAnswers] = useState({});
  const [tab, setTab] = useState(0);
  const [uploading, setUploading] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [showMissing, setShowMissing] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const d = await call({ token, action: 'load' });
        setAnswers(d.answers || {});
        setState({ loading: false, error: '', venue: d.venue || '', submitted: !!d.submitted });
      } catch (e) {
        setState({ loading: false, error: e.message, venue: '', submitted: false });
      }
    })();
  }, [token]);

  const set = (sectionKey, fieldKey, value) =>
    setAnswers((prev) => ({ ...prev, [sectionKey]: { ...(prev[sectionKey] || {}), [fieldKey]: value } }));

  const missing = useMemo(() => missingRequired(answers), [answers]);
  const owedIn = (groupKey) => {
    const titles = new Set(sectionsIn(groupKey).map((s) => s.title));
    return missing.filter((m) => titles.has(m.section)).length;
  };
  const totalRequired = useMemo(() => missingRequired({}).length, []);
  const doneCount = Math.max(0, totalRequired - missing.length);
  const pct = totalRequired ? Math.round((doneCount / totalRequired) * 100) : 100;

  const upload = async (sectionKey, field, fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const busyKey = `${sectionKey}.${field.key}`;
    setUploading((u) => ({ ...u, [busyKey]: true }));
    try {
      const stored = [];
      for (const file of files) {
        const { path, signedUrl, name } = await call({ token, action: 'upload-url', fileName: file.name, size: file.size });
        const put = await fetch(signedUrl, {
          method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file,
        });
        if (!put.ok) throw new Error(`Could not upload ${file.name}.`);
        stored.push({ name, path, size: file.size, mime: file.type || null });
      }
      const existing = (answers[sectionKey] || {})[field.key];
      const prev = Array.isArray(existing) ? existing : existing ? [existing] : [];
      set(sectionKey, field.key, field.multiple ? [...prev, ...stored] : stored[0]);
    } catch (e) { alert(e.message); }
    setUploading((u) => ({ ...u, [busyKey]: false }));
  };

  const removeFile = (sectionKey, field, path) => {
    const v = (answers[sectionKey] || {})[field.key];
    if (field.multiple) set(sectionKey, field.key, (Array.isArray(v) ? v : []).filter((f) => f.path !== path));
    else set(sectionKey, field.key, null);
  };

  const submit = async () => {
    if (missing.length) {
      setShowMissing(true);
      const first = GROUPS.findIndex((g) => owedIn(g.key) > 0);
      if (first >= 0) setTab(first);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    setSubmitting(true);
    try {
      await call({ token, action: 'submit', answers, files: allFiles(answers), summary: summarize(answers) });
      setState((s) => ({ ...s, submitted: true }));
      window.scrollTo(0, 0);
    } catch (e) { alert(e.message); }
    setSubmitting(false);
  };

  if (state.loading) return <Frame><div className="py-24 text-center text-slate-400 text-sm">Loading…</div></Frame>;
  if (state.error) return (
    <Frame><div className="py-20 text-center">
      <div className="text-4xl mb-3">🔒</div>
      <div className="text-slate-700 max-w-sm mx-auto">{state.error}</div>
    </div></Frame>
  );
  if (state.submitted) return (
    <Frame><div className="py-20 text-center">
      <div className="w-16 h-16 rounded-full bg-emerald-100 text-emerald-600 text-3xl flex items-center justify-center mx-auto mb-5">✓</div>
      <h1 className="text-2xl font-bold text-slate-900 mb-2">That's everything, thank you</h1>
      <p className="text-slate-600 text-[15px] max-w-md mx-auto leading-relaxed">
        Your pack is with our team{state.venue ? <> for <strong>{state.venue}</strong></> : null}. We'll be in touch if
        anything needs clarifying, and you'll hear from us with next steps shortly.
      </p>
      <div className="mt-8 text-left">
        <BookingInvite venue={state.venue} prefill={{
          name: answers?.company?.contact_name || answers?.signoff?.full_name || '',
        }} />
      </div>
    </div></Frame>
  );

  const group = GROUPS[tab];
  const sections = sectionsIn(group.key);

  return (
    <Frame>
      {/* Header: what this is, who it's for, how far through */}
      <div className="pt-7 pb-5">
        <h1 className="text-[26px] leading-tight font-bold text-slate-900">Onboarding pack</h1>
        <p className="text-[15px] text-slate-600 mt-1">
          {state.venue ? <>Setting up <span className="font-semibold text-slate-800">{state.venue}</span>. </> : null}
          It saves as you go, so you can stop and come back.
        </p>
        <div className="mt-4 flex items-center gap-3">
          <div className="flex-1 h-2 bg-slate-200 rounded-full overflow-hidden">
            <div className="h-full bg-emerald-500 rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
          </div>
          <span className="text-xs font-semibold text-slate-500 tabular-nums shrink-0">{pct}%</span>
        </div>
      </div>

      {/* Three tabs. The whole map of the form. */}
      <div className="sticky top-0 z-10 -mx-4 px-4 py-2 bg-slate-100/95 backdrop-blur">
        <div className="flex gap-1 p-1 bg-slate-200/70 rounded-xl">
          {GROUPS.map((g, i) => {
            const owed = owedIn(g.key);
            const active = i === tab;
            return (
              <button key={g.key} onClick={() => { setTab(i); window.scrollTo({ top: 0 }); }}
                className={`flex-1 px-2 py-2 rounded-lg text-[13px] font-semibold transition flex items-center justify-center gap-1.5 ${
                  active ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}>
                <span className="truncate">{g.short}</span>
                {owed > 0
                  ? <span className="shrink-0 min-w-[18px] h-[18px] px-1 rounded-full bg-amber-400 text-amber-950 text-[10px] font-bold flex items-center justify-center">{owed}</span>
                  : <span className="shrink-0 text-emerald-600 text-xs">✓</span>}
              </button>
            );
          })}
        </div>
      </div>

      <p className="text-[13px] text-slate-500 mt-3 mb-3">{group.blurb}</p>

      {/* Everything in this group, one scroll */}
      <div className="space-y-3 pb-28">
        {sections.map((section) => {
          const a = answers[section.key] || {};
          return (
            <section key={section.key} className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
              <h2 className="text-[15px] font-bold text-slate-900">{section.title}</h2>
              {section.hint && <p className="text-xs text-slate-500 mt-1 mb-1 whitespace-pre-line leading-relaxed">{section.hint}</p>}

              <div className="space-y-4 mt-4">
                {visibleFields(section, answers).map((f) => {
                  const v = a[f.key];
                  const busy = uploading[`${section.key}.${f.key}`];

                  // The declaration itself: read-only, and deliberately set
                  // apart so it does not read as another question to fill in.
                  if (f.type === 'terms') {
                    return (
                      <div key={f.key} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                        <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500 mb-2">{f.label}</div>
                        <ol className="space-y-2 text-[13px] text-slate-700 leading-relaxed list-decimal pl-4 marker:text-slate-400">
                          {f.clauses.map((c, i) => <li key={i}>{c}</li>)}
                        </ol>
                      </div>
                    );
                  }

                  if (f.type === 'confirm') {
                    return (
                      <label key={f.key}
                        className={`flex gap-3 p-3.5 rounded-xl border cursor-pointer transition ${
                          v === true ? 'bg-emerald-50 border-emerald-300' : 'bg-slate-50 border-slate-200 hover:border-slate-400'}`}>
                        <input type="checkbox" checked={v === true} onChange={(e) => set(section.key, f.key, e.target.checked)}
                          className="mt-0.5 w-5 h-5 accent-emerald-600 shrink-0" />
                        <span className="min-w-0">
                          <span className="block text-sm font-semibold text-slate-800">
                            {f.label}{f.required && <span className="text-red-500 ml-0.5">*</span>}
                          </span>
                          {f.hint && <span className="block text-xs text-slate-500 mt-1 whitespace-pre-line">{f.hint}</span>}
                        </span>
                      </label>
                    );
                  }

                  const files = Array.isArray(v) ? v : v ? [v] : [];
                  return (
                    <div key={f.key}>
                      <label className="block text-sm font-semibold text-slate-800">
                        {f.label}{f.required && <span className="text-red-500 ml-0.5">*</span>}
                      </label>
                      {f.hint && <p className="text-xs text-slate-500 mt-0.5 mb-1.5 whitespace-pre-line leading-relaxed">{f.hint}</p>}

                      {f.type === 'text' && (
                        <input className={INPUT} value={v || ''} onChange={(e) => set(section.key, f.key, e.target.value)} />
                      )}
                      {f.type === 'textarea' && (
                        <textarea rows={5} className={INPUT + ' resize-y leading-relaxed'} value={v || ''}
                          onChange={(e) => set(section.key, f.key, e.target.value)} />
                      )}
                      {f.type === 'choice' && (
                        <div className="flex flex-wrap gap-2 mt-1">
                          {f.options.map((o) => (
                            <button key={o} type="button" onClick={() => set(section.key, f.key, v === o ? '' : o)}
                              className={`px-4 py-2 rounded-xl text-sm font-semibold border transition ${
                                v === o ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-700 border-slate-300 hover:border-slate-500'}`}>
                              {o}
                            </button>
                          ))}
                        </div>
                      )}
                      {f.type === 'file' && (
                        <div className="mt-1">
                          {files.length > 0 && (
                            <div className="space-y-1.5 mb-2">
                              {files.map((file) => (
                                <div key={file.path} className="flex items-center gap-2.5 px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl">
                                  <span className="text-slate-400 shrink-0">📎</span>
                                  <span className="text-sm text-slate-800 truncate flex-1 min-w-0">{file.name}</span>
                                  <span className="text-[11px] text-slate-400 font-mono shrink-0">{(file.size / 1048576).toFixed(1)}MB</span>
                                  <button onClick={() => removeFile(section.key, f, file.path)}
                                    className="text-slate-300 hover:text-red-600 text-xl leading-none shrink-0 px-1">×</button>
                                </div>
                              ))}
                            </div>
                          )}
                          <label className={`flex items-center justify-center gap-2 px-4 py-3.5 border-2 border-dashed rounded-xl transition ${
                            busy ? 'border-slate-200 text-slate-400' : 'border-slate-300 text-slate-600 hover:border-slate-900 hover:text-slate-900 cursor-pointer'}`}>
                            <input type="file" className="hidden" multiple={!!f.multiple} disabled={!!busy}
                              onChange={(e) => { upload(section.key, f, e.target.files); e.target.value = ''; }} />
                            <span className="text-sm font-semibold">
                              {busy ? 'Uploading…' : files.length ? '+ Add another file' : 'Choose file'}
                            </span>
                          </label>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}

        {tab === GROUPS.length - 1 && (
          <BookingInvite venue={state.venue} compact prefill={{
            name: answers?.company?.contact_name || answers?.signoff?.full_name || '',
          }} />
        )}

        {showMissing && missing.length > 0 && (
          <div className="p-4 bg-amber-50 border border-amber-200 rounded-2xl">
            <div className="text-sm font-bold text-amber-900 mb-1.5">Still needed before you can send</div>
            <ul className="text-[13px] text-amber-900 space-y-1">
              {missing.map((m, i) => <li key={i}><span className="text-amber-700">{m.section}</span> — {m.field}</li>)}
            </ul>
          </div>
        )}
      </div>

      {/* One action, always reachable */}
      <div className="fixed bottom-0 left-0 right-0 bg-white/95 backdrop-blur border-t border-slate-200 px-4 py-3">
        <div className="max-w-2xl mx-auto flex items-center gap-3">
          <div className="text-xs text-slate-500 min-w-0 flex-1">
            {missing.length === 0
              ? <span className="text-emerald-700 font-semibold">Everything's answered</span>
              : <>{missing.length} still needed{owedIn(group.key) === 0 ? ', on another tab' : ''}</>}
          </div>
          {tab < GROUPS.length - 1 ? (
            <button onClick={() => { setTab(tab + 1); window.scrollTo({ top: 0 }); }}
              className="px-5 py-2.5 rounded-xl text-sm font-bold bg-slate-900 text-white hover:bg-slate-800 shrink-0">
              Next: {GROUPS[tab + 1].short}
            </button>
          ) : (
            <button disabled={submitting} onClick={submit}
              className="px-6 py-2.5 rounded-xl text-sm font-bold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 shrink-0">
              {submitting ? 'Sending…' : 'Send to our team'}
            </button>
          )}
        </div>
      </div>
    </Frame>
  );
}

const INPUT = "w-full px-3.5 py-2.5 bg-white border border-slate-300 rounded-xl text-[15px] text-slate-900 placeholder-slate-400 focus:outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-900/10";

function Frame({ children }) {
  return (
    <div className="min-h-screen bg-slate-100">
      <div className="max-w-2xl mx-auto px-4">{children}</div>
    </div>
  );
}

import { useEffect, useState, useRef } from 'react';

const FN_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/forms-public`;

export default function PublicForm({ slug }) {
  const [form, setForm] = useState(null);
  const [branding, setBranding] = useState({});
  const [values, setValues] = useState({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const recaptchaRef = useRef(null);
  const widgetId = useRef(null);
  const siteKey = branding?.recaptcha_site_key || null;

  const src = new URLSearchParams(window.location.search).get('src');

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${FN_URL}?slug=${encodeURIComponent(slug)}`);
        const d = await res.json();
        if (!res.ok) { setError(d.error || 'Form not found.'); }
        else { setForm(d.form); setBranding(d.branding || {}); }
      } catch {
        setError('Could not load this form.');
      }
      setLoading(false);
    })();
  }, [slug]);

  // reCAPTCHA v2 — load Google's script + render the checkbox once we know the site key.
  useEffect(() => {
    if (!siteKey || done) return;
    const renderWidget = () => {
      if (window.grecaptcha?.render && recaptchaRef.current && widgetId.current === null) {
        try { widgetId.current = window.grecaptcha.render(recaptchaRef.current, { sitekey: siteKey }); } catch { /* already rendered */ }
      }
    };
    if (window.grecaptcha?.render) { renderWidget(); return; }
    if (!document.getElementById('recaptcha-api')) {
      const sc = document.createElement('script');
      sc.id = 'recaptcha-api'; sc.src = 'https://www.google.com/recaptcha/api.js?render=explicit';
      sc.async = true; sc.defer = true; document.head.appendChild(sc);
    }
    const iv = setInterval(() => { if (window.grecaptcha?.render) { clearInterval(iv); renderWidget(); } }, 200);
    return () => clearInterval(iv);
  }, [siteKey, done]);

  const accent = form?.settings?.accent || '#E8743C';
  const bgColor = form?.settings?.bg_color || '#F1F5F9';
  const showLogo = form?.settings?.show_logo !== false && branding?.logo_url;
  const cols = Math.min(3, Math.max(1, Number(form?.settings?.columns) || 1));
  const maxW = cols >= 3 ? 'max-w-3xl' : cols === 2 ? 'max-w-2xl' : 'max-w-md';
  const gridCols = cols === 3 ? 'sm:grid-cols-3' : cols === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-1';

  const setVal = (k, v) => setValues(prev => ({ ...prev, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    let recaptcha_token = '';
    if (siteKey) {
      recaptcha_token = window.grecaptcha?.getResponse(widgetId.current) || '';
      if (!recaptcha_token) { setError('Please tick the reCAPTCHA box.'); setSubmitting(false); return; }
    }
    try {
      const res = await fetch(FN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug,
          data: values,
          recaptcha_token,
          src,
          page_url: document.referrer || window.location.href,
          referrer: document.referrer || null,
        }),
      });
      const d = await res.json();
      if (!res.ok) { setError(d.error || 'Something went wrong.'); window.grecaptcha?.reset(widgetId.current); setSubmitting(false); return; }
      if (d.redirect_url) { window.location.href = d.redirect_url; return; }
      setForm(f => ({ ...f, _successMessage: d.message }));
      setDone(true);
    } catch {
      setError('Could not submit. Please try again.');
    }
    setSubmitting(false);
  };

  const wrap = (children) => (
    <div className="min-h-screen w-full flex items-center justify-center p-4" style={{ backgroundColor: bgColor }}>
      <div className={`w-full ${maxW} bg-white rounded-2xl shadow-sm border border-slate-200 p-6 sm:p-8`}>
        {showLogo && <img src={branding.logo_url} alt={branding.business_name || ''} className="h-12 object-contain mb-5 mx-auto" />}
        {children}
      </div>
    </div>
  );

  if (loading) return wrap(<div className="text-center text-slate-400 text-sm py-8">Loading…</div>);
  if (error && !form) return wrap(<div className="text-center text-slate-600 text-sm py-8">{error}</div>);

  if (done) return wrap(
    <div className="text-center py-6">
      <div className="w-12 h-12 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center text-2xl mx-auto mb-3">✓</div>
      <div className="text-lg font-bold text-slate-800 mb-1">Thank you</div>
      <div className="text-sm text-slate-500">{form?._successMessage || "We'll be in touch shortly."}</div>
    </div>
  );

  const input = "w-full px-3 py-2.5 bg-white border border-slate-300 rounded-lg text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-orange-400 focus:border-transparent";
  const label = "block text-xs font-semibold text-slate-600 mb-1";

  return wrap(
    <form onSubmit={submit} className="space-y-4">
      <div>
        <div className="text-xl font-bold text-slate-800">{form.name}</div>
        {form.description && <div className="text-sm text-slate-500 mt-1">{form.description}</div>}
      </div>

      <div className={`grid gap-4 ${gridCols}`}>
      {(form.fields || []).map(f => (
        <div key={f.key} className={(f.type === 'textarea' || f.type === 'file') ? 'sm:col-span-full' : ''}>
          <label className={label}>{f.label}{f.required && <span style={{ color: accent }}> *</span>}</label>
          {f.type === 'textarea' ? (
            <textarea className={input + ' resize-none'} rows={4} required={f.required}
              placeholder={f.placeholder || ''} value={values[f.key] || ''}
              onChange={e => setVal(f.key, e.target.value)} />
          ) : f.type === 'select' ? (
            <select className={input} required={f.required} value={values[f.key] || ''}
              onChange={e => setVal(f.key, e.target.value)}>
              <option value="">{f.placeholder || 'Select…'}</option>
              {(f.options || []).map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : (
            <input className={input} type={f.type || 'text'} required={f.required}
              placeholder={f.placeholder || ''} value={values[f.key] || ''}
              onChange={e => setVal(f.key, e.target.value)} />
          )}
        </div>
      ))}
      </div>

      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

      {siteKey && <div ref={recaptchaRef} className="flex justify-center my-1" />}
      <button type="submit" disabled={submitting} style={{ backgroundColor: accent }}
        className="w-full py-2.5 text-white text-sm font-semibold rounded-lg transition hover:opacity-90 disabled:opacity-50">
        {submitting ? 'Sending…' : (form.settings?.submit_label || 'Submit')}
      </button>

      <div className="text-center text-[10px] text-slate-300 pt-1">Powered by ServOS</div>
    </form>
  );
}

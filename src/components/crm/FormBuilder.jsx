import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';

const FIELD_TYPES = ['text', 'email', 'tel', 'textarea', 'select'];
const MAPS_COMMON = [
  { v: 'none', l: "Don't map (store as note)" },
  // Contact
  { v: 'first_name', l: 'Contact · First name' },
  { v: 'last_name', l: 'Contact · Last name' },
  { v: 'email', l: 'Contact · Email' },
  { v: 'phone', l: 'Contact · Phone' },
  { v: 'job_title', l: 'Contact · Job title' },
  // Company
  { v: 'company_name', l: 'Company · Name' },
  { v: 'company_domain', l: 'Company · Domain' },
  { v: 'company_city', l: 'Company · City' },
  // Location
  { v: 'location_name', l: 'Location · Name' },
  { v: 'location_address', l: 'Location · Address' },
  { v: 'location_city', l: 'Location · City' },
  { v: 'location_postcode', l: 'Location · Postcode' },
  { v: 'message', l: 'Message / notes' },
];
const MAPS_LEAD = [
  { v: 'venue_type', l: 'Lead · Venue type' },
  { v: 'covers', l: 'Lead · Covers' },
  { v: 'current_pos', l: 'Lead · Current POS' },
];
const MAPS_SUPPORT = [{ v: 'subject', l: 'Ticket · Subject' }];

function fieldKey(label, existing) {
  let base = (label || 'field').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'field';
  let key = base, i = 2;
  while (existing.includes(key)) { key = `${base}_${i++}`; }
  return key;
}

export default function FormBuilder({ formId, profile, onClose, onNavigate }) {
  const [form, setForm] = useState(null);
  const [subs, setSubs] = useState([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState('');

  const canWrite = profile.role === 'owner' || profile.role === 'editor';
  const mapsOptions = (dest) => [...MAPS_COMMON, ...(dest === 'support' ? MAPS_SUPPORT : MAPS_LEAD)];

  useEffect(() => { load(); }, [formId]);

  const load = async () => {
    const [f, s] = await Promise.all([
      supabase.from('forms').select('*').eq('id', formId).single(),
      supabase.from('form_submissions').select('*').eq('form_id', formId).order('created_at', { ascending: false }).limit(50),
    ]);
    setForm(f.data);
    setSubs(s.data || []);
  };

  const set = (k, v) => setForm(prev => ({ ...prev, [k]: v }));
  const setSetting = (k, v) => setForm(prev => ({ ...prev, settings: { ...(prev.settings || {}), [k]: v } }));

  const updateField = (idx, patch) => setForm(prev => {
    const fields = [...prev.fields];
    fields[idx] = { ...fields[idx], ...patch };
    return { ...prev, fields };
  });
  const addField = () => setForm(prev => {
    const keys = (prev.fields || []).map(f => f.key);
    return { ...prev, fields: [...(prev.fields || []), { key: fieldKey('field', keys), label: 'New field', type: 'text', required: false, maps_to: 'none' }] };
  });
  const removeField = (idx) => setForm(prev => ({ ...prev, fields: prev.fields.filter((_, i) => i !== idx) }));
  const moveField = (idx, dir) => setForm(prev => {
    const fields = [...prev.fields];
    const j = idx + dir;
    if (j < 0 || j >= fields.length) return prev;
    [fields[idx], fields[j]] = [fields[j], fields[idx]];
    return { ...prev, fields };
  });

  const save = async () => {
    setSaving(true); setSaved(false);
    // Ensure keys are present/unique
    const seen = [];
    const fields = (form.fields || []).map(f => {
      let key = f.key || fieldKey(f.label, seen);
      if (seen.includes(key)) key = fieldKey(f.label, seen);
      seen.push(key);
      return { ...f, key };
    });
    const { error } = await supabase.from('forms').update({
      name: form.name, description: form.description || null, destination: form.destination,
      source_tag: form.source_tag || null, fields, settings: form.settings || {}, enabled: form.enabled,
    }).eq('id', formId);
    setSaving(false);
    if (error) { alert('Save failed: ' + error.message); return; }
    setSaved(true); setTimeout(() => setSaved(false), 2500);
    load();
  };

  const deleteForm = async () => {
    if (!confirm(`Delete form "${form.name}"? Submissions are kept but the form stops working.`)) return;
    await supabase.from('forms').delete().eq('id', formId);
    onClose();
  };

  const copy = (text, which) => { navigator.clipboard.writeText(text); setCopied(which); setTimeout(() => setCopied(''), 1500); };

  if (!form) return <div className="h-full flex items-center justify-center text-dim text-sm">Loading…</div>;

  const publicUrl = `${window.location.origin}/f/${form.slug}`;
  const iframeCode = `<iframe src="${publicUrl}" style="width:100%;max-width:480px;height:640px;border:0;" title="${form.name}"></iframe>`;

  const input = "w-full px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper placeholder-dim focus:outline-none focus:border-ember";
  const label = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block";

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 py-4 border-b border-bdr flex items-center gap-3">
        <button onClick={onClose} className="text-muted hover:text-paper text-lg">&larr;</button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <div className="text-xl font-bold text-paper truncate">{form.name}</div>
            <span className={`px-1.5 py-0.5 text-[9px] font-bold uppercase rounded ${form.destination === 'support' ? 'bg-purple-100 text-purple-700 border border-purple-200' : 'bg-orange-100 text-orange-700 border border-orange-200'}`}>
              {form.destination === 'support' ? 'Support' : 'Lead'}
            </span>
          </div>
          <div className="text-[10px] text-dim font-mono">/f/{form.slug}</div>
        </div>
        {canWrite && (
          <div className="flex items-center gap-2">
            {saved && <span className="text-sm text-emerald-600 font-medium">✓ Saved</span>}
            <button onClick={save} disabled={saving} className="btn-glass px-5 py-2 rounded-xl text-sm font-semibold disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>
            {profile.role === 'owner' && <button onClick={deleteForm} className="px-3 py-2 text-xs text-red-600 border border-red-200 rounded-xl hover:bg-red-50">Delete</button>}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="grid grid-cols-12 gap-4 max-w-[1400px]">

          {/* LEFT: settings */}
          <div className="col-span-4 space-y-4">
            <Card title="Settings">
              <div className="space-y-3">
                <div><label className={label}>Form name</label><input className={input} value={form.name} onChange={e => set('name', e.target.value)} /></div>
                <div><label className={label}>Description</label><textarea className={input + ' resize-none'} rows={2} value={form.description || ''} onChange={e => set('description', e.target.value)} placeholder="Shown under the title" /></div>
                <div className="grid grid-cols-2 gap-3">
                  <div><label className={label}>Submissions go to</label>
                    <select className={input} value={form.destination} onChange={e => set('destination', e.target.value)}>
                      <option value="lead">Leads pipeline</option><option value="support">Support inbox</option>
                    </select></div>
                  <div><label className={label}>Source tag</label><input className={input} value={form.source_tag || ''} onChange={e => set('source_tag', e.target.value)} placeholder="homepage" /></div>
                </div>
                <div><label className={label}>Submit button label</label><input className={input} value={form.settings?.submit_label || ''} onChange={e => setSetting('submit_label', e.target.value)} placeholder="Submit" /></div>
                <div><label className={label}>Layout columns</label>
                  <select className={input} value={form.settings?.columns || 1} onChange={e => setSetting('columns', Number(e.target.value))}>
                    <option value={1}>1 column</option><option value={2}>2 columns</option><option value={3}>3 columns</option>
                  </select></div>
                <div><label className={label}>Success message</label><textarea className={input + ' resize-none'} rows={2} value={form.settings?.success_message || ''} onChange={e => setSetting('success_message', e.target.value)} placeholder="Thanks — we'll be in touch." /></div>
                <div><label className={label}>Redirect URL (optional)</label><input className={input} value={form.settings?.redirect_url || ''} onChange={e => setSetting('redirect_url', e.target.value)} placeholder="https://… after submit" /></div>
                <div><label className={label}>Default priority</label>
                  <select className={input} value={form.settings?.default_priority || (form.destination === 'support' ? 'P2' : 'warm')} onChange={e => setSetting('default_priority', e.target.value)}>
                    {form.destination === 'support'
                      ? ['P0','P1','P2','P3'].map(p => <option key={p} value={p}>{p}</option>)
                      : ['hot','warm','medium','cold'].map(p => <option key={p} value={p}>{p}</option>)}
                  </select></div>
                <label className="flex items-center gap-2 pt-1 cursor-pointer">
                  <input type="checkbox" checked={form.enabled} onChange={e => set('enabled', e.target.checked)} />
                  <span className="text-sm text-paper">Form is live</span>
                </label>
              </div>
            </Card>

            {/* Look & feel */}
            <Card title="Look &amp; feel">
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div><label className={label}>Accent colour</label>
                    <div className="flex gap-2 items-center">
                      <input type="color" value={form.settings?.accent || '#E8743C'} onChange={e => setSetting('accent', e.target.value)} className="w-10 h-9 rounded border border-bdr bg-card" />
                      <input className={input + ' font-mono'} value={form.settings?.accent || '#E8743C'} onChange={e => setSetting('accent', e.target.value)} />
                    </div>
                    <div className="text-[10px] text-dim mt-1">Buttons, focus &amp; required marks</div>
                  </div>
                  <div><label className={label}>Background</label>
                    <div className="flex gap-2 items-center">
                      <input type="color" value={form.settings?.bg_color || '#F1F5F9'} onChange={e => setSetting('bg_color', e.target.value)} className="w-10 h-9 rounded border border-bdr bg-card" />
                      <input className={input + ' font-mono'} value={form.settings?.bg_color || '#F1F5F9'} onChange={e => setSetting('bg_color', e.target.value)} />
                    </div>
                    <div className="text-[10px] text-dim mt-1">Page behind the form</div>
                  </div>
                </div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={form.settings?.show_logo !== false} onChange={e => setSetting('show_logo', e.target.checked)} />
                  <span className="text-sm text-paper">Show our logo at the top</span>
                </label>
                <div><label className={label}>Button label</label><input className={input} value={form.settings?.submit_label || ''} onChange={e => setSetting('submit_label', e.target.value)} placeholder="Submit" /></div>
              </div>
            </Card>

            {/* Embed */}
            <Card title="Embed on your website">
              <div className="space-y-3">
                <div>
                  <label className={label}>Public link</label>
                  <div className="flex gap-2">
                    <input readOnly value={publicUrl} className={input + ' font-mono text-xs'} onFocus={e => e.target.select()} />
                    <button onClick={() => copy(publicUrl, 'url')} className="px-2 py-1 text-xs btn-ghost rounded-xl shrink-0">{copied === 'url' ? '✓' : 'Copy'}</button>
                  </div>
                </div>
                <div>
                  <label className={label}>Iframe embed code</label>
                  <textarea readOnly value={iframeCode} rows={3} className={input + ' font-mono text-[10px] resize-none'} onFocus={e => e.target.select()} />
                  <button onClick={() => copy(iframeCode, 'iframe')} className="mt-1 px-2 py-1 text-xs btn-ghost rounded-xl">{copied === 'iframe' ? '✓ Copied' : 'Copy code'}</button>
                </div>
                <div className="text-[11px] text-dim leading-relaxed pt-1 border-t border-bdr">
                  Use the same form on different pages and tag each one by adding <code className="bg-slate-100 px-1 rounded">?src=pricing</code> to the link, e.g. <span className="font-mono break-all">{publicUrl}?src=pricing</span>. That source is recorded on every lead/ticket.
                </div>
              </div>
            </Card>
          </div>

          {/* MIDDLE: fields */}
          <div className="col-span-4 space-y-4">
            <Card title="Fields" count={(form.fields || []).length}
              action={canWrite ? { label: '+ Add field', onClick: addField } : null}>
              <div className="space-y-3">
                {(form.fields || []).map((f, idx) => (
                  <div key={idx} className="glass-inner rounded-xl p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <input className={input} value={f.label} onChange={e => updateField(idx, { label: e.target.value })} placeholder="Field label" />
                      <div className="flex flex-col">
                        <button onClick={() => moveField(idx, -1)} className="text-dim hover:text-paper text-[10px] leading-none">▲</button>
                        <button onClick={() => moveField(idx, 1)} className="text-dim hover:text-paper text-[10px] leading-none">▼</button>
                      </div>
                      <button onClick={() => removeField(idx)} className="text-red-500 hover:text-red-600 text-sm shrink-0">×</button>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <select className={input + ' text-xs'} value={f.type} onChange={e => updateField(idx, { type: e.target.value })}>
                        {FIELD_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                      <select className={input + ' text-xs'} value={f.maps_to || 'none'} onChange={e => updateField(idx, { maps_to: e.target.value })}>
                        {mapsOptions(form.destination).map(m => <option key={m.v} value={m.v}>{m.l}</option>)}
                      </select>
                    </div>
                    {f.type === 'select' && (
                      <input className={input + ' text-xs'} value={(f.options || []).join(', ')}
                        onChange={e => updateField(idx, { options: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
                        placeholder="Options, comma separated" />
                    )}
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={!!f.required} onChange={e => updateField(idx, { required: e.target.checked })} />
                      <span className="text-xs text-muted">Required</span>
                    </label>
                  </div>
                ))}
                {(form.fields || []).length === 0 && <div className="text-xs text-dim italic text-center py-4">No fields yet.</div>}
              </div>
            </Card>
          </div>

          {/* RIGHT: submissions */}
          <div className="col-span-4 space-y-4">
            <Card title="Recent submissions" count={subs.length}>
              {subs.length === 0 ? (
                <div className="text-xs text-dim italic py-4 text-center">No submissions yet.</div>
              ) : (
                <div className="space-y-2">
                  {subs.map(s => (
                    <div key={s.id} className="glass-inner rounded-xl p-3">
                      <div className="flex items-center justify-between mb-1">
                        <div className="text-[10px] text-dim font-mono">{new Date(s.created_at).toLocaleString('en-GB', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' })}</div>
                        {s.source_tag && <span className="text-[9px] px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded">{s.source_tag}</span>}
                      </div>
                      <div className="text-xs text-paper space-y-0.5">
                        {Object.entries(s.data || {}).slice(0, 4).map(([k, v]) => (
                          <div key={k} className="truncate"><span className="text-dim">{k}:</span> {String(v)}</div>
                        ))}
                      </div>
                      <div className="flex gap-2 mt-2">
                        {s.created_lead_id && <button onClick={() => onNavigate?.('lead', s.created_lead_id)} className="text-[10px] text-ember hover:underline">View lead →</button>}
                        {s.created_ticket_id && <button onClick={() => onNavigate?.('ticket', s.created_ticket_id)} className="text-[10px] text-ember hover:underline">View ticket →</button>}
                        {s.status === 'error' && <span className="text-[10px] text-red-600">Error: {s.error}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}

function Card({ title, count, action, children }) {
  return (
    <div className="glass-card rounded-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-bdr flex items-center gap-2">
        <h3 className="text-sm font-bold text-paper">{title}</h3>
        {count !== undefined && <span className="text-xs text-dim font-mono">({count})</span>}
        {action && <button onClick={action.onClick} className="ml-auto text-xs text-ember hover:text-ember-deep font-medium">{action.label}</button>}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

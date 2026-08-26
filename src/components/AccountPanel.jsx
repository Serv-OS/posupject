import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { TEAM_LABELS } from './UsersPanel.jsx';

import { getGoogleClientId } from '../lib/googleClientId';
const REDIRECT_URI = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/gmail-oauth-callback`;
const PERSONAL_SCOPES = 'openid email https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/chat.spaces.readonly https://www.googleapis.com/auth/chat.messages https://www.googleapis.com/auth/chat.memberships.readonly https://www.googleapis.com/auth/directory.readonly';

// My Account: a user sets their own contact details + notification preferences.
// Email notifications go to profile.email; SMS notifications go to profile.mobile.
export default function AccountPanel({ profile, onSaved }) {
  const [form, setForm] = useState({ display_name: '', phone: '', mobile: '', timezone: '' });
  const [teams, setTeams] = useState([]);
  const [prefs, setPrefs] = useState({
    email_enabled: true,
    sms_enabled: false,
    chat_dm_enabled: false,
    notify_on_mention: true,
    notify_on_assignment: true,
    notify_on_reply: true,
    quiet_hours_start: '',
    quiet_hours_end: '',
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [google, setGoogle] = useState(null);
  const [dmTest, setDmTest] = useState(null);
  const sendDmTest = async () => {
    setDmTest('sending');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/notify-dispatch`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ test_dm: profile.email }),
      });
      const d = await res.json().catch(() => ({}));
      setDmTest(res.ok ? 'sent' : ('error: ' + (d.error || res.status)));
    } catch (e) { setDmTest('error: ' + e.message); }
  };
  const [signature, setSignature] = useState('');
  const [signatureLogo, setSignatureLogo] = useState(false);
  const [brandingLogo, setBrandingLogo] = useState(null);

  useEffect(() => {
    load();
    const handler = (e) => {
      if (e.data?.type === 'google-oauth-result') {
        if (e.data.success) load(); else setError('Google connection failed: ' + e.data.detail);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [profile.id]);

  const connectGoogle = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    const clientId = await getGoogleClientId();
    const url = 'https://accounts.google.com/o/oauth2/v2/auth?' +
      `client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&response_type=code&access_type=offline&prompt=consent` +
      `&scope=${encodeURIComponent(PERSONAL_SCOPES)}` +
      `&state=${encodeURIComponent('personal:' + (session?.access_token || ''))}`;
    const w = 500, h = 640;
    window.open(url, 'google-oauth', `width=${w},height=${h},left=${(screen.width - w) / 2},top=${(screen.height - h) / 2}`);
  };

  const disconnectGoogle = async () => {
    if (!confirm('Disconnect your Google account? Your inbox and calendar features will stop working.')) return;
    await supabase.from('user_integrations').delete().eq('profile_id', profile.id);
    setGoogle(null);
  };

  const load = async () => {
    setLoading(true);
    const [p, np, gi] = await Promise.all([
      supabase.from('profiles').select('display_name, phone, mobile, email, teams, timezone').eq('id', profile.id).single(),
      supabase.from('notification_preferences').select('*').eq('profile_id', profile.id).maybeSingle(),
      supabase.from('user_integrations').select('email, scope').eq('profile_id', profile.id).maybeSingle(),
    ]);
    setGoogle(gi.data || null);
    // Signature loaded separately so a missing column never breaks the page.
    try {
      const { data: sig } = await supabase.from('profiles').select('email_signature, email_signature_logo').eq('id', profile.id).maybeSingle();
      setSignature(sig?.email_signature || '');
      setSignatureLogo(!!sig?.email_signature_logo);
    } catch { /* columns may not exist yet */ }
    supabase.from('support_settings').select('logo_url').eq('id', 1).maybeSingle()
      .then(r => setBrandingLogo(r.data?.logo_url || null));
    if (p.data) {
      setForm({
        display_name: p.data.display_name || '',
        phone: p.data.phone || '',
        mobile: p.data.mobile || '',
        timezone: p.data.timezone || '',
      });
      setTeams(p.data.teams || []);
    }
    if (np.data) {
      setPrefs({
        email_enabled: np.data.email_enabled,
        sms_enabled: np.data.sms_enabled,
        chat_dm_enabled: np.data.chat_dm_enabled ?? false,
        notify_on_mention: np.data.notify_on_mention,
        notify_on_assignment: np.data.notify_on_assignment,
        notify_on_reply: np.data.notify_on_reply,
        quiet_hours_start: np.data.quiet_hours_start ? np.data.quiet_hours_start.slice(0, 5) : '',
        quiet_hours_end: np.data.quiet_hours_end ? np.data.quiet_hours_end.slice(0, 5) : '',
      });
    }
    setLoading(false);
  };

  const normalizePhone = (v) => v.replace(/[^\d+]/g, '');

  const save = async () => {
    setError('');
    setSaving(true);
    setSaved(false);

    // Warn (don't block) if SMS is on but no mobile saved
    const mobile = normalizePhone(form.mobile);
    if (prefs.sms_enabled && !mobile) {
      setError('Add a mobile number to receive SMS notifications.');
      setSaving(false);
      return;
    }

    const { error: pErr } = await supabase.from('profiles').update({
      display_name: form.display_name.trim() || null,
      phone: normalizePhone(form.phone) || null,
      mobile: mobile || null,
      timezone: form.timezone || null,
    }).eq('id', profile.id);

    if (pErr) { setError('Could not save profile: ' + pErr.message); setSaving(false); return; }

    // Signature saved separately so a not-yet-migrated column can't block the core save.
    const { error: sigErr } = await supabase.from('profiles').update({
      email_signature: signature || null,
      email_signature_logo: signatureLogo,
    }).eq('id', profile.id);
    if (sigErr) { setError('Profile saved, but signature could not save (run migrations 029/030): ' + sigErr.message); setSaving(false); return; }

    const { error: npErr } = await supabase.from('notification_preferences').upsert({
      profile_id: profile.id,
      email_enabled: prefs.email_enabled,
      sms_enabled: prefs.sms_enabled,
      chat_dm_enabled: prefs.chat_dm_enabled,
      notify_on_mention: prefs.notify_on_mention,
      notify_on_assignment: prefs.notify_on_assignment,
      notify_on_reply: prefs.notify_on_reply,
      quiet_hours_start: prefs.quiet_hours_start || null,
      quiet_hours_end: prefs.quiet_hours_end || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'profile_id' });

    if (npErr) { setError('Could not save preferences: ' + npErr.message); setSaving(false); return; }

    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
    onSaved?.();
  };

  const input = "w-full px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper placeholder-dim focus:outline-none focus:border-ember";
  const label = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block";

  if (loading) return <div className="h-full flex items-center justify-center text-dim text-sm">Loading account...</div>;

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-5 border-b border-bdr">
        <div className="text-xl font-bold text-paper">My Account</div>
        <div className="text-xs text-muted">Your contact details and notification preferences</div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-2xl space-y-6">

          {/* Contact details */}
          <div className="glass-card rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-bdr">
              <div className="text-base font-bold text-paper">Contact details</div>
              <div className="text-xs text-muted">Where the system reaches you</div>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className={label}>Display name</label>
                <input className={input} value={form.display_name}
                  onChange={e => setForm({ ...form, display_name: e.target.value })} placeholder="Your name" />
              </div>

              <div>
                <label className={label}>Teams</label>
                {teams.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {teams.map(t => (
                      <span key={t} className="px-2 py-0.5 text-xs font-medium rounded-lg bg-ember/15 text-ember border border-ember/25">
                        {TEAM_LABELS[t] || t}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="text-sm text-dim italic">Not on any team yet</div>
                )}
                <div className="text-[11px] text-dim mt-1">Teams determine what work gets routed to you. An owner manages these.</div>
              </div>

              <div>
                <label className={label}>Login / notification email</label>
                <input className={input + ' opacity-60 cursor-not-allowed'} value={profile.email} disabled />
                <div className="text-[11px] text-dim mt-1">Email notifications are sent here. Contact an owner to change your login email.</div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={label}>Mobile (for SMS)</label>
                  <input className={input} value={form.mobile}
                    onChange={e => setForm({ ...form, mobile: e.target.value })} placeholder="+447700900123" />
                  <div className="text-[11px] text-dim mt-1">Use international format, e.g. +44...</div>
                </div>
                <div>
                  <label className={label}>Phone (optional)</label>
                  <input className={input} value={form.phone}
                    onChange={e => setForm({ ...form, phone: e.target.value })} placeholder="Desk / landline" />
                </div>
              </div>
            </div>
          </div>

          {/* Google connection (personal inbox + calendar) */}
          <div className="glass-card rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-bdr flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-white border border-bdr flex items-center justify-center text-lg">{'\u{1F4C5}'}</div>
              <div className="flex-1">
                <div className="text-base font-bold text-paper">Google account</div>
                <div className="text-xs text-muted">Connect your inbox &amp; calendar — schedule meetings and triage email in one place</div>
              </div>
            </div>
            <div className="p-5">
              {google ? (
                <div className="flex items-center gap-3 p-3 glass-inner rounded-xl">
                  <div className="w-8 h-8 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center text-sm font-bold">{'\u{2713}'}</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-paper">{google.email}</div>
                    <div className="text-xs text-muted">Inbox, calendar &amp; chat connected · Reconnect if Chat is empty</div>
                  </div>
                  <button onClick={connectGoogle} className="px-2 py-1 text-xs text-paper border border-bdr rounded-xl hover:bg-card">Reconnect</button>
                  <button onClick={disconnectGoogle} className="px-2 py-1 text-xs text-red-600 border border-red-200 rounded-xl hover:bg-red-50">Disconnect</button>
                </div>
              ) : (
                <div>
                  <button onClick={connectGoogle} className="btn-glass px-5 py-2.5 rounded-xl text-sm font-semibold">Connect Google</button>
                  <div className="text-[11px] text-dim mt-2">Connects your own Gmail + Google Calendar (separate from the shared support inbox). You'll be asked to allow email and calendar access.</div>
                </div>
              )}
            </div>
          </div>

          {/* Email signature */}
          <div className="glass-card rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-bdr">
              <div className="text-base font-bold text-paper">Email signature</div>
              <div className="text-xs text-muted">Added to the bottom of replies you send from the Inbox</div>
            </div>
            <div className="p-5 space-y-4">
              <textarea className={input + ' resize-none font-mono text-[13px]'} rows={5} value={signature}
                onChange={e => setSignature(e.target.value)}
                placeholder={`Peter Roberts\nServOS\npeter@serv-os.app · 0800 000 0000`} />
              <div className="text-[11px] text-dim">A separator line is added automatically before it.</div>

              <Toggle label="Include company logo" sub={brandingLogo ? 'Shown above your signature in sent emails' : 'No logo set — add one in Settings → Quote branding'}
                checked={signatureLogo} onChange={setSignatureLogo} />

              {(signature || (signatureLogo && brandingLogo)) && (
                <div>
                  <div className={label}>Preview</div>
                  <div className="p-4 bg-white rounded-xl border border-bdr">
                    {signatureLogo && brandingLogo && <img src={brandingLogo} alt="logo" className="h-10 object-contain mb-2" />}
                    <div className="text-[13px] text-slate-700 whitespace-pre-wrap leading-snug border-t border-slate-200 pt-2">{signature || <span className="text-slate-400 italic">(your signature text)</span>}</div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Notification preferences */}
          <div className="glass-card rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-bdr">
              <div className="text-base font-bold text-paper">Notifications</div>
              <div className="text-xs text-muted">Choose how and when you get notified</div>
            </div>
            <div className="p-5 space-y-5">

              {/* Channels */}
              <div>
                <div className={label}>Channels</div>
                <div className="space-y-2 mt-2">
                  <Toggle label="Email notifications" sub={profile.email}
                    checked={prefs.email_enabled} onChange={v => setPrefs({ ...prefs, email_enabled: v })} />
                  <Toggle label="SMS notifications" sub={form.mobile || 'No mobile number set'}
                    checked={prefs.sms_enabled} onChange={v => setPrefs({ ...prefs, sms_enabled: v })} />
                  <div className="text-[11px] text-dim pl-1 pt-1">
                    Google Chat: when you're @mentioned, you're tagged in the team's <span className="text-muted font-medium">CRM notifications</span> space, so Chat pings you personally.
                  </div>
                </div>
              </div>

              {/* Events */}
              <div>
                <div className={label}>Notify me when</div>
                <div className="space-y-2 mt-2">
                  <Toggle label="I'm @mentioned" sub="Someone tags you in a note or activity"
                    checked={prefs.notify_on_mention} onChange={v => setPrefs({ ...prefs, notify_on_mention: v })} />
                  <Toggle label="A record is assigned to me" sub="Ticket, deal, task or onboarding"
                    checked={prefs.notify_on_assignment} onChange={v => setPrefs({ ...prefs, notify_on_assignment: v })} />
                  <Toggle label="A customer replies" sub="On a ticket you own"
                    checked={prefs.notify_on_reply} onChange={v => setPrefs({ ...prefs, notify_on_reply: v })} />
                </div>
              </div>

              {/* Quiet hours */}
              <div>
                <div className={label}>Quiet hours (optional)</div>
                <div className="text-[11px] text-dim mb-2">No notifications during this window. Leave blank for always-on.</div>
                <div className="flex items-center gap-3">
                  <div>
                    <span className="text-[10px] text-dim block mb-1">From</span>
                    <input type="time" className={input + ' w-32'} value={prefs.quiet_hours_start}
                      onChange={e => setPrefs({ ...prefs, quiet_hours_start: e.target.value })} />
                  </div>
                  <div>
                    <span className="text-[10px] text-dim block mb-1">To</span>
                    <input type="time" className={input + ' w-32'} value={prefs.quiet_hours_end}
                      onChange={e => setPrefs({ ...prefs, quiet_hours_end: e.target.value })} />
                  </div>
                  <div>
                    <span className="text-[10px] text-dim block mb-1">Timezone</span>
                    <select className={input + ' w-56'} value={form.timezone}
                      onChange={e => setForm({ ...form, timezone: e.target.value })}>
                      <option value="">Default (UK)</option>
                      <option value="Europe/London">Europe/London</option>
                      <option value="America/Los_Angeles">America/Los_Angeles</option>
                      <option value="America/Denver">America/Denver</option>
                      <option value="America/Chicago">America/Chicago</option>
                      <option value="America/New_York">America/New_York</option>
                    </select>
                  </div>
                </div>
                <div className="text-[11px] text-dim mt-2">Quiet hours use this timezone.</div>
              </div>
            </div>
          </div>

          {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-2">{error}</div>}

          <div className="flex items-center gap-3">
            <button onClick={save} disabled={saving}
              className="btn-glass px-6 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-50">
              {saving ? 'Saving...' : 'Save changes'}
            </button>
            {saved && <span className="text-sm text-emerald-600 font-medium">{'✓'} Saved</span>}
          </div>

        </div>
      </div>
    </div>
  );
}

function Toggle({ label, sub, checked, onChange }) {
  return (
    <button type="button" onClick={() => onChange(!checked)}
      className="w-full flex items-center gap-3 p-3 glass-inner rounded-xl text-left hover:border-bdr transition">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-paper">{label}</div>
        {sub && <div className="text-xs text-muted truncate">{sub}</div>}
      </div>
      <div className={`relative w-10 h-6 rounded-full transition shrink-0 ${checked ? 'bg-emerald-500' : 'bg-slate-300'}`}>
        <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`} />
      </div>
    </button>
  );
}

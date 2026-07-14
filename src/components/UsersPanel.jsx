import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

const FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

// Secondary roles / teams -- independent of the owner/editor/viewer permission role.
// Used to route work, e.g. auto-assign tickets to the Support team.
export const TEAM_OPTIONS = [
  { key: 'support',    label: 'Support' },
  { key: 'sales',      label: 'Sales' },
  { key: 'onboarding', label: 'Onboarding' },
  { key: 'billing',    label: 'Billing' },
  { key: 'engineering', label: 'Eng' },
];
export const TEAM_LABELS = Object.fromEntries(TEAM_OPTIONS.map(t => [t.key, t.label]));

export default function UsersPanel({ profile }) {
  const [users, setUsers]       = useState([]);
  const [invites, setInvites]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [inviting, setInviting] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole]   = useState('editor');
  const [error, setError] = useState('');
  const [pwTarget, setPwTarget] = useState(null); // { id?, email, name, invite? } to set a password for

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    const [u, i] = await Promise.all([
      supabase.from('profiles').select('*').order('created_at'),
      supabase.from('invited_emails').select('*').is('accepted_at', null).order('invited_at', { ascending: false }),
    ]);
    setUsers(u.data || []);
    setInvites(i.data || []);
    setLoading(false);
  };

  const invite = async (e) => {
    e.preventDefault();
    setError('');
    const email = inviteEmail.trim().toLowerCase();
    if (!email || !email.includes('@')) { setError('Please enter a valid email address.'); return; }
    if (users.some(u => u.email.toLowerCase() === email)) {
      setError('That email is already an active user.');
      return;
    }
    const { error: err } = await supabase.from('invited_emails').upsert({
      email, role: inviteRole, invited_by: profile.id, invited_at: new Date().toISOString(),
    }, { onConflict: 'email' });
    if (err) { setError(err.message); return; }
    setInviteEmail(''); setInviteRole('editor'); setInviting(false);
    load();
  };

  const revokeInvite = async (email) => {
    if (!confirm(`Revoke invite for ${email}?`)) return;
    await supabase.from('invited_emails').delete().eq('email', email);
    load();
  };

  const changeInviteRole = async (email, role) => {
    await supabase.from('invited_emails').update({ role }).eq('email', email);
    load();
  };

  const changeRole = async (id, role) => {
    await supabase.from('profiles').update({ role }).eq('id', id);
    load();
  };

  const saveMobile = async (id, mobile) => {
    const clean = (mobile || '').replace(/[^\d+]/g, '') || null;
    await supabase.from('profiles').update({ mobile: clean }).eq('id', id);
    load();
  };

  const toggleTeam = async (u, key) => {
    const current = u.teams || [];
    const next = current.includes(key) ? current.filter(t => t !== key) : [...current, key];
    await supabase.from('profiles').update({ teams: next }).eq('id', u.id);
    load();
  };

  const removeUser = async (u) => {
    if (!confirm(`Remove ${u.email}? They'll lose access immediately. Their items and comments stay, but they'll need a new invite to return.`)) return;
    setError('');
    const { error: err } = await supabase.rpc('admin_delete_user', { target_user_id: u.id });
    if (err) { setError(`Failed to remove user: ${err.message}`); return; }
    load();
  };

  const copyInviteUrl = () => {
    navigator.clipboard.writeText(window.location.origin);
    alert('Sign-up URL copied to clipboard');
  };

  if (profile.role !== 'owner') {
    return <div className="p-8 text-muted text-sm">Only owners can manage users.</div>;
  }

  const input = "bg-card border border-bdr rounded text-sm text-paper placeholder-dim focus:outline-none focus:border-ember";

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-bdr flex items-center justify-between">
        <div>
          <div className="text-lg font-bold text-paper">Users</div>
          <div className="text-[10px] text-dim font-mono uppercase tracking-[0.18em]">Invite-only access. Only emails on the invite list can sign up.</div>
        </div>
        {!inviting && (
          <button onClick={() => setInviting(true)}
            className="px-3 py-1.5 bg-ember text-ink text-sm font-semibold rounded hover:bg-ember-deep transition">
            + Invite user
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-3xl space-y-4">

          {inviting && (
            <div className="bg-card border border-bdr rounded-xl p-4">
              <div className="text-sm font-semibold text-paper mb-3">Invite a user</div>
              <form onSubmit={invite} className="space-y-3">
                <div className="grid grid-cols-12 gap-2">
                  <input type="email" required value={inviteEmail} onChange={e => setInviteEmail(e.target.value)}
                    placeholder="email@example.com" autoFocus
                    className={`col-span-7 px-3 py-2 ${input}`}/>
                  <select value={inviteRole} onChange={e => setInviteRole(e.target.value)}
                    className={`col-span-3 px-2 py-2 ${input}`}>
                    <option value="owner">Owner</option>
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                  </select>
                  <button type="submit"
                    className="col-span-2 px-3 py-2 bg-ember text-ink rounded text-sm font-semibold hover:bg-ember-deep transition">
                    Invite
                  </button>
                </div>
                {error && <div className="text-xs text-red-600">{error}</div>}
                <div className="flex items-center justify-between">
                  <div className="text-xs text-muted leading-relaxed">
                    Once invited, share <button type="button" onClick={copyInviteUrl} className="text-ember hover:underline">{window.location.origin}</button> with them.
                  </div>
                  <button type="button" onClick={() => { setInviting(false); setError(''); setInviteEmail(''); }}
                    className="text-xs text-muted hover:text-paper shrink-0 ml-3">Cancel</button>
                </div>
              </form>
            </div>
          )}

          {invites.length > 0 && (
            <div className="bg-card border border-bdr rounded-xl overflow-hidden">
              <div className="px-4 py-2.5 border-b border-bdr flex items-center gap-2">
                <div className="text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim">Pending invites</div>
                <div className="text-xs text-dim">{invites.length}</div>
              </div>
              {invites.map(inv => (
                <div key={inv.email} className="px-4 py-3 border-b border-bdr last:border-b-0 grid grid-cols-12 gap-3 items-center">
                  <div className="col-span-6 flex items-center gap-2 min-w-0">
                    <div className="w-7 h-7 rounded-full bg-muted/20 text-muted text-xs flex items-center justify-center shrink-0">&#x2709;</div>
                    <div className="min-w-0">
                      <div className="text-sm text-paper truncate">{inv.email}</div>
                      <div className="text-xs text-dim">invited {new Date(inv.invited_at).toLocaleDateString('en-GB', { day:'numeric', month:'short' })}</div>
                    </div>
                  </div>
                  <div className="col-span-3">
                    <select value={inv.role} onChange={e => changeInviteRole(inv.email, e.target.value)}
                      className={`w-full px-2 py-1 ${input} text-xs`}>
                      <option value="owner">Owner</option>
                      <option value="editor">Editor</option>
                      <option value="viewer">Viewer</option>
                    </select>
                  </div>
                  <div className="col-span-3 flex justify-end gap-1.5">
                    <button onClick={() => setPwTarget({ email: inv.email, name: inv.email, invite: true })}
                      title="Create their login with a password now — for when they didn't get the invite link"
                      className="px-2 py-1 text-xs text-ember hover:text-ember-deep border border-bdr rounded whitespace-nowrap">Set up login</button>
                    <button onClick={() => revokeInvite(inv.email)}
                      className="px-2 py-1 text-xs text-red-600 hover:text-red-600 border border-red-200 hover:bg-red-50 rounded">
                      Revoke
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {error && !inviting && <div className="text-xs text-red-600 bg-red-50 border border-red-500/20 rounded-lg px-4 py-2">{error}</div>}

          <div className="bg-card border border-bdr rounded-xl overflow-hidden">
            <div className="px-4 py-2.5 border-b border-bdr grid grid-cols-12 gap-3 text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim">
              <div className="col-span-3">User</div>
              <div className="col-span-2">Role</div>
              <div className="col-span-3">Mobile (SMS)</div>
              <div className="col-span-3">Teams</div>
              <div className="col-span-1 text-right"></div>
            </div>
            {loading && <div className="px-4 py-8 text-center text-dim text-sm">Loading…</div>}
            {!loading && users.map(u => (
              <div key={u.id} className="px-4 py-3 border-b border-bdr last:border-b-0 grid grid-cols-12 gap-3 items-center">
                <div className="col-span-3 flex items-center gap-2 min-w-0">
                  <div className="w-7 h-7 rounded-full bg-ember text-ink text-xs font-bold flex items-center justify-center shrink-0">
                    {(u.display_name || u.email)[0].toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm text-paper truncate">{u.display_name || u.email.split('@')[0]}</div>
                    <div className="text-xs text-muted truncate">{u.email}</div>
                    <div className="text-[10px] text-dim">joined {new Date(u.created_at).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'2-digit' })}</div>
                  </div>
                </div>
                <div className="col-span-2">
                  {u.id === profile.id ? (
                    <span className="px-2 py-0.5 bg-ember/20 text-ember text-[10px] font-bold uppercase rounded">{u.role} (you)</span>
                  ) : (
                    <select value={u.role} onChange={e => changeRole(u.id, e.target.value)}
                      className={`px-2 py-1 ${input} text-xs`}>
                      <option value="owner">Owner</option>
                      <option value="editor">Editor</option>
                      <option value="viewer">Viewer</option>
                    </select>
                  )}
                </div>
                <div className="col-span-3">
                  <input
                    defaultValue={u.mobile || ''}
                    placeholder="+44..."
                    onBlur={e => { if ((e.target.value || '') !== (u.mobile || '')) saveMobile(u.id, e.target.value); }}
                    className={`w-full px-2 py-1 ${input} text-xs font-mono`} />
                </div>
                <div className="col-span-3">
                  <div className="flex flex-wrap gap-1">
                    {TEAM_OPTIONS.map(t => {
                      const on = (u.teams || []).includes(t.key);
                      return (
                        <button key={t.key} onClick={() => toggleTeam(u, t.key)}
                          title={on ? `Remove from ${t.label}` : `Add to ${t.label}`}
                          className={`px-1.5 py-0.5 text-[10px] font-semibold rounded-lg border transition ${
                            on ? 'bg-ember text-white border-ember' : 'bg-card text-dim border-bdr hover:text-paper'
                          }`}>
                          {t.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="col-span-1 flex justify-end gap-1">
                  {u.id !== profile.id && (
                    <>
                      <button onClick={() => setPwTarget({ id: u.id, email: u.email, name: u.display_name || u.email })}
                        title="Set / reset this user's password" aria-label="Set password"
                        className="px-2 py-1 text-xs text-muted hover:text-paper border border-bdr rounded">🔑</button>
                      <button onClick={() => removeUser(u)}
                        className="px-2 py-1 text-xs text-red-600 hover:text-red-600 border border-red-200 hover:bg-red-50 rounded">
                        &times;
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
            {!loading && users.length === 0 && (
              <div className="px-4 py-8 text-center text-dim text-sm">No users yet.</div>
            )}
          </div>

          <div className="bg-card/60 border border-bdr rounded-xl p-4 text-xs text-muted leading-relaxed">
            <div className="text-sm font-semibold text-paper mb-2">How it works</div>
            <ul className="space-y-1 ml-4 list-disc">
              <li>Add someone's email to the invite list above with a pre-assigned role.</li>
              <li>Share <span className="text-paper font-mono">{window.location.origin}</span> with them.</li>
              <li>They sign up with the same email you invited. Other emails are rejected at sign-up.</li>
              <li>Once they sign up, they appear in the Users list below with the role you assigned.</li>
            </ul>
            <div className="text-sm font-semibold text-paper mt-4 mb-2">Role permissions</div>
            <ul className="space-y-1 ml-4 list-disc">
              <li><span className="text-paper">Owner:</span> manage users, invites, roles + all editor permissions</li>
              <li><span className="text-paper">Editor:</span> create / edit / delete projects, buckets, items, comments</li>
              <li><span className="text-paper">Viewer:</span> read-only</li>
            </ul>
          </div>

        </div>
      </div>
      {pwTarget && <SetPasswordModal target={pwTarget} onClose={() => setPwTarget(null)} onDone={load} />}
    </div>
  );
}

// Owner-only: set/reset a user's password (or create a login for an invited
// person who never signed up). Calls the admin-set-password edge function.
function SetPasswordModal({ target, onClose, onDone }) {
  const [pw, setPw] = useState('');
  const [show, setShow] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const genPw = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    const a = crypto.getRandomValues(new Uint32Array(14));
    setPw(Array.from(a, n => chars[n % chars.length]).join(''));
    setShow(true);
  };

  const submit = async () => {
    if (pw.length < 8) { setError('Use at least 8 characters.'); return; }
    setSaving(true); setError('');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`${FUNCTIONS_URL}/admin-set-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ user_id: target.id || undefined, email: target.email, password: pw }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.error) throw new Error(j.error || `Failed (${res.status})`);
      setDone(true);
      onDone?.();
    } catch (e) { setError(e.message); }
    setSaving(false);
  };

  const input = "w-full px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper focus:outline-none focus:border-ember";
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-panel border border-bdr rounded-2xl w-full max-w-md shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-bdr flex items-center justify-between">
          <div className="text-base font-bold text-paper">{target.invite ? 'Set up login' : 'Set password'}</div>
          <button onClick={onClose} className="text-muted hover:text-paper text-lg leading-none">×</button>
        </div>
        <div className="p-5 space-y-3">
          <div className="text-sm text-muted">For <span className="text-paper font-semibold">{target.name}</span> <span className="text-dim">({target.email})</span></div>

          {done ? (
            <div className="space-y-3">
              <div className="text-sm text-emerald-600 font-medium">✓ Password set. They can log in now.</div>
              <div className="bg-card border border-bdr rounded-xl p-3 text-sm space-y-1.5">
                <div className="flex justify-between gap-2"><span className="text-dim">Site</span><span className="text-paper font-mono">{window.location.origin}</span></div>
                <div className="flex justify-between gap-2"><span className="text-dim">Email</span><span className="text-paper font-mono break-all">{target.email}</span></div>
                <div className="flex justify-between gap-2"><span className="text-dim">Password</span><span className="text-paper font-mono">{pw}</span></div>
              </div>
              <button onClick={() => { navigator.clipboard.writeText(`Site: ${window.location.origin}\nEmail: ${target.email}\nPassword: ${pw}`); }}
                className="w-full px-3 py-2 btn-ghost rounded-xl text-sm">Copy login details</button>
              <div className="text-[11px] text-dim">Share these securely and ask them to change the password after first sign-in.</div>
              <button onClick={onClose} className="w-full px-3 py-2 bg-ember text-ink rounded-xl text-sm font-semibold">Done</button>
            </div>
          ) : (
            <>
              <div>
                <label className="text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block">New password</label>
                <div className="flex gap-2">
                  <input type={show ? 'text' : 'password'} value={pw} onChange={e => setPw(e.target.value)} autoFocus
                    placeholder="At least 8 characters" className={input} />
                  <button type="button" onClick={() => setShow(s => !s)} className="px-2 btn-ghost rounded-xl text-xs shrink-0">{show ? 'Hide' : 'Show'}</button>
                </div>
                <button type="button" onClick={genPw} className="mt-1.5 text-xs text-ember hover:text-ember-deep font-medium">Generate a strong password</button>
              </div>
              {error && <div className="text-xs text-red-600">{error}</div>}
              <div className="flex gap-2 pt-1">
                <button onClick={submit} disabled={saving || pw.length < 8}
                  className="px-5 py-2 bg-ember text-ink rounded-xl text-sm font-semibold disabled:opacity-50">
                  {saving ? 'Setting…' : target.invite ? 'Create login' : 'Set password'}
                </button>
                <button onClick={onClose} className="px-4 py-2 btn-ghost rounded-xl text-sm">Cancel</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

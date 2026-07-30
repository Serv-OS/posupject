import { useEffect, useState, useCallback, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import { PhoneCall, PhoneIncoming, PhoneOutgoing, PhoneMissed, Voicemail } from 'lucide-react';
import CallButton from '../CallButton.jsx';

const fmtWhen = (d) => new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtDur = (s) => { const n = Number(s) || 0; return n >= 60 ? `${Math.floor(n / 60)}m ${n % 60}s` : `${n}s`; };

// Outcome buckets for filtering
export const callKind = (a) => {
  const md = a.channel_metadata || {};
  if (md.kind === 'voicemail' || md.outcome === 'voicemail') return 'voicemail';
  if (['no_answer', 'busy', 'failed'].includes(md.outcome)) return 'missed';
  return 'answered';
};

// Last 10 digits, so +44 7700 900123 / 07700900123 / (770) 090-0123 all match.
const lastDigits = (s) => (s || '').replace(/\D/g, '').slice(-10);

const KIND_BADGE = {
  answered: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  missed: 'bg-red-100 text-red-700 border-red-200',
  voicemail: 'bg-amber-100 text-amber-700 border-amber-200',
};

export default function CallLogPanel({ profile, onNavigate }) {
  const [calls, setCalls] = useState([]);
  const [people, setPeople] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [dirFilter, setDirFilter] = useState('all');
  const [kindFilter, setKindFilter] = useState('all');
  const [agentFilter, setAgentFilter] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [newContact, setNewContact] = useState(null);   // { number, first_name, last_name, email }
  const [saving, setSaving] = useState(false);

  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  const load = useCallback(async () => {
    const [a, p, c] = await Promise.all([
      supabase.from('crm_activities').select('*').eq('type', 'call')
        .order('occurred_at', { ascending: false }).limit(1000),
      supabase.from('profiles').select('id, email, display_name'),
      supabase.from('contacts').select('id, first_name, last_name, phone, mobile'),
    ]);
    setCalls(a.data || []); setPeople(p.data || []); setContacts(c.data || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    // Live: new calls/voicemails appear as they happen, outcomes update in place
    const ch = supabase.channel('call-log')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'crm_activities' },
        (payload) => { if ((payload.new || payload.old || {}).type === 'call') load(); })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load]);

  const agentName = (id) => {
    const p = people.find(x => x.id === id);
    return p ? (p.display_name || p.email) : null;
  };
  const contactOf = (a) => contacts.find(c => c.id === a.contact_id);

  // Create a contact straight from a call, then adopt every other call from the
  // same number so the whole history shows the name, not just this row.
  const saveContact = async () => {
    const f = newContact;
    if (!f) return;
    if (!f.first_name.trim() && !f.last_name.trim()) { alert('Give the contact at least a first or last name.'); return; }
    setSaving(true);
    const { data: contact, error } = await supabase.from('contacts').insert({
      first_name: f.first_name.trim() || null,
      last_name: f.last_name.trim() || null,
      email: f.email.trim() || null,
      phone: f.number || null,
      owner_id: profile.id,
    }).select().single();
    if (error) { setSaving(false); alert('Could not create contact: ' + error.message); return; }

    const want = lastDigits(f.number);
    const ids = calls.filter(a => {
      if (a.contact_id) return false;
      const m = a.channel_metadata || {};
      const n = a.direction === 'inbound' ? m.from_number : (m.to_number || m.from_number);
      return want && lastDigits(n) === want;
    }).map(a => a.id);
    if (ids.length) await supabase.from('crm_activities').update({ contact_id: contact.id }).in('id', ids);

    setSaving(false);
    setNewContact(null);
    load();
  };

  const filtered = useMemo(() => calls.filter(a => {
    if (dirFilter !== 'all' && a.direction !== dirFilter) return false;
    if (kindFilter !== 'all' && callKind(a) !== kindFilter) return false;
    if (agentFilter !== 'all' && a.actor_id !== agentFilter) return false;
    if (dateFrom && new Date(a.occurred_at) < new Date(dateFrom)) return false;
    if (dateTo && new Date(a.occurred_at) >= new Date(new Date(dateTo).getTime() + 86400000)) return false;
    if (search.trim()) {
      const md = a.channel_metadata || {};
      const ct = contactOf(a);
      const hay = [md.from_number, md.to_number, ct?.first_name, ct?.last_name, ct?.phone, ct?.mobile,
        agentName(a.actor_id), a.body].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(search.trim().toLowerCase())) return false;
    }
    return true;
  }), [calls, dirFilter, kindFilter, agentFilter, dateFrom, dateTo, search, contacts, people]);

  const today = new Date(new Date().toDateString());
  const todayCalls = calls.filter(a => new Date(a.occurred_at) >= today);
  const stats = {
    today: todayCalls.length,
    missed: calls.filter(a => callKind(a) === 'missed').length,
    voicemail: calls.filter(a => callKind(a) === 'voicemail').length,
    answeredToday: todayCalls.filter(a => callKind(a) === 'answered').length,
  };

  const input = "px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper placeholder-dim focus:outline-none focus:border-ember";
  const chip = (active) => `px-3 py-1.5 rounded-xl text-xs font-semibold capitalize transition ${active ? 'bg-ember text-white' : 'bg-card text-muted hover:text-paper'}`;

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-5 border-b border-bdr flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2.5">
          <PhoneCall size={20} className="text-ember" />
          <div>
            <div className="text-xl font-bold text-paper">Call Log</div>
            <div className="text-xs text-muted">Every call, missed call and voicemail — in and out</div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-[1100px] mx-auto space-y-4">

          {/* Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[['Calls today', stats.today, 'text-paper'], ['Answered today', stats.answeredToday, 'text-emerald-600'],
              ['Missed (all time)', stats.missed, 'text-red-600'], ['Voicemails', stats.voicemail, 'text-amber-600']].map(([k, v, cls]) => (
              <div key={k} className="glass-card rounded-2xl px-4 py-3">
                <div className="text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim">{k}</div>
                <div className={`text-lg font-bold ${cls}`}>{v}</div>
              </div>
            ))}
          </div>

          {/* Filters */}
          <div className="glass-card rounded-2xl p-3 space-y-2.5">
            <div className="flex items-center gap-1.5 flex-wrap">
              {['all', 'inbound', 'outbound'].map(d => (
                <button key={d} onClick={() => setDirFilter(d)} className={chip(dirFilter === d)}>{d}</button>
              ))}
              <span className="w-px h-5 bg-bdr mx-1" />
              {['all', 'answered', 'missed', 'voicemail'].map(k => (
                <button key={k} onClick={() => setKindFilter(k)} className={chip(kindFilter === k)}>
                  {k}{k !== 'all' && <span className="ml-1 opacity-60">{calls.filter(a => callKind(a) === k).length}</span>}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <input className={input + ' flex-1 min-w-44'} placeholder="Search number, contact, agent or notes…"
                value={search} onChange={e => setSearch(e.target.value)} />
              <select className={input} value={agentFilter} onChange={e => setAgentFilter(e.target.value)}>
                <option value="all">All agents</option>
                {people.map(p => <option key={p.id} value={p.id}>{p.display_name || p.email}</option>)}
              </select>
              <input type="date" className={input} value={dateFrom} onChange={e => setDateFrom(e.target.value)} title="From date" />
              <span className="text-xs text-dim">to</span>
              <input type="date" className={input} value={dateTo} onChange={e => setDateTo(e.target.value)} title="To date" />
              {(dateFrom || dateTo || search || dirFilter !== 'all' || kindFilter !== 'all' || agentFilter !== 'all') && (
                <button onClick={() => { setDateFrom(''); setDateTo(''); setSearch(''); setDirFilter('all'); setKindFilter('all'); setAgentFilter('all'); }}
                  className="text-xs text-ember hover:underline">Clear</button>
              )}
            </div>
          </div>

          {/* Log */}
          <div className="space-y-1.5">
            {loading && <div className="py-10 text-center text-dim text-sm">Loading…</div>}
            {!loading && !filtered.length && <div className="py-10 text-center text-dim text-xs italic">No calls match these filters.</div>}
            {filtered.map(a => {
              const md = a.channel_metadata || {};
              const kind = callKind(a);
              const ct = contactOf(a);
              const ctName = ct ? [ct.first_name, ct.last_name].filter(Boolean).join(' ') : null;
              const number = a.direction === 'inbound' ? md.from_number : (md.to_number || md.from_number);
              const dur = md.recording_duration || md.duration_seconds;
              const recUrl = md.recording_sid ? `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/twilio-recording?sid=${md.recording_sid}` : null;
              const Icon = kind === 'voicemail' ? Voicemail : kind === 'missed' ? PhoneMissed : a.direction === 'inbound' ? PhoneIncoming : PhoneOutgoing;
              return (
                <div key={a.id} className="glass-card rounded-2xl px-4 py-3">
                  <div className="flex items-center gap-3 flex-wrap">
                    <Icon size={16} className={kind === 'missed' ? 'text-red-500' : kind === 'voicemail' ? 'text-amber-500' : a.direction === 'inbound' ? 'text-blue-500' : 'text-emerald-600'} />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-paper">
                        {ctName ? (
                          <button onClick={() => a.contact_id && onNavigate?.('contact', a.contact_id)} className="hover:text-ember transition">{ctName}</button>
                        ) : (number || 'Unknown number')}
                        {ctName && number && <span className="text-xs text-dim font-normal ml-2">{number}</span>}
                      </div>
                      <div className="text-[11px] text-dim">
                        {fmtWhen(a.occurred_at)}
                        {a.actor_id && <> · {agentName(a.actor_id)}</>}
                        {dur > 0 && <> · {fmtDur(dur)}</>}
                      </div>
                    </div>
                    <div className="ml-auto flex items-center gap-2">
                      {/* Ring them back — the number from the call, else the contact's own */}
                      <CallButton number={number || ct?.mobile || ct?.phone} variant="icon"
                        title={`Call ${ctName || number || ''} back`} />
                      {canWrite && !ct && number && (
                        <button onClick={() => setNewContact({ number, first_name: '', last_name: '', email: '' })}
                          title={`Add ${number} to contacts`}
                          className="text-[11px] font-semibold text-ember hover:text-ember-deep whitespace-nowrap">+ Add contact</button>
                      )}
                      <span className={`px-2 py-0.5 text-[9px] font-bold uppercase rounded border ${KIND_BADGE[kind]}`}>
                        {kind === 'answered' ? (md.outcome || 'connected').replace(/_/g, ' ') : kind}
                      </span>
                      <span className="px-2 py-0.5 text-[9px] font-bold uppercase rounded bg-card border border-bdr text-muted">{a.direction}</span>
                      {a.subject_type === 'ticket' && a.subject_id && (
                        <button onClick={() => onNavigate?.('ticket', a.subject_id)} className="text-xs text-ember hover:underline">Ticket →</button>
                      )}
                    </div>
                  </div>
                  {a.body && <div className="text-xs text-muted mt-1.5 ml-7 whitespace-pre-wrap">{a.body}</div>}
                  {recUrl && <audio controls preload="none" src={recUrl} className="w-full mt-2 h-8" />}
                </div>
              );
            })}
            {!loading && filtered.length >= 1000 && (
              <div className="text-[11px] text-dim text-center py-2">Showing the most recent 1,000 calls — use the date filter to narrow further back.</div>
            )}
          </div>

        </div>
      </div>

      {newContact && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => !saving && setNewContact(null)}>
          <div className="glass-raised rounded-2xl w-full max-w-sm overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-3 border-b border-bdr">
              <div className="text-sm font-bold text-paper">New contact</div>
              <div className="text-[11px] text-muted font-mono">{newContact.number}</div>
            </div>
            <div className="p-5 space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block">First name</label>
                  <input autoFocus className={input + ' w-full !py-1.5 text-sm'} value={newContact.first_name}
                    onChange={e => setNewContact({ ...newContact, first_name: e.target.value })} />
                </div>
                <div>
                  <label className="text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block">Last name</label>
                  <input className={input + ' w-full !py-1.5 text-sm'} value={newContact.last_name}
                    onChange={e => setNewContact({ ...newContact, last_name: e.target.value })} />
                </div>
              </div>
              <div>
                <label className="text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block">Email (optional)</label>
                <input className={input + ' w-full !py-1.5 text-sm'} value={newContact.email}
                  onChange={e => setNewContact({ ...newContact, email: e.target.value })} />
              </div>
              <div className="text-[11px] text-dim">Earlier calls from this number will be linked to the new contact too.</div>
            </div>
            <div className="px-5 py-3 border-t border-bdr flex justify-end gap-2">
              <button onClick={() => setNewContact(null)} disabled={saving} className="btn-ghost px-4 py-2 rounded-xl text-sm">Cancel</button>
              <button onClick={saveContact} disabled={saving} className="btn-glass px-4 py-2 rounded-xl text-sm font-semibold disabled:opacity-50">
                {saving ? 'Saving…' : 'Create contact'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

import { useEffect, useState, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import SlaBadge from './SlaBadge.jsx';
import { ListContainer, RecordCard, CardHead, Chip, ChipRow, MetaRow, OwnerTag } from './cardKit.jsx';

const STAGE_STYLES = {
  new: 'bg-blue-100 text-blue-700 border border-blue-200',
  in_progress: 'bg-orange-100 text-orange-700 border border-orange-200',
  waiting_on_customer: 'bg-amber-100 text-amber-700 border border-amber-200',
  escalated: 'bg-red-100 text-red-700 border border-red-200',
  resolved: 'bg-emerald-100 text-emerald-700 border border-emerald-200',
  closed: 'bg-slate-100 text-slate-600 border border-slate-200',
};
const STAGE_LABELS = {
  new:'New', in_progress:'In Progress', waiting_on_customer:'Waiting',
  escalated:'Escalated', resolved:'Resolved', closed:'Closed',
};
const PRIORITY_STYLES = {
  P0: 'text-red-600', P1: 'text-orange-600', P2: 'text-blue-400', P3: 'text-slate-400',
};

export const awaitingReply = (t) =>
  !!t.last_customer_reply_at && !['resolved', 'closed'].includes(t.stage) &&
  (!t.last_agent_reply_at || new Date(t.last_customer_reply_at) > new Date(t.last_agent_reply_at));

export default function TicketList({ profile, onSelect, onNavigate }) {
  const [tickets, setTickets] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ status: 'open', search: '' });
  const [locations, setLocations] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [subject, setSubject] = useState('');
  const [newLocation, setNewLocation] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [contacts, setContacts] = useState([]);
  const [contactId, setContactId] = useState('');
  const [priority, setPriority] = useState('P2');
  const [ticketType, setTicketType] = useState('support');
  const [description, setDescription] = useState('');

  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  useEffect(() => {
    load();
    // Realtime: auto-refresh when tickets change
    const ch = supabase.channel('tickets-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tickets' }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

  const load = async () => {
    setLoading(true);
    const [t, c, l, m, ct] = await Promise.all([
      supabase.from('tickets').select('*').order('created_at', { ascending: false }),
      supabase.from('companies').select('id, name').order('name'),
      supabase.from('locations').select('id, name, company_id').order('name'),
      supabase.from('profiles').select('id, email, display_name'),
      supabase.from('contacts').select('id, first_name, last_name, email, phone').order('first_name'),
    ]);
    setTickets(t.data || []);
    setCompanies(c.data || []);
    setLocations(l.data || []);
    setMembers(m.data || []);
    setContacts(ct.data || []);
    setLoading(false);
  };

  const filtered = useMemo(() => {
    let result = tickets;
    result = [...result].sort((a, b) => Number(awaitingReply(b)) - Number(awaitingReply(a)));
    if (filter.status === 'open') result = result.filter(t => !['resolved','closed'].includes(t.stage));
    else if (filter.status !== 'all') result = result.filter(t => t.stage === filter.status);
    if (filter.search) {
      const q = filter.search.toLowerCase();
      result = result.filter(t => t.subject.toLowerCase().includes(q) ||
        (companies.find(c => c.id === t.company_id)?.name || '').toLowerCase().includes(q));
    }
    return result;
  }, [tickets, filter, companies]);

  const companyName = (id) => companies.find(c => c.id === id)?.name || '';
  const ownerName = (id) => {
    const m = members.find(u => u.id === id);
    return m ? (m.display_name || m.email.split('@')[0]) : '';
  };

  const handleLocationChange = (locId) => {
    setNewLocation(locId);
    if (locId) {
      const loc = locations.find(l => l.id === locId);
      if (loc) setCompanyId(loc.company_id);
    }
  };

  const create = async (e) => {
    e.preventDefault();
    if (!subject.trim() || !companyId) return;
    const person = contacts.find(c => c.id === contactId) || null;
    const { data } = await supabase.from('tickets').insert({
      subject: subject.trim(),
      description: description.trim() || null,
      company_id: companyId,
      contact_id: contactId || null,
      customer_email: person?.email || null,
      customer_phone: person?.phone || null,
      priority, ticket_type: ticketType, owner_id: profile.id,
    }).select().single();
    if (data) {
      await supabase.from('stage_history').insert({
        object_type: 'ticket', object_id: data.id, from_stage: null, to_stage: 'new', changed_by: profile.id,
      });
      if (newLocation) {
        await supabase.from('associations').insert({
          from_type: 'ticket', from_id: data.id, to_type: 'location', to_id: newLocation, label: 'affected_location',
        });
      }
      if (contactId) {
        await supabase.from('associations').insert({
          from_type: 'ticket', from_id: data.id, to_type: 'contact', to_id: contactId, label: 'primary_contact',
        });
      }
    }
    setSubject(''); setDescription(''); setNewLocation(''); setCompanyId(''); setContactId(''); setPriority('P2'); setTicketType('support'); setShowCreate(false);
    if (data) onSelect(data.id);
    else load();
  };

  const openCount = tickets.filter(t => !['resolved','closed'].includes(t.stage)).length;
  const escalatedCount = tickets.filter(t => t.stage === 'escalated').length;
  const input = "w-full px-3 py-2 bg-card border border-bdr rounded text-sm text-paper placeholder-dim focus:outline-none focus:border-ember";

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-bdr flex items-center justify-between">
        <div>
          <div className="text-lg font-bold text-paper">Support Tickets</div>
          <div className="text-[10px] text-dim font-mono uppercase tracking-[0.18em]">
            {openCount} open{escalatedCount > 0 ? ` / ${escalatedCount} escalated` : ''} / {tickets.length} total
          </div>
        </div>
        {canWrite && (
          <button onClick={() => setShowCreate(true)}
            className="px-3 py-1.5 bg-ember text-ink text-sm font-semibold rounded hover:bg-ember-deep transition">+ New ticket</button>
        )}
      </div>

      <div className="px-6 py-3 border-b border-bdr flex items-center gap-2">
        <input value={filter.search} onChange={e => setFilter({ ...filter, search: e.target.value })}
          placeholder="Search tickets..." className="px-3 py-1.5 bg-card border border-bdr rounded text-sm text-paper placeholder-dim focus:outline-none focus:border-ember w-56" />
        <select value={filter.status} onChange={e => setFilter({ ...filter, status: e.target.value })}
          className="px-2 py-1.5 bg-card border border-bdr rounded text-sm text-paper focus:outline-none focus:border-ember">
          <option value="open">Open</option>
          <option value="all">All</option>
          {Object.entries(STAGE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>

      {showCreate && (
        <div className="px-6 py-3 border-b border-bdr max-h-[70vh] overflow-y-auto">
          <form onSubmit={create} className="space-y-2">
            <input className={input} value={subject} onChange={e => setSubject(e.target.value)} placeholder="Ticket subject" autoFocus />
            <textarea className={input + ' resize-none'} rows={2} value={description} onChange={e => setDescription(e.target.value)} placeholder="Description (optional)" />
            <div className="flex gap-2 items-center flex-wrap">
              <select className={input + ' w-56'} value={newLocation} onChange={e => handleLocationChange(e.target.value)}>
                <option value="">Select location...</option>
                {locations.map(l => {
                  const co = companies.find(c => c.id === l.company_id);
                  return <option key={l.id} value={l.id}>{l.name} ({co?.name || '?'})</option>;
                })}
              </select>
              {companyId && (
                <span className="px-3 py-2 bg-slate-50 border border-slate-200 rounded text-xs text-slate-600 flex items-center gap-1.5">
                  {'\u{1F3E2}'} {companies.find(c => c.id === companyId)?.name || ''}
                </span>
              )}
              {!newLocation && (
                <select className={input + ' w-44'} value={companyId} onChange={e => setCompanyId(e.target.value)}>
                  <option value="">Or company...</option>
                  {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              )}
              <select className={input + ' w-56'} value={contactId} onChange={e => setContactId(e.target.value)}>
                <option value="">Raise for a person (optional)…</option>
                {contacts.map(c => {
                  const nm = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || 'Unnamed';
                  return <option key={c.id} value={c.id}>{nm}{c.email ? ` — ${c.email}` : ''}</option>;
                })}
              </select>
              <select className={input + ' w-24'} value={priority} onChange={e => setPriority(e.target.value)}>
                <option value="P0">P0</option><option value="P1">P1</option><option value="P2">P2</option><option value="P3">P3</option>
              </select>
              <select className={input + ' w-36'} value={ticketType} onChange={e => setTicketType(e.target.value)}>
                <option value="support">Support</option><option value="bug">Bug</option>
                <option value="feature_request">Feature Req</option><option value="billing">Billing</option><option value="other">Other</option>
              </select>
              <button type="submit" className="px-4 py-2 bg-ember text-white text-sm font-semibold rounded shrink-0">Create</button>
              <button type="button" onClick={() => { setShowCreate(false); setNewLocation(''); setCompanyId(''); setContactId(''); setDescription(''); }}
                className="px-3 py-2 text-sm text-muted border border-bdr rounded shrink-0">Cancel</button>
            </div>
          </form>
        </div>
      )}

      <ListContainer>
        {loading && <div className="py-8 text-center text-dim text-sm">Loading...</div>}
        {!loading && filtered.length === 0 && <div className="py-8 text-center text-dim text-sm">No tickets.</div>}
        {!loading && filtered.map(t => (
          <RecordCard key={t.id} onClick={() => onSelect(t.id)} highlight={awaitingReply(t)}>
            <CardHead
              title={t.subject}
              subtitle={[t.ticket_number ? `#${t.ticket_number}` : null, t.ticket_type].filter(Boolean).join(' · ')}
              badge={<span className={`px-2 py-0.5 text-[9px] font-bold uppercase rounded ${STAGE_STYLES[t.stage]}`}>{STAGE_LABELS[t.stage] || t.stage}</span>}
            />
            <ChipRow>
              <Chip tone="slate" icon={'\u{1F3E2}'}>{companyName(t.company_id)}</Chip>
              <span className={`inline-flex items-center px-2 py-1 text-xs font-bold rounded-lg bg-card border border-bdr ${PRIORITY_STYLES[t.priority]}`}>{t.priority}</span>
              {awaitingReply(t) && (
                <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-bold rounded-lg bg-amber-100 text-amber-700 border border-amber-200 animate-pulse">
                  {'\u{1F4AC}'} Customer replied
                </span>
              )}
              <SlaBadge ticket={t} />
            </ChipRow>
            <MetaRow>
              <OwnerTag name={ownerName(t.owner_id)} />
              <span>Created {new Date(t.created_at).toLocaleDateString('en-GB', { day:'numeric', month:'short' })}</span>
            </MetaRow>
          </RecordCard>
        ))}
      </ListContainer>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import AssociationManager from './AssociationManager.jsx';
import ConversationTimeline from './ConversationTimeline.jsx';
import CallButton from '../CallButton.jsx';
import SlaBadge from './SlaBadge.jsx';
import { computeSla, fmtMinutes } from '../../lib/sla';
import AttachmentsCard from './AttachmentsCard.jsx';
import TimerButton from './TimerButton.jsx';

const STAGES = ['new','in_progress','waiting_on_customer','escalated','resolved','closed'];
const STAGE_LABELS = { new:'New', in_progress:'In Progress', waiting_on_customer:'Waiting on Customer', escalated:'Escalated', resolved:'Resolved', closed:'Closed' };
const STAGE_STYLES = {
  new:'bg-blue-100 text-blue-700 border border-blue-200', in_progress:'bg-orange-100 text-orange-700 border border-orange-200',
  waiting_on_customer:'bg-amber-100 text-amber-700 border border-amber-200', escalated:'bg-red-100 text-red-700 border border-red-200',
  resolved:'bg-emerald-100 text-emerald-700 border border-emerald-200', closed:'bg-slate-100 text-slate-600 border border-slate-200',
};

// Generate UK/intl phone format variants so we can match a contact regardless of how the number is stored
function phoneVariants(phone) {
  if (!phone) return [];
  const p = phone.replace(/\s/g, '');
  const out = [p];
  if (p.startsWith('+44')) { out.push('0' + p.slice(3)); out.push(p.slice(1)); }
  if (p.startsWith('0')) { out.push('+44' + p.slice(1)); out.push('44' + p.slice(1)); }
  if (p.startsWith('44')) { out.push('+' + p); out.push('0' + p.slice(2)); }
  return out;
}

export default function TicketDetail({ ticketId, profile, onClose, onNavigate }) {
  const [ticket, setTicket] = useState(null);
  const [company, setCompany] = useState(null);
  const [locations, setLocations] = useState([]);
  const [members, setMembers] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [history, setHistory] = useState([]);
  const [projects, setProjects] = useState([]);
  const [contactContext, setContactContext] = useState({ companies: [], locations: [] });
  const [matchedContact, setMatchedContact] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const [creatingContact, setCreatingContact] = useState(false);
  const [newContact, setNewContact] = useState({ first_name: '', last_name: '', email: '', phone: '' });

  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  useEffect(() => { load(); }, [ticketId]);

  const load = async () => {
    const [t, m, c, h, prj, allLoc, ct] = await Promise.all([
      supabase.from('tickets').select('*').eq('id', ticketId).single(),
      supabase.from('profiles').select('id, email, display_name'),
      supabase.from('companies').select('id, name').order('name'),
      supabase.from('stage_history').select('*').eq('object_type', 'ticket').eq('object_id', ticketId).order('changed_at', { ascending: false }),
      supabase.from('crm_projects').select('*').eq('subject_type', 'ticket').eq('subject_id', ticketId).order('created_at', { ascending: false }),
      supabase.from('locations').select('id, name, company_id, venue_type, city').order('name'),
      supabase.from('contacts').select('id, first_name, last_name, email, phone').order('last_name'),
    ]);
    setTicket(t.data);
    setMembers(m.data || []);
    setCompanies(c.data || []);
    setHistory(h.data || []);
    setProjects(prj.data || []);
    setLocations(allLoc.data || []);
    setContacts(ct.data || []);
    if (t.data?.company_id) {
      setCompany(c.data?.find(co => co.id === t.data.company_id) || null);
    }

    // Detect whether the ticket's customer matches an existing contact (by contact_id, phone, or email)
    let matched = null;
    if (t.data?.contact_id) {
      matched = (ct.data || []).find(x => x.id === t.data.contact_id) || null;
    }
    if (!matched && (t.data?.customer_phone || t.data?.customer_email)) {
      const variants = phoneVariants(t.data?.customer_phone);
      matched = (ct.data || []).find(x =>
        (t.data.customer_email && x.email && x.email.toLowerCase() === t.data.customer_email.toLowerCase()) ||
        (x.phone && variants.includes(x.phone.replace(/\s/g, '')))
      ) || null;
    }
    setMatchedContact(matched);

    // Auto-pull company/location from linked contacts
    const [contactAssocs] = await Promise.all([
      supabase.from('associations').select('*')
        .or(`and(from_type.eq.ticket,from_id.eq.${ticketId},to_type.eq.contact),and(to_type.eq.ticket,to_id.eq.${ticketId},from_type.eq.contact)`),
    ]);
    const contactIds = (contactAssocs.data || []).map(a => a.from_type === 'contact' ? a.from_id : a.to_id);
    if (contactIds.length > 0) {
      // Get associations for those contacts to find their companies and locations
      const { data: contactLinks } = await supabase.from('associations').select('*')
        .in('from_id', contactIds)
        .eq('from_type', 'contact')
        .in('to_type', ['company', 'location']);
      const linkedCompanyIds = [...new Set((contactLinks || []).filter(a => a.to_type === 'company').map(a => a.to_id))];
      const linkedLocationIds = [...new Set((contactLinks || []).filter(a => a.to_type === 'location').map(a => a.to_id))];
      setContactContext({
        companies: (c.data || []).filter(co => linkedCompanyIds.includes(co.id)),
        locations: (allLoc.data || []).filter(l => linkedLocationIds.includes(l.id)),
      });
    }
  };

  // Create a brand-new contact from the ticket's customer details, link it, and set as primary
  const createContactFromTicket = async () => {
    const payload = {
      first_name: newContact.first_name.trim() || null,
      last_name: newContact.last_name.trim() || null,
      email: (newContact.email.trim() || ticket.customer_email || '') || null,
      phone: (newContact.phone.trim() || ticket.customer_phone || '') || null,
      owner_id: profile.id,
    };
    if (!payload.first_name && !payload.last_name && !payload.email && !payload.phone) {
      alert('Enter at least a name, email, or phone for the new contact.');
      return;
    }
    const { data: contact, error } = await supabase.from('contacts').insert(payload).select().single();
    if (error) { alert('Could not create contact: ' + error.message); return; }

    // Link contact to the ticket (association + ticket.contact_id)
    await supabase.from('associations').insert({
      from_type: 'ticket', from_id: ticketId, to_type: 'contact', to_id: contact.id, label: 'primary_contact',
    });
    await supabase.from('tickets').update({ contact_id: contact.id }).eq('id', ticketId);

    // Link contact to the ticket's company if there is one
    if (ticket.company_id) {
      await supabase.from('associations').insert({
        from_type: 'contact', from_id: contact.id, to_type: 'company', to_id: ticket.company_id, label: 'primary_contact',
      });
    }

    setCreatingContact(false);
    setNewContact({ first_name: '', last_name: '', email: '', phone: '' });
    load();
  };

  const startEdit = () => { setDraft({ ...ticket }); setEditing(true); };
  const save = async () => {
    const oldStage = ticket.stage;
    const patch = {
      subject: draft.subject, description: draft.description || null, stage: draft.stage,
      priority: draft.priority, ticket_type: draft.ticket_type, source: draft.source || null,
      notes: draft.notes || null, owner_id: draft.owner_id || null, company_id: draft.company_id,
      channel: draft.channel || null, customer_email: draft.customer_email || null,
      customer_phone: draft.customer_phone || null, contact_id: draft.contact_id || null,
    };
    if (patch.stage === 'resolved' && !ticket.resolved_at) patch.resolved_at = new Date().toISOString();
    if (patch.stage === 'closed') patch.closed_at = new Date().toISOString();
    const { error } = await supabase.from('tickets').update(patch).eq('id', ticketId);
    if (error) { alert('Save failed: ' + error.message); return; }
    if (patch.stage !== oldStage) {
      await supabase.from('stage_history').insert({ object_type: 'ticket', object_id: ticketId, from_stage: oldStage, to_stage: patch.stage, changed_by: profile.id });
    }
    setEditing(false); load();
  };
  const set = (k, v) => setDraft({ ...draft, [k]: v });

  const changeStage = async (newStage) => {
    if (newStage === ticket.stage) return;
    const patch = { stage: newStage };
    if (newStage === 'resolved') patch.resolved_at = new Date().toISOString();
    if (newStage === 'closed') patch.closed_at = new Date().toISOString();
    await supabase.from('tickets').update(patch).eq('id', ticketId);
    await supabase.from('stage_history').insert({ object_type: 'ticket', object_id: ticketId, from_stage: ticket.stage, to_stage: newStage, changed_by: profile.id });
    load();
  };

  const deleteRecord = async () => {
    if (!confirm(`Delete ticket "${ticket?.subject}"?\n\nThis cannot be undone.`)) return;
    await supabase.from('tickets').delete().eq('id', ticketId);
    onClose();
  };

  const createLinkedProject = async () => {
    const name = prompt(`Project name for this support ticket:`);
    if (!name?.trim()) return;
    const { data } = await supabase.from('crm_projects').insert({ name: name.trim(), subject_type: 'ticket', subject_id: ticketId, owner_id: profile.id }).select().single();
    if (data) onNavigate?.('project', data.id); else load();
  };

  if (!ticket) return <div className="h-full flex items-center justify-center text-dim text-sm">Loading...</div>;

  const ownerName = (id) => { const m = members.find(u => u.id === id); return m ? (m.display_name || m.email.split('@')[0]) : 'Unassigned'; };
  const companyLocations = ticket.company_id ? locations.filter(l => l.company_id === ticket.company_id) : [];

  const input = "w-full px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper placeholder-dim focus:outline-none focus:border-ember";
  const label = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block";

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 py-5 border-b border-bdr flex items-center gap-4">
        <button onClick={onClose} className="text-muted hover:text-paper text-lg">&larr;</button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            {ticket.ticket_number && (
              <span className="px-2 py-0.5 text-xs font-mono font-bold rounded-lg bg-ink-soft text-ember border border-bdr shrink-0">
                #{ticket.ticket_number}
              </span>
            )}
            <div className="text-xl font-bold text-paper truncate">{ticket.subject}</div>
          </div>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span className={`badge-status ${STAGE_STYLES[ticket.stage]}`}>{STAGE_LABELS[ticket.stage]}</span>
            <SlaBadge ticket={ticket} />
            <span className="text-xs text-dim font-mono">{ticket.priority}</span>
            <span className="text-xs text-muted">{ticket.ticket_type}</span>
            {company && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] rounded-lg bg-slate-100 text-slate-600 border border-slate-200 cursor-pointer hover:border-slate-300"
                onClick={() => onNavigate?.('company', company.id)}>
                {'\u{1F3E2}'} {company.name}
              </span>
            )}
            {ticket.channel && (
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase rounded-lg ${
                ticket.channel === 'sms' ? 'bg-blue-100 text-blue-700' : ticket.channel === 'email' ? 'bg-purple-100 text-purple-700' : 'bg-emerald-100 text-emerald-700'
              }`}>{ticket.channel}</span>
            )}
            {ticket.customer_phone && <span className="text-xs text-muted">{ticket.customer_phone}</span>}
            {ticket.customer_email && <span className="text-xs text-muted">{ticket.customer_email}</span>}
          </div>
        </div>
        {!editing && (
          <div className="flex gap-2 items-center">
            <TimerButton subjectType="ticket" subjectId={ticketId} label={ticket.subject} profile={profile} />
            {canWrite && <button onClick={startEdit} className="btn-ghost px-4 py-2 rounded-xl text-sm">Edit</button>}
            {profile.role === 'owner' && (
              <button onClick={deleteRecord} className="px-3 py-2 text-xs text-red-600 border border-red-200 rounded-xl hover:bg-red-50 transition">Delete</button>
            )}
          </div>
        )}
      </div>

      {/* Stage bar */}
      {canWrite && (
        <div className="px-6 py-2 border-b border-bdr flex gap-0.5 overflow-x-auto">
          {STAGES.map((s, i) => {
            const isActive = ticket.stage === s;
            const isPast = STAGES.indexOf(ticket.stage) > i;
            return (
              <button key={s} onClick={() => changeStage(s)}
                className={`px-2.5 py-1.5 text-[9px] font-bold uppercase rounded-xl transition whitespace-nowrap ${
                  isActive ? 'bg-ember text-white' : isPast ? 'bg-ember/20 text-ember' : 'bg-card text-dim hover:text-paper'
                }`}>{STAGE_LABELS[s]}</button>
            );
          })}
        </div>
      )}

      {/* Content */}
      {editing ? (
        <div className="flex-1 min-h-0 overflow-y-auto p-6">
          <div className="max-w-3xl">
            <Card title="Edit Support Ticket">
              <div className="space-y-3">
                <div><label className={label}>Subject</label><input className={input} value={draft.subject || ''} onChange={e => set('subject', e.target.value)} /></div>
                <div><label className={label}>Description</label><textarea className={input + ' resize-none'} rows={4} value={draft.description || ''} onChange={e => set('description', e.target.value)} /></div>
                <div className="grid grid-cols-2 gap-3">
                  <div><label className={label}>Stage</label><select className={input} value={draft.stage} onChange={e => set('stage', e.target.value)}>
                    {STAGES.map(s => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}</select></div>
                  <div><label className={label}>Priority</label><select className={input} value={draft.priority} onChange={e => set('priority', e.target.value)}>
                    <option value="P0">P0</option><option value="P1">P1</option><option value="P2">P2</option><option value="P3">P3</option></select></div>
                  <div><label className={label}>Type</label><select className={input} value={draft.ticket_type || 'support'} onChange={e => set('ticket_type', e.target.value)}>
                    <option value="support">Support</option><option value="bug">Bug</option><option value="feature_request">Feature Request</option><option value="billing">Billing</option><option value="other">Other</option></select></div>
                  <div><label className={label}>Owner</label><select className={input} value={draft.owner_id || ''} onChange={e => set('owner_id', e.target.value || null)}>
                    <option value="">Unassigned</option>{members.map(m => <option key={m.id} value={m.id}>{m.display_name || m.email}</option>)}</select></div>
                  <div><label className={label}>Company</label><select className={input} value={draft.company_id} onChange={e => set('company_id', e.target.value)}>
                    {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
                  <div><label className={label}>Channel</label><select className={input} value={draft.channel || ''} onChange={e => set('channel', e.target.value || null)}>
                    <option value="">Not set</option><option value="email">Email</option><option value="sms">SMS</option><option value="whatsapp">WhatsApp</option><option value="phone">Phone</option><option value="web">Web</option></select></div>
                  <div><label className={label}>Customer email</label><input className={input} value={draft.customer_email || ''} onChange={e => set('customer_email', e.target.value)} placeholder="customer@example.com" /></div>
                  <div><label className={label}>Customer phone</label><input className={input} value={draft.customer_phone || ''} onChange={e => set('customer_phone', e.target.value)} placeholder="+44..." /></div>
                </div>
                <div><label className={label}>Notes</label><textarea className={input + ' resize-none'} rows={2} value={draft.notes || ''} onChange={e => set('notes', e.target.value)} /></div>
                <div className="flex gap-2 pt-1">
                  <button onClick={save} className="btn-glass px-5 py-2 rounded-xl text-sm">Save</button>
                  <button onClick={() => setEditing(false)} className="btn-ghost px-4 py-2 rounded-xl text-sm">Cancel</button>
                </div>
              </div>
            </Card>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-5 p-6 max-w-[1600px] w-full mx-auto overflow-y-auto lg:overflow-hidden">

            {/* LEFT rail — own scroll */}
            <div className="lg:w-[300px] lg:shrink-0 lg:overflow-y-auto space-y-5">
              {/* Customer card: show who contacted us, match or create a contact */}
              {(ticket.customer_phone || ticket.customer_email || matchedContact) && (
                <Card title="Customer">
                  <div className="space-y-2">
                    {ticket.customer_phone && (
                      <div className="flex items-center gap-2 text-sm">
                        <span className="text-base">{'\u{1F4F1}'}</span>
                        <span className="text-paper font-mono flex-1">{ticket.customer_phone}</span>
                        <CallButton number={ticket.customer_phone} />
                      </div>
                    )}
                    {ticket.customer_email && (
                      <div className="flex items-center gap-2 text-sm">
                        <span className="text-base">{'\u{1F4E7}'}</span>
                        <span className="text-paper break-all">{ticket.customer_email}</span>
                      </div>
                    )}

                    {matchedContact ? (
                      <div onClick={() => onNavigate?.('contact', matchedContact.id)}
                        className="mt-2 p-3 glass-inner rounded-xl cursor-pointer flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center text-sm font-bold shrink-0">
                          {([matchedContact.first_name, matchedContact.last_name].filter(Boolean).join(' ')[0] || '?').toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-semibold text-paper">{[matchedContact.first_name, matchedContact.last_name].filter(Boolean).join(' ') || matchedContact.email || matchedContact.phone}</div>
                          <div className="text-xs text-muted">Known contact</div>
                        </div>
                      </div>
                    ) : canWrite ? (
                      creatingContact ? (
                        <div className="mt-2 p-3 glass-inner rounded-xl space-y-2">
                          <div className="text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim">New contact</div>
                          <div className="grid grid-cols-2 gap-2">
                            <input className={input} placeholder="First name" value={newContact.first_name} onChange={e => setNewContact({ ...newContact, first_name: e.target.value })} autoFocus />
                            <input className={input} placeholder="Last name" value={newContact.last_name} onChange={e => setNewContact({ ...newContact, last_name: e.target.value })} />
                          </div>
                          <input className={input} placeholder="Email" value={newContact.email || ticket.customer_email || ''} onChange={e => setNewContact({ ...newContact, email: e.target.value })} />
                          <input className={input} placeholder="Phone" value={newContact.phone || ticket.customer_phone || ''} onChange={e => setNewContact({ ...newContact, phone: e.target.value })} />
                          <div className="flex gap-2">
                            <button onClick={createContactFromTicket} className="btn-glass px-3 py-1.5 rounded-xl text-xs">Create &amp; link</button>
                            <button onClick={() => setCreatingContact(false)} className="btn-ghost px-3 py-1.5 rounded-xl text-xs">Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <div className="mt-2 p-3 glass-inner rounded-xl">
                          <div className="text-xs text-muted mb-2">This customer isn't in your contacts yet.</div>
                          <button onClick={() => { setCreatingContact(true); setNewContact({ first_name: '', last_name: '', email: ticket.customer_email || '', phone: ticket.customer_phone || '' }); }}
                            className="btn-glass px-3 py-1.5 rounded-xl text-xs w-full">+ Create new contact</button>
                        </div>
                      )
                    ) : null}
                  </div>
                </Card>
              )}

              <Card title="Key Info">
                <div className="space-y-3">
                  <Field label="Priority" value={ticket.priority} />
                  <Field label="Type" value={ticket.ticket_type} />
                  <Field label="Stage" value={STAGE_LABELS[ticket.stage]} />
                  <Field label="Owner" value={ownerName(ticket.owner_id)} />
                  <Field label="Source" value={ticket.source} />
                  <Field label="Created" value={new Date(ticket.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })} />
                  {ticket.resolved_at && <Field label="Resolved" value={new Date(ticket.resolved_at).toLocaleDateString('en-GB')} />}
                  {ticket.description && <Field label="Description" value={ticket.description} />}
                  {ticket.notes && <Field label="Notes" value={ticket.notes} />}
                </div>
              </Card>

              <Card title="SLA">
                {(() => {
                  const sla = computeSla(ticket);
                  const fmt = (ts) => ts ? new Date(ts).toLocaleString('en-GB', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }) : '--';
                  return (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-paper font-medium">Status</span>
                        <SlaBadge ticket={ticket} />
                      </div>
                      <div className="space-y-1 pt-1 border-t border-bdr">
                        <div className="text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-0.5">First response</div>
                        <div className="flex justify-between text-xs"><span className="text-muted">Due</span><span className="text-paper">{fmt(ticket.response_due_at)}</span></div>
                        <div className="flex justify-between text-xs"><span className="text-muted">Responded</span>
                          <span className={ticket.first_response_at ? 'text-paper' : 'text-amber-600'}>{ticket.first_response_at ? fmt(ticket.first_response_at) : 'Awaiting reply'}</span></div>
                      </div>
                      <div className="space-y-1 pt-2 border-t border-bdr">
                        <div className="text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-0.5">Resolution</div>
                        <div className="flex justify-between text-xs"><span className="text-muted">Due</span><span className="text-paper">{fmt(ticket.resolution_due_at)}</span></div>
                        <div className="flex justify-between text-xs"><span className="text-muted">Resolved</span>
                          <span className="text-paper">{ticket.resolved_at ? fmt(ticket.resolved_at) : ticket.closed_at ? fmt(ticket.closed_at) : '--'}</span></div>
                      </div>
                      {sla.detail && <div className="text-[11px] text-dim pt-1">{sla.detail}</div>}
                    </div>
                  );
                })()}
              </Card>

              {/* Contact context: companies/locations pulled from linked contacts */}
              {(contactContext.companies.length > 0 || contactContext.locations.length > 0) && (
                <Card title="Via Contact">
                  <div className="space-y-2">
                    {contactContext.companies.map(c => (
                      <div key={c.id} onClick={() => onNavigate?.('company', c.id)}
                        className="p-2 glass-inner rounded-xl cursor-pointer flex items-center gap-2">
                        <span className="text-sm">{'\u{1F3E2}'}</span>
                        <span className="text-xs text-paper">{c.name}</span>
                      </div>
                    ))}
                    {contactContext.locations.map(l => (
                      <div key={l.id} onClick={() => onNavigate?.('location', l.id)}
                        className="p-2 glass-inner rounded-xl cursor-pointer flex items-center gap-2">
                        <span className="text-sm">{'\u{1F4CD}'}</span>
                        <span className="text-xs text-paper">{l.name}</span>
                      </div>
                    ))}
                  </div>
                </Card>
              )}
            </div>

            {/* CENTER: Conversation — fills the viewport height, only the list scrolls */}
            <div className="flex-1 min-w-0 flex flex-col min-h-[560px] lg:min-h-0">
              <div className="flex-1 min-h-0 glass-card rounded-2xl overflow-hidden flex flex-col">
                <ConversationTimeline subjectType="ticket" subjectId={ticketId} profile={profile} contacts={[]} ticket={ticket} />
              </div>
            </div>

            {/* RIGHT rail — own scroll */}
            <div className="lg:w-[312px] lg:shrink-0 lg:overflow-y-auto space-y-5">
              <Card title="Company">
                {company ? (
                  <div onClick={() => onNavigate?.('company', company.id)}
                    className="p-3 glass-inner rounded-xl cursor-pointer flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-ember/15 border border-ember/25 flex items-center justify-center text-lg shrink-0">{'\u{1F3E2}'}</div>
                    <div className="flex-1 min-w-0">
                      <div className="text-base font-semibold text-paper">{company.name}</div>
                      <div className="text-xs text-muted">Company</div>
                    </div>
                  </div>
                ) : <Empty>No company</Empty>}
              </Card>

              <Card title="Locations" count={companyLocations.length}>
                {companyLocations.length > 0 ? (
                  <div className="space-y-2">
                    {companyLocations.map(l => (
                      <div key={l.id} onClick={() => onNavigate?.('location', l.id)}
                        className="p-3 glass-inner rounded-xl cursor-pointer">
                        <div className="text-sm font-medium text-paper">{l.name}</div>
                        <div className="text-xs text-muted">{[l.venue_type, l.city].filter(Boolean).join(' / ')}</div>
                      </div>
                    ))}
                  </div>
                ) : <Empty>No locations</Empty>}
              </Card>

              <AttachmentsCard subjectType="ticket" subjectId={ticketId} profile={profile} />

              <Card title="Projects" count={projects.length}
                action={canWrite ? { label: '+ Create', onClick: createLinkedProject } : null}>
                {projects.length > 0 ? (
                  <div className="space-y-2">
                    {projects.map(p => (
                      <div key={p.id} onClick={() => onNavigate?.('project', p.id)}
                        className="p-3 glass-inner rounded-xl cursor-pointer">
                        <div className="text-sm font-medium text-paper">{p.name}</div>
                        <div className="text-xs text-muted mt-0.5">{p.status}</div>
                      </div>
                    ))}
                  </div>
                ) : <Empty>No projects linked</Empty>}
              </Card>

              <Card title="Contacts">
                <AssociationManager subjectType="ticket" subjectId={ticketId} targetType="contact" profile={profile} onNavigate={onNavigate} />
              </Card>

              <Card title="Stage History" count={history.length}>
                {history.length > 0 ? (
                  <div className="space-y-2">
                    {history.map(h => (
                      <div key={h.id} className="flex items-center gap-3 text-xs py-1.5">
                        <span className="text-paper">{ownerName(h.changed_by)}</span>
                        <span className="text-muted">{h.from_stage ? STAGE_LABELS[h.from_stage] : 'Created'} &rarr; {STAGE_LABELS[h.to_stage]}</span>
                        <span className="text-dim ml-auto text-[10px]">
                          {new Date(h.changed_at).toLocaleDateString('en-GB', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' })}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : <Empty>No stage changes</Empty>}
              </Card>
            </div>
          </div>
        )}
    </div>
  );
}

function Card({ title, count, action, noPadding, children }) {
  return (
    <div className="glass-card rounded-2xl overflow-hidden">
      <div className="px-5 py-3.5 border-b border-bdr flex items-center gap-2">
        <h3 className="text-[13px] font-bold text-paper tracking-tight">{title}</h3>
        {count !== undefined && <span className="text-xs text-dim font-mono">({count})</span>}
        {action && <button onClick={action.onClick} className="ml-auto text-xs text-ember hover:text-ember-deep font-medium">{action.label}</button>}
      </div>
      <div className={noPadding ? '' : 'p-5'}>{children}</div>
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div>
      <div className="text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-0.5">{label}</div>
      <div className="text-sm text-paper break-words">{value || <span className="text-dim italic">--</span>}</div>
    </div>
  );
}

function Empty({ children }) {
  return <div className="text-xs text-dim italic py-3 text-center">{children}</div>;
}

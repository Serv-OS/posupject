import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import TimerButton from './TimerButton.jsx';
import ActivityTimeline from './ActivityTimeline.jsx';
import AssociationManager from './AssociationManager.jsx';
import AttachmentsCard from './AttachmentsCard.jsx';
import CallButton from '../CallButton.jsx';
import ScheduleMeeting from './ScheduleMeeting.jsx';
import LeadBadge from './LeadBadge.jsx';
import { LEAD_STAGES, LEAD_STAGE_MAP } from '../../lib/leadStages';

const STAGE_FLOW = ['new_lead', 'attempting', 'mql', 'sql'];
const SOURCE_OPTIONS = ['website', 'referral', 'cold_outreach', 'event', 'trade_show', 'social', 'inbound_call', 'inbound_email', 'pos_review_site', 'partner', 'other'];
const VENUE_TYPES = ['restaurant', 'bar', 'cafe', 'fast_casual', 'qsr', 'hotel_fb', 'nightclub', 'food_hall', 'catering', 'other'];

export default function LeadDetail({ leadId, profile, onClose, onNavigate }) {
  const [lead, setLead] = useState(null);
  const [company, setCompany] = useState(null);
  const [location, setLocation] = useState(null);
  const [contact, setContact] = useState(null);
  const [members, setMembers] = useState([]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const [ready, setReady] = useState(false);

  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  useEffect(() => { load(); }, [leadId]);

  // Make sure the lead's FK-linked records show up in the Contacts/Companies/
  // Locations boxes by mirroring them as associations (once).
  const ensureAssociations = async (ld) => {
    const links = [
      { id: ld.contact_id, to_type: 'contact', label: 'primary_contact' },
      { id: ld.company_id, to_type: 'company', label: 'primary_contact' },
      { id: ld.location_id, to_type: 'location', label: 'affected_location' },
    ].filter(x => x.id);
    if (!links.length) return;
    const { data: existing } = await supabase.from('associations')
      .select('from_type, from_id, to_type, to_id')
      .or(`and(from_type.eq.lead,from_id.eq.${leadId}),and(to_type.eq.lead,to_id.eq.${leadId})`);
    const has = (toType, toId) => (existing || []).some(a =>
      (a.from_type === 'lead' && a.from_id === leadId && a.to_type === toType && a.to_id === toId) ||
      (a.to_type === 'lead' && a.to_id === leadId && a.from_type === toType && a.from_id === toId));
    const toInsert = links.filter(l => !has(l.to_type, l.id))
      .map(l => ({ from_type: 'lead', from_id: leadId, to_type: l.to_type, to_id: l.id, label: l.label }));
    if (toInsert.length) await supabase.from('associations').insert(toInsert);
  };

  const load = async () => {
    const [l, m] = await Promise.all([
      supabase.from('leads').select('*').eq('id', leadId).single(),
      supabase.from('profiles').select('id, email, display_name'),
    ]);
    setLead(l.data);
    setMembers(m.data || []);
    // Linked records still fetched for the header Call button
    if (l.data?.company_id) supabase.from('companies').select('id, name, phone, domain').eq('id', l.data.company_id).single().then(r => setCompany(r.data)); else setCompany(null);
    if (l.data?.location_id) supabase.from('locations').select('id, name, phone, city, venue_type').eq('id', l.data.location_id).single().then(r => setLocation(r.data)); else setLocation(null);
    if (l.data?.contact_id) supabase.from('contacts').select('id, first_name, last_name, phone, email').eq('id', l.data.contact_id).single().then(r => setContact(r.data)); else setContact(null);
    if (l.data) { await ensureAssociations(l.data); setReady(true); }
  };

  const ownerName = (id) => { const m = members.find(u => u.id === id); return m ? (m.display_name || m.email.split('@')[0]) : 'Unassigned'; };

  const changeStage = async (s) => {
    if (s === lead.stage) return;
    await supabase.from('leads').update({ stage: s }).eq('id', leadId);
    await supabase.from('stage_history').insert({ object_type: 'lead', object_id: leadId, from_stage: lead.stage, to_stage: s, changed_by: profile.id });
    load();
  };

  const startEdit = () => { setDraft({ ...lead }); setEditing(true); };
  const save = async () => {
    const patch = {
      name: draft.name, source: draft.source || null, priority: draft.priority,
      venue_type: draft.venue_type || null, covers: draft.covers ? parseInt(draft.covers) : null,
      current_pos: draft.current_pos || null, next_action: draft.next_action || null,
      next_action_date: draft.next_action_date || null, notes: draft.notes || null,
      owner_id: draft.owner_id || null,
    };
    const { error } = await supabase.from('leads').update(patch).eq('id', leadId);
    if (error) { alert('Save failed: ' + error.message); return; }
    setEditing(false); load();
  };
  const set = (k, v) => setDraft({ ...draft, [k]: v });

  const convertToDeal = async () => {
    if (!confirm('Convert this lead into a deal?')) return;
    const { data: deal } = await supabase.from('deals').insert({
      name: `Deal: ${lead.name}`, company_id: lead.company_id, owner_id: lead.owner_id || profile.id, source: lead.source,
    }).select().single();
    if (deal) {
      await supabase.from('stage_history').insert({ object_type: 'deal', object_id: deal.id, from_stage: null, to_stage: 'new_lead', changed_by: profile.id });
      if (lead.contact_id) await supabase.from('associations').insert({ from_type: 'deal', from_id: deal.id, to_type: 'contact', to_id: lead.contact_id, label: 'primary_contact' });
      if (lead.location_id) await supabase.from('associations').insert({ from_type: 'deal', from_id: deal.id, to_type: 'location', to_id: lead.location_id, label: 'affected_location' });
      await supabase.from('leads').update({ stage: 'deal', deal_id: deal.id }).eq('id', leadId);
      onNavigate?.('deal', deal.id);
    }
  };

  const disqualify = async () => {
    const reason = prompt('Disqualification reason:');
    if (reason === null) return;
    await supabase.from('leads').update({ stage: 'disqualified', disqualified_reason: reason }).eq('id', leadId);
    load();
  };

  const deleteRecord = async () => {
    if (!confirm(`Delete lead "${lead?.name}"? This cannot be undone.`)) return;
    await supabase.from('leads').delete().eq('id', leadId);
    onClose();
  };

  if (!lead) return <div className="h-full flex items-center justify-center text-dim text-sm">Loading...</div>;

  const phone = contact?.phone || location?.phone || company?.phone || null;
  const input = "w-full px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper placeholder-dim focus:outline-none focus:border-ember";
  const label = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block";

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 py-4 border-b border-bdr flex items-center gap-3">
        <button onClick={onClose} className="text-muted hover:text-paper text-lg">&larr;</button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <div className="text-xl font-bold text-paper truncate">{lead.name}</div>
            <LeadBadge stage={lead.stage} full />
          </div>
          <div className="text-xs text-muted mt-0.5">
            {lead.source && <span>{lead.source.replace(/_/g, ' ')} / </span>}
            {lead.priority} priority / Owner: {ownerName(lead.owner_id)}
          </div>
        </div>
        {!editing && <TimerButton subjectType="lead" subjectId={leadId} label={lead.name} profile={profile} />}
        {!editing && (
          <ScheduleMeeting subjectType="lead" subjectId={leadId} contactId={lead.contact_id}
            attendeeEmail={contact?.email} defaultTitle={`Meeting: ${lead.name}`} />
        )}
        {!editing && phone && <CallButton number={phone} className="px-3 py-2 text-sm" />}
        {canWrite && !editing && (
          <div className="flex gap-2">
            <button onClick={startEdit} className="btn-ghost px-4 py-2 rounded-xl text-sm">Edit</button>
            {profile.role === 'owner' && <button onClick={deleteRecord} className="px-3 py-2 text-xs text-red-600 border border-red-200 rounded-xl hover:bg-red-50 transition">Delete</button>}
          </div>
        )}
      </div>

      {/* Stage bar */}
      {canWrite && lead.stage !== 'deal' && lead.stage !== 'disqualified' && (
        <div className="px-6 py-2 border-b border-bdr flex gap-0.5 overflow-x-auto items-center">
          {STAGE_FLOW.map((s, i) => {
            const active = lead.stage === s;
            const past = STAGE_FLOW.indexOf(lead.stage) > i;
            return (
              <button key={s} onClick={() => changeStage(s)}
                className={`px-2.5 py-1.5 text-[9px] font-bold uppercase rounded-xl transition whitespace-nowrap ${active ? 'bg-ember text-white' : past ? 'bg-ember/20 text-ember' : 'bg-card text-dim hover:text-paper'}`}>
                {LEAD_STAGE_MAP[s]?.short || s}
              </button>
            );
          })}
          <div className="ml-auto flex gap-2">
            <button onClick={convertToDeal} className="px-3 py-1.5 text-[10px] font-bold bg-emerald-100 text-emerald-700 border border-emerald-200 rounded-lg hover:bg-emerald-200">Convert to Deal</button>
            <button onClick={disqualify} className="px-3 py-1.5 text-[10px] font-bold text-red-600 border border-red-200 rounded-lg hover:bg-red-50">Disqualify</button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-6">
        {editing ? (
          <div className="max-w-2xl">
            <Card title="Edit Lead">
              <div className="space-y-3">
                <div><label className={label}>Name</label><input className={input} value={draft.name || ''} onChange={e => set('name', e.target.value)} /></div>
                <div className="grid grid-cols-2 gap-3">
                  <div><label className={label}>Source</label><select className={input} value={draft.source || ''} onChange={e => set('source', e.target.value)}>
                    <option value="">--</option>{SOURCE_OPTIONS.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}</select></div>
                  <div><label className={label}>Priority</label><select className={input} value={draft.priority || 'medium'} onChange={e => set('priority', e.target.value)}>
                    <option value="hot">Hot</option><option value="warm">Warm</option><option value="medium">Medium</option><option value="cold">Cold</option></select></div>
                  <div><label className={label}>Venue type</label><select className={input} value={draft.venue_type || ''} onChange={e => set('venue_type', e.target.value)}>
                    <option value="">--</option>{VENUE_TYPES.map(v => <option key={v} value={v}>{v.replace(/_/g, ' ')}</option>)}</select></div>
                  <div><label className={label}>Covers</label><input type="number" className={input} value={draft.covers || ''} onChange={e => set('covers', e.target.value)} /></div>
                  <div><label className={label}>Current POS</label><input className={input} value={draft.current_pos || ''} onChange={e => set('current_pos', e.target.value)} /></div>
                  <div><label className={label}>Owner</label><select className={input} value={draft.owner_id || ''} onChange={e => set('owner_id', e.target.value || null)}>
                    <option value="">Unassigned</option>{members.map(m => <option key={m.id} value={m.id}>{m.display_name || m.email}</option>)}</select></div>
                  <div><label className={label}>Next action</label><input className={input} value={draft.next_action || ''} onChange={e => set('next_action', e.target.value)} placeholder="e.g. Book demo" /></div>
                  <div><label className={label}>Next action date</label><input type="date" className={input} value={draft.next_action_date || ''} onChange={e => set('next_action_date', e.target.value)} /></div>
                </div>
                <div><label className={label}>Notes</label><textarea className={input + ' resize-none'} rows={3} value={draft.notes || ''} onChange={e => set('notes', e.target.value)} /></div>
                <div className="flex gap-2"><button onClick={save} className="btn-glass px-5 py-2 rounded-xl text-sm">Save</button><button onClick={() => setEditing(false)} className="btn-ghost px-4 py-2 rounded-xl text-sm">Cancel</button></div>
              </div>
            </Card>
          </div>
        ) : (
          <div className="grid grid-cols-12 gap-4 max-w-[1400px]">
            {/* LEFT: key info + linked records */}
            <div className="col-span-4 space-y-4">
              <Card title="Lead Info">
                <div className="space-y-3">
                  <Field label="Source" value={lead.source?.replace(/_/g, ' ')} />
                  <Field label="Priority" value={lead.priority} />
                  <Field label="Venue type" value={lead.venue_type?.replace(/_/g, ' ')} />
                  <Field label="Covers" value={lead.covers} />
                  <Field label="Current POS" value={lead.current_pos} />
                  <Field label="Next action" value={[lead.next_action, lead.next_action_date].filter(Boolean).join(' / ')} />
                  <Field label="Owner" value={ownerName(lead.owner_id)} />
                  <Field label="Created" value={new Date(lead.created_at).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'2-digit' })} />
                  {lead.disqualified_reason && <Field label="Disqualified" value={lead.disqualified_reason} />}
                  {lead.notes && <Field label="Notes" value={lead.notes} />}
                </div>
              </Card>

              <AttachmentsCard subjectType="lead" subjectId={leadId} profile={profile} />
            </div>

            {/* MIDDLE: activity */}
            <div className="col-span-4 space-y-4">
              <Card title="Activity & notes">
                <ActivityTimeline subjectType="lead" subjectId={leadId} profile={profile} contactEmail={contact?.email} />
              </Card>
            </div>

            {/* RIGHT: associations (includes the lead's linked company/location/contact) */}
            <div className="col-span-4 space-y-4">
              {ready ? (
                <>
                  <Card title="Contacts">
                    <AssociationManager subjectType="lead" subjectId={leadId} targetType="contact" profile={profile} onNavigate={onNavigate} />
                  </Card>
                  <Card title="Companies">
                    <AssociationManager subjectType="lead" subjectId={leadId} targetType="company" profile={profile} onNavigate={onNavigate} />
                  </Card>
                  <Card title="Locations">
                    <AssociationManager subjectType="lead" subjectId={leadId} targetType="location" profile={profile} onNavigate={onNavigate} />
                  </Card>
                </>
              ) : (
                <Card title="Linked records"><Empty>Loading…</Empty></Card>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Card({ title, noPadding, children }) {
  return (
    <div className="glass-card rounded-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-bdr"><h3 className="text-sm font-bold text-paper">{title}</h3></div>
      <div className={noPadding ? '' : 'p-4'}>{children}</div>
    </div>
  );
}
function Field({ label, value }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div>
      <div className="text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-0.5">{label}</div>
      <div className="text-sm text-paper break-words">{value}</div>
    </div>
  );
}
function Empty({ children }) { return <div className="text-xs text-dim italic py-3 text-center">{children}</div>; }

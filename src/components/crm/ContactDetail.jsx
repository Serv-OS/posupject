import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import TimerButton from './TimerButton.jsx';
import AssociationManager from './AssociationManager.jsx';
import ActivityTimeline from './ActivityTimeline.jsx';
import CallButton from '../CallButton.jsx';
import LeadBadge from './LeadBadge.jsx';
import LeadsCard from './LeadsCard.jsx';
import InvoicesCard from './InvoicesCard.jsx';
import ScheduleMeeting from './ScheduleMeeting.jsx';
import { primaryLead } from '../../lib/leadStages';

export default function ContactDetail({ contactId, profile, onClose, onNavigate, onCreateLead }) {
  const [contact, setContact] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const [members, setMembers] = useState([]);
  const [leads, setLeads] = useState([]);

  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  useEffect(() => { load(); }, [contactId]);

  const load = async () => {
    const [c, m, ld] = await Promise.all([
      supabase.from('contacts').select('*').eq('id', contactId).single(),
      supabase.from('profiles').select('id, email, display_name'),
      supabase.from('leads').select('*').eq('contact_id', contactId).order('created_at', { ascending: false }),
    ]);
    setContact(c.data);
    setMembers(m.data || []);
    setLeads(ld.data || []);
  };

  const startEdit = () => { setDraft({ ...contact }); setEditing(true); };
  const save = async () => {
    const { id, created_at, updated_at, ...patch } = draft;
    await supabase.from('contacts').update(patch).eq('id', contactId);
    setEditing(false); load();
  };
  const set = (k, v) => setDraft({ ...draft, [k]: v });

  const deleteRecord = async () => {
    const name = [contact?.first_name, contact?.last_name].filter(Boolean).join(' ') || contact?.email;
    if (!confirm(`Delete contact "${name}"?\n\nThis cannot be undone.`)) return;
    await supabase.from('contacts').delete().eq('id', contactId);
    onClose();
  };

  if (!contact) return <div className="h-full flex items-center justify-center text-dim text-sm">Loading...</div>;

  const fullName = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || 'Unnamed contact';

  const input = "w-full px-3 py-2 bg-card border border-bdr rounded text-sm text-paper placeholder-dim focus:outline-none focus:border-ember";
  const label = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block";

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 py-4 border-b border-bdr flex items-center gap-3">
        <button onClick={onClose} className="text-muted hover:text-paper text-lg">&larr;</button>
        <div className="w-10 h-10 rounded-full bg-ember text-ink text-base font-bold flex items-center justify-center shrink-0">
          {fullName[0]?.toUpperCase() || '?'}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <div className="text-xl font-bold text-paper truncate">{fullName}</div>
            {primaryLead(leads) && <LeadBadge stage={primaryLead(leads).stage} full />}
          </div>
          <div className="text-xs text-muted mt-0.5">
            {contact.job_title && <span>{contact.job_title} / </span>}
            {contact.email && <span className="text-ember">{contact.email}</span>}
            {contact.phone && <span> / {contact.phone}</span>}
          </div>
        </div>
        {!editing && <TimerButton subjectType="contact" subjectId={contactId} label={fullName} profile={profile} />}
        {!editing && (
          <ScheduleMeeting subjectType="contact" subjectId={contactId} contactId={contactId}
            attendeeEmail={contact.email} defaultTitle={`Meeting with ${fullName}`} />
        )}
        {!editing && contact.phone && (
          <CallButton number={contact.phone} className="px-3 py-2 text-sm" />
        )}
        {canWrite && !editing && (
          <div className="flex gap-2">
            <button onClick={async () => {
              const { data } = await supabase.from('associations').select('from_id, to_id, from_type, to_type')
                .or(`and(from_type.eq.contact,from_id.eq.${contactId},to_type.eq.company),and(to_type.eq.contact,to_id.eq.${contactId},from_type.eq.company)`).limit(1);
              const companyId = data && data.length ? (data[0].from_type === 'company' ? data[0].from_id : data[0].to_id) : null;
              onCreateLead?.({ contactId, companyId });
            }} className="px-3 py-2 text-xs font-semibold rounded-xl bg-ember/15 text-ember-deep border border-ember/25 hover:bg-ember/25">+ Lead</button>
            <button onClick={startEdit} className="btn-ghost px-4 py-2 rounded-xl text-sm">Edit</button>
            {profile.role === 'owner' && (
              <button onClick={deleteRecord} className="px-3 py-2 text-xs text-red-600 border border-red-200 rounded-xl hover:bg-red-50 transition">Delete</button>
            )}
          </div>
        )}
      </div>

      {/* Card grid */}
      <div className="flex-1 overflow-y-auto p-6">
        {editing ? (
          <div className="max-w-4xl">
            <Card title="Edit Contact">
              <div className="grid grid-cols-2 gap-3">
                <div><label className={label}>First name</label><input className={input} value={draft.first_name || ''} onChange={e => set('first_name', e.target.value)} /></div>
                <div><label className={label}>Last name</label><input className={input} value={draft.last_name || ''} onChange={e => set('last_name', e.target.value)} /></div>
                <div><label className={label}>Email</label><input className={input} type="email" value={draft.email || ''} onChange={e => set('email', e.target.value)} /></div>
                <div><label className={label}>Phone</label><input className={input} value={draft.phone || ''} onChange={e => set('phone', e.target.value)} /></div>
                <div><label className={label}>Job title</label><input className={input} value={draft.job_title || ''} onChange={e => set('job_title', e.target.value)} /></div>
                <div><label className={label}>Source</label><input className={input} value={draft.source || ''} onChange={e => set('source', e.target.value)} /></div>
                <div><label className={label}>Owner</label><select className={input} value={draft.owner_id || ''} onChange={e => set('owner_id', e.target.value || null)}>
                  <option value="">Unassigned</option>{members.map(m => <option key={m.id} value={m.id}>{m.display_name || m.email}</option>)}</select></div>
                <div className="flex items-end"><label className="flex items-center gap-2 cursor-pointer py-2">
                  <input type="checkbox" checked={draft.marketing_opt_in || false} onChange={e => set('marketing_opt_in', e.target.checked)} className="accent-ember" />
                  <span className="text-sm text-paper">Marketing opt-in</span></label></div>
              </div>
              <div className="mt-3"><label className={label}>Notes</label><textarea className={input + ' resize-none'} rows={3} value={draft.notes || ''} onChange={e => set('notes', e.target.value)} /></div>
              <div className="flex gap-2 mt-4">
                <button onClick={save} className="px-5 py-2 bg-ember text-ink text-sm font-semibold rounded hover:bg-ember-deep">Save</button>
                <button onClick={() => setEditing(false)} className="px-4 py-2 text-sm text-muted border border-bdr rounded">Cancel</button>
              </div>
            </Card>
          </div>
        ) : (
          <div className="grid grid-cols-12 gap-4 max-w-[1400px]">

            {/* LEFT: Key Info */}
            <div className="col-span-4 space-y-4">
              <Card title="Key Info">
                <div className="space-y-3">
                  <Field label="Email" value={contact.email} />
                  <Field label="Phone" value={contact.phone} />
                  <Field label="Job Title" value={contact.job_title} />
                  <Field label="Source" value={contact.source} />
                  <Field label="Marketing" value={contact.marketing_opt_in ? 'Opted in' : 'Not opted in'} />
                  {contact.gdpr_consent_at && <Field label="GDPR Consent" value={new Date(contact.gdpr_consent_at).toLocaleDateString('en-GB')} />}
                  {contact.notes && <Field label="Notes" value={contact.notes} />}
                </div>
              </Card>
            </div>

            {/* MIDDLE: Activity */}
            <div className="col-span-4 space-y-4">
              <Card title="Activity">
                <ActivityTimeline subjectType="contact" subjectId={contactId} profile={profile} />
              </Card>
            </div>

            {/* RIGHT: Leads + Companies + Locations */}
            <div className="col-span-4 space-y-4">
              <LeadsCard leads={leads} />

              <InvoicesCard contactId={contactId} profile={profile} onNavigate={onNavigate} />

              <Card title="Companies">
                <AssociationManager subjectType="contact" subjectId={contactId} targetType="company" profile={profile} onNavigate={onNavigate} />
              </Card>

              <Card title="Locations">
                <AssociationManager subjectType="contact" subjectId={contactId} targetType="location" profile={profile} onNavigate={onNavigate} />
              </Card>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Card({ title, count, action, children }) {
  return (
    <div className="glass-card rounded-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-bdr flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-bold text-paper">{title}</h3>
          {count !== undefined && <span className="text-xs text-dim font-mono">({count})</span>}
        </div>
        {action && <button onClick={action.onClick} className="text-xs text-ember hover:text-ember-deep font-medium">{action.label}</button>}
      </div>
      <div className="p-4">{children}</div>
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

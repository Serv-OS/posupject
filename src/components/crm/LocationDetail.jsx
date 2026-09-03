import { useEffect, useState, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { EditSheet } from './ui.jsx';
import { LocationTradingCard } from './TradingCard.jsx';
import TimerButton from './TimerButton.jsx';
import AttachmentsCard from './AttachmentsCard.jsx';
import PosLinkCard from './PosLinkCard.jsx';
import AssociationManager from './AssociationManager.jsx';
import ActivityTimeline from './ActivityTimeline.jsx';
import CallButton from '../CallButton.jsx';
import LeadBadge from './LeadBadge.jsx';
import LeadsCard from './LeadsCard.jsx';
import ProcessingRatesCard from './ProcessingRatesCard.jsx';
import HardwareCard from './HardwareCard.jsx';
import SlaBadge from './SlaBadge.jsx';
import { Card as WorkCard, Pill, Mono, Avatar, MobileSheet, SheetRow, PrimaryBtn, GhostBtn } from './ui.jsx';
import { runOrQueue, isOnline } from '../../lib/offlineQueue';
import { startTimer } from '../../lib/timer';
import InvoicesCard from './InvoicesCard.jsx';
import LocationModulesCard from './LocationModulesCard.jsx';
import EntityPicker from './EntityPicker.jsx';
import { primaryLead } from '../../lib/leadStages';

const STATUS_OPTIONS = ['prospect', 'onboarding', 'live', 'churned'];
const STATUS_COLORS = {
  prospect: 'bg-blue-100 text-blue-700 border border-blue-200 border-blue-500/30',
  onboarding: 'bg-orange-100 text-orange-700 border border-orange-200 border-orange-500/30',
  live: 'bg-emerald-100 text-emerald-700 border border-emerald-200 border-green-500/30',
  churned: 'bg-red-100 text-red-700 border border-red-200 border-red-500/30',
};

export default function LocationDetail({ locationId, profile, onClose, onNavigate, onCreateLead }) {
  const [location, setLocation] = useState(null);
  const [company, setCompany] = useState(null);
  const [companies, setCompanies] = useState([]);
  const [deals, setDeals] = useState([]);
  const [onboardings, setOnboardings] = useState([]);
  const [projects, setProjects] = useState([]);
  const [leads, setLeads] = useState([]);
  const [editing, setEditing] = useState(false);
  const [saveErr, setSaveErr] = useState('');
  const [draft, setDraft] = useState({});
  const [members, setMembers] = useState([]);
  // Phone site screen (17): open work here, who is on site, and what you record while standing there.
  const [tickets, setTickets] = useState([]);
  const [siteContacts, setSiteContacts] = useState([]);
  const [sheet, setSheet] = useState(null); // 'more' | 'note' | 'ticket'
  const [sheetText, setSheetText] = useState('');
  const [flash, setFlash] = useState('');
  const fileRef = useRef(null);
  useEffect(() => {
    if (!locationId) return;
    supabase.from('tickets').select('id, ticket_number, subject, priority, stage, status, sla_due_at, first_response_due_at, resolution_due_at, created_at').eq('location_id', locationId).order('created_at', { ascending: false }).limit(30)
      .then(r => setTickets((r.data || []).filter(t => !/closed|resolved|done|cancel/i.test(`${t.stage || ''} ${t.status || ''}`))));
    supabase.from('associations').select('from_type, from_id, to_type, to_id').or(`and(from_type.eq.location,from_id.eq.${locationId},to_type.eq.contact),and(to_type.eq.location,to_id.eq.${locationId},from_type.eq.contact)`)
      .then(async r => {
        const ids = [...new Set((r.data || []).map(x => (x.from_type === 'contact' ? x.from_id : x.to_id)))];
        if (!ids.length) { setSiteContacts([]); return; }
        const c = await supabase.from('contacts').select('id, first_name, last_name, job_title, phone, email').in('id', ids);
        setSiteContacts(c.data || []);
      });
  }, [locationId]);
  const say = (m) => { setFlash(m); setTimeout(() => setFlash(''), 2500); };
  const recordNote = async () => {
    const body = sheetText.trim(); if (!body) return;
    const r = await runOrQueue(supabase, `Note on ${location?.name || 'site'}`, { table: 'crm_activities', kind: 'insert', values: { type: 'note', body, subject_type: 'location', subject_id: locationId, actor_id: profile.id } });
    setSheet(null); setSheetText(''); say(r.queued ? 'Note queued — sends when signal returns' : r.error ? `Could not save: ${r.error.message}` : 'Note saved');
  };
  const recordPhoto = async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    if (!isOnline()) { say('Photos need signal — try again when you are back online'); return; }
    const path = `location/${locationId}/${crypto.randomUUID()}-${file.name.replace(/[^\w.\-]+/g, '_')}`;
    const { error: upErr } = await supabase.storage.from('attachments').upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
    if (upErr) { say(`Upload failed: ${upErr.message}`); return; }
    const r = await runOrQueue(supabase, `Photo — ${file.name}`, { table: 'attachments', kind: 'insert', values: { subject_type: 'location', subject_id: locationId, file_name: file.name, file_path: path, mime_type: file.type || null, size_bytes: file.size, uploaded_by: profile.id } });
    say(r.error ? `Could not save: ${r.error.message}` : 'Photo added');
    if (fileRef.current) fileRef.current.value = '';
  };
  const recordTime = async () => {
    try { await startTimer({ subjectType: 'location', subjectId: locationId, label: location?.name, profileId: profile.id }); say('Timer running for this site'); }
    catch (err) { say(`Could not start: ${err.message}`); }
  };
  const recordTicket = async () => {
    const subject = sheetText.trim(); if (!subject) return;
    const values = { subject, location_id: locationId, company_id: location?.company_id || null, priority: 'P2', ticket_type: 'support', owner_id: profile.id, channel: 'phone', source: 'site' };
    if (!isOnline()) { const r = await runOrQueue(supabase, `New ticket — ${subject}`, { table: 'tickets', kind: 'insert', values }); setSheet(null); setSheetText(''); say(r.queued ? 'Ticket queued — sends when signal returns' : 'Ticket raised'); return; }
    const { data: t, error } = await supabase.from('tickets').insert(values).select('id').single();
    if (error) { say(`Could not raise: ${error.message}`); return; }
    await supabase.from('stage_history').insert({ object_type: 'ticket', object_id: t.id, from_stage: null, to_stage: 'new', changed_by: profile.id });
    setSheet(null); setSheetText(''); onNavigate?.('ticket', t.id);
  };

  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  useEffect(() => { load(); }, [locationId]);

  const load = async () => {
    const [l, m, prj, ld] = await Promise.all([
      supabase.from('locations').select('*').eq('id', locationId).single(),
      supabase.from('profiles').select('id, email, display_name'),
      supabase.from('crm_projects').select('*').eq('subject_type', 'location').eq('subject_id', locationId).order('created_at', { ascending: false }),
      supabase.from('leads').select('*').eq('location_id', locationId).order('created_at', { ascending: false }),
    ]);
    setLocation(l.data);
    supabase.from('companies').select('id, name').order('name').then(r => setCompanies(r.data || []));
    setMembers(m.data || []);
    setProjects(prj.data || []);
    setLeads(ld.data || []);
    // Deals and onboardings belong to THIS LOCATION, not to whoever happens to
    // own the company this month. Fetching them by the location's company_id
    // was wrong three ways: the page listed every sibling site's deals as if
    // they were this one's, a location moved to another company instantly lost
    // its own deal off the page while a stranger's appeared in its place, and a
    // location with no company kept whatever the previously-viewed one had.
    // Nothing was ever deleted; the page was asking the wrong question.
    const [assoc, ob] = await Promise.all([
      // Written from either end depending on which screen made the link.
      supabase.from('associations').select('from_type, from_id, to_type, to_id')
        .or(`and(to_type.eq.location,to_id.eq.${locationId}),and(from_type.eq.location,from_id.eq.${locationId})`),
      supabase.from('onboardings').select('*').eq('location_id', locationId).order('created_at', { ascending: false }),
    ]);
    const dealIds = [...new Set((assoc.data || [])
      .map(a => (a.from_type === 'deal' ? a.from_id : a.to_type === 'deal' ? a.to_id : null))
      .filter(Boolean))];
    const d = dealIds.length
      ? await supabase.from('deals').select('*').in('id', dealIds).order('created_at', { ascending: false })
      : { data: [] };
    setDeals(d.data || []);
    setOnboardings(ob.data || []);

    // The company block is the only part that legitimately depends on the link.
    if (l.data?.company_id) {
      const { data: c } = await supabase.from('companies').select('id, name').eq('id', l.data.company_id).single();
      setCompany(c);
    } else {
      setCompany(null);
    }
  };

  const startEdit = () => { setDraft({ ...location }); setEditing(true); setSaveErr(''); };

  // Only the fields this form actually edits. It used to spread the whole row
  // minus id/created_at/updated_at, which broke the moment the table gained a
  // generated column (est_monthly_transactions): Postgres refuses any write to
  // one, the update failed, and because the result was never checked the panel
  // closed as though it had saved. An allow-list cannot rot that way.
  const EDITABLE = [
    'name', 'address', 'city', 'postcode', 'phone', 'email', 'venue_type',
    'covers', 'status', 'owner_id', 'notes', 'kickoff_at',
    'expected_install_date', 'actual_install_date', 'go_live_date', 'activation_date',
    'venue_code',
  ];

  const save = async () => {
    const patch = {};
    for (const k of EDITABLE) if (k in draft) patch[k] = draft[k] === '' ? null : draft[k];
    const { error } = await supabase.from('locations').update(patch).eq('id', locationId);
    if (error) { setSaveErr(error.message); return; }   // stay open, keep their typing
    setSaveErr(''); setEditing(false); load();
  };
  const set = (k, v) => setDraft({ ...draft, [k]: v });

  // Unlink this location from its company (e.g. ownership changed). Keeps the
  // location + its history; only clears the company link.
  const unlinkCompany = async () => {
    if (!confirm(`Unlink "${location?.name}" from ${company?.name || 'this company'}?\n\nThe location and its history stay — only the company link is removed.`)) return;
    const { error } = await supabase.from('locations').update({ company_id: null }).eq('id', locationId);
    if (error) { alert('Could not unlink: ' + error.message); return; }
    load();
  };

  // Assign (or reassign) this location to a company (e.g. new owner).
  const linkCompany = async (cid) => {
    const { error } = await supabase.from('locations').update({ company_id: cid }).eq('id', locationId);
    if (error) { alert('Could not link: ' + error.message); return; }
    load();
  };

  const deleteRecord = async () => {
    if (!confirm(`Delete location "${location?.name}"?\n\nThis cannot be undone.`)) return;
    await supabase.from('locations').delete().eq('id', locationId);
    onClose();
  };

  const createLinkedProject = async () => {
    const name = prompt(`Project name for ${location?.name}:`);
    if (!name?.trim()) return;
    const { data } = await supabase.from('crm_projects').insert({
      name: name.trim(),
      subject_type: 'location',
      subject_id: locationId,
      owner_id: profile.id,
    }).select().single();
    if (data) onNavigate?.('project', data.id);
    else load();
  };

  const ownerName = (id) => { const m = members.find(u => u.id === id); return m ? (m.display_name || m.email.split('@')[0]) : 'Unassigned'; };

  if (!location) return <div className="h-full flex items-center justify-center text-dim text-sm">Loading...</div>;

  const input = "w-full px-3 py-2 bg-card border border-bdr rounded text-sm text-paper placeholder-dim focus:outline-none focus:border-ember";
  const label = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block";

  const DEAL_STAGES ={ new_lead:'New Lead', contacted:'Contacted', qualified:'Qualified', demo_booked:'Demo Booked', demo_done:'Demo Done', proposal_sent:'Proposal', negotiation:'Negotiation', closed_won:'Won', closed_lost:'Lost' };
  const OB_STAGES = { kickoff:'Kickoff', hardware_ordered:'HW Ordered', hardware_shipped:'HW Shipped', account_menu_config:'Config', staff_training:'Training', go_live_scheduled:'Go-Live', live:'Live', handover_to_support:'Handover', on_hold:'On Hold' };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="lg:hidden px-[18px] pt-3 pb-[14px] border-b" style={{ borderColor: 'var(--hair)' }}>
        <button onClick={onClose} className="text-[13px] text-dim">&larr; Sites</button>
        <div className="font-display text-[22px] font-extrabold text-paper truncate">{location.name}</div>
        <div className="text-[13px] text-muted truncate">
          {company?.name || 'No company'}{location.go_live_date ? ` · live since ${new Date(location.go_live_date).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })}` : location.status ? ` · ${location.status}` : ''}
        </div>
        <div className="flex gap-2 mt-2.5">
          {location.phone
            ? <a href={`tel:${location.phone}`} className="flex-1 text-center px-3 py-3 rounded-[11px] text-[14px] font-semibold" style={{ background: 'linear-gradient(180deg, rgb(var(--c-primary)), rgb(var(--c-primary-deep)))', color: 'rgb(var(--c-ink))' }}>Call site</a>
            : <span className="flex-1 text-center px-3 py-3 rounded-[11px] text-[14px] font-semibold opacity-50" style={{ background: 'var(--surface-solid)', border: '1px solid var(--ink-line)' }}>No phone</span>}
          <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([location.address, location.city, location.postcode].filter(Boolean).join(', ') || location.name)}`} target="_blank" rel="noreferrer"
            className="flex-1 text-center px-3 py-3 rounded-[11px] text-[14px] font-semibold text-paper" style={{ background: 'var(--surface-solid)', border: '1px solid var(--ink-line)' }}>Navigate</a>
          <button onClick={() => setSheet('more')} className="px-[15px] py-3 rounded-[11px] text-[14px] text-paper" style={{ background: 'var(--surface-solid)', border: '1px solid var(--ink-line)' }}>…</button>
        </div>
      </div>
      <div className="hidden lg:flex px-6 py-5 border-b border-bdr items-center gap-4">
        <button onClick={onClose} className="text-muted hover:text-paper text-lg">&larr;</button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 mb-1.5">
            <div className="text-xl font-bold text-paper truncate">{location.name}</div>
            <span className={`badge-status ${STATUS_COLORS[location.status] || ''}`}>{location.status}</span>
            {primaryLead(leads) && <LeadBadge stage={primaryLead(leads).stage} full />}
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            {location.company_id && (
              <span className="badge-company inline-flex items-center gap-1.5">
                <span className="cursor-pointer" onClick={() => onNavigate?.('company', location.company_id)}>
                  {'\u{1F3E2}'} {company?.name || 'Unknown company'}
                </span>
                {canWrite && (
                  <button onClick={unlinkCompany} title="Remove company link"
                    className="text-red-500 hover:text-red-700 font-bold leading-none">×</button>
                )}
              </span>
            )}
            {location.venue_type && <span className="text-xs text-muted">{location.venue_type}</span>}
            {location.covers && <span className="text-xs text-muted">{location.covers} covers</span>}
          </div>
        </div>
        {!editing && <TimerButton subjectType="location" subjectId={locationId} label={location.name} profile={profile} />}
        {!editing && location.phone && (
          <CallButton number={location.phone} className="px-3 py-2 text-sm" />
        )}
        {canWrite && !editing && (
          <div className="flex gap-2">
            <button onClick={() => onCreateLead?.({ locationId, companyId: location.company_id })} className="px-3 py-2 text-xs font-semibold rounded-xl bg-ember/15 text-ember-deep border border-ember/25 hover:bg-ember/25">+ Lead</button>
            <button onClick={startEdit} className="btn-ghost px-4 py-2 rounded-xl text-sm">Edit</button>
            {profile.role === 'owner' && (
              <button onClick={deleteRecord} className="px-3 py-2 text-xs text-red-600 border border-red-200 rounded-xl hover:bg-red-50 transition">Delete</button>
            )}
          </div>
        )}
      </div>

      {/* Card grid */}
      <div className="flex-1 overflow-y-auto p-[14px] lg:p-6">
        {flash && <div className="lg:hidden mb-3 px-[14px] py-2.5 rounded-[12px] text-[13px] font-medium" style={{ background: 'rgb(var(--c-primary) / .12)', color: 'rgb(var(--c-primary-deep))' }}>{flash}</div>}
        {!editing && (
          <div className="lg:hidden flex flex-col gap-3 pb-[calc(70px+env(safe-area-inset-bottom))]">
            <WorkCard>
              <div className="px-[15px] py-3 border-b flex items-center gap-2" style={{ borderColor: 'var(--hair)' }}>
                <span className="text-[14px] font-bold text-paper">Open work here</span><Mono>{tickets.length + onboardings.filter(o => !/live|complete|done|cancel/i.test(o.stage || '')).length + projects.filter(p => p.status === 'active').length}</Mono>
              </div>
              {tickets.map(t => (
                <button key={t.id} onClick={() => onNavigate?.('ticket', t.id)} className="w-full text-left px-[15px] py-[13px] border-b" style={{ borderColor: 'var(--hair)', borderLeft: (t.priority === 'P0' || t.priority === 'P1') ? '3px solid rgb(var(--c-coral))' : '3px solid transparent' }}>
                  <div className="flex items-center gap-2"><Pill tone="coral">Ticket</Pill><SlaBadge ticket={t} /></div>
                  <div className="text-[15px] font-medium text-paper mt-1">{t.ticket_number ? `#${t.ticket_number} ` : ''}{t.subject}</div>
                </button>
              ))}
              {onboardings.filter(o => !/live|complete|done|cancel/i.test(o.stage || '')).map(o => (
                <button key={o.id} onClick={() => onNavigate?.('onboarding', o.id)} className="w-full text-left px-[15px] py-[13px] border-b" style={{ borderColor: 'var(--hair)' }}>
                  <div className="flex items-center gap-2"><Pill tone="uv">Onboarding</Pill><Mono>{String(o.stage || '').replace(/_/g, ' ')}</Mono></div>
                  <div className="text-[15px] font-medium text-paper mt-1">{o.name || company?.name || 'Onboarding'}</div>
                </button>
              ))}
              {projects.filter(p => p.status === 'active').map(p => (
                <button key={p.id} onClick={() => onNavigate?.('project', p.id)} className="w-full text-left px-[15px] py-[13px] border-b last:border-b-0" style={{ borderColor: 'var(--hair)' }}>
                  <div className="flex items-center gap-2"><Pill tone="primary">Project</Pill>{p.due_date && <Mono>due {new Date(p.due_date + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</Mono>}</div>
                  <div className="text-[15px] font-medium text-paper mt-1">{p.name}</div>
                </button>
              ))}
              {tickets.length + onboardings.length + projects.length === 0 && <div className="px-[15px] py-4 text-[13px] text-dim">Nothing open at this site.</div>}
            </WorkCard>
            <WorkCard>
              <div className="px-[15px] py-3 border-b flex items-center gap-2" style={{ borderColor: 'var(--hair)' }}><span className="text-[14px] font-bold text-paper">On site</span><Mono>{siteContacts.length}</Mono></div>
              {siteContacts.length === 0 && <div className="px-[15px] py-4 text-[13px] text-dim">No contacts linked to this site yet.</div>}
              {siteContacts.map((c, i) => (
                <div key={c.id} className={`px-[15px] py-[11px] flex items-center gap-2.5 ${i < siteContacts.length - 1 ? 'border-b' : ''}`} style={{ borderColor: 'var(--hair)' }}>
                  <Avatar id={c.id} name={[c.first_name, c.last_name].filter(Boolean).join(' ')} size={30} />
                  <button onClick={() => onNavigate?.('contact', c.id)} className="flex-1 min-w-0 text-left">
                    <div className="text-[15px] font-medium text-paper truncate">{[c.first_name, c.last_name].filter(Boolean).join(' ')}</div>
                    {c.job_title && <div className="text-[12px] text-muted truncate">{c.job_title}</div>}
                  </button>
                  {c.phone && <a href={`tel:${c.phone}`} className="px-3 py-1.5 rounded-[9px] text-[13px] font-semibold text-paper" style={{ background: 'var(--surface-solid)', border: '1px solid var(--ink-line)' }}>Call</a>}
                </div>
              ))}
            </WorkCard>
            <HardwareCard locationId={locationId} profile={profile} alwaysShow />
            {canWrite && (
              <WorkCard>
                <div className="px-[15px] py-3 border-b text-[14px] font-bold text-paper" style={{ borderColor: 'var(--hair)' }}>Record while you are here</div>
                <div className="p-[12px] grid gap-2" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
                  {[['Note', () => { setSheetText(''); setSheet('note'); }], ['Photo', () => fileRef.current?.click()], ['Log time', recordTime], ['New ticket', () => { setSheetText(''); setSheet('ticket'); }]].map(([l, fn]) => (
                    <button key={l} onClick={fn} className="px-3 py-[13px] rounded-[12px] text-[14px] font-semibold text-paper" style={{ background: 'var(--surface-solid)', border: '1px solid var(--ink-line)', boxShadow: 'var(--shadow-tile)' }}>{l}</button>
                  ))}
                </div>
                <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={recordPhoto} />
              </WorkCard>
            )}
            <AttachmentsCard subjectType="location" subjectId={locationId} profile={profile} />
          </div>
        )}
        {sheet === 'more' && (
          <MobileSheet title={location.name} onClose={() => setSheet(null)}>
            {canWrite && <SheetRow onClick={() => { setSheet(null); startEdit(); }}>Edit site</SheetRow>}
            {canWrite && <SheetRow onClick={() => { setSheet(null); onCreateLead?.({ locationId, companyId: location.company_id }); }}>+ Lead</SheetRow>}
            {location.company_id && <SheetRow onClick={() => { setSheet(null); onNavigate?.('company', location.company_id); }} sub={company?.name}>Open company</SheetRow>}
            {profile.role === 'owner' && <SheetRow tone="coral" onClick={() => { setSheet(null); deleteRecord(); }}>Delete site</SheetRow>}
          </MobileSheet>
        )}
        {(sheet === 'note' || sheet === 'ticket') && (
          <MobileSheet title={sheet === 'note' ? 'Note' : 'New ticket'} sub={sheet === 'note' ? `On ${location.name}` : 'Raised for this site, priority Standard'} onClose={() => setSheet(null)}
            footer={<><GhostBtn className="flex-1 justify-center" onClick={() => setSheet(null)}>Cancel</GhostBtn><PrimaryBtn className="flex-1 justify-center" onClick={sheet === 'note' ? recordNote : recordTicket} disabled={!sheetText.trim()}>{sheet === 'note' ? 'Save note' : 'Raise ticket'}</PrimaryBtn></>}>
            <textarea autoFocus rows={sheet === 'note' ? 5 : 3} value={sheetText} onChange={e => setSheetText(e.target.value)} placeholder={sheet === 'note' ? 'What did you see or agree?' : 'What is wrong?'}
              className="w-full px-[13px] py-[11px] rounded-[12px] border text-[15px] text-paper placeholder-dim focus:outline-none resize-none" style={{ background: 'var(--surface-solid)', borderColor: 'var(--ink-line)' }} />
          </MobileSheet>
        )}
        {editing && (
          <div className="lg:hidden">
            <EditSheet title="Edit location" values={draft} onChange={set} onCancel={() => { setEditing(false); setSaveErr(''); }} onSave={save} error={saveErr}
              sections={[
                { title: 'Identity', fields: [
                  { key: 'name', label: 'Site name' },
                  { key: 'status', label: 'Status', type: 'select', options: STATUS_OPTIONS.map(x => [x, x]) },
                  { key: 'venue_type', label: 'Venue type', placeholder: 'restaurant, bar, cafe…' },
                  { key: 'covers', label: 'Covers', type: 'number', parse: (v) => (v ? parseInt(v) : null) },
                  { key: 'venue_code', label: 'ServOS venue ID', placeholder: 'SV-1001', parse: (v) => (v.trim().toUpperCase() || null), hint: 'From the ServOS admin portal, beside the venue name.' },
                ] },
                { title: 'Address & contact', fields: [
                  { key: 'address', label: 'Address' }, { key: 'city', label: 'City' }, { key: 'postcode', label: 'Postcode' },
                  { key: 'phone', label: 'Phone', type: 'tel' }, { key: 'email', label: 'Email', type: 'email' },
                ] },
                { title: 'Key dates', summary: 'call, install, go-live', fields: [
                  { key: 'kickoff_at', label: 'Onboarding call', type: 'datetime-local' },
                  { key: 'expected_install_date', label: 'Expected install date', type: 'date' },
                  { key: 'actual_install_date', label: 'Actual install date', type: 'date' },
                  { key: 'go_live_date', label: 'Go-live date', type: 'date' },
                  { key: 'activation_date', label: 'Activation date', type: 'date' },
                ] },
                { title: 'Ownership & notes', summary: 'owner, notes', fields: [
                  { key: 'owner_id', label: 'Owner', type: 'select', options: [['', 'Unassigned'], ...members.map(m => [m.id, m.display_name || m.email])] },
                  { key: 'notes', label: 'Notes', type: 'textarea' },
                ] },
              ]} />
          </div>
        )}
        {editing ? (
          <div className="max-w-4xl hidden lg:block">
            <Card title="Edit Location">
              <div className="grid grid-cols-2 gap-3">
                <div><label className={label}>Name</label><input className={input} value={draft.name || ''} onChange={e => set('name', e.target.value)} /></div>
                <div><label className={label}>Status</label><select className={input} value={draft.status} onChange={e => set('status', e.target.value)}>
                  {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}</select></div>
                <div><label className={label}>Venue type</label><input className={input} value={draft.venue_type || ''} onChange={e => set('venue_type', e.target.value)} placeholder="restaurant, bar, cafe..." /></div>
                <div><label className={label}>Covers</label><input className={input} type="number" value={draft.covers || ''} onChange={e => set('covers', e.target.value ? parseInt(e.target.value) : null)} /></div>
                <div><label className={label}>Address</label><input className={input} value={draft.address || ''} onChange={e => set('address', e.target.value)} /></div>
                <div><label className={label}>City</label><input className={input} value={draft.city || ''} onChange={e => set('city', e.target.value)} /></div>
                <div><label className={label}>Postcode</label><input className={input} value={draft.postcode || ''} onChange={e => set('postcode', e.target.value)} /></div>
                {/* The venue's ID in ServOS. Copied from the ServOS admin portal
                    when the venue is set up, and it is how the support chat knows
                    which venue is on the line. Names cannot do this job: ServOS
                    calls a site "Leeds" while we hold three Leeds venues under
                    different brands. Uppercased on entry so SV-1001 and sv-1001
                    cannot become two different venues. */}
                <div>
                  <label className={label}>ServOS venue ID</label>
                  <input
                    className={`${input} font-mono`}
                    value={draft.venue_code || ''}
                    onChange={e => set('venue_code', e.target.value.trim().toUpperCase() || null)}
                    placeholder="SV-1001"
                  />
                  <div className="text-[10px] text-dim mt-1">
                    From the ServOS admin portal, beside the venue name. Links this record to the till.
                  </div>
                </div>
                <div><label className={label}>Phone</label><input className={input} value={draft.phone || ''} onChange={e => set('phone', e.target.value)} /></div>
                <div><label className={label}>Email</label><input className={input} value={draft.email || ''} onChange={e => set('email', e.target.value)} /></div>
                <div><label className={label}>Onboarding call</label><input className={input} type="datetime-local" value={(draft.kickoff_at || '').slice(0, 16)} onChange={e => set('kickoff_at', e.target.value || null)} /></div>
                <div><label className={label}>Expected install date</label><input className={input} type="date" value={draft.expected_install_date || ''} onChange={e => set('expected_install_date', e.target.value || null)} /></div>
                <div><label className={label}>Actual install date</label><input className={input} type="date" value={draft.actual_install_date || ''} onChange={e => set('actual_install_date', e.target.value || null)} /></div>
                <div><label className={label}>Go-live date</label><input className={input} type="date" value={draft.go_live_date || ''} onChange={e => set('go_live_date', e.target.value || null)} /></div>
                <div><label className={label}>Activation date</label><input className={input} type="date" value={draft.activation_date || ''} onChange={e => set('activation_date', e.target.value || null)} /></div>
                <div><label className={label}>Owner</label><select className={input} value={draft.owner_id || ''} onChange={e => set('owner_id', e.target.value || null)}>
                  <option value="">Unassigned</option>{members.map(m => <option key={m.id} value={m.id}>{m.display_name || m.email}</option>)}</select></div>
              </div>
              <div className="mt-3"><label className={label}>Notes</label><textarea className={input + ' resize-none'} rows={3} value={draft.notes || ''} onChange={e => set('notes', e.target.value)} /></div>
              <div className="flex gap-2 mt-4">
                <button onClick={save} className="px-5 py-2 bg-ember text-ink text-sm font-semibold rounded hover:bg-ember-deep">Save</button>
                <button onClick={() => { setEditing(false); setSaveErr(''); }} className="px-4 py-2 text-sm text-muted border border-bdr rounded">Cancel</button>
              </div>
              {saveErr && (
                <div className="mt-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-3 py-2">
                  Couldn't save: {saveErr}
                </div>
              )}
            </Card>
          </div>
        ) : (
          <div className="hidden lg:grid grid-cols-12 gap-4 max-w-[1400px]">

            {/* LEFT: Key Info + Modules */}
            <div className="col-span-4 space-y-4">
              <Card title="Key Info">
                <div className="space-y-3">
                  <Field label="Address" value={[location.address, location.city, location.postcode].filter(Boolean).join(', ')} />
                  <Field label="Phone" value={location.phone} />
                  <Field label="Email" value={location.email} />
                  <Field label="Venue Type" value={location.venue_type} />
                  <Field label="Covers" value={location.covers} />
                  <Field label="Status" value={location.status} badge={STATUS_COLORS[location.status]} />
                  {/* Called out rather than left blank: an unlinked venue means the
                      support chat cannot tell who is calling, which is a thing to
                      fix, not an empty field to scroll past. */}
                  <div>
                    <div className="text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-0.5">ServOS venue ID</div>
                    {location.venue_code ? (
                      <div className="text-sm text-paper font-mono">{location.venue_code}</div>
                    ) : (
                      <div className="text-sm text-dim italic">Not linked — support chat cannot identify this venue</div>
                    )}
                  </div>
                  <Field label="Owner" value={ownerName(location.owner_id)} />
                  {location.notes && <Field label="Notes" value={location.notes} />}
                </div>
              </Card>

              <LocationTradingCard location={location} canWrite={canWrite} onSaved={load} />

              <PosLinkCard locationId={locationId} code={location.venue_code} posId={location.pos_location_id}
                profile={profile} onSaved={(v) => setLocation(l => ({ ...l, ...v }))} />

              <Card title="Key Dates">
                <div className="space-y-3">
                  <Field label="Onboarding call" value={location.kickoff_at ? new Date(location.kickoff_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : null} />
                  <Field label="Expected install" value={location.expected_install_date ? new Date(location.expected_install_date).toLocaleDateString('en-GB') : null} />
                  <Field label="Actual install" value={location.actual_install_date ? new Date(location.actual_install_date).toLocaleDateString('en-GB') : null} />
                  <Field label="Go-live" value={location.go_live_date ? new Date(location.go_live_date).toLocaleDateString('en-GB') : null} />
                  <Field label="Activation" value={location.activation_date ? new Date(location.activation_date).toLocaleDateString('en-GB') : null} />
                </div>
              </Card>

              <Card title="Company">
                {location.company_id ? (
                  <div className="flex items-center gap-3">
                    <div onClick={() => onNavigate?.('company', location.company_id)}
                      className="p-3 glass-inner rounded-xl cursor-pointer flex items-center gap-3 flex-1 min-w-0">
                      <div className="w-10 h-10 rounded-xl bg-ember/20 border border-ember/30 flex items-center justify-center text-lg shrink-0">{'\u{1F3E2}'}</div>
                      <div className="flex-1 min-w-0">
                        <div className="text-base font-semibold text-paper truncate">{company?.name || 'Unknown'}</div>
                        <div className="text-xs text-muted">Parent company</div>
                      </div>
                      <span className="text-xs text-ember">&rarr;</span>
                    </div>
                    {canWrite && (
                      <button onClick={unlinkCompany} title="Remove company link"
                        className="text-xs text-red-500 hover:text-red-700 border border-red-200 rounded-lg px-2 py-1.5 shrink-0">Remove</button>
                    )}
                  </div>
                ) : canWrite ? (
                  <div className="space-y-2">
                    <div className="text-xs text-dim">No company linked. Search to associate one:</div>
                    <EntityPicker table="companies" searchCols={['name']} placeholder="Search companies…"
                      labelOf={c => c.name} subOf={c => c.domain || c.city || ''}
                      onPick={c => linkCompany(c.id)} />
                  </div>
                ) : (
                  <div className="text-xs text-dim italic py-2 text-center">No company linked</div>
                )}
              </Card>

              <LocationModulesCard locationId={locationId} canWrite={canWrite} />

              <ProcessingRatesCard locationId={locationId} companyId={location.company_id} onNavigate={onNavigate} />

              <HardwareCard locationId={locationId} profile={profile} alwaysShow />

              <InvoicesCard locationId={locationId} profile={profile} onNavigate={onNavigate} />
            </div>

            {/* MIDDLE: Activity + Contacts */}
            <div className="col-span-4 space-y-4">
              <Card title="Activity">
                <ActivityTimeline subjectType="location" subjectId={locationId} profile={profile} contactEmail={location?.email} />
              </Card>

              <Card title="Contacts">
                <AssociationManager subjectType="location" subjectId={locationId} targetType="contact" profile={profile} onNavigate={onNavigate} />
              </Card>

              <AttachmentsCard subjectType="location" subjectId={locationId} profile={profile} />
            </div>

            {/* RIGHT: Deals + Onboardings + Projects */}
            <div className="col-span-4 space-y-4">
              <LeadsCard leads={leads} />
              <Card title="Deals" count={deals.length}>
                {deals.length > 0 ? (
                  <div className="space-y-2">
                    {deals.map(d => (
                      <div key={d.id} onClick={() => onNavigate?.('deal', d.id)}
                        className="p-3 glass-inner rounded-xl cursor-pointer">
                        <div className="text-sm font-medium text-paper">{d.name}</div>
                        <div className="flex items-center gap-2 mt-1">
                          <span className="text-xs text-ember font-mono font-bold">{d.value ? `£${Number(d.value).toLocaleString()}` : ''}</span>
                          <span className="text-[10px] text-muted uppercase">{DEAL_STAGES[d.stage] || d.stage}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : <Empty>No deals</Empty>}
              </Card>

              <Card title="Onboardings" count={onboardings.length}>
                {onboardings.length > 0 ? (
                  <div className="space-y-2">
                    {onboardings.map(o => (
                      <div key={o.id} onClick={() => onNavigate?.('onboarding', o.id)}
                        className="p-3 glass-inner rounded-xl cursor-pointer">
                        <div className="text-sm font-medium text-paper">Onboarding</div>
                        <div className="text-xs text-muted mt-0.5">{OB_STAGES[o.stage] || o.stage}</div>
                      </div>
                    ))}
                  </div>
                ) : <Empty>No onboardings</Empty>}
              </Card>

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

function Field({ label, value, badge }) {
  const display = value || <span className="text-dim italic">--</span>;
  return (
    <div>
      <div className="text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-0.5">{label}</div>
      {badge ? (
        <span className={`px-2 py-0.5 text-xs font-bold uppercase rounded ${badge}`}>{value}</span>
      ) : (
        <div className="text-sm text-paper break-words">{display}</div>
      )}
    </div>
  );
}

function Empty({ children }) {
  return <div className="text-xs text-dim italic py-3 text-center">{children}</div>;
}

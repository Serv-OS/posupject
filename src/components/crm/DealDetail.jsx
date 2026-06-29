import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { handleClosedWon } from '../../lib/dealHelpers';
import TimerButton from './TimerButton.jsx';
import AssociationManager from './AssociationManager.jsx';
import ActivityTimeline from './ActivityTimeline.jsx';

const STAGES = [
  'new_lead','contacted','qualified','demo_booked','demo_done',
  'proposal_sent','negotiation','closed_won','closed_lost'
];
const STAGE_LABELS = {
  new_lead:'New Lead', contacted:'Contacted', qualified:'Qualified',
  demo_booked:'Demo Booked', demo_done:'Demo Done', proposal_sent:'Proposal Sent',
  negotiation:'Negotiation', closed_won:'Closed Won', closed_lost:'Closed Lost',
};

export default function DealDetail({ dealId, profile, onClose, onNavigate }) {
  const [deal, setDeal] = useState(null);
  const [company, setCompany] = useState(null);
  const [members, setMembers] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [locations, setLocations] = useState([]);
  const [history, setHistory] = useState([]);
  const [projects, setProjects] = useState([]);
  const [quotes, setQuotes] = useState([]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});

  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  useEffect(() => { load(); }, [dealId]);

  const load = async () => {
    const [d, m, c, l, h, prj, qz] = await Promise.all([
      supabase.from('deals').select('*').eq('id', dealId).single(),
      supabase.from('profiles').select('id, email, display_name'),
      supabase.from('companies').select('id, name').order('name'),
      supabase.from('locations').select('id, name, company_id, venue_type, city').order('name'),
      supabase.from('stage_history').select('*').eq('object_type', 'deal').eq('object_id', dealId).order('changed_at', { ascending: false }),
      supabase.from('crm_projects').select('*').eq('subject_type', 'deal').eq('subject_id', dealId).order('created_at', { ascending: false }),
      supabase.from('quotes').select('*').eq('deal_id', dealId).order('created_at', { ascending: false }),
    ]);
    setDeal(d.data);
    setMembers(m.data || []);
    setCompanies(c.data || []);
    setLocations(l.data || []);
    setHistory(h.data || []);
    setProjects(prj.data || []);
    setQuotes(qz.data || []);
    if (d.data?.company_id) setCompany(c.data?.find(co => co.id === d.data.company_id) || null);
  };

  const createQuote = async () => {
    // Find the deal's primary contact (if linked) to prefill the quote
    const { data: assoc } = await supabase.from('associations').select('to_id, from_id, from_type, to_type')
      .or(`and(from_type.eq.deal,from_id.eq.${dealId},to_type.eq.contact),and(to_type.eq.deal,to_id.eq.${dealId},from_type.eq.contact)`)
      .limit(1);
    const contactId = assoc && assoc.length ? (assoc[0].from_type === 'contact' ? assoc[0].from_id : assoc[0].to_id) : null;
    // Find the deal's affected location (if linked)
    const { data: locAssoc } = await supabase.from('associations').select('to_id, from_id, from_type, to_type')
      .or(`and(from_type.eq.deal,from_id.eq.${dealId},to_type.eq.location),and(to_type.eq.deal,to_id.eq.${dealId},from_type.eq.location)`)
      .limit(1);
    const locationId = locAssoc && locAssoc.length ? (locAssoc[0].from_type === 'location' ? locAssoc[0].from_id : locAssoc[0].to_id) : null;
    const validUntil = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const { data, error } = await supabase.from('quotes').insert({
      deal_id: dealId, company_id: deal.company_id || null, contact_id: contactId, location_id: locationId,
      tax_rate: 20, payment_terms: 'pay_now', valid_until: validUntil, created_by: profile.id,
    }).select().single();
    if (error) { alert('Could not create quote: ' + error.message); return; }
    onNavigate?.('quote', data.id);
  };

  const startEdit = () => { setDraft({ ...deal }); setEditing(true); };
  const save = async () => {
    const oldStage = deal.stage;
    const patch = {
      name: draft.name,
      company_id: draft.company_id,
      stage: draft.stage,
      value: draft.value || null,
      currency: draft.currency || 'GBP',
      expected_close_date: draft.expected_close_date || null,
      source: draft.source || null,
      notes: draft.notes || null,
      lost_reason: draft.lost_reason || null,
      owner_id: draft.owner_id || null,
      hardware_value: draft.hardware_value || null,
      services_value: draft.services_value || null,
      saas_arr: draft.saas_arr || null,
      payments_arr: draft.payments_arr || null,
    };
    if (patch.stage === 'closed_won' || patch.stage === 'closed_lost') patch.closed_at = deal.closed_at || new Date().toISOString();
    else patch.closed_at = null;
    const { error } = await supabase.from('deals').update(patch).eq('id', dealId);
    if (error) { alert('Save failed: ' + error.message); return; }
    if (patch.stage !== oldStage) {
      await supabase.from('stage_history').insert({ object_type: 'deal', object_id: dealId, from_stage: oldStage, to_stage: patch.stage, changed_by: profile.id });
      if (patch.stage === 'closed_won') { const ob = await handleClosedWon(dealId, profile.id); if (ob) alert('Onboarding created automatically.'); }
    }
    setEditing(false); load();
  };
  const set = (k, v) => setDraft({ ...draft, [k]: v });

  const changeStage = async (newStage) => {
    if (newStage === deal.stage) return;
    const patch = { stage: newStage };
    if (newStage === 'closed_won' || newStage === 'closed_lost') patch.closed_at = new Date().toISOString();
    else patch.closed_at = null;
    await supabase.from('deals').update(patch).eq('id', dealId);
    await supabase.from('stage_history').insert({ object_type: 'deal', object_id: dealId, from_stage: deal.stage, to_stage: newStage, changed_by: profile.id });
    if (newStage === 'closed_won') { const ob = await handleClosedWon(dealId, profile.id); if (ob) alert('Onboarding created automatically.'); }
    load();
  };

  const createLinkedProject = async () => {
    const name = prompt(`Project name for deal "${deal?.name}":`);
    if (!name?.trim()) return;
    const { data } = await supabase.from('crm_projects').insert({ name: name.trim(), subject_type: 'deal', subject_id: dealId, owner_id: profile.id }).select().single();
    if (data) onNavigate?.('project', data.id); else load();
  };

  const deleteRecord = async () => {
    if (!confirm(`Delete deal "${deal?.name}"?\n\nThis cannot be undone.`)) return;
    await supabase.from('deals').delete().eq('id', dealId);
    onClose();
  };

  if (!deal) return <div className="h-full flex items-center justify-center text-dim text-sm">Loading...</div>;

  const ownerName = (id) => { const m = members.find(u => u.id === id); return m ? (m.display_name || m.email.split('@')[0]) : 'Unassigned'; };
  const fmt = (v) => v ? `\u{00A3}${Number(v).toLocaleString('en-GB', { minimumFractionDigits: 2 })}` : '';
  const companyLocations = deal.company_id ? locations.filter(l => l.company_id === deal.company_id) : [];

  const input = "w-full px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper placeholder-dim focus:outline-none focus:border-ember";
  const label = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block";

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 py-5 border-b border-bdr flex items-center gap-4">
        <button onClick={onClose} className="text-muted hover:text-paper text-lg">&larr;</button>
        <div className="flex-1 min-w-0">
          <div className="text-xl font-bold text-paper truncate">{deal.name}</div>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span className="badge-status bg-blue-100 text-blue-700 border border-blue-200">{STAGE_LABELS[deal.stage]}</span>
            {deal.value && <span className="text-sm font-bold text-ember font-mono">{fmt(deal.value)}</span>}
            {company && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] rounded-lg bg-slate-100 text-slate-600 border border-slate-200 cursor-pointer hover:border-slate-300"
                onClick={() => onNavigate?.('company', company.id)}>
                {'\u{1F3E2}'} {company.name}
              </span>
            )}
          </div>
        </div>
        {!editing && <TimerButton subjectType="deal" subjectId={dealId} label={deal.name} profile={profile} />}
        {canWrite && !editing && (
          <div className="flex gap-2">
            <button onClick={startEdit} className="btn-ghost px-4 py-2 rounded-xl text-sm">Edit</button>
            {profile.role === 'owner' && (
              <button onClick={deleteRecord} className="px-3 py-2 text-xs text-red-600 border border-red-200 rounded-xl hover:bg-red-50 transition">Delete</button>
            )}
          </div>
        )}
      </div>

      {/* Stage progress */}
      {canWrite && (
        <div className="px-6 py-2 border-b border-bdr flex gap-0.5 overflow-x-auto">
          {STAGES.map((s, i) => {
            const isActive = deal.stage === s;
            const isPast = STAGES.indexOf(deal.stage) > i;
            return (
              <button key={s} onClick={() => changeStage(s)}
                className={`px-2.5 py-1.5 text-[9px] font-bold uppercase rounded-xl transition whitespace-nowrap ${
                  isActive ? 'bg-ember text-white' : isPast ? 'bg-ember/20 text-ember' : 'bg-card text-dim hover:text-paper'
                }`}>{STAGE_LABELS[s]}</button>
            );
          })}
        </div>
      )}

      {/* Card grid */}
      <div className="flex-1 overflow-y-auto p-6">
        {editing ? (
          <div className="max-w-3xl">
            <Card title="Edit Deal">
              <div className="grid grid-cols-2 gap-3">
                <div><label className={label}>Name</label><input className={input} value={draft.name || ''} onChange={e => set('name', e.target.value)} /></div>
                <div><label className={label}>Company</label><select className={input} value={draft.company_id || ''} onChange={e => set('company_id', e.target.value)}>
                  {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
                <div><label className={label}>Stage</label><select className={input} value={draft.stage} onChange={e => set('stage', e.target.value)}>
                  {STAGES.map(s => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}</select></div>
                <div><label className={label}>Source</label><input className={input} value={draft.source || ''} onChange={e => set('source', e.target.value)} /></div>
                <div><label className={label}>Expected close</label><input className={input} type="date" value={draft.expected_close_date || ''} onChange={e => set('expected_close_date', e.target.value || null)} /></div>
                <div><label className={label}>Owner</label><select className={input} value={draft.owner_id || ''} onChange={e => set('owner_id', e.target.value || null)}>
                  <option value="">Unassigned</option>{members.map(m => <option key={m.id} value={m.id}>{m.display_name || m.email}</option>)}</select></div>
              </div>
              <div className="mt-3"><label className={label + ' mb-2'}>Revenue Breakdown</label>
                <div className="grid grid-cols-2 gap-3">
                  <div><label className={label}>Hardware (one-time)</label><input className={input} type="number" step="0.01" value={draft.hardware_value || ''} onChange={e => set('hardware_value', e.target.value ? parseFloat(e.target.value) : null)} placeholder="0.00" /></div>
                  <div><label className={label}>Services (one-time)</label><input className={input} type="number" step="0.01" value={draft.services_value || ''} onChange={e => set('services_value', e.target.value ? parseFloat(e.target.value) : null)} placeholder="0.00" /></div>
                  <div><label className={label}>SaaS ARR</label><input className={input} type="number" step="0.01" value={draft.saas_arr || ''} onChange={e => set('saas_arr', e.target.value ? parseFloat(e.target.value) : null)} placeholder="0.00" /></div>
                  <div><label className={label}>Payments ARR</label><input className={input} type="number" step="0.01" value={draft.payments_arr || ''} onChange={e => set('payments_arr', e.target.value ? parseFloat(e.target.value) : null)} placeholder="0.00" /></div>
                  <div><label className={label}>Total deal value</label><input className={input} type="number" step="0.01" value={draft.value || ''} onChange={e => set('value', e.target.value ? parseFloat(e.target.value) : null)} placeholder="Or enter a flat total" /></div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 mt-3">
                {draft.stage === 'closed_lost' && <div><label className={label}>Lost reason</label><input className={input} value={draft.lost_reason || ''} onChange={e => set('lost_reason', e.target.value)} /></div>}
              </div>
              <div className="mt-3"><label className={label}>Notes</label><textarea className={input + ' resize-none'} rows={3} value={draft.notes || ''} onChange={e => set('notes', e.target.value)} /></div>
              <div className="flex gap-2 mt-4">
                <button onClick={save} className="btn-glass px-5 py-2 rounded-xl text-sm">Save</button>
                <button onClick={() => setEditing(false)} className="btn-ghost px-4 py-2 rounded-xl text-sm">Cancel</button>
              </div>
            </Card>
          </div>
        ) : (
          <div className="grid grid-cols-12 gap-4 max-w-[1400px]">

            {/* LEFT: Key Info + Company + Locations */}
            <div className="col-span-4 space-y-4">
              <Card title="Key Info">
                <div className="space-y-3">
                  <Field label="Stage" value={STAGE_LABELS[deal.stage]} />
                  <Field label="Source" value={deal.source} />
                  <Field label="Expected close" value={deal.expected_close_date ? new Date(deal.expected_close_date).toLocaleDateString('en-GB') : null} />
                  <Field label="Owner" value={ownerName(deal.owner_id)} />
                  <Field label="Created" value={new Date(deal.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })} />
                  {deal.lost_reason && <Field label="Lost reason" value={deal.lost_reason} />}
                  {deal.notes && <Field label="Notes" value={deal.notes} />}
                </div>
              </Card>

              <Card title="Revenue">
                <div className="space-y-2">
                  {deal.hardware_value > 0 && <div className="flex justify-between"><span className="text-xs text-muted">Hardware</span><span className="text-sm text-paper font-mono">{fmt(deal.hardware_value)}</span></div>}
                  {deal.services_value > 0 && <div className="flex justify-between"><span className="text-xs text-muted">Services</span><span className="text-sm text-paper font-mono">{fmt(deal.services_value)}</span></div>}
                  {deal.saas_arr > 0 && <div className="flex justify-between"><span className="text-xs text-muted">SaaS ARR</span><span className="text-sm text-paper font-mono">{fmt(deal.saas_arr)}</span></div>}
                  {deal.payments_arr > 0 && <div className="flex justify-between"><span className="text-xs text-muted">Payments ARR</span><span className="text-sm text-paper font-mono">{fmt(deal.payments_arr)}</span></div>}
                  <div className="flex justify-between pt-2 border-t border-bdr">
                    <span className="text-xs text-paper font-semibold">Total</span>
                    <span className="text-base text-ember font-mono font-bold">{fmt(
                      (deal.hardware_value || 0) + (deal.services_value || 0) + (deal.saas_arr || 0) + (deal.payments_arr || 0) || deal.value
                    )}</span>
                  </div>
                </div>
              </Card>

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
                ) : <Empty>No locations for this company</Empty>}
              </Card>
            </div>

            {/* MIDDLE: Activity + Contacts */}
            <div className="col-span-4 space-y-4">
              <Card title="Activity">
                <ActivityTimeline subjectType="deal" subjectId={dealId} profile={profile} />
              </Card>

              <Card title="Contacts">
                <AssociationManager subjectType="deal" subjectId={dealId} targetType="contact" profile={profile} onNavigate={onNavigate} />
              </Card>
            </div>

            {/* RIGHT: Quotes + Projects + Stage History */}
            <div className="col-span-4 space-y-4">
              <Card title="Quotes" count={quotes.length}
                action={canWrite ? { label: '+ New quote', onClick: createQuote } : null}>
                {quotes.length > 0 ? (
                  <div className="space-y-2">
                    {quotes.map(q => (
                      <div key={q.id} onClick={() => onNavigate?.('quote', q.id)}
                        className="p-3 glass-inner rounded-xl cursor-pointer flex items-center gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-paper">Quote #{q.quote_number}</div>
                          <div className="text-xs text-muted">£{Number(q.one_off_total || 0).toLocaleString('en-GB')} one-off{q.recurring_arr > 0 ? ` · £${Number(q.recurring_arr).toLocaleString('en-GB')} ARR` : ''}</div>
                        </div>
                        <span className="px-1.5 py-0.5 text-[9px] font-bold uppercase rounded bg-slate-100 text-slate-600 border border-slate-200">{q.status}</span>
                      </div>
                    ))}
                  </div>
                ) : <div className="text-xs text-dim italic py-3 text-center">No quotes yet</div>}
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

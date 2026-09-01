import { useEffect, useState, useMemo, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { useStickyState } from '../../lib/stickyState';
import { downloadListPdf } from '../../lib/listPdf';

const STAGES = [
  { key: 'new_lead',      label: 'New Lead',          color: '#3b82f6' },
  { key: 'attempting',     label: 'Attempting',         color: '#6366f1' },
  { key: 'mql',           label: 'Marketing Qualified', color: '#8b5cf6' },
  { key: 'sql',           label: 'Sales Qualified',    color: '#E8743C' },
  { key: 'deal',          label: 'Deal',               color: '#10b981' },
  { key: 'disqualified',  label: 'Disqualified',       color: '#ef4444' },
];

const STAGE_LABELS = { new_lead: 'New Lead', attempting: 'Attempting', mql: 'MQL', sql: 'SQL', deal: 'Deal', disqualified: 'Disqualified' };

const PRIORITY_STYLES = {
  hot: 'bg-red-100 text-red-700 border border-red-200',
  warm: 'bg-orange-100 text-orange-700 border border-orange-200',
  medium: 'bg-blue-100 text-blue-700 border border-blue-200',
  cold: 'bg-slate-100 text-slate-600 border border-slate-200',
};

const SOURCE_OPTIONS = ['website', 'referral', 'cold_outreach', 'event', 'trade_show', 'social', 'inbound_call', 'inbound_email', 'pos_review_site', 'partner', 'other'];
const VENUE_TYPES = ['restaurant', 'bar', 'cafe', 'fast_casual', 'qsr', 'hotel_fb', 'nightclub', 'food_hall', 'catering', 'other'];

export default function LeadBoard({ profile, onNavigate, prefill, onPrefillConsumed }) {
  const [leads, setLeads] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [locations, setLocations] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [members, setMembers] = useState([]);
  // Board-vs-list and the search box are how you left the screen, so they come
  // back with you from a lead record. One object, one key, safe to extend.
  const [filters, setFilters] = useStickyState('leads', { view: 'board', search: '' });
  const { view: viewMode, search } = filters;
  const setFilter = (k, v) => setFilters(p => ({ ...p, [k]: v }));
  const [showCreate, setShowCreate] = useState(false);
  const [dragItem, setDragItem] = useState(null);

  // Create form
  const [newName, setNewName] = useState('');
  const [newSource, setNewSource] = useState('website');
  const [newPriority, setNewPriority] = useState('medium');
  const [newVenueType, setNewVenueType] = useState('');
  const [newCovers, setNewCovers] = useState('');
  const [newCurrentPos, setNewCurrentPos] = useState('');
  const [newNotes, setNewNotes] = useState('');
  // Search-and-link
  const [companySearch, setCompanySearch] = useState('');
  const [selectedCompany, setSelectedCompany] = useState(null);
  const [locationSearch, setLocationSearch] = useState('');
  const [selectedLocation, setSelectedLocation] = useState(null);
  const [contactSearch, setContactSearch] = useState('');
  const [selectedContact, setSelectedContact] = useState(null);
  // New record fields
  const [newContactFirst, setNewContactFirst] = useState('');
  const [newContactLast, setNewContactLast] = useState('');
  const [newContactEmail, setNewContactEmail] = useState('');
  const [newContactPhone, setNewContactPhone] = useState('');

  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  useEffect(() => {
    load();
    const ch = supabase.channel('leads-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'leads' }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

  const load = async () => {
    const [l, c, loc, ct, m] = await Promise.all([
      supabase.from('leads').select('*').order('created_at', { ascending: false }),
      supabase.from('companies').select('id, name, domain').order('name'),
      supabase.from('locations').select('id, name, company_id, venue_type, city').order('name'),
      supabase.from('contacts').select('id, first_name, last_name, email, phone').order('last_name'),
      supabase.from('profiles').select('id, email, display_name'),
    ]);
    setLeads(l.data || []);
    setCompanies(c.data || []);
    setLocations(loc.data || []);
    setContacts(ct.data || []);
    setMembers(m.data || []);
  };

  // Open the create form pre-filled when arriving via "Create lead" from a record
  const prefillDone = useRef(false);
  useEffect(() => {
    if (!prefill || prefillDone.current) return;
    if (!companies.length && !locations.length && !contacts.length) return; // wait for data
    prefillDone.current = true;
    setShowCreate(true);
    if (prefill.companyId) { const c = companies.find(x => x.id === prefill.companyId); if (c) { setSelectedCompany(c); setCompanySearch(c.name); setNewName(n => n || c.name); } }
    if (prefill.locationId) { const l = locations.find(x => x.id === prefill.locationId); if (l) { setSelectedLocation(l); setLocationSearch(l.name); } }
    if (prefill.contactId) { const ct = contacts.find(x => x.id === prefill.contactId); if (ct) { setSelectedContact(ct); setContactSearch([ct.first_name, ct.last_name].filter(Boolean).join(' ')); } }
    onPrefillConsumed?.();
  }, [prefill, companies, locations, contacts]);

  const filtered = useMemo(() => {
    if (!search) return leads;
    const q = search.toLowerCase();
    return leads.filter(l => l.name.toLowerCase().includes(q));
  }, [leads, search]);

  const byStage = useMemo(() => {
    const map = {};
    STAGES.forEach(s => { map[s.key] = []; });
    filtered.forEach(l => { if (map[l.stage]) map[l.stage].push(l); });
    return map;
  }, [filtered]);

  const ownerName = (id) => { const m = members.find(u => u.id === id); return m ? (m.display_name || m.email.split('@')[0]) : ''; };
  const companyName = (id) => companies.find(c => c.id === id)?.name || '';
  const locationName = (id) => locations.find(l => l.id === id)?.name || '';
  const contactFullName = (id) => { const c = contacts.find(x => x.id === id); return c ? [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email : ''; };

  // Print what you are looking at: the board reads stage by stage, the list
  // reads newest first, so the row order follows the view you are in. Leads
  // carry no value or currency column, so there is no money on this sheet.
  const exportPdf = () => {
    const rows = viewMode === 'board'
      ? STAGES.flatMap(s => byStage[s.key] || [])
      : filtered;
    return downloadListPdf({
      title: 'Leads',
      columns: ['Lead', 'Stage', 'Priority', 'Company', 'Location', 'Contact', 'Venue', 'Source', 'Owner', 'Next action'],
      rows: rows.map(l => [
        l.name,
        STAGE_LABELS[l.stage] || l.stage || '',
        l.priority || '',
        companyName(l.company_id),
        locationName(l.location_id),
        contactFullName(l.contact_id),
        [l.venue_type?.replace(/_/g, ' '), l.covers ? `${l.covers} covers` : ''].filter(Boolean).join(' / '),
        (l.source || '').replace(/_/g, ' '),
        ownerName(l.owner_id),
        l.next_action || '',
      ]),
      // Search is the only filter this screen has; say so when it is on.
      filters: search ? [`Search: "${search}"`] : [],
      footNote: viewMode === 'board'
        ? 'Ordered by pipeline stage, as shown on the board.'
        : 'Newest first, as shown in the list.',
    });
  };

  // Filtered search results
  const companyResults = useMemo(() => {
    if (!companySearch || companySearch.length < 2) return [];
    const q = companySearch.toLowerCase();
    return companies.filter(c => c.name.toLowerCase().includes(q) || (c.domain || '').toLowerCase().includes(q)).slice(0, 5);
  }, [companySearch, companies]);

  const locationResults = useMemo(() => {
    if (!locationSearch || locationSearch.length < 2) return [];
    const q = locationSearch.toLowerCase();
    return locations.filter(l => l.name.toLowerCase().includes(q)).slice(0, 5);
  }, [locationSearch, locations]);

  const contactResults = useMemo(() => {
    if (!contactSearch || contactSearch.length < 2) return [];
    const q = contactSearch.toLowerCase();
    return contacts.filter(c => [c.first_name, c.last_name, c.email].filter(Boolean).join(' ').toLowerCase().includes(q)).slice(0, 5);
  }, [contactSearch, contacts]);

  const moveStage = async (leadId, toStage) => {
    await supabase.from('leads').update({ stage: toStage }).eq('id', leadId);
    await supabase.from('stage_history').insert({ object_type: 'lead', object_id: leadId, from_stage: leads.find(l => l.id === leadId)?.stage, to_stage: toStage, changed_by: profile.id });
    load();
  };

  const convertToDeal = async (lead) => {
    const { data: deal } = await supabase.from('deals').insert({
      name: `Deal: ${lead.name}`,
      company_id: lead.company_id,
      owner_id: lead.owner_id || profile.id,
      source: lead.source,
    }).select().single();

    if (deal) {
      await supabase.from('stage_history').insert({ object_type: 'deal', object_id: deal.id, from_stage: null, to_stage: 'new_lead', changed_by: profile.id });
      if (lead.contact_id) {
        await supabase.from('associations').insert({ from_type: 'deal', from_id: deal.id, to_type: 'contact', to_id: lead.contact_id, label: 'primary_contact' });
      }
      if (lead.location_id) {
        await supabase.from('associations').insert({ from_type: 'deal', from_id: deal.id, to_type: 'location', to_id: lead.location_id, label: 'affected_location' });
      }
      await supabase.from('leads').update({ stage: 'deal', deal_id: deal.id }).eq('id', lead.id);
      onNavigate?.('deal', deal.id);
    }
  };

  const disqualify = async (lead) => {
    const reason = prompt('Disqualification reason:');
    if (reason === null) return;
    await supabase.from('leads').update({ stage: 'disqualified', disqualified_reason: reason }).eq('id', lead.id);
    load();
  };

  const createLead = async (e) => {
    e.preventDefault();
    if (!newName.trim()) return;

    let companyId = selectedCompany?.id || null;
    let locationId = selectedLocation?.id || null;
    let contactId = selectedContact?.id || null;

    // Create new company if typed but not selected
    if (!companyId && companySearch.trim()) {
      const { data } = await supabase.from('companies').insert({ name: companySearch.trim(), owner_id: profile.id }).select().single();
      if (data) companyId = data.id;
    }

    // Create new location if typed but not selected
    if (!locationId && locationSearch.trim() && companyId) {
      const { data } = await supabase.from('locations').insert({ name: locationSearch.trim(), company_id: companyId, venue_type: newVenueType || null, owner_id: profile.id }).select().single();
      if (data) locationId = data.id;
    }

    // Create new contact if details provided but not selected
    if (!contactId && (newContactFirst || newContactEmail)) {
      const { data } = await supabase.from('contacts').insert({
        first_name: newContactFirst.trim() || null, last_name: newContactLast.trim() || null,
        email: newContactEmail.trim() || null, phone: newContactPhone.trim() || null, owner_id: profile.id,
      }).select().single();
      if (data) {
        contactId = data.id;
        // Link to company
        if (companyId) {
          await supabase.from('associations').insert({ from_type: 'contact', from_id: contactId, to_type: 'company', to_id: companyId, label: 'primary_contact' });
        }
      }
    }

    // Auto-derive company from location if not set
    if (!companyId && locationId) {
      const loc = locations.find(l => l.id === locationId);
      if (loc?.company_id) companyId = loc.company_id;
    }

    // A lead needs a company, a location AND a contact
    const missing = [!companyId && 'a company', !locationId && 'a location', !contactId && 'a contact'].filter(Boolean);
    if (missing.length) {
      alert(`A lead needs ${missing.join(', ')}. Please add ${missing.length > 1 ? 'them' : 'it'} before creating the lead.`);
      return;
    }

    // Link contact to company/location if not already
    if (contactId && companyId) {
      const { data: ex } = await supabase.from('associations').select('id')
        .eq('from_type', 'contact').eq('from_id', contactId).eq('to_type', 'company').eq('to_id', companyId).limit(1);
      if (!ex?.length) await supabase.from('associations').insert({ from_type: 'contact', from_id: contactId, to_type: 'company', to_id: companyId, label: 'primary_contact' });
    }

    const { data: newLead } = await supabase.from('leads').insert({
      name: newName.trim(),
      source: newSource,
      priority: newPriority,
      company_id: companyId,
      location_id: locationId,
      contact_id: contactId,
      venue_type: newVenueType || null,
      covers: newCovers ? parseInt(newCovers) : null,
      current_pos: newCurrentPos.trim() || null,
      notes: newNotes.trim() || null,
      owner_id: profile.id,
    }).select('id').single();

    // Reset form
    setNewName(''); setNewSource('website'); setNewPriority('medium'); setNewVenueType('');
    setNewCovers(''); setNewCurrentPos(''); setNewNotes('');
    setCompanySearch(''); setSelectedCompany(null);
    setLocationSearch(''); setSelectedLocation(null);
    setContactSearch(''); setSelectedContact(null);
    setNewContactFirst(''); setNewContactLast(''); setNewContactEmail(''); setNewContactPhone('');
    setShowCreate(false);
    load();
    if (newLead) onNavigate?.('lead', newLead.id);
  };

  const onDragStart = (e, lead) => { setDragItem(lead); e.dataTransfer.effectAllowed = 'move'; };
  const onDragOver = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; };
  const onDrop = (e, stageKey) => { e.preventDefault(); if (dragItem) moveStage(dragItem.id, stageKey); setDragItem(null); };

  const input = "w-full px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper placeholder-dim focus:outline-none focus:border-ember";
  const label = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block";

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-bdr flex items-center justify-between">
        <div>
          <div className="text-lg font-bold text-paper">Leads</div>
          <div className="text-[10px] text-dim font-mono uppercase tracking-[0.18em]">
            {leads.length} active / {byStage.new_lead?.length || 0} new / {byStage.sql?.length || 0} qualified
          </div>
        </div>
        <div className="flex gap-2">
          <input value={search} onChange={e => setFilter('search', e.target.value)} placeholder="Search leads..."
            className="px-3 py-1.5 bg-card border border-bdr rounded-xl text-sm text-paper placeholder-dim focus:outline-none focus:border-ember w-48" />
          <div className="flex bg-card border border-bdr rounded-xl">
            <button onClick={() => setFilter('view', 'board')} className={`px-3 py-1 text-xs rounded-xl ${viewMode === 'board' ? 'text-paper bg-ink-soft' : 'text-muted'}`}>Board</button>
            <button onClick={() => setFilter('view', 'list')} className={`px-3 py-1 text-xs rounded-xl ${viewMode === 'list' ? 'text-paper bg-ink-soft' : 'text-muted'}`}>List</button>
          </div>
          <button onClick={exportPdf} disabled={!filtered.length}
            className="px-3 py-1.5 text-sm text-muted border border-bdr rounded-xl hover:text-paper transition disabled:opacity-50">Export PDF</button>
          {canWrite && <button onClick={() => setShowCreate(true)} className="px-3 py-1.5 bg-ember text-white text-sm font-semibold rounded-xl hover:bg-ember-deep transition">+ Add lead</button>}
        </div>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="px-6 py-4 border-b border-bdr overflow-y-auto max-h-[50vh]">
          <form onSubmit={createLead} className="space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <div><label className={label}>Lead name *</label><input className={input} value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. The Ivy - New POS" autoFocus /></div>
              <div><label className={label}>Source</label><select className={input} value={newSource} onChange={e => setNewSource(e.target.value)}>
                {SOURCE_OPTIONS.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}</select></div>
              <div><label className={label}>Priority</label><select className={input} value={newPriority} onChange={e => setNewPriority(e.target.value)}>
                <option value="hot">Hot</option><option value="warm">Warm</option><option value="medium">Medium</option><option value="cold">Cold</option></select></div>
            </div>

            {/* Search-and-link: Company */}
            <div className="grid grid-cols-3 gap-3">
              <div className="relative">
                <label className={label}>Company (search or create)</label>
                <input className={input} value={selectedCompany ? selectedCompany.name : companySearch}
                  onChange={e => { setCompanySearch(e.target.value); setSelectedCompany(null); }}
                  placeholder="Type to search..." />
                {companyResults.length > 0 && !selectedCompany && (
                  <div className="absolute z-10 top-full left-0 right-0 mt-1 bg-white border border-bdr rounded-xl shadow-lg max-h-32 overflow-y-auto">
                    {companyResults.map(c => (
                      <button key={c.id} type="button" onClick={() => { setSelectedCompany(c); setCompanySearch(c.name); }}
                        className="w-full px-3 py-2 text-left text-sm hover:bg-slate-50 flex items-center gap-2">
                        <span className="text-paper">{c.name}</span>
                        {c.domain && <span className="text-dim text-xs">{c.domain}</span>}
                      </button>
                    ))}
                  </div>
                )}
                {selectedCompany && <div className="text-[10px] text-emerald-600 mt-0.5">Linked to existing company</div>}
                {companySearch && !selectedCompany && companyResults.length === 0 && companySearch.length >= 2 && <div className="text-[10px] text-ember mt-0.5">Will create new company</div>}
              </div>

              {/* Search-and-link: Location */}
              <div className="relative">
                <label className={label}>Location (search or create)</label>
                <input className={input} value={selectedLocation ? selectedLocation.name : locationSearch}
                  onChange={e => { setLocationSearch(e.target.value); setSelectedLocation(null); }}
                  placeholder="Type to search..." />
                {locationResults.length > 0 && !selectedLocation && (
                  <div className="absolute z-10 top-full left-0 right-0 mt-1 bg-white border border-bdr rounded-xl shadow-lg max-h-32 overflow-y-auto">
                    {locationResults.map(l => {
                      const co = companies.find(c => c.id === l.company_id);
                      return (
                        <button key={l.id} type="button" onClick={() => { setSelectedLocation(l); setLocationSearch(l.name); if (co && !selectedCompany) { setSelectedCompany(co); setCompanySearch(co.name); } }}
                          className="w-full px-3 py-2 text-left text-sm hover:bg-slate-50">
                          <span className="text-paper">{l.name}</span>
                          {co && <span className="text-dim text-xs ml-2">({co.name})</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
                {selectedLocation && <div className="text-[10px] text-emerald-600 mt-0.5">Linked to existing location</div>}
              </div>

              {/* Search-and-link: Contact */}
              <div className="relative">
                <label className={label}>Contact (search or create below)</label>
                <input className={input} value={selectedContact ? contactFullName(selectedContact.id) : contactSearch}
                  onChange={e => { setContactSearch(e.target.value); setSelectedContact(null); }}
                  placeholder="Type to search..." />
                {contactResults.length > 0 && !selectedContact && (
                  <div className="absolute z-10 top-full left-0 right-0 mt-1 bg-white border border-bdr rounded-xl shadow-lg max-h-32 overflow-y-auto">
                    {contactResults.map(c => (
                      <button key={c.id} type="button" onClick={() => { setSelectedContact(c); setContactSearch([c.first_name, c.last_name].filter(Boolean).join(' ')); }}
                        className="w-full px-3 py-2 text-left text-sm hover:bg-slate-50">
                        <span className="text-paper">{[c.first_name, c.last_name].filter(Boolean).join(' ')}</span>
                        <span className="text-dim text-xs ml-2">{c.email}</span>
                      </button>
                    ))}
                  </div>
                )}
                {selectedContact && <div className="text-[10px] text-emerald-600 mt-0.5">Linked to existing contact</div>}
              </div>
            </div>

            {/* New contact fields (if not selecting existing) */}
            {!selectedContact && (
              <div className="grid grid-cols-4 gap-3">
                <div><label className={label}>First name</label><input className={input} value={newContactFirst} onChange={e => setNewContactFirst(e.target.value)} /></div>
                <div><label className={label}>Last name</label><input className={input} value={newContactLast} onChange={e => setNewContactLast(e.target.value)} /></div>
                <div><label className={label}>Email</label><input className={input} value={newContactEmail} onChange={e => setNewContactEmail(e.target.value)} /></div>
                <div><label className={label}>Phone</label><input className={input} value={newContactPhone} onChange={e => setNewContactPhone(e.target.value)} /></div>
              </div>
            )}

            {/* Hospitality qualification */}
            <div className="grid grid-cols-3 gap-3">
              <div><label className={label}>Venue type</label><select className={input} value={newVenueType} onChange={e => setNewVenueType(e.target.value)}>
                <option value="">Select...</option>{VENUE_TYPES.map(v => <option key={v} value={v}>{v.replace(/_/g, ' ')}</option>)}</select></div>
              <div><label className={label}>Covers / day</label><input className={input} type="number" value={newCovers} onChange={e => setNewCovers(e.target.value)} placeholder="Daily covers" /></div>
              <div><label className={label}>Current POS</label><input className={input} value={newCurrentPos} onChange={e => setNewCurrentPos(e.target.value)} placeholder="e.g. Square, Lightspeed" /></div>
            </div>
            <div><label className={label}>Notes</label><textarea className={input + ' resize-none'} rows={2} value={newNotes} onChange={e => setNewNotes(e.target.value)} placeholder="Pain points, context..." /></div>

            <div className="flex gap-2">
              <button type="submit" className="px-4 py-2 bg-ember text-white text-sm font-semibold rounded-xl">Create lead</button>
              <button type="button" onClick={() => setShowCreate(false)} className="px-4 py-2 text-sm text-muted border border-bdr rounded-xl">Cancel</button>
            </div>
          </form>
        </div>
      )}

      {/* Board view */}
      {viewMode === 'board' ? (
        <div className="flex-1 overflow-x-auto overflow-y-hidden">
          <div className="h-full flex gap-3 px-4 py-3 min-w-max">
            {STAGES.map(stage => (
              <div key={stage.key} className="w-72 shrink-0 flex flex-col glass-card rounded-2xl overflow-hidden"
                onDragOver={onDragOver} onDrop={e => onDrop(e, stage.key)}>
                <div className="px-3 py-2.5 border-b border-bdr" style={{ borderLeftColor: stage.color, borderLeftWidth: 3 }}>
                  <div className="text-[10px] font-bold uppercase tracking-wide text-paper">{stage.label}</div>
                  <div className="text-[9px] text-dim font-mono">{byStage[stage.key]?.length || 0}</div>
                </div>
                <div className="flex-1 overflow-y-auto p-1.5 space-y-1.5">
                  {(byStage[stage.key] || []).map(lead => (
                    <div key={lead.id} draggable={canWrite} onDragStart={e => onDragStart(e, lead)}
                      onClick={() => onNavigate?.('lead', lead.id)}
                      className="glass-inner rounded-2xl p-3 cursor-pointer">
                      <div className="flex items-start justify-between gap-1 mb-1">
                        <div className="text-sm font-semibold text-paper leading-snug">{lead.name}</div>
                        <span className={`px-1 py-0.5 text-[8px] font-bold uppercase rounded shrink-0 ${PRIORITY_STYLES[lead.priority]}`}>{lead.priority}</span>
                      </div>

                      {lead.company_id && <div className="text-[10px] text-muted mb-0.5">{'\u{1F3E2}'} {companyName(lead.company_id)}</div>}
                      {lead.location_id && <div className="text-[10px] text-muted mb-0.5">{'\u{1F4CD}'} {locationName(lead.location_id)}</div>}
                      {lead.contact_id && <div className="text-[10px] text-muted mb-0.5">{'\u{1F464}'} {contactFullName(lead.contact_id)}</div>}
                      {lead.venue_type && <div className="text-[10px] text-dim">{lead.venue_type.replace(/_/g, ' ')}{lead.covers ? ` / ${lead.covers} covers` : ''}</div>}
                      {lead.current_pos && <div className="text-[10px] text-dim">Current: {lead.current_pos}</div>}
                      {lead.next_action && <div className="text-[10px] text-ember mt-1">{'\u{25B6}'} {lead.next_action}</div>}

                      <div className="flex items-center gap-1 mt-2">
                        {lead.source && <span className="px-1 py-0.5 text-[8px] bg-slate-100 text-slate-600 rounded">{lead.source.replace(/_/g, ' ')}</span>}
                        {stage.key === 'sql' && canWrite && (
                          <button onClick={(e) => { e.stopPropagation(); convertToDeal(lead); }}
                            className="ml-auto px-2 py-0.5 text-[9px] font-bold bg-emerald-100 text-emerald-700 border border-emerald-200 rounded-lg hover:bg-emerald-200">Deal</button>
                        )}
                        {canWrite && (
                          <button onClick={(e) => { e.stopPropagation(); disqualify(lead); }}
                            className="px-1.5 py-0.5 text-[9px] text-red-600 hover:bg-red-50 rounded" title="Disqualify">DQ</button>
                        )}
                        {lead.owner_id && (
                          <span className="ml-auto w-5 h-5 rounded-full bg-ember text-white text-[9px] font-bold flex items-center justify-center" title={ownerName(lead.owner_id)}>
                            {ownerName(lead.owner_id)[0]?.toUpperCase() || '?'}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        /* List view */
        <div className="flex-1 overflow-y-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-bdr text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim">
                <th className="px-6 py-2.5 text-left">Lead</th>
                <th className="px-3 py-2.5 text-left">Company</th>
                <th className="px-3 py-2.5 text-left">Contact</th>
                <th className="px-3 py-2.5 text-center">Priority</th>
                <th className="px-3 py-2.5 text-left">Stage</th>
                <th className="px-3 py-2.5 text-left">Source</th>
                <th className="px-3 py-2.5 text-left">Venue</th>
                <th className="px-3 py-2.5 text-left">Owner</th>
                <th className="px-3 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(lead => (
                <tr key={lead.id} onClick={() => onNavigate?.('lead', lead.id)} className="border-b border-bdr hover:bg-card/50 cursor-pointer transition">
                  <td className="px-6 py-3 text-sm text-paper font-medium">{lead.name}</td>
                  <td className="px-3 py-3 text-xs text-muted">{companyName(lead.company_id)}</td>
                  <td className="px-3 py-3 text-xs text-muted">{contactFullName(lead.contact_id)}</td>
                  <td className="px-3 py-3 text-center"><span className={`px-1.5 py-0.5 text-[9px] font-bold uppercase rounded ${PRIORITY_STYLES[lead.priority]}`}>{lead.priority}</span></td>
                  <td className="px-3 py-3"><span className="px-1.5 py-0.5 text-[9px] font-bold uppercase rounded bg-blue-100 text-blue-700 border border-blue-200">{STAGE_LABELS[lead.stage]}</span></td>
                  <td className="px-3 py-3 text-xs text-muted">{lead.source?.replace(/_/g, ' ')}</td>
                  <td className="px-3 py-3 text-xs text-muted">{lead.venue_type?.replace(/_/g, ' ')}</td>
                  <td className="px-3 py-3 text-xs text-muted">{ownerName(lead.owner_id)}</td>
                  <td className="px-3 py-3 text-right">
                    {lead.stage === 'sql' && canWrite && (
                      <button onClick={(e) => { e.stopPropagation(); convertToDeal(lead); }} className="px-2 py-1 text-[10px] font-bold bg-emerald-100 text-emerald-700 rounded-lg">Convert</button>
                    )}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && <tr><td colSpan={9} className="px-6 py-8 text-center text-dim text-sm">No leads.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

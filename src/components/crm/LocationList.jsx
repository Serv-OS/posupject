import { useEffect, useState, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import LeadBadge from './LeadBadge.jsx';
import { primaryLead, LEAD_STAGES, LEAD_STAGE_MAP } from '../../lib/leadStages';
import { ListContainer, RecordCard, CardHead, Chip, ChipRow } from './cardKit.jsx';
import { useStickyState } from '../../lib/stickyState';
import { downloadListPdf } from '../../lib/listPdf';

const STATUS_COLORS = {
  prospect: 'bg-blue-100 text-blue-700 border border-blue-200',
  onboarding: 'bg-orange-100 text-orange-700 border border-orange-200',
  live: 'bg-emerald-100 text-emerald-700 border border-emerald-200',
  churned: 'bg-red-100 text-red-700 border border-red-200',
};

export default function LocationList({ profile, onSelect, onNavigate }) {
  const [locations, setLocations] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [leads, setLeads] = useState([]);
  // One object, one key: adding a filter later cannot orphan a stale
  // sessionStorage entry, and useStickyState merges it onto the default.
  const [filters, setFilters] = useStickyState('locations', { search: '', status: 'all', lead: 'all' });
  const { search, status: statusFilter, lead: leadFilter } = filters;
  const setFilter = (k, v) => setFilters(p => ({ ...p, [k]: v }));
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const blankLoc = { name: '', company_id: '', new_company: '', address: '', city: '', postcode: '', phone: '', email: '', venue_type: '', covers: '', status: 'prospect', notes: '' };
  const [showCreate, setShowCreate] = useState(false);
  const [nl, setNl] = useState(blankLoc);
  const setL = (k, v) => setNl(p => ({ ...p, [k]: v }));

  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  useEffect(() => { load(); }, []);

  const createLocation = async (e) => {
    e.preventDefault();
    if (!nl.name.trim()) { alert('Enter a location name.'); return; }
    let companyId = nl.company_id;
    if (companyId === '__new__') {
      if (!nl.new_company.trim()) { alert('Enter the new company name.'); return; }
      const { data: co, error: cErr } = await supabase.from('companies').insert({ name: nl.new_company.trim(), owner_id: profile.id }).select('id').single();
      if (cErr) { alert('Could not create company: ' + cErr.message); return; }
      companyId = co.id;
    }
    if (!companyId) { alert('Select or create a company for this location.'); return; }
    const { data, error } = await supabase.from('locations').insert({
      name: nl.name.trim(), company_id: companyId,
      address: nl.address.trim() || null, city: nl.city.trim() || null, postcode: nl.postcode.trim() || null,
      phone: nl.phone.trim() || null, email: nl.email.trim() || null,
      venue_type: nl.venue_type || null, covers: nl.covers ? parseInt(nl.covers) : null,
      status: nl.status || 'prospect', notes: nl.notes.trim() || null, owner_id: profile.id,
    }).select('id').single();
    if (error) { alert('Could not create location: ' + error.message); return; }
    setNl(blankLoc); setShowCreate(false);
    if (data) onSelect(data.id); else load();
  };

  const [associations, setAssociations] = useState([]);
  const [contacts, setContacts] = useState([]);

  const load = async () => {
    setLoading(true);
    const [l, c, ld, a, ct] = await Promise.all([
      supabase.from('locations').select('*').order('name'),
      supabase.from('companies').select('id, name'),
      supabase.from('leads').select('id, location_id, stage, name'),
      supabase.from('associations').select('*')
        .or('and(from_type.eq.contact,to_type.eq.location),and(from_type.eq.location,to_type.eq.contact)'),
      supabase.from('contacts').select('id, first_name, last_name'),
    ]);
    setLocations(l.data || []);
    setCompanies(c.data || []);
    setLeads(ld.data || []);
    setAssociations(a.data || []);
    setContacts(ct.data || []);
    setLoading(false);
  };

  const leadFor = (locationId) => primaryLead(leads.filter(l => l.location_id === locationId));
  const contactNames = (locationId) => {
    const ids = new Set();
    for (const a of associations) {
      // association may be stored either direction: contact↔location
      if (a.from_type === 'location' && a.from_id === locationId && a.to_type === 'contact') ids.add(a.to_id);
      else if (a.to_type === 'location' && a.to_id === locationId && a.from_type === 'contact') ids.add(a.from_id);
    }
    return [...ids]
      .map(id => { const c = contacts.find(x => x.id === id); return c ? [c.first_name, c.last_name].filter(Boolean).join(' ') : null; })
      .filter(Boolean).join(', ');
  };

  const filtered = useMemo(() => {
    let result = locations;
    if (statusFilter !== 'all') result = result.filter(l => l.status === statusFilter);
    if (leadFilter !== 'all') {
      result = result.filter(l => {
        const pl = leadFor(l.id);
        if (leadFilter === 'any') return !!pl;
        if (leadFilter === 'none') return !pl;
        return pl?.stage === leadFilter;
      });
    }
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(l =>
        l.name.toLowerCase().includes(q) ||
        (l.city || '').toLowerCase().includes(q) ||
        (companies.find(c => c.id === l.company_id)?.name || '').toLowerCase().includes(q)
      );
    }
    return result;
  }, [locations, companies, leads, search, statusFilter, leadFilter]);

  const companyName = (id) => companies.find(c => c.id === id)?.name || '';

  const leadFilterLabel = leadFilter === 'any' ? 'Has a lead'
    : leadFilter === 'none' ? 'No lead'
    : LEAD_STAGE_MAP[leadFilter]?.label || leadFilter;

  // Only the filters actually narrowing the list, so the PDF says what it is a
  // list of. 'all' narrows nothing, so it is never named.
  const activeFilters = [
    search && `Search: \u201C${search}\u201D`,
    statusFilter !== 'all' && `Status: ${statusFilter}`,
    leadFilter !== 'all' && `Lead: ${leadFilterLabel}`,
  ].filter(Boolean);

  // No money on this screen: the venue trading figures live on the record, in
  // GBP only, so nothing here needs the dual-region currency treatment.
  const exportPdf = async () => {
    setExporting(true);
    try {
      await downloadListPdf({
        title: 'Locations',
        columns: ['Location', 'Venue code', 'Company', 'Contacts', 'City', 'Postcode', 'Status', 'Lead', 'Venue type', 'Covers'],
        // `filtered`, never `locations`, so the paper copy matches the screen.
        rows: filtered.map(l => {
          const lead = leadFor(l.id);
          return [
            l.name,
            l.venue_code || '',
            companyName(l.company_id),
            contactNames(l.id),
            l.city || '',
            l.postcode || '',
            l.status || '',
            lead ? (LEAD_STAGE_MAP[lead.stage]?.label || lead.stage) : '',
            (l.venue_type || '').replace(/_/g, ' '),
            l.covers ?? '',
          ];
        }),
        filters: activeFilters,
        footNote: 'Sorted by location name, as shown on screen. A blank venue code is a venue not yet linked to the POS platform.',
      });
    } finally {
      setExporting(false);
    }
  };

  const counts = useMemo(() => {
    const m = { prospect: 0, onboarding: 0, live: 0, churned: 0 };
    locations.forEach(l => { if (m[l.status] !== undefined) m[l.status]++; });
    return m;
  }, [locations]);

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-bdr flex items-center justify-between">
        <div>
          <div className="text-lg font-bold text-paper">Locations</div>
          <div className="text-[10px] text-dim font-mono uppercase tracking-[0.18em]">
            {locations.length} total / {counts.live} live / {counts.onboarding} onboarding / {counts.prospect} prospect
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={exportPdf} disabled={exporting || !filtered.length}
            className="px-3 py-1.5 text-sm text-muted border border-bdr rounded-xl transition disabled:opacity-50">
            {exporting ? 'Building PDF...' : 'Export PDF'}
          </button>
          {canWrite && (
            <button onClick={() => setShowCreate(true)}
              className="px-3 py-1.5 bg-ember text-white text-sm font-semibold rounded-xl hover:bg-ember-deep transition">+ Add location</button>
          )}
        </div>
      </div>

      {showCreate && (
        <div className="px-6 py-4 border-b border-bdr max-h-[70vh] overflow-y-auto">
          <form onSubmit={createLocation} className="space-y-3 max-w-3xl">
            {(() => { const input = "w-full px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper placeholder-dim focus:outline-none focus:border-ember"; const label = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block"; return (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div><label className={label}>Location name *</label><input className={input} value={nl.name} onChange={e => setL('name', e.target.value)} autoFocus /></div>
                  <div><label className={label}>Company *</label>
                    <select className={input} value={nl.company_id} onChange={e => setL('company_id', e.target.value)}>
                      <option value="">Select company…</option>
                      {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                      <option value="__new__">+ Create new company…</option>
                    </select></div>
                  {nl.company_id === '__new__' && <div className="sm:col-span-2"><label className={label}>New company name</label><input className={input} value={nl.new_company} onChange={e => setL('new_company', e.target.value)} /></div>}
                  <div><label className={label}>Address</label><input className={input} value={nl.address} onChange={e => setL('address', e.target.value)} /></div>
                  <div className="grid grid-cols-2 gap-3">
                    <div><label className={label}>City</label><input className={input} value={nl.city} onChange={e => setL('city', e.target.value)} /></div>
                    <div><label className={label}>Postcode</label><input className={input} value={nl.postcode} onChange={e => setL('postcode', e.target.value)} /></div>
                  </div>
                  <div><label className={label}>Phone</label><input className={input} value={nl.phone} onChange={e => setL('phone', e.target.value)} /></div>
                  <div><label className={label}>Email</label><input className={input} value={nl.email} onChange={e => setL('email', e.target.value)} /></div>
                  <div><label className={label}>Venue type</label>
                    <select className={input} value={nl.venue_type} onChange={e => setL('venue_type', e.target.value)}>
                      <option value="">Select…</option>
                      {['restaurant','bar','cafe','fast_casual','qsr','hotel_fb','nightclub','food_hall','catering','other'].map(v => <option key={v} value={v}>{v.replace(/_/g,' ')}</option>)}
                    </select></div>
                  <div className="grid grid-cols-2 gap-3">
                    <div><label className={label}>Covers</label><input type="number" className={input} value={nl.covers} onChange={e => setL('covers', e.target.value)} /></div>
                    <div><label className={label}>Status</label>
                      <select className={input} value={nl.status} onChange={e => setL('status', e.target.value)}>
                        <option value="prospect">Prospect</option><option value="onboarding">Onboarding</option><option value="live">Live</option><option value="churned">Churned</option>
                      </select></div>
                  </div>
                </div>
                <div><label className={label}>Notes</label><textarea className={input + ' resize-none'} rows={2} value={nl.notes} onChange={e => setL('notes', e.target.value)} /></div>
                <div className="flex gap-2">
                  <button type="submit" className="px-4 py-2 bg-ember text-white text-sm font-semibold rounded-xl">Create location</button>
                  <button type="button" onClick={() => { setShowCreate(false); setNl(blankLoc); }} className="px-3 py-2 text-sm text-muted border border-bdr rounded-xl">Cancel</button>
                </div>
              </>
            ); })()}
          </form>
        </div>
      )}

      <div className="px-6 py-3 border-b border-bdr flex items-center gap-2">
        <input value={search} onChange={e => setFilter('search', e.target.value)}
          placeholder="Search locations..."
          className="px-3 py-1.5 bg-card border border-bdr rounded text-sm text-paper placeholder-dim focus:outline-none focus:border-ember w-72" />
        <select value={statusFilter} onChange={e => setFilter('status', e.target.value)}
          className="px-2 py-1.5 bg-card border border-bdr rounded text-sm text-paper focus:outline-none focus:border-ember">
          <option value="all">All statuses</option>
          <option value="prospect">Prospect</option>
          <option value="onboarding">Onboarding</option>
          <option value="live">Live</option>
          <option value="churned">Churned</option>
        </select>
        <select value={leadFilter} onChange={e => setFilter('lead', e.target.value)}
          className="px-2 py-1.5 bg-card border border-bdr rounded text-sm text-paper focus:outline-none focus:border-ember">
          <option value="all">All leads</option>
          <option value="any">Has a lead</option>
          <option value="none">No lead</option>
          {LEAD_STAGES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
      </div>

      <ListContainer>
        {loading && <div className="py-8 text-center text-dim text-sm">Loading...</div>}
        {!loading && filtered.length === 0 && (
          <div className="py-8 text-center text-dim text-sm">{search || statusFilter !== 'all' ? 'No locations match your filters.' : 'No locations yet.'}</div>
        )}
        {!loading && filtered.map(l => {
          const lead = leadFor(l.id);
          return (
            <RecordCard key={l.id} onClick={() => onSelect(l.id)}>
              <CardHead title={l.name} badge={
                <span className="flex items-center gap-1.5">
                  {lead && <LeadBadge stage={lead.stage} />}
                  <span className={`px-2 py-0.5 text-[9px] font-bold uppercase rounded ${STATUS_COLORS[l.status] || 'bg-card text-dim'}`}>{l.status}</span>
                </span>
              } />
              <ChipRow>
                <Chip tone="slate" icon={'\u{1F3E2}'}>{companyName(l.company_id)}</Chip>
                <Chip tone="slate" icon={'\u{1F464}'}>{contactNames(l.id)}</Chip>
                <Chip icon={'\u{1F4CD}'}>{l.city}</Chip>
                <Chip>{l.venue_type}</Chip>
                <Chip>{l.covers ? `${l.covers} covers` : ''}</Chip>
                {/* Shown ONLY when linked. An unlinked venue is the normal state
                    for a prospect, so flagging every one of those would be noise;
                    the detail panel is where the gap is called out. */}
                {l.venue_code && <Chip tone="slate" icon={'\u{1F5A5}'}>{l.venue_code}</Chip>}
              </ChipRow>
            </RecordCard>
          );
        })}
      </ListContainer>
    </div>
  );
}

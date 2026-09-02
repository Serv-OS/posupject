import { useEffect, useState, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import LeadBadge from './LeadBadge.jsx';
import { primaryLead, LEAD_STAGES, LEAD_STAGE_MAP } from '../../lib/leadStages';
import { ListContainer, RecordCard, CardHead, Chip, ChipRow } from './cardKit.jsx';
import { useStickyState } from '../../lib/stickyState';
import { downloadListPdf } from '../../lib/listPdf';

export default function ContactList({ profile, onSelect }) {
  const [contacts, setContacts] = useState([]);
  const [associations, setAssociations] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [locations, setLocations] = useState([]);
  const [leads, setLeads] = useState([]);
  const [members, setMembers] = useState([]);
  // Filters live in one sticky object so opening a contact and coming back does
  // not dump you into the unfiltered list again.
  const [filters, setFilters] = useStickyState('contacts', { search: '', leadFilter: 'all' });
  const { search, leadFilter } = filters;
  const setFilter = (k, v) => setFilters(p => ({ ...p, [k]: v }));
  const [loading, setLoading] = useState(true);

  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    const [c, a, co, ld, loc, m] = await Promise.all([
      supabase.from('contacts').select('*').order('last_name'),
      supabase.from('associations').select('*').or('from_type.eq.contact,to_type.eq.contact'),
      supabase.from('companies').select('id, name'),
      supabase.from('leads').select('id, contact_id, stage, name'),
      supabase.from('locations').select('id, name'),
      // Owners are not on the card, but a printed contact list is useless
      // without knowing who each one belongs to.
      supabase.from('profiles').select('id, email, display_name'),
    ]);
    setContacts(c.data || []);
    setAssociations(a.data || []);
    setCompanies(co.data || []);
    setLeads(ld.data || []);
    setLocations(loc.data || []);
    setMembers(m.data || []);
    setLoading(false);
  };

  const leadFor = (contactId) => primaryLead(leads.filter(l => l.contact_id === contactId));

  const filtered = useMemo(() => {
    let result = contacts;
    if (leadFilter !== 'all') {
      result = result.filter(c => {
        const pl = leadFor(c.id);
        if (leadFilter === 'any') return !!pl;
        if (leadFilter === 'none') return !pl;
        return pl?.stage === leadFilter;
      });
    }
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(c =>
        (c.first_name || '').toLowerCase().includes(q) ||
        (c.last_name || '').toLowerCase().includes(q) ||
        (c.email || '').toLowerCase().includes(q) ||
        (c.phone || '').toLowerCase().includes(q)
      );
    }
    return result;
  }, [contacts, leads, search, leadFilter]);

  // Resolve ids of `targetType` linked to a contact, whichever direction the
  // association is stored (contact↔company / contact↔location).
  const linkedIds = (contactId, targetType) => {
    const ids = new Set();
    for (const a of associations) {
      if (a.from_type === 'contact' && a.from_id === contactId && a.to_type === targetType) ids.add(a.to_id);
      else if (a.to_type === 'contact' && a.to_id === contactId && a.from_type === targetType) ids.add(a.from_id);
    }
    return [...ids];
  };

  const getCompanyNames = (contactId) =>
    linkedIds(contactId, 'company').map(id => companies.find(c => c.id === id)?.name).filter(Boolean).join(', ');

  const locationCount = (contactId) => linkedIds(contactId, 'location').length;

  const ownerName = (id) => {
    const m = members.find(u => u.id === id);
    return m ? (m.display_name || m.email.split('@')[0]) : '';
  };

  const fullNameOf = (c) => [c.first_name, c.last_name].filter(Boolean).join(' ') || 'No name';
  const stageLabel = (key) => LEAD_STAGE_MAP[key]?.label || key;

  const exportPdf = async () => {
    // `filtered` is the exact array the cards below map over, so the PDF can
    // never quietly include rows the current filter is hiding. Contacts hold no
    // money, so nothing here is currency-bearing.
    const active = [];
    if (search) active.push(`Search: "${search}"`);
    if (leadFilter === 'any') active.push('Lead: has a lead');
    else if (leadFilter === 'none') active.push('Lead: no lead');
    else if (leadFilter !== 'all') active.push(`Lead: ${stageLabel(leadFilter)}`);

    await downloadListPdf({
      title: 'Contacts',
      columns: ['Contact', 'Job title', 'Email', 'Phone', 'Company', 'Lead', 'Owner'],
      rows: filtered.map(c => {
        const lead = leadFor(c.id);
        return [
          fullNameOf(c),
          c.job_title || '',
          c.email || '',
          c.phone || '',
          getCompanyNames(c.id),
          lead ? stageLabel(lead.stage) : '',
          ownerName(c.owner_id),
        ];
      }),
      filters: active,
    });
  };

  const blank = { first_name: '', last_name: '', email: '', phone: '', job_title: '', company_id: '', source: '', notes: '' };
  const [showCreate, setShowCreate] = useState(false);
  const [nc, setNc] = useState(blank);
  const set = (k, v) => setNc(p => ({ ...p, [k]: v }));

  const create = async (e) => {
    e.preventDefault();
    if (!nc.first_name.trim() && !nc.last_name.trim() && !nc.email.trim()) { alert('Enter a name or email.'); return; }
    const { data, error } = await supabase.from('contacts').insert({
      first_name: nc.first_name.trim() || null, last_name: nc.last_name.trim() || null,
      email: nc.email.trim() || null, phone: nc.phone.trim() || null,
      job_title: nc.job_title.trim() || null, source: nc.source.trim() || null,
      notes: nc.notes.trim() || null, owner_id: profile.id,
    }).select().single();
    if (error) { alert('Could not create contact: ' + error.message); return; }
    if (data && nc.company_id) {
      await supabase.from('associations').insert({ from_type: 'contact', from_id: data.id, to_type: 'company', to_id: nc.company_id, label: 'primary_contact' });
    }
    setNc(blank); setShowCreate(false);
    if (data) onSelect(data.id); else load();
  };

  const input = "w-full px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper placeholder-dim focus:outline-none focus:border-ember";
  const label = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block";

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-bdr flex items-center justify-between">
        <div>
          <div className="text-lg font-bold text-paper">Contacts</div>
          <div className="text-[10px] text-dim font-mono uppercase tracking-[0.18em]">{contacts.length} contacts</div>
        </div>
        {canWrite && (
          <button onClick={() => setShowCreate(true)}
            className="px-3 py-1.5 bg-ember text-ink text-sm font-semibold rounded hover:bg-ember-deep transition">
            + Add contact
          </button>
        )}
      </div>

      <div className="px-6 py-3 border-b border-bdr flex items-center gap-2">
        <input value={search} onChange={e => setFilter('search', e.target.value)}
          placeholder="Search contacts..."
          className="px-3 py-1.5 bg-card border border-bdr rounded text-sm text-paper placeholder-dim focus:outline-none focus:border-ember w-72" />
        <select value={leadFilter} onChange={e => setFilter('leadFilter', e.target.value)}
          className="px-2 py-1.5 bg-card border border-bdr rounded text-sm text-paper focus:outline-none focus:border-ember">
          <option value="all">All contacts</option>
          <option value="any">Has a lead</option>
          <option value="none">No lead</option>
          {LEAD_STAGES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <button onClick={exportPdf} disabled={!filtered.length}
          className="ml-auto px-3 py-1.5 text-sm text-muted border border-bdr rounded hover:text-paper transition disabled:opacity-50">
          Export PDF
        </button>
      </div>

      {showCreate && (
        <div className="px-6 py-4 border-b border-bdr max-h-[70vh] overflow-y-auto">
          <form onSubmit={create} className="space-y-3 max-w-3xl">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div><label className={label}>First name</label><input className={input} value={nc.first_name} onChange={e => set('first_name', e.target.value)} autoFocus /></div>
              <div><label className={label}>Last name</label><input className={input} value={nc.last_name} onChange={e => set('last_name', e.target.value)} /></div>
              <div><label className={label}>Email</label><input className={input} type="email" value={nc.email} onChange={e => set('email', e.target.value)} /></div>
              <div><label className={label}>Phone</label><input className={input} value={nc.phone} onChange={e => set('phone', e.target.value)} /></div>
              <div><label className={label}>Job title</label><input className={input} value={nc.job_title} onChange={e => set('job_title', e.target.value)} /></div>
              <div><label className={label}>Company</label><select className={input} value={nc.company_id} onChange={e => set('company_id', e.target.value)}>
                <option value="">— None —</option>{companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
              <div><label className={label}>Source</label><input className={input} value={nc.source} onChange={e => set('source', e.target.value)} placeholder="e.g. referral, event" /></div>
            </div>
            <div><label className={label}>Notes</label><textarea className={input + ' resize-none'} rows={2} value={nc.notes} onChange={e => set('notes', e.target.value)} /></div>
            <div className="flex gap-2">
              <button type="submit" className="px-4 py-2 bg-ember text-white text-sm font-semibold rounded-xl">Create contact</button>
              <button type="button" onClick={() => { setShowCreate(false); setNc(blank); }} className="px-3 py-2 text-sm text-muted border border-bdr rounded-xl">Cancel</button>
            </div>
          </form>
        </div>
      )}

      <ListContainer>
        {loading && <div className="py-8 text-center text-dim text-sm">Loading...</div>}
        {!loading && filtered.length === 0 && (
          <div className="py-8 text-center text-dim text-sm">{search ? 'No contacts match your search.' : 'No contacts yet.'}</div>
        )}
        {!loading && filtered.map(c => {
          const lead = leadFor(c.id);
          const fullName = fullNameOf(c);
          return (
            <RecordCard key={c.id} href={`#contact_detail/${c.id}`} onClick={() => onSelect(c.id)}>
              <CardHead title={fullName} subtitle={c.job_title} badge={lead && <LeadBadge stage={lead.stage} />} />
              <ChipRow>
                <Chip icon={'\u{1F4E7}'}>{c.email}</Chip>
                <Chip icon={'\u{1F4F1}'}>{c.phone}</Chip>
                <Chip tone="slate" icon={'\u{1F3E2}'}>{getCompanyNames(c.id)}</Chip>
                {locationCount(c.id) > 0 && (
                  <Chip tone="slate" icon={'\u{1F4CD}'}>{locationCount(c.id)} location{locationCount(c.id) !== 1 ? 's' : ''}</Chip>
                )}
              </ChipRow>
            </RecordCard>
          );
        })}
      </ListContainer>
    </div>
  );
}

import { useEffect, useState, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import LeadBadge from './LeadBadge.jsx';
import { primaryLead, LEAD_STAGES, LEAD_STAGE_MAP } from '../../lib/leadStages';
import { ListContainer, RecordCard, CardHead, Chip, ChipRow, MetaRow, OwnerTag } from './cardKit.jsx';
import { useStickyState } from '../../lib/stickyState';
import { downloadListPdf } from '../../lib/listPdf';

export default function CompanyList({ profile, onSelect }) {
  const [companies, setCompanies] = useState([]);
  const [locations, setLocations] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [assocs, setAssocs] = useState([]);
  const [members, setMembers] = useState([]);
  const [leads, setLeads] = useState([]);
  // Filters live in one sticky object so opening a company and coming back does
  // not dump you into the unfiltered list again.
  const [filters, setFilters] = useStickyState('companies', { search: '', leadFilter: 'all' });
  const { search, leadFilter } = filters;
  const setFilter = (k, v) => setFilters(p => ({ ...p, [k]: v }));
  const [loading, setLoading] = useState(true);

  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    const [c, l, m, ld, ct, as] = await Promise.all([
      supabase.from('companies').select('*').order('name'),
      supabase.from('locations').select('id, company_id, status, name'),
      supabase.from('profiles').select('id, email, display_name'),
      supabase.from('leads').select('id, company_id, stage, name'),
      supabase.from('contacts').select('id, first_name, last_name, email, job_title'),
      // Contacts hang off companies through the associations table, not a
      // company_id column, which is why the list could never show them.
      supabase.from('associations').select('from_type, from_id, to_type, to_id, label')
        .or('and(from_type.eq.company,to_type.eq.contact),and(from_type.eq.contact,to_type.eq.company)'),
    ]);
    setCompanies(c.data || []);
    setLocations(l.data || []);
    setMembers(m.data || []);
    setLeads(ld.data || []);
    setContacts(ct.data || []);
    setAssocs(as.data || []);
    setLoading(false);
  };

  const leadFor = (companyId) => primaryLead(leads.filter(l => l.company_id === companyId));

  const filtered = useMemo(() => {
    let result = companies;
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
        c.name.toLowerCase().includes(q) ||
        (c.domain || '').toLowerCase().includes(q) ||
        (c.city || '').toLowerCase().includes(q)
      );
    }
    return result;
  }, [companies, leads, search, leadFilter]);

  // An association is stored in whichever direction it happened to be created,
  // so both ends have to be checked. Reading only from_id would have shown the
  // contact on some companies and not others, which is worse than showing none.
  const contactsFor = (companyId) => {
    const ids = new Set();
    for (const a of assocs) {
      if (a.from_type === 'company' && a.from_id === companyId && a.to_type === 'contact') ids.add(a.to_id);
      else if (a.to_type === 'company' && a.to_id === companyId && a.from_type === 'contact') ids.add(a.from_id);
    }
    return contacts.filter(c => ids.has(c.id));
  };
  const contactName = (c) => [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || 'Unnamed contact';
  const sitesFor = (companyId) => locations.filter(l => l.company_id === companyId);

  const locCount = (companyId) => locations.filter(l => l.company_id === companyId).length;
  const liveCount = (companyId) => locations.filter(l => l.company_id === companyId && l.status === 'live').length;
  const ownerName = (id) => {
    const m = members.find(u => u.id === id);
    return m ? (m.display_name || m.email.split('@')[0]) : '';
  };

  const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }) : '';
  const stageLabel = (key) => LEAD_STAGE_MAP[key]?.label || key;

  const exportPdf = async () => {
    // `filtered` is the exact array the cards below map over, so the PDF can
    // never quietly include rows the current filter is hiding.
    //
    // Companies carry no money and no currency of their own (currency lives on
    // invoices and quotes), so the only region marker to print is the country
    // code — worth a column now that the book is split UK/US.
    const hasCountry = filtered.some(c => c.country);
    const active = [];
    if (search) active.push(`Search: "${search}"`);
    if (leadFilter === 'any') active.push('Lead: has a lead');
    else if (leadFilter === 'none') active.push('Lead: no lead');
    else if (leadFilter !== 'all') active.push(`Lead: ${stageLabel(leadFilter)}`);

    await downloadListPdf({
      title: 'Companies',
      columns: ['Company', 'Industry', 'City', ...(hasCountry ? ['Country'] : []), 'Lead', 'Owner', 'Locations', 'Created'],
      rows: filtered.map(c => {
        const lead = leadFor(c.id);
        const live = liveCount(c.id);
        return [
          c.name,
          c.industry || '',
          c.city || '',
          ...(hasCountry ? [c.country || ''] : []),
          lead ? stageLabel(lead.stage) : '',
          ownerName(c.owner_id),
          `${locCount(c.id)}${live > 0 ? ` (${live} live)` : ''}`,
          fmtDate(c.created_at),
        ];
      }),
      filters: active,
    });
  };

  const blank = { name: '', domain: '', industry: '', phone: '', email: '', website: '', address: '', city: '', postcode: '', country: '', notes: '' };
  const [showCreate, setShowCreate] = useState(false);
  const [nc, setNc] = useState(blank);
  const set = (k, v) => setNc(p => ({ ...p, [k]: v }));

  const create = async (e) => {
    e.preventDefault();
    if (!nc.name.trim()) { alert('Enter a company name.'); return; }
    const payload = { owner_id: profile.id };
    Object.keys(blank).forEach(k => { payload[k] = nc[k]?.trim() ? nc[k].trim() : null; });
    payload.name = nc.name.trim();
    const { data, error } = await supabase.from('companies').insert(payload).select().single();
    if (error) { alert('Could not create company: ' + error.message); return; }
    setNc(blank); setShowCreate(false);
    if (data) onSelect(data.id); else load();
  };

  const input = "w-full px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper placeholder-dim focus:outline-none focus:border-ember";
  const label = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block";

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-bdr flex items-center justify-between">
        <div>
          <div className="text-lg font-bold text-paper">Companies</div>
          <div className="text-[10px] text-dim font-mono uppercase tracking-[0.18em]">
            {companies.length} companies / {locations.length} locations
          </div>
        </div>
        {canWrite && (
          <button onClick={() => setShowCreate(true)}
            className="px-3 py-1.5 bg-ember text-ink text-sm font-semibold rounded hover:bg-ember-deep transition">
            + Add company
          </button>
        )}
      </div>

      <div className="px-6 py-3 border-b border-bdr flex items-center gap-2">
        <input value={search} onChange={e => setFilter('search', e.target.value)}
          placeholder="Search companies..."
          className="px-3 py-1.5 bg-card border border-bdr rounded text-sm text-paper placeholder-dim focus:outline-none focus:border-ember w-72" />
        <select value={leadFilter} onChange={e => setFilter('leadFilter', e.target.value)}
          className="px-2 py-1.5 bg-card border border-bdr rounded text-sm text-paper focus:outline-none focus:border-ember">
          <option value="all">All companies</option>
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
              <div><label className={label}>Company name *</label><input className={input} value={nc.name} onChange={e => set('name', e.target.value)} autoFocus /></div>
              <div><label className={label}>Industry</label><input className={input} value={nc.industry} onChange={e => set('industry', e.target.value)} placeholder="e.g. Restaurant group" /></div>
              <div><label className={label}>Domain</label><input className={input} value={nc.domain} onChange={e => set('domain', e.target.value)} placeholder="example.com" /></div>
              <div><label className={label}>Website</label><input className={input} value={nc.website} onChange={e => set('website', e.target.value)} placeholder="https://" /></div>
              <div><label className={label}>Phone</label><input className={input} value={nc.phone} onChange={e => set('phone', e.target.value)} /></div>
              <div><label className={label}>Email</label><input className={input} value={nc.email} onChange={e => set('email', e.target.value)} /></div>
              <div><label className={label}>Address</label><input className={input} value={nc.address} onChange={e => set('address', e.target.value)} /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className={label}>City</label><input className={input} value={nc.city} onChange={e => set('city', e.target.value)} /></div>
                <div><label className={label}>Postcode</label><input className={input} value={nc.postcode} onChange={e => set('postcode', e.target.value)} /></div>
              </div>
            </div>
            <div><label className={label}>Notes</label><textarea className={input + ' resize-none'} rows={2} value={nc.notes} onChange={e => set('notes', e.target.value)} /></div>
            <div className="flex gap-2">
              <button type="submit" className="px-4 py-2 bg-ember text-white text-sm font-semibold rounded-xl">Create company</button>
              <button type="button" onClick={() => { setShowCreate(false); setNc(blank); }} className="px-3 py-2 text-sm text-muted border border-bdr rounded-xl">Cancel</button>
            </div>
          </form>
        </div>
      )}

      <ListContainer>
        {loading && <div className="py-8 text-center text-dim text-sm">Loading...</div>}
        {!loading && filtered.length === 0 && (
          <div className="py-8 text-center text-dim text-sm">{search ? 'No companies match your search.' : 'No companies yet. Add one to get started.'}</div>
        )}
        {!loading && filtered.map(c => {
          const lead = leadFor(c.id);
          return (
            <RecordCard key={c.id} href={`#company_detail/${c.id}`} onClick={() => onSelect(c.id)}>
              <CardHead title={c.name} subtitle={c.industry} badge={lead && <LeadBadge stage={lead.stage} />} />
              <ChipRow>
                <Chip icon={'\u{1F310}'}>{c.domain}</Chip>
                <Chip icon={'\u{1F4CD}'}>{c.city}</Chip>
              </ChipRow>
              {/* Who and what is actually attached. The row used to show the
                  OWNER and a location count, which answered "who is it assigned
                  to" rather than "who do we deal with there". A company with a
                  named primary contact and a named site looked empty. */}
              {(() => {
                const people = contactsFor(c.id);
                const sites = sitesFor(c.id);
                if (!people.length && !sites.length) return null;
                return (
                  <div className="flex flex-wrap items-center gap-1.5 mt-2">
                    {people.slice(0, 3).map(p => (
                      <span key={p.id} title={[contactName(p), p.job_title, p.email].filter(Boolean).join(' · ')}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] bg-ember/10 text-ember-deep border border-ember/20">
                        {'\u{1F464}'} {contactName(p)}
                      </span>
                    ))}
                    {people.length > 3 && <span className="text-[11px] text-dim">+{people.length - 3} more</span>}
                    {sites.slice(0, 2).map(s => (
                      <span key={s.id} title={s.name}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] bg-slate-100 text-slate-600 border border-slate-200">
                        {'\u{1F4CD}'} {s.name}
                      </span>
                    ))}
                    {sites.length > 2 && <span className="text-[11px] text-dim">+{sites.length - 2} more sites</span>}
                  </div>
                );
              })()}
              <MetaRow>
                <OwnerTag name={ownerName(c.owner_id)} />
                <span>{locCount(c.id)} location{locCount(c.id) !== 1 ? 's' : ''}{liveCount(c.id) > 0 ? ` · ${liveCount(c.id)} live` : ''}</span>
                {contactsFor(c.id).length > 0 && (
                  <span>{contactsFor(c.id).length} contact{contactsFor(c.id).length !== 1 ? 's' : ''}</span>
                )}
              </MetaRow>
            </RecordCard>
          );
        })}
      </ListContainer>
    </div>
  );
}

import { useEffect, useState, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import { ListContainer, RecordCard, CardHead, Chip, ChipRow, MetaRow, OwnerTag } from './cardKit.jsx';

import { PRIORITY_LABEL } from '../../lib/priority';
const STATUS_STYLES = {
  new: 'bg-blue-100 text-blue-700 border border-blue-200',
  under_review: 'bg-purple-100 text-purple-700 border border-purple-200',
  planned: 'bg-orange-100 text-orange-700 border border-orange-200',
  in_progress: 'bg-amber-100 text-amber-700 border border-amber-200',
  shipped: 'bg-emerald-100 text-emerald-700 border border-emerald-200',
  declined: 'bg-red-100 text-red-700 border border-red-200',
};
const STATUS_LABELS = {
  new:'New', under_review:'Under Review', planned:'Planned',
  in_progress:'In Progress', shipped:'Shipped', declined:'Declined',
};

export default function FeatureRequestList({ profile, onSelect }) {
  const [requests, setRequests] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [members, setMembers] = useState([]);
  const [associations, setAssociations] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('open');
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('P2');

  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    const [r, c, m, a, co] = await Promise.all([
      supabase.from('feature_requests').select('*').order('created_at', { ascending: false }),
      supabase.from('contacts').select('id, first_name, last_name, email'),
      supabase.from('profiles').select('id, email, display_name'),
      supabase.from('associations').select('*').or('from_type.eq.feature_request,to_type.eq.feature_request'),
      supabase.from('companies').select('id, name'),
    ]);
    setRequests(r.data || []);
    setContacts(c.data || []);
    setMembers(m.data || []);
    setAssociations(a.data || []);
    setCompanies(co.data || []);
    setLoading(false);
  };

  const filtered = useMemo(() => {
    let result = requests;
    if (filter === 'open') result = result.filter(r => !['shipped','declined'].includes(r.status));
    else if (filter !== 'all') result = result.filter(r => r.status === filter);
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(r => r.title.toLowerCase().includes(q));
    }
    return result;
  }, [requests, filter, search]);

  const contactName = (id) => {
    const c = contacts.find(x => x.id === id);
    return c ? [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email : '';
  };

  // ids of `targetType` linked to a feature request, whichever direction stored
  const frLinkedIds = (frId, targetType) => {
    const ids = new Set();
    for (const a of associations) {
      if (a.from_type === 'feature_request' && a.from_id === frId && a.to_type === targetType) ids.add(a.to_id);
      else if (a.to_type === 'feature_request' && a.to_id === frId && a.from_type === targetType) ids.add(a.from_id);
    }
    return ids;
  };

  const getLinkedCompanies = (frId) =>
    [...frLinkedIds(frId, 'company')].map(id => companies.find(c => c.id === id)?.name).filter(Boolean).join(', ');

  const demandCount = (frId) => frLinkedIds(frId, 'company').size + frLinkedIds(frId, 'deal').size;

  const create = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    const { data } = await supabase.from('feature_requests').insert({
      title: title.trim(),
      description: description.trim() || null,
      priority,
      owner_id: profile.id,
    }).select().single();
    setTitle(''); setDescription(''); setPriority('P2'); setShowCreate(false);
    if (data) onSelect(data.id);
    else load();
  };

  const input = "w-full px-3 py-2 bg-card border border-bdr rounded text-sm text-paper placeholder-dim focus:outline-none focus:border-ember";

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-bdr flex items-center justify-between">
        <div>
          <div className="text-lg font-bold text-paper">Feature Requests</div>
          <div className="text-[10px] text-dim font-mono uppercase tracking-[0.18em]">
            {requests.filter(r => !['shipped','declined'].includes(r.status)).length} open / {requests.filter(r => r.status === 'shipped').length} shipped
          </div>
        </div>
        {canWrite && (
          <button onClick={() => setShowCreate(true)}
            className="px-3 py-1.5 bg-ember text-ink text-sm font-semibold rounded hover:bg-ember-deep transition">+ New request</button>
        )}
      </div>

      <div className="px-6 py-3 border-b border-bdr flex items-center gap-2">
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search..."
          className="px-3 py-1.5 bg-card border border-bdr rounded text-sm text-paper placeholder-dim focus:outline-none focus:border-ember w-56" />
        <select value={filter} onChange={e => setFilter(e.target.value)}
          className="px-2 py-1.5 bg-card border border-bdr rounded text-sm text-paper focus:outline-none focus:border-ember">
          <option value="open">Open</option>
          <option value="all">All</option>
          {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>

      {showCreate && (
        <div className="px-6 py-3 border-b border-bdr max-h-[70vh] overflow-y-auto">
          <form onSubmit={create} className="space-y-2">
            <input className={input} value={title} onChange={e => setTitle(e.target.value)} placeholder="Feature request title" autoFocus />
            <div className="flex gap-2">
              <input className={input + ' flex-1'} value={description} onChange={e => setDescription(e.target.value)} placeholder="Description (optional)" />
              <select className="px-2 py-2 bg-card border border-bdr rounded text-sm text-paper" value={priority} onChange={e => setPriority(e.target.value)}>
                <option value="P0">{PRIORITY_LABEL.P0}</option><option value="P1">{PRIORITY_LABEL.P1}</option><option value="P2">{PRIORITY_LABEL.P2}</option><option value="P3">{PRIORITY_LABEL.P3}</option>
              </select>
              <button type="submit" className="px-4 py-2 bg-ember text-ink text-sm font-semibold rounded shrink-0">Create</button>
              <button type="button" onClick={() => setShowCreate(false)} className="px-3 py-2 text-sm text-muted border border-bdr rounded shrink-0">Cancel</button>
            </div>
          </form>
        </div>
      )}

      <ListContainer>
        {loading && <div className="py-8 text-center text-dim text-sm">Loading...</div>}
        {!loading && filtered.length === 0 && <div className="py-8 text-center text-dim text-sm">No feature requests.</div>}
        {!loading && filtered.map(r => {
          const demand = demandCount(r.id);
          const cos = getLinkedCompanies(r.id);
          return (
            <RecordCard key={r.id} onClick={() => onSelect(r.id)}>
              <CardHead title={r.title} subtitle={r.description}
                badge={<span className={`px-2 py-0.5 text-[9px] font-bold uppercase rounded ${STATUS_STYLES[r.status]}`}>{STATUS_LABELS[r.status]}</span>} />
              <ChipRow>
                <span className="inline-flex items-center px-2 py-1 text-xs font-bold rounded-lg bg-card border border-bdr text-paper">{r.priority}</span>
                {demand > 0 && <Chip icon={'\u{1F4C8}'}>{`${demand} requesting`}</Chip>}
                <Chip tone="slate" icon={'\u{1F3E2}'}>{cos}</Chip>
              </ChipRow>
              <MetaRow>
                {contactName(r.requested_by) && <span>Requested by {contactName(r.requested_by)}</span>}
                <span>Created {new Date(r.created_at).toLocaleDateString('en-GB', { day:'numeric', month:'short' })}</span>
              </MetaRow>
            </RecordCard>
          );
        })}
      </ListContainer>
    </div>
  );
}

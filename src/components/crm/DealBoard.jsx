import { useEffect, useState, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import { sumByCurrency, fmtMoney0 } from '../../lib/money';
import { handleClosedWon } from '../../lib/dealHelpers';

const STAGES = [
  { key: 'new_lead',       label: 'New Lead',       color: '#3b82f6' },
  { key: 'contacted',      label: 'Contacted',      color: '#6366f1' },
  { key: 'qualified',      label: 'Qualified',      color: '#8b5cf6' },
  { key: 'demo_booked',    label: 'Demo Booked',    color: '#a855f7' },
  { key: 'demo_done',      label: 'Demo Done',      color: '#E8743C' },
  { key: 'proposal_sent',  label: 'Proposal Sent',  color: '#C75A29' },
  { key: 'negotiation',    label: 'Negotiation',    color: '#eab308' },
  { key: 'closed_won',     label: 'Closed Won',     color: '#10b981' },
  { key: 'closed_lost',    label: 'Closed Lost',    color: '#ef4444' },
];

export default function DealBoard({ profile, onSelectDeal, onNavigate }) {
  const [deals, setDeals] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [locations, setLocations] = useState([]);
  const [associations, setAssociations] = useState([]);
  const [members, setMembers] = useState([]);
  const [dragDeal, setDragDeal] = useState(null);
  const [viewMode, setViewMode] = useState('board');
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newLocation, setNewLocation] = useState('');
  const [newCompany, setNewCompany] = useState('');
  const [newValue, setNewValue] = useState('');

  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  useEffect(() => { load(); }, []);

  const load = async () => {
    const [d, c, l, m, a] = await Promise.all([
      supabase.from('deals').select('*').order('created_at', { ascending: false }),
      supabase.from('companies').select('id, name').order('name'),
      supabase.from('locations').select('id, name, company_id').order('name'),
      supabase.from('profiles').select('id, email, display_name'),
      supabase.from('associations').select('*')
        .or('and(from_type.eq.deal,to_type.eq.location),and(from_type.eq.location,to_type.eq.deal)'),
    ]);
    setDeals(d.data || []);
    setLocations(l.data || []);
    setCompanies(c.data || []);
    setMembers(m.data || []);
    setAssociations(a.data || []);
  };

  const filtered = useMemo(() => {
    if (!search) return deals;
    const q = search.toLowerCase();
    return deals.filter(d =>
      d.name.toLowerCase().includes(q) ||
      (companies.find(c => c.id === d.company_id)?.name || '').toLowerCase().includes(q)
    );
  }, [deals, search, companies]);

  const dealsByStage = useMemo(() => {
    const map = {};
    STAGES.forEach(s => { map[s.key] = []; });
    filtered.forEach(d => { if (map[d.stage]) map[d.stage].push(d); });
    return map;
  }, [filtered]);

  const companyName = (id) => companies.find(c => c.id === id)?.name || '';
  const ownerName = (id) => {
    const m = members.find(u => u.id === id);
    return m ? (m.display_name || m.email.split('@')[0]) : '';
  };
  const dealLocation = (dealId) => {
    for (const a of associations) {
      if (a.from_type === 'deal' && a.from_id === dealId && a.to_type === 'location') return locations.find(l => l.id === a.to_id) || null;
      if (a.to_type === 'deal' && a.to_id === dealId && a.from_type === 'location') return locations.find(l => l.id === a.from_id) || null;
    }
    return null;
  };
  const fmt = (v) => v ? `\u{00A3}${Number(v).toLocaleString('en-GB', { minimumFractionDigits: 0 })}` : '';

  const moveDeal = async (dealId, fromStage, toStage) => {
    if (fromStage === toStage) return;
    const patch = { stage: toStage };
    if (toStage === 'closed_won' || toStage === 'closed_lost') {
      patch.closed_at = new Date().toISOString();
    } else {
      patch.closed_at = null;
    }
    await supabase.from('deals').update(patch).eq('id', dealId);
    // Write stage history
    await supabase.from('stage_history').insert({
      object_type: 'deal',
      object_id: dealId,
      from_stage: fromStage,
      to_stage: toStage,
      changed_by: profile.id,
    });
    // Auto-create onboarding on closed_won
    if (toStage === 'closed_won') {
      const ob = await handleClosedWon(dealId, profile.id);
      if (ob) alert('Onboarding created automatically for this deal.');
    }
    load();
  };

  const onDragStart = (e, deal) => { setDragDeal(deal); e.dataTransfer.effectAllowed = 'move'; };
  const onDragOver = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; };
  const onDrop = (e, stageKey) => {
    e.preventDefault();
    if (dragDeal && dragDeal.stage !== stageKey) moveDeal(dragDeal.id, dragDeal.stage, stageKey);
    setDragDeal(null);
  };

  // Auto-derive company when location is selected
  const handleLocationChange = (locId) => {
    setNewLocation(locId);
    if (locId) {
      const loc = locations.find(l => l.id === locId);
      if (loc) setNewCompany(loc.company_id);
    }
  };

  const create = async (e) => {
    e.preventDefault();
    if (!newName.trim()) { alert('Please enter a deal name.'); return; }
    if (!newCompany) { alert('Please select a location or a company for this deal.'); return; }
    const { data, error } = await supabase.from('deals').insert({
      name: newName.trim(),
      company_id: newCompany,
      value: newValue ? parseFloat(newValue) : null,
      owner_id: profile.id,
    }).select().single();
    if (error) { alert('Could not create deal: ' + error.message); return; }
    if (data) {
      // Write initial stage history
      await supabase.from('stage_history').insert({
        object_type: 'deal', object_id: data.id, from_stage: null, to_stage: 'new_lead', changed_by: profile.id,
      });
      // Auto-link the location if one was selected
      if (newLocation) {
        await supabase.from('associations').insert({
          from_type: 'deal', from_id: data.id, to_type: 'location', to_id: newLocation, label: 'affected_location',
        });
      }
    }
    setNewName(''); setNewLocation(''); setNewCompany(''); setNewValue(''); setShowCreate(false);
    if (data) onSelectDeal(data.id);
    else load();
  };

  const stageValue = (stageKey) => {
    return sumByCurrency(dealsByStage[stageKey] || [], d => d.value || 0);
  };

  // Never one blended figure: a $30k + £10k board is '£10,000 + $30,000'.
  const formatCurrency = (sums) => {
    if (sums == null) return '';
    if (typeof sums === 'number') return sums ? fmtMoney0(sums, 'GBP') : '';
    const parts = ['GBP', 'USD'].filter(c => sums[c]).map(c => fmtMoney0(sums[c], c));
    return parts.join(' + ');
  };

  const input = "w-full px-3 py-2 bg-card border border-bdr rounded text-sm text-paper placeholder-dim focus:outline-none focus:border-ember";
  const fld = "px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper placeholder-dim focus:outline-none focus:border-ember";

  const pipelineTotal = sumByCurrency(deals.filter(d => !['closed_won','closed_lost'].includes(d.stage)), d => d.value || 0);
  const wonTotal = sumByCurrency(deals.filter(d => d.stage === 'closed_won'), d => d.value || 0);

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-bdr flex items-center justify-between">
        <div>
          <div className="text-lg font-bold text-paper">Sales Pipeline</div>
          <div className="text-[10px] text-dim font-mono uppercase tracking-[0.18em]">
            {deals.length} deals / Pipeline {formatCurrency(pipelineTotal)} / Won {formatCurrency(wonTotal)}
          </div>
        </div>
        <div className="flex gap-2">
          <div className="flex bg-card border border-bdr rounded">
            <button onClick={() => setViewMode('board')}
              className={`px-2 py-1 text-xs ${viewMode === 'board' ? 'text-paper bg-ink-soft' : 'text-muted'}`}>Board</button>
            <button onClick={() => setViewMode('list')}
              className={`px-2 py-1 text-xs ${viewMode === 'list' ? 'text-paper bg-ink-soft' : 'text-muted'}`}>List</button>
          </div>
          {canWrite && (
            <button onClick={() => setShowCreate(true)}
              className="px-3 py-1.5 bg-ember text-ink text-sm font-semibold rounded hover:bg-ember-deep transition">
              + New deal
            </button>
          )}
        </div>
      </div>

      {showCreate && (
        <div className="px-6 py-3 border-b border-bdr max-h-[70vh] overflow-y-auto">
          <form onSubmit={create} className="flex flex-wrap gap-2 items-center">
            <input className={`${fld} flex-1 min-w-[180px]`} value={newName} onChange={e => setNewName(e.target.value)} placeholder="Deal name" autoFocus />
            <input className={`${fld} w-32`} value={newValue} onChange={e => setNewValue(e.target.value)} placeholder="Value (GBP)" type="number" step="0.01" />
            <select className={`${fld} w-60`} value={newLocation} onChange={e => handleLocationChange(e.target.value)}>
              <option value="">Select location...</option>
              {locations.map(l => {
                const co = companies.find(c => c.id === l.company_id);
                return <option key={l.id} value={l.id}>{l.name} ({co?.name || '?'})</option>;
              })}
            </select>
            {newCompany && (
              <span className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-600 flex items-center gap-1.5 shrink-0">
                {'\u{1F3E2}'} {companies.find(c => c.id === newCompany)?.name || ''}
              </span>
            )}
            {!newLocation && (
              <select className={`${fld} w-48`} value={newCompany} onChange={e => setNewCompany(e.target.value)}>
                <option value="">Or select company...</option>
                {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}
            <button type="submit" className="px-4 py-2 bg-ember text-white text-sm font-semibold rounded-xl shrink-0">Create</button>
            <button type="button" onClick={() => { setShowCreate(false); setNewLocation(''); setNewCompany(''); }}
              className="px-3 py-2 text-sm text-muted border border-bdr rounded-xl shrink-0">Cancel</button>
          </form>
        </div>
      )}

      <div className="px-6 py-2 border-b border-bdr">
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search deals..."
          className="px-3 py-1.5 bg-card border border-bdr rounded text-sm text-paper placeholder-dim focus:outline-none focus:border-ember w-64" />
      </div>

      {viewMode === 'board' ? (
        <div className="flex-1 overflow-x-auto overflow-y-hidden">
          <div className="h-full flex gap-2 px-4 py-3 min-w-max">
            {STAGES.map(stage => (
              <div key={stage.key}
                className="w-72 shrink-0 flex flex-col glass-card rounded-2xl overflow-hidden"
                onDragOver={onDragOver} onDrop={e => onDrop(e, stage.key)}>
                <div className="px-3 py-2 border-b border-bdr" style={{ borderLeftColor: stage.color, borderLeftWidth: 3 }}>
                  <div className="text-[10px] font-bold uppercase tracking-wide text-paper">{stage.label}</div>
                  <div className="text-[9px] text-dim font-mono">
                    {dealsByStage[stage.key]?.length || 0} / {formatCurrency(stageValue(stage.key))}
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto p-1.5 space-y-1.5">
                  {(dealsByStage[stage.key] || []).map(d => {
                    const loc = dealLocation(d.id);
                    return (
                      <div key={d.id}
                        draggable={canWrite}
                        onDragStart={e => onDragStart(e, d)}
                        onClick={() => onSelectDeal(d.id)}
                        className="glass-inner rounded-2xl p-4 cursor-pointer">

                        {/* Row 1: Name + Expected Close */}
                        <div className="flex items-start justify-between gap-2 mb-3">
                          <div className="text-base font-bold text-paper leading-tight">{d.name}</div>
                          {d.expected_close_date && (
                            <div className="text-right shrink-0">
                              <div className="text-[9px] font-mono font-bold uppercase tracking-wider text-dim">Expected Close Date</div>
                              <div className="text-sm text-paper font-mono">{new Date(d.expected_close_date).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })}</div>
                            </div>
                          )}
                        </div>

                        {/* Label/value rows */}
                        <table className="w-full">
                          <tbody className="text-sm">
                            <tr><td className="py-0.5 text-muted font-medium pr-4 whitespace-nowrap">Company</td><td className="py-0.5 text-paper">{companyName(d.company_id) || '--'}</td></tr>
                            {loc && <tr><td className="py-0.5 text-muted font-medium pr-4 whitespace-nowrap">Location</td><td className="py-0.5 text-paper">{loc.name}</td></tr>}
                            {d.hardware_value > 0 && <tr><td className="py-0.5 text-muted font-medium pr-4 whitespace-nowrap">Hardware</td><td className="py-0.5 text-paper font-mono">{fmt(d.hardware_value)}</td></tr>}
                            {d.services_value > 0 && <tr><td className="py-0.5 text-muted font-medium pr-4 whitespace-nowrap">Services</td><td className="py-0.5 text-paper font-mono">{fmt(d.services_value)}</td></tr>}
                            {d.saas_arr > 0 && <tr><td className="py-0.5 text-muted font-medium pr-4 whitespace-nowrap">SAAS ARR</td><td className="py-0.5 text-paper font-mono">{fmt(d.saas_arr)}</td></tr>}
                            {d.payments_arr > 0 && <tr><td className="py-0.5 text-muted font-medium pr-4 whitespace-nowrap">Payments ARR</td><td className="py-0.5 text-paper font-mono">{fmt(d.payments_arr)}</td></tr>}
                            {!d.hardware_value && !d.services_value && !d.saas_arr && !d.payments_arr && d.value > 0 && (
                              <tr><td className="py-0.5 text-muted font-medium pr-4 whitespace-nowrap">Value</td><td className="py-0.5 text-paper font-mono">{fmt(d.value)}</td></tr>
                            )}
                          </tbody>
                        </table>

                        {/* Owner avatar bottom right */}
                        {d.owner_id && (
                          <div className="flex justify-end mt-2">
                            <span className="w-7 h-7 rounded-full bg-ember text-white text-xs font-bold flex items-center justify-center shadow-sm"
                              title={ownerName(d.owner_id)}>
                              {ownerName(d.owner_id)[0]?.toUpperCase() || '?'}
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-bdr text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim">
                <th className="px-6 py-2.5 text-left">Deal</th>
                <th className="px-3 py-2.5 text-left">Company</th>
                <th className="px-3 py-2.5 text-left">Stage</th>
                <th className="px-3 py-2.5 text-right">Value</th>
                <th className="px-3 py-2.5 text-left">Owner</th>
                <th className="px-3 py-2.5 text-left">Created</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(d => (
                <tr key={d.id} onClick={() => onSelectDeal(d.id)}
                  className="border-b border-bdr hover:bg-card/50 cursor-pointer transition">
                  <td className="px-6 py-3 text-sm text-paper font-medium">{d.name}</td>
                  <td className="px-3 py-3 text-xs text-muted">{companyName(d.company_id)}</td>
                  <td className="px-3 py-3">
                    <span className="px-1.5 py-0.5 text-[9px] font-bold uppercase rounded"
                      style={{ backgroundColor: STAGES.find(s => s.key === d.stage)?.color + '30', color: STAGES.find(s => s.key === d.stage)?.color }}>
                      {STAGES.find(s => s.key === d.stage)?.label || d.stage}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-xs text-ember font-mono text-right">{d.value ? fmtMoney0(d.value, d.currency) : ''}</td>
                  <td className="px-3 py-3 text-xs text-muted">{ownerName(d.owner_id)}</td>
                  <td className="px-3 py-3 text-xs text-dim">{new Date(d.created_at).toLocaleDateString('en-GB', { day:'numeric', month:'short' })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

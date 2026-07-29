import { useEffect, useState, useMemo } from 'react';
import { supabase } from '../../lib/supabase';

const STAGES = [
  { key: 'kickoff',              label: 'Kickoff',           color: '#3b82f6' },
  { key: 'hardware_ordered',     label: 'HW Ordered',        color: '#6366f1' },
  { key: 'hardware_shipped',     label: 'HW Shipped',        color: '#8b5cf6' },
  { key: 'account_menu_config',  label: 'Config',            color: '#a855f7' },
  { key: 'staff_training',       label: 'Training',          color: '#E8743C' },
  { key: 'go_live_scheduled',    label: 'Go-Live Sched.',    color: '#C75A29' },
  { key: 'live',                 label: 'Live',              color: '#10b981' },
  { key: 'handover_to_support',  label: 'Handover',          color: '#948A7A' },
  // Parked, not progress — kept last and amber so the pipeline still reads
  // left-to-right as the happy path.
  { key: 'on_hold',              label: 'On Hold',           color: '#f59e0b' },
];

export default function OnboardingBoard({ profile, onSelectOnboarding, onNavigate }) {
  const [onboardings, setOnboardings] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [locations, setLocations] = useState([]);
  const [deals, setDeals] = useState([]);
  const [assocs, setAssocs] = useState([]);
  const [members, setMembers] = useState([]);
  const [dragItem, setDragItem] = useState(null);
  const [search, setSearch] = useState('');

  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  useEffect(() => { load(); }, []);

  const load = async () => {
    const [o, c, m, l, d, a] = await Promise.all([
      supabase.from('onboardings').select('*').order('created_at'),
      supabase.from('companies').select('id, name').order('name'),
      supabase.from('profiles').select('id, email, display_name'),
      supabase.from('locations').select('id, name, company_id'),
      supabase.from('deals').select('id, name'),
      supabase.from('associations').select('from_type, from_id, to_type, to_id').or('and(from_type.eq.deal,to_type.eq.location),and(from_type.eq.location,to_type.eq.deal)'),
    ]);
    setOnboardings(o.data || []);
    setCompanies(c.data || []);
    setMembers(m.data || []);
    setLocations(l.data || []);
    setDeals(d.data || []);
    setAssocs(a.data || []);
  };

  const dealName = (id) => deals.find(d => d.id === id)?.name || '';
  const locationName = (o) => {
    if (o.location_id) return locations.find(l => l.id === o.location_id)?.name || '';
    // derive from the deal's affected location
    if (o.deal_id) {
      const a = assocs.find(x => (x.from_type === 'deal' && x.from_id === o.deal_id && x.to_type === 'location') || (x.to_type === 'deal' && x.to_id === o.deal_id && x.from_type === 'location'));
      if (a) { const lid = a.from_type === 'location' ? a.from_id : a.to_id; return locations.find(l => l.id === lid)?.name || ''; }
    }
    // else company's first location
    const cl = locations.find(l => l.company_id === o.company_id);
    return cl?.name || '';
  };
  const fmtD = (d) => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '';
  const fmtDT = (d) => d ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';

  const byStage = useMemo(() => {
    const q = search.trim().toLowerCase();
    const match = (o) => {
      if (!q) return true;
      const co = companies.find(c => c.id === o.company_id)?.name || '';
      const loc = o.location_id ? (locations.find(l => l.id === o.location_id)?.name || '') : '';
      const m = members.find(u => u.id === o.owner_id);
      const own = m ? (m.display_name || m.email) : '';
      return [co, loc, own].some(s => s.toLowerCase().includes(q));
    };
    const map = {};
    STAGES.forEach(s => { map[s.key] = []; });
    onboardings.filter(match).forEach(o => { if (map[o.stage]) map[o.stage].push(o); });
    return map;
  }, [onboardings, search, companies, locations, members]);

  const companyName = (id) => companies.find(c => c.id === id)?.name || '';
  const ownerName = (id) => {
    const m = members.find(u => u.id === id);
    return m ? (m.display_name || m.email.split('@')[0]) : '';
  };

  const moveOnboarding = async (id, fromStage, toStage) => {
    if (fromStage === toStage) return;
    await supabase.from('onboardings').update({ stage: toStage }).eq('id', id);
    await supabase.from('stage_history').insert({
      object_type: 'onboarding', object_id: id,
      from_stage: fromStage, to_stage: toStage, changed_by: profile.id,
    });
    load();
  };

  const onDragStart = (e, item) => { setDragItem(item); e.dataTransfer.effectAllowed = 'move'; };
  const onDragOver = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; };
  const onDrop = (e, stageKey) => {
    e.preventDefault();
    if (dragItem && dragItem.stage !== stageKey) moveOnboarding(dragItem.id, dragItem.stage, stageKey);
    setDragItem(null);
  };

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-bdr flex items-center gap-4 flex-wrap">
        <div>
          <div className="text-lg font-bold text-paper">Onboarding Pipeline</div>
          <div className="text-[10px] text-dim font-mono uppercase tracking-[0.18em]">
            {onboardings.length} onboardings / {onboardings.filter(o => o.stage === 'live').length} live
          </div>
        </div>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search company, location or owner…"
          className="ml-auto w-full sm:w-72 px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper placeholder-dim focus:outline-none focus:border-ember" />
      </div>

      <div className="flex-1 overflow-x-auto overflow-y-hidden">
        <div className="h-full flex gap-2 px-4 py-3 min-w-max">
          {STAGES.map(stage => (
            <div key={stage.key}
              className="w-72 shrink-0 flex flex-col glass-card rounded-2xl overflow-hidden"
              onDragOver={onDragOver} onDrop={e => onDrop(e, stage.key)}>
              <div className="px-3 py-2 border-b border-bdr" style={{ borderLeftColor: stage.color, borderLeftWidth: 3 }}>
                <div className="text-[10px] font-bold uppercase tracking-wide text-paper">{stage.label}</div>
                <div className="text-[9px] text-dim font-mono">{byStage[stage.key]?.length || 0}</div>
              </div>
              <div className="flex-1 overflow-y-auto p-1.5 space-y-1.5">
                {(byStage[stage.key] || []).map(o => {
                  const rows = [
                    ['Company', companyName(o.company_id)],
                    ['Location', locationName(o)],
                    ['Deal', dealName(o.deal_id)],
                    ['Call', fmtDT(o.kickoff_at)],
                    ['Exp. install', fmtD(o.expected_install_date)],
                    ['Install', fmtD(o.actual_install_date)],
                    ['Go live', fmtD(o.target_go_live)],
                    ['Activation', fmtD(o.activation_date)],
                  ].filter(([, v]) => v);
                  return (
                    <div key={o.id}
                      draggable={canWrite}
                      onDragStart={e => onDragStart(e, o)}
                      onClick={() => onSelectOnboarding(o.id)}
                      className="glass-inner rounded-xl p-3 cursor-pointer">
                      <table className="w-full text-xs">
                        <tbody>
                          {rows.map(([k, v]) => (
                            <tr key={k}>
                              <td className="py-0.5 pr-3 text-dim font-mono whitespace-nowrap align-top">{k}</td>
                              <td className="py-0.5 text-paper">{v}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {o.owner_id && (
                        <div className="flex items-center gap-1.5 mt-2 pt-2 border-t border-bdr">
                          <span className="w-5 h-5 rounded-full bg-ember text-white text-[9px] font-bold flex items-center justify-center">{ownerName(o.owner_id)[0]?.toUpperCase() || '?'}</span>
                          <span className="text-[10px] text-muted">{ownerName(o.owner_id)}</span>
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
    </div>
  );
}

import { useEffect, useState, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import LocationModulesCard from './LocationModulesCard.jsx';

const STATUS_STYLES = {
  quoted: 'bg-slate-100 text-slate-600 border border-slate-200',
  included: 'bg-blue-100 text-blue-700 border border-blue-200',
  enabling: 'bg-orange-100 text-orange-700 border border-orange-200',
  live: 'bg-emerald-100 text-emerald-700 border border-emerald-200',
  disabled: 'bg-red-100 text-red-700 border border-red-200',
};

export default function ModulesPanel({ profile }) {
  const [modules, setModules] = useState([]);
  const [locations, setLocations] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [locationModules, setLocationModules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedLocation, setSelectedLocation] = useState('all');
  const [editModule, setEditModule] = useState(null);
  const [catalogueOpen, setCatalogueOpen] = useState(true);

  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  const saveModule = async (m) => {
    const name = (m.name || '').trim();
    if (!name) { alert('Module name is required'); return; }
    const row = { name, description: (m.description || '').trim() || null, icon: (m.icon || '').trim() || null, sort_order: Number(m.sort_order) || 0 };
    const { error } = m.id
      ? await supabase.from('modules').update(row).eq('id', m.id)
      : await supabase.from('modules').insert(row);
    if (error) { alert(error.message); return; }
    setEditModule(null); load();
  };

  const removeModule = async (m) => {
    if (!confirm(`Remove module "${m.name}"?\n\nThis also removes it from every location.`)) return;
    await supabase.from('location_modules').delete().eq('module_id', m.id);
    await supabase.from('modules').delete().eq('id', m.id);
    load();
  };

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    const [m, l, c, lm] = await Promise.all([
      supabase.from('modules').select('*').order('sort_order'),
      supabase.from('locations').select('id, name, company_id, status').order('name'),
      supabase.from('companies').select('id, name'),
      supabase.from('location_modules').select('*'),
    ]);
    setModules(m.data || []);
    setLocations(l.data || []);
    setCompanies(c.data || []);
    setLocationModules(lm.data || []);
    setLoading(false);
  };

  const companyName = (id) => companies.find(c => c.id === id)?.name || '';

  const moduleStats = useMemo(() => {
    const map = {};
    modules.forEach(m => {
      const lms = locationModules.filter(lm => lm.module_id === m.id);
      map[m.id] = {
        total: lms.length,
        live: lms.filter(lm => lm.status === 'live').length,
        enabling: lms.filter(lm => lm.status === 'enabling').length,
      };
    });
    return map;
  }, [modules, locationModules]);

  const filteredLM = useMemo(() => {
    if (selectedLocation === 'all') return locationModules;
    return locationModules.filter(lm => lm.location_id === selectedLocation);
  }, [locationModules, selectedLocation]);

  const getLocationModuleStatus = (locationId, moduleId) => {
    return locationModules.find(lm => lm.location_id === locationId && lm.module_id === moduleId);
  };

  // Advance a cell's status. Optimistic — patches local state instead of
  // reloading the whole page (the old load() reset scroll on every click).
  const toggleModule = async (locationId, moduleId, currentLM) => {
    if (!canWrite) return;
    if (currentLM) {
      // Cycle: quoted -> included -> enabling -> live -> disabled -> (remove)
      const cycle = ['quoted', 'included', 'enabling', 'live', 'disabled'];
      const idx = cycle.indexOf(currentLM.status);
      if (idx === cycle.length - 1) {
        setLocationModules(lms => lms.filter(x => x.id !== currentLM.id));
        await supabase.from('location_modules').delete().eq('id', currentLM.id);
      } else {
        const newStatus = cycle[idx + 1];
        const patch = { status: newStatus };
        if (newStatus === 'live') patch.enabled_at = new Date().toISOString();
        if (newStatus === 'disabled') patch.disabled_at = new Date().toISOString();
        setLocationModules(lms => lms.map(x => x.id === currentLM.id ? { ...x, ...patch } : x));
        await supabase.from('location_modules').update(patch).eq('id', currentLM.id);
      }
    } else {
      const { data } = await supabase.from('location_modules')
        .insert({ location_id: locationId, module_id: moduleId, status: 'quoted' })
        .select().single();
      if (data) setLocationModules(lms => [...lms, data]);
    }
  };

  const liveLocations = locations.filter(l => l.status === 'live' || l.status === 'onboarding');

  const label = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim";

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-bdr">
        <div className="text-lg font-bold text-paper">Product Modules</div>
        <div className="text-[10px] text-dim font-mono uppercase tracking-[0.18em]">
          {modules.length} modules / {locations.length} locations
        </div>
      </div>

      {/* Module catalogue overview — collapsible (not needed once modules are set up) */}
      <div className="px-6 py-4 border-b border-bdr">
        <div className="flex items-center mb-3 gap-2">
          <button onClick={() => setCatalogueOpen(o => !o)} className={label + ' flex items-center gap-1.5 hover:text-muted transition'}>
            <span className={`inline-block transition-transform ${catalogueOpen ? 'rotate-90' : ''}`}>{'▸'}</span>
            Module Catalogue
          </button>
          {canWrite && catalogueOpen && (
            <button onClick={() => setEditModule({ name: '', description: '', icon: '', sort_order: (modules.at(-1)?.sort_order || 0) + 1 })}
              className="ml-auto text-xs text-ember hover:text-ember-deep font-medium">+ Add module</button>
          )}
          {!catalogueOpen && <span className="ml-auto text-xs text-dim">{modules.length} modules · hidden</span>}
        </div>
        {catalogueOpen && (
        <div className="grid grid-cols-2 gap-2">
          {modules.map(m => {
            const s = moduleStats[m.id] || { total: 0, live: 0, enabling: 0 };
            return (
              <div key={m.id} className="bg-card/50 border border-bdr rounded-lg px-3 py-2 flex items-center gap-3 group">
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-paper">{m.name}</div>
                  <div className="text-xs text-dim">{m.description}</div>
                </div>
                {canWrite && (
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition shrink-0">
                    <button onClick={() => setEditModule(m)} title="Edit" className="text-dim hover:text-paper p-1">✎</button>
                    <button onClick={() => removeModule(m)} title="Remove" className="text-dim hover:text-red-600 p-1">🗑</button>
                  </div>
                )}
                <div className="text-right shrink-0">
                  <div className="text-sm text-paper font-mono">{s.live}</div>
                  <div className="text-[9px] text-dim">live</div>
                </div>
              </div>
            );
          })}
        </div>
        )}
      </div>

      {/* Location x Module matrix */}
      <div className="px-6 py-3 border-b border-bdr flex items-center gap-2">
        <div className={label}>Location enablement</div>
        <select value={selectedLocation} onChange={e => setSelectedLocation(e.target.value)}
          className="ml-auto px-2 py-1 bg-card border border-bdr rounded text-xs text-paper focus:outline-none focus:border-ember">
          <option value="all">All locations</option>
          {locations.map(l => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
      </div>

      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="px-6 py-8 text-center text-dim text-sm">Loading...</div>
        ) : selectedLocation !== 'all' ? (
          /* Single location → full manager: search to add, one-click status, bulk update */
          <div className="p-6 max-w-xl">
            <LocationModulesCard locationId={selectedLocation} canWrite={canWrite} />
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-bdr text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim">
                <th className="px-4 py-2.5 text-left sticky left-0 bg-panel z-10">Location</th>
                {modules.map(m => (
                  <th key={m.id} className="px-2 py-2.5 text-center whitespace-nowrap">
                    <div className="w-16 truncate" title={m.name}>{m.name.split(' ')[0]}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(selectedLocation === 'all' ? locations : locations.filter(l => l.id === selectedLocation)).map(loc => (
                <tr key={loc.id} className="border-b border-bdr hover:bg-card/30">
                  <td className="px-4 py-2.5 sticky left-0 bg-panel z-10">
                    <div className="text-sm font-semibold text-paper">{loc.name}</div>
                    <div className="text-[11px] text-dim">{companyName(loc.company_id)}</div>
                  </td>
                  {modules.map(mod => {
                    const lm = getLocationModuleStatus(loc.id, mod.id);
                    return (
                      <td key={mod.id} className="px-2 py-2 text-center">
                        {lm ? (
                          <button onClick={() => toggleModule(loc.id, mod.id, lm)}
                            className={`px-1.5 py-0.5 text-[8px] font-bold uppercase rounded cursor-pointer ${STATUS_STYLES[lm.status]}`}
                            title={`Click to advance status (currently: ${lm.status})`}>
                            {lm.status}
                          </button>
                        ) : (
                          canWrite ? (
                            <button onClick={() => toggleModule(loc.id, mod.id, null)}
                              className="w-5 h-5 rounded border border-bdr hover:border-ember text-dim hover:text-paper text-[10px] mx-auto flex items-center justify-center"
                              title="Enable module">+</button>
                          ) : (
                            <span className="text-dim text-[10px]">-</span>
                          )
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editModule && <ModuleModal module={editModule} onSave={saveModule} onClose={() => setEditModule(null)} />}
    </div>
  );
}

function ModuleModal({ module, onSave, onClose }) {
  const [f, setF] = useState({ name: module.name || '', description: module.description || '', icon: module.icon || '', sort_order: module.sort_order ?? 0 });
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const input = "w-full px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper focus:outline-none focus:border-ember";
  const lbl = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block";
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="glass-card rounded-2xl w-full max-w-sm" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-bdr flex items-center justify-between">
          <div className="text-base font-bold text-paper">{module.id ? 'Edit module' : 'Add module'}</div>
          <button onClick={onClose} className="text-muted hover:text-paper text-lg leading-none">×</button>
        </div>
        <div className="p-5 space-y-3">
          <div><label className={lbl}>Name</label><input className={input} value={f.name} onChange={e => set('name', e.target.value)} autoFocus placeholder="e.g. Loyalty" /></div>
          <div><label className={lbl}>Description</label><input className={input} value={f.description} onChange={e => set('description', e.target.value)} placeholder="What this module does" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={lbl}>Icon (emoji, optional)</label><input className={input} value={f.icon} onChange={e => set('icon', e.target.value)} placeholder="🎁" /></div>
            <div><label className={lbl}>Sort order</label><input type="number" className={input} value={f.sort_order} onChange={e => set('sort_order', e.target.value)} /></div>
          </div>
          <div className="flex gap-2 pt-1">
            <button onClick={() => onSave({ ...module, ...f })} className="btn-glass px-5 py-2 rounded-xl text-sm font-semibold">Save</button>
            <button onClick={onClose} className="btn-ghost px-4 py-2 rounded-xl text-sm">Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}

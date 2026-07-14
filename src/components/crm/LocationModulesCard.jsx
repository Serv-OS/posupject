import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';

// Manage a location's product modules in place. Self-contained + optimistic:
// adds, status changes and bulk updates all write to the DB and patch local
// state directly, so the surrounding Location page never reloads (the old flow
// cycled status one click at a time and re-fetched the whole page each click).
const STATUSES = ['quoted', 'included', 'enabling', 'live', 'disabled'];
const STATUS_STYLE = {
  quoted: 'bg-slate-100 text-slate-600 border border-slate-200',
  included: 'bg-blue-100 text-blue-700 border border-blue-200',
  enabling: 'bg-orange-100 text-orange-700 border border-orange-200',
  live: 'bg-emerald-100 text-emerald-700 border border-emerald-200',
  disabled: 'bg-red-100 text-red-700 border border-red-200',
};
const stamp = (status) => {
  const p = { status };
  if (status === 'live') p.enabled_at = new Date().toISOString();
  if (status === 'disabled') p.disabled_at = new Date().toISOString();
  return p;
};

export default function LocationModulesCard({ locationId, canWrite }) {
  const [catalogue, setCatalogue] = useState([]);   // modules table (all available)
  const [rows, setRows] = useState([]);             // location_modules for this location
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);    // the add "catalogue" — hidden by default
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(() => new Set());  // selected location_module ids (bulk)
  const [bulkStatus, setBulkStatus] = useState('live');

  useEffect(() => { load(); }, [locationId]);

  const load = async () => {
    setLoading(true);
    const [c, lm] = await Promise.all([
      supabase.from('modules').select('*').order('sort_order'),
      supabase.from('location_modules').select('*').eq('location_id', locationId),
    ]);
    setCatalogue(c.data || []);
    setRows(lm.data || []);
    setLoading(false);
  };

  const modName = (id) => catalogue.find(m => m.id === id)?.name || 'Unknown';

  // Catalogue modules not yet on this location, filtered by the search box.
  const available = useMemo(() => {
    const added = new Set(rows.map(r => r.module_id));
    const q = query.trim().toLowerCase();
    return catalogue
      .filter(m => !added.has(m.id))
      .filter(m => !q || m.name.toLowerCase().includes(q) || (m.description || '').toLowerCase().includes(q));
  }, [catalogue, rows, query]);

  // Enabled rows shown in catalogue order for a stable list.
  const orderedRows = useMemo(() => {
    const ord = new Map(catalogue.map((m, i) => [m.id, i]));
    return [...rows].sort((a, b) => (ord.get(a.module_id) ?? 999) - (ord.get(b.module_id) ?? 999));
  }, [rows, catalogue]);

  const addModule = async (moduleId) => {
    if (!canWrite) return;
    const { data, error } = await supabase.from('location_modules')
      .insert({ location_id: locationId, module_id: moduleId, status: 'quoted' })
      .select().single();
    if (error) { alert('Could not add: ' + error.message); return; }
    setRows(rs => [...rs, data]);
    setQuery('');
  };

  const setStatus = async (row, status) => {
    if (!canWrite || row.status === status) return;
    const patch = stamp(status);
    setRows(rs => rs.map(r => r.id === row.id ? { ...r, ...patch } : r));   // optimistic
    const { error } = await supabase.from('location_modules').update(patch).eq('id', row.id);
    if (error) { alert('Update failed: ' + error.message); load(); }
  };

  const removeModule = async (row) => {
    if (!canWrite) return;
    setRows(rs => rs.filter(r => r.id !== row.id));
    setSel(s => { const n = new Set(s); n.delete(row.id); return n; });
    const { error } = await supabase.from('location_modules').delete().eq('id', row.id);
    if (error) { alert('Remove failed: ' + error.message); load(); }
  };

  const toggleSel = (id) => setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allSelected = rows.length > 0 && sel.size === rows.length;
  const toggleSelAll = () => setSel(allSelected ? new Set() : new Set(rows.map(r => r.id)));

  // Set the same status on every selected module in one request.
  const bulkApply = async () => {
    if (!canWrite || sel.size === 0) return;
    const ids = [...sel];
    const patch = stamp(bulkStatus);
    setRows(rs => rs.map(r => sel.has(r.id) ? { ...r, ...patch } : r));     // optimistic
    const { error } = await supabase.from('location_modules').update(patch).in('id', ids);
    if (error) { alert('Bulk update failed: ' + error.message); load(); }
    setSel(new Set());
  };

  return (
    <div className="glass-card rounded-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-bdr flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-bold text-paper">Modules</h3>
          <span className="text-xs text-dim font-mono">({rows.length})</span>
        </div>
        {canWrite && (
          <button onClick={() => setShowAdd(v => !v)} className="text-xs text-ember hover:text-ember-deep font-medium">
            {showAdd ? 'Hide catalogue' : '+ Add'}
          </button>
        )}
      </div>
      <div className="p-4 space-y-2">
        {/* Add picker — the searchable catalogue, hidden until "+ Add" */}
        {showAdd && canWrite && (
          <div className="mb-1 border border-bdr rounded-xl p-2 bg-card/40">
            <input value={query} onChange={e => setQuery(e.target.value)} autoFocus
              placeholder="Search modules to add…"
              className="w-full px-3 py-2 bg-card border border-bdr rounded-lg text-sm text-paper placeholder-dim focus:outline-none focus:border-ember mb-2" />
            <div className="max-h-48 overflow-y-auto space-y-1">
              {available.length === 0 ? (
                <div className="text-xs text-dim italic py-2 text-center">
                  {catalogue.length && catalogue.length === rows.length ? 'All modules added' : 'No matches'}
                </div>
              ) : available.map(m => (
                <button key={m.id} onClick={() => addModule(m.id)}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left hover:bg-ember/10 transition">
                  {m.icon && <span className="shrink-0">{m.icon}</span>}
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm text-paper truncate">{m.name}</span>
                    {m.description && <span className="block text-[11px] text-dim truncate">{m.description}</span>}
                  </span>
                  <span className="text-ember text-sm shrink-0">+</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Bulk action bar — appears when rows are selected */}
        {canWrite && sel.size > 0 && (
          <div className="flex items-center gap-2 px-2.5 py-2 bg-ember/10 border border-ember/25 rounded-lg text-xs">
            <span className="text-ember-deep font-semibold whitespace-nowrap">{sel.size} selected</span>
            <select value={bulkStatus} onChange={e => setBulkStatus(e.target.value)}
              className="ml-auto px-2 py-1 bg-card border border-bdr rounded text-paper focus:outline-none focus:border-ember">
              {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <button onClick={bulkApply} className="px-2.5 py-1 bg-ember text-white rounded font-semibold shrink-0">Apply</button>
            <button onClick={() => setSel(new Set())} className="text-dim hover:text-paper shrink-0">Clear</button>
          </div>
        )}

        {/* Enabled modules */}
        {loading ? (
          <div className="text-xs text-dim italic py-3 text-center">Loading…</div>
        ) : orderedRows.length === 0 ? (
          <div className="text-xs text-dim italic py-3 text-center">No modules enabled</div>
        ) : (
          <div className="space-y-1.5">
            {canWrite && orderedRows.length > 1 && (
              <label className="flex items-center gap-2 px-1 text-[11px] text-dim cursor-pointer select-none">
                <input type="checkbox" checked={allSelected} onChange={toggleSelAll} className="accent-ember" />
                Select all
              </label>
            )}
            {orderedRows.map(row => (
              <div key={row.id} className="flex items-center gap-2 py-1.5 px-3 bg-ink-soft border border-bdr rounded-lg">
                {canWrite && (
                  <input type="checkbox" checked={sel.has(row.id)} onChange={() => toggleSel(row.id)} className="accent-ember shrink-0" />
                )}
                <span className="text-sm text-paper flex-1 min-w-0 truncate">{modName(row.module_id)}</span>
                {canWrite ? (
                  <select value={row.status} onChange={e => setStatus(row, e.target.value)}
                    className={`px-2 py-0.5 text-[10px] font-bold uppercase rounded focus:outline-none cursor-pointer ${STATUS_STYLE[row.status] || ''}`}>
                    {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                ) : (
                  <span className={`px-2 py-0.5 text-[10px] font-bold uppercase rounded ${STATUS_STYLE[row.status] || ''}`}>{row.status}</span>
                )}
                {canWrite && (
                  <button onClick={() => removeModule(row)} title="Remove module"
                    className="text-dim hover:text-red-600 shrink-0 leading-none text-base">×</button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';

export default function AssociationManager({ subjectType, subjectId, targetType, profile, onNavigate }) {
  const [associations, setAssociations] = useState([]);
  const [targets, setTargets] = useState([]);
  const [roles, setRoles] = useState([]);
  const [adding, setAdding] = useState(false);
  const [selectedTarget, setSelectedTarget] = useState('');
  const [selectedRole, setSelectedRole] = useState('');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState([]);

  const canWrite = profile.role === 'owner' || profile.role === 'editor';
  const TARGET_TABLE = targetType === 'contact' ? 'contacts' : targetType === 'company' ? 'companies' : 'locations';

  useEffect(() => { load(); }, [subjectType, subjectId, targetType]);

  // Type-ahead: search the WHOLE target table (not just a loaded page) as you type.
  useEffect(() => {
    const q = search.replace(/[,()%*]/g, ' ').trim();
    if (!adding || selectedTarget || q.length < 1) { setResults([]); return; }
    const filter = targetType === 'contact'
      ? `first_name.ilike.%${q}%,last_name.ilike.%${q}%,email.ilike.%${q}%`
      : targetType === 'location'
        ? `name.ilike.%${q}%,city.ilike.%${q}%`
        : `name.ilike.%${q}%,domain.ilike.%${q}%`;
    const handle = setTimeout(async () => {
      const { data } = await supabase.from(TARGET_TABLE).select('*')
        .or(filter).order(targetType === 'contact' ? 'last_name' : 'name').limit(20);
      const linked = new Set(associations.map(a => a.linked_id));
      setResults((data || []).filter(t => !linked.has(t.id)));
    }, 200);
    return () => clearTimeout(handle);
  }, [search, adding, selectedTarget, targetType]);

  const load = async () => {
    // Get associations where this subject links to targetType
    const [fwd, rev] = await Promise.all([
      supabase.from('associations').select('*')
        .eq('from_type', subjectType).eq('from_id', subjectId).eq('to_type', targetType),
      supabase.from('associations').select('*')
        .eq('to_type', subjectType).eq('to_id', subjectId).eq('from_type', targetType),
    ]);

    // Merge both directions
    const all = [
      ...(fwd.data || []).map(a => ({ ...a, linked_id: a.to_id, direction: 'fwd' })),
      ...(rev.data || []).map(a => ({ ...a, linked_id: a.from_id, direction: 'rev' })),
    ];
    setAssociations(all);

    // Load roles + the names of the already-linked targets (fetched by id so they
    // always resolve, even with thousands of records). The picker uses live search.
    const linkedIds = all.map(a => a.linked_id);
    const [t, r] = await Promise.all([
      linkedIds.length
        ? supabase.from(TARGET_TABLE).select('*').in('id', linkedIds)
        : Promise.resolve({ data: [] }),
      supabase.from('association_roles').select('*').order('sort'),
    ]);
    setTargets(t.data || []);
    setRoles(r.data || []);
    if (r.data?.length && !selectedRole) setSelectedRole(r.data[0].role);
  };

  const addAssociation = async () => {
    if (!selectedTarget || !selectedRole) return;
    await supabase.from('associations').insert({
      from_type: subjectType,
      from_id: subjectId,
      to_type: targetType,
      to_id: selectedTarget,
      label: selectedRole,
    });
    setSelectedTarget(''); setSearch(''); setResults([]); setAdding(false);
    load();
  };

  const removeAssociation = async (assoc) => {
    await supabase.from('associations').delete().eq('id', assoc.id);
    load();
  };

  const getTargetName = (id) => {
    const t = targets.find(x => x.id === id);
    if (!t) return id.slice(0, 8);
    if (targetType === 'contact') return [t.first_name, t.last_name].filter(Boolean).join(' ') || t.email || 'Unknown';
    return t.name || 'Unknown';
  };

  const getTargetSub = (id) => {
    const t = targets.find(x => x.id === id);
    if (!t) return '';
    if (targetType === 'contact') return t.email || t.phone || '';
    if (targetType === 'location') return t.city || '';
    return t.domain || '';
  };

  const getRoleLabel = (role) => {
    const r = roles.find(x => x.role === role);
    return r ? r.label : role;
  };

  // Group associations by linked entity
  const grouped = {};
  associations.forEach(a => {
    if (!grouped[a.linked_id]) grouped[a.linked_id] = { id: a.linked_id, roles: [] };
    grouped[a.linked_id].roles.push(a);
  });

  const label = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim";
  const input = "w-full px-3 py-2 bg-card border border-bdr rounded text-sm text-paper focus:outline-none focus:border-ember";

  const typeLabel = targetType === 'contact' ? 'Contacts' : targetType === 'company' ? 'Companies' : 'Locations';

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className={label}>{typeLabel} ({Object.keys(grouped).length})</div>
        {canWrite && !adding && (
          <button onClick={() => { setSelectedTarget(''); setSearch(''); setResults([]); setAdding(true); }}
            className="px-2 py-1 text-xs text-ember hover:text-ember-deep">+ Link {targetType}</button>
        )}
      </div>

      {adding && (
        <div className="bg-card border border-bdr rounded-lg p-3 mb-3 space-y-2">
          {!selectedTarget ? (
            <div>
              <input autoFocus className={input} value={search} onChange={e => setSearch(e.target.value)}
                placeholder={`Search ${targetType}s by name${targetType === 'contact' ? ' or email' : ''}…`} />
              {results.length > 0 && (
                <div className="mt-1 max-h-52 overflow-y-auto border border-bdr rounded-lg divide-y divide-bdr">
                  {results.map(t => {
                    const name = targetType === 'contact'
                      ? ([t.first_name, t.last_name].filter(Boolean).join(' ') || t.email || 'Unknown')
                      : (t.name || 'Unknown');
                    const sub = targetType === 'contact' ? (t.email || t.phone || '') : (t.city || t.domain || '');
                    return (
                      <button key={t.id} type="button"
                        onClick={() => { setSelectedTarget(t.id); setSearch(name); setResults([]); }}
                        className="w-full text-left px-3 py-2 hover:bg-ember/10 transition">
                        <div className="text-sm text-paper truncate">{name}</div>
                        {sub && <div className="text-xs text-dim truncate">{sub}</div>}
                      </button>
                    );
                  })}
                </div>
              )}
              {search.trim().length >= 1 && results.length === 0 && (
                <div className="text-xs text-dim italic px-1 py-1.5">No matches — keep typing.</div>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2 px-3 py-2 bg-ember/10 border border-ember/30 rounded">
              <span className="text-sm text-paper flex-1 truncate">{search || getTargetName(selectedTarget)}</span>
              <button type="button" onClick={() => { setSelectedTarget(''); setSearch(''); }}
                className="text-xs text-dim hover:text-paper shrink-0">change</button>
            </div>
          )}
          <select className={input} value={selectedRole} onChange={e => setSelectedRole(e.target.value)}>
            {roles.map(r => <option key={r.role} value={r.role}>{r.label}</option>)}
          </select>
          <div className="flex gap-2">
            <button onClick={addAssociation} disabled={!selectedTarget}
              className="px-3 py-1.5 bg-ember text-ink text-xs font-semibold rounded disabled:opacity-50">Link</button>
            <button onClick={() => { setAdding(false); setSelectedTarget(''); setSearch(''); setResults([]); }}
              className="px-3 py-1.5 text-xs text-muted border border-bdr rounded">Cancel</button>
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        {Object.values(grouped).map(g => (
          <div key={g.id} className="flex items-center gap-2 py-2 px-3 bg-card/50 border border-bdr rounded-lg group">
            <div className="flex-1 min-w-0 cursor-pointer" onClick={() => onNavigate?.(targetType, g.id)}>
              <div className="text-sm text-paper truncate hover:text-ember transition">{getTargetName(g.id)}</div>
              <div className="text-xs text-dim truncate">{getTargetSub(g.id)}</div>
            </div>
            <div className="flex gap-1 flex-wrap shrink-0">
              {g.roles.map(r => (
                <span key={r.id} className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] bg-ember/10 text-ember border border-ember/20 rounded">
                  {getRoleLabel(r.label)}
                  {canWrite && (
                    <button onClick={() => removeAssociation(r)}
                      className="text-ember/50 hover:text-red-600 ml-0.5">&times;</button>
                  )}
                </span>
              ))}
            </div>
            {canWrite && (
              <button
                onClick={() => {
                  setSelectedTarget(g.id);
                  setAdding(true);
                }}
                className="text-dim hover:text-paper text-xs opacity-0 group-hover:opacity-100 shrink-0"
                title="Add role">+</button>
            )}
          </div>
        ))}
        {Object.keys(grouped).length === 0 && !adding && (
          <div className="text-xs text-dim italic py-3 text-center">No {typeLabel.toLowerCase()} linked.</div>
        )}
      </div>
    </div>
  );
}

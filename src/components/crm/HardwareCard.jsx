import { useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Cpu, Undo2, ArrowRightLeft, MapPin } from 'lucide-react';
import { recallToServicing, moveUnits, fmtGBP, CONDITIONS, MOVABLE } from '../../lib/inventoryOps';
import MoveUnitsDialog from '../inventory/MoveUnitsDialog';

const condLabel = (c) => (CONDITIONS.find(([k]) => k === c)?.[1]) || c || '';
const STATUS_BADGE = {
  deployed: 'bg-purple-100 text-purple-700',
  staged: 'bg-blue-100 text-blue-700',
  servicing: 'bg-orange-100 text-orange-700',
};
const SELECT = '*, company:companies(name), location:locations(name), warehouse:inv_warehouses(name)';

// Hardware booked out to a customer (company or specific location), fed live
// from the inventory module. Shows full per-unit detail; hidden when no kit.
//
// On a site page, pass the site's companyId too: kit booked to the company
// with no site is then offered here, so it can be put on the right site in
// one tap instead of staying invisible on every site page.
export default function HardwareCard({ companyId, locationId, profile, alwaysShow = false }) {
  const [rows, setRows] = useState(null);
  const [unsited, setUnsited] = useState([]);
  const [moving, setMoving] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const canWrite = profile && (profile.role === 'owner' || profile.role === 'editor');
  // Only the newest load may set state. Moving from one site page to another
  // can leave the previous site's answer arriving last, which would list (and
  // offer to move) another company's units.
  const latest = useRef(0);

  const load = async () => {
    const mine = ++latest.current;
    let q = supabase.from('inv_serials').select(SELECT).in('status', ['deployed', 'staged', 'servicing']);
    if (locationId) q = q.eq('location_id', locationId);
    else if (companyId) q = q.eq('company_id', companyId);
    else { setRows([]); setUnsited([]); return; }
    const [main, loose] = await Promise.all([
      q.order('deployed_at', { ascending: false, nullsFirst: false }),
      locationId && companyId
        ? supabase.from('inv_serials').select(SELECT).eq('company_id', companyId).is('location_id', null)
          .in('status', MOVABLE).order('deployed_at', { ascending: false, nullsFirst: false })
        : Promise.resolve({ data: [] }),
    ]);
    if (mine !== latest.current) return;
    setRows(main.data || []);
    setUnsited(loose.data || []);
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [companyId, locationId]);

  if (!rows) return null;
  if (rows.length === 0 && unsited.length === 0 && !alwaysShow) return null;

  const value = rows.reduce((s, r) => s + (Number(r.cost) || 0), 0);
  const groups = {};
  rows.forEach(r => { (groups[r.product_name] = groups[r.product_name] || []).push(r); });
  const by = () => ({ byName: profile.display_name || profile.email, actorId: profile.id });

  const doRecall = async (r) => {
    if (!confirm(`Recall ${r.serial} for servicing?`)) return;
    try {
      const { data: wh } = await supabase.from('inv_warehouses').select('id').limit(1);
      await recallToServicing({ serial: r.serial, warehouse: wh?.[0]?.id, ...by() });
      load();
    } catch (e) { alert(e.message); }
  };

  // Put the company's unsited kit on this site. Each unit keeps its own ref.
  const assignHere = async (units) => {
    if (busy) return;
    if (units.length > 1 && !confirm(`Put ${units.length} units on this site?`)) return;
    setBusy(true); setError('');
    try {
      // Only units still with no site: one another page has just put on a
      // site stays where it was put.
      await moveUnits({
        serials: units.map(u => u.serial), companyId, locationId, ...by(),
        expected: Object.fromEntries(units.map(u => [u.serial, { company_id: u.company_id, location_id: null }])),
      });
    } catch (e) { setError(e.message); }
    setBusy(false);
    load();
  };

  const unitLine = (u, { showSite }) => (
    <div key={u.serial} className="flex items-center gap-2 text-xs flex-wrap">
      <span className="font-mono text-paper">{u.serial}</span>
      {u.status !== 'deployed' && (
        <span className={`text-[9px] font-bold uppercase px-1 py-0.5 rounded ${STATUS_BADGE[u.status]}`}>{u.status}</span>
      )}
      {u.condition && <span className="text-amber-600">{condLabel(u.condition)}</span>}
      {u.used && <span className="text-[9px] font-bold uppercase px-1 py-0.5 rounded bg-slate-200 text-slate-600">used</span>}
      <span className="text-dim">
        {u.deployed_at ? `installed ${new Date(u.deployed_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })}` : 'staged'}
        {u.dispatch_ref ? ` · ref ${u.dispatch_ref}` : ''}
        {showSite && u.location?.name ? ` · ${u.location.name}` : ''}
      </span>
      {showSite && !u.location_id && MOVABLE.includes(u.status) && (
        <span className="text-[9px] font-bold uppercase px-1 py-0.5 rounded bg-amber-100 text-amber-700">no site</span>
      )}
      {u.cost != null && <span className="text-dim ml-auto tabular-nums">{fmtGBP(u.cost)}</span>}
      {canWrite && MOVABLE.includes(u.status) && (
        <button onClick={() => setMoving([u])} title="Move to another site or company" aria-label={`Move ${u.serial}`}
          className={`text-dim hover:text-ember ${u.cost != null ? '' : 'ml-auto'}`}><ArrowRightLeft size={13} /></button>
      )}
      {canWrite && u.status === 'deployed' && (
        <button onClick={() => doRecall(u)} title="Recall for servicing" aria-label={`Recall ${u.serial}`}
          className="text-dim hover:text-ember"><Undo2 size={13} /></button>
      )}
    </div>
  );

  return (
    <div className="glass-card rounded-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-bdr flex items-center gap-2">
        <Cpu size={15} className="text-ember" />
        <h3 className="text-sm font-bold text-paper">Hardware on site</h3>
        <span className="text-xs text-dim font-mono">({rows.length})</span>
        {value > 0 && <span className="ml-auto text-xs text-muted">{fmtGBP(value)} value</span>}
      </div>
      {rows.length === 0 && unsited.length === 0 && (
        <div className="p-4 text-xs text-dim italic">
          No hardware on site yet. Book kit out to this location from <b>Inventory → Stock Out</b> and it will appear here with serials, install dates and value.
        </div>
      )}
      <div className="divide-y divide-bdr">
        {Object.entries(groups).map(([product, units]) => (
          <div key={product} className="px-4 py-3">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-sm font-semibold text-paper">{product}</span>
              <span className="text-xs text-dim">× {units.length}</span>
              {units[0].category && <span className="text-[10px] text-dim">· {units[0].category}</span>}
            </div>
            <div className="space-y-1">
              {units.map(u => unitLine(u, { showSite: !locationId }))}
            </div>
          </div>
        ))}
      </div>

      {unsited.length > 0 && (
        <div className="px-4 py-3 border-t border-bdr bg-amber-50/60 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <MapPin size={13} className="text-amber-700" />
            <span className="text-xs font-semibold text-amber-800">
              {unsited.length} unit{unsited.length === 1 ? '' : 's'} for this company {unsited.length === 1 ? 'has' : 'have'} no site
            </span>
            {canWrite && (
              <button onClick={() => assignHere(unsited)} disabled={busy}
                className="ml-auto px-3 py-1.5 rounded-xl bg-amber-100 text-amber-800 border border-amber-200 text-xs font-semibold hover:bg-amber-200 disabled:opacity-50">
                {busy ? 'Moving…' : unsited.length === 1 ? 'Put it on this site' : 'Put all on this site'}
              </button>
            )}
          </div>
          <div className="space-y-1">
            {unsited.map(u => (
              <div key={u.serial} className="flex items-center gap-2 text-xs flex-wrap">
                <span className="font-mono text-paper">{u.serial}</span>
                <span className="text-muted">{u.product_name}</span>
                {u.dispatch_ref && <span className="text-dim">· ref {u.dispatch_ref}</span>}
                {canWrite && (
                  <button onClick={() => assignHere([u])} disabled={busy}
                    className="ml-auto px-2.5 py-1.5 min-h-[32px] rounded-lg text-[11px] font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-50">This site</button>
                )}
              </div>
            ))}
          </div>
          {error && <div className="text-xs text-red-600" role="alert">{error}</div>}
        </div>
      )}

      {moving && (
        <MoveUnitsDialog units={moving} profile={profile} onClose={() => setMoving(null)}
          onMoved={() => { setMoving(null); load(); }} onRefresh={load} />
      )}
    </div>
  );
}

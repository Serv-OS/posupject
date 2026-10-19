import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRightLeft, X } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { moveUnits, whereLabel, missingSite } from '../../lib/inventoryOps';
import TargetPicker from './TargetPicker';

const field = 'w-full r-field !text-[16px] sm:!text-sm disabled:opacity-60';
const label = 'text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block';

// The one value every unit shares, or undefined when they differ.
const shared = (rows, pick) => {
  const vals = [...new Set(rows.map(pick))];
  return vals.length === 1 ? vals[0] : undefined;
};

/**
 * Move kit that is out with a customer to another company or site, one unit
 * or many. `units` are inv_serials rows with company:companies(name) and
 * location:locations(name) embedded.
 */
export default function MoveUnitsDialog({ units, profile, onClose, onMoved, onRefresh }) {
  const [companies, setCompanies] = useState([]);
  const [locations, setLocations] = useState([]);
  const [companyId, setCompanyId] = useState(shared(units, u => u.company_id || '') ?? '');
  const [locationId, setLocationId] = useState(shared(units, u => u.location_id || '') ?? '');
  // Units on different sites open on "No site". Saving that untouched would
  // take every one of them off its site, so a mixed set needs a real pick.
  const mixedSites = shared(units, u => u.location_id || '') === undefined;
  const [touched, setTouched] = useState(false);
  // One shared ref is shown and can be edited or cleared. Mixed refs start
  // blank, and blank then means "keep each unit's own".
  const sameRef = shared(units, u => u.dispatch_ref || '');
  const [ref, setRef] = useState(sameRef ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let live = true;
    (async () => {
      const [c, l] = await Promise.all([
        supabase.from('companies').select('id, name').order('name'),
        supabase.from('locations').select('id, name, company_id').order('name'),
      ]);
      if (!live) return;
      if (c.error || l.error) setLoadError('Could not load the customer list. Close and try again.');
      setCompanies(c.data || []); setLocations(l.data || []);
    })();
    return () => { live = false; };
  }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const keepRefs = sameRef === undefined && !ref.trim();
  const refToSave = keepRefs ? undefined : ref;
  const unchanged = units.every(u =>
    (u.company_id || '') === companyId && (u.location_id || '') === locationId
    && (refToSave === undefined || (u.dispatch_ref || '') === ref.trim()));
  const noTarget = !companyId && !locationId;
  const needsPick = mixedSites && !touched;
  const froms = [...new Set(units.map(whereLabel))];
  const n = units.length;

  const save = async () => {
    setBusy(true); setError('');
    try {
      await moveUnits({
        serials: units.map(u => u.serial), companyId, locationId, ref: refToSave,
        expected: Object.fromEntries(units.map(u => [u.serial, { company_id: u.company_id, location_id: u.location_id }])),
        byName: profile?.display_name || profile?.email, actorId: profile?.id,
      });
      onMoved?.(n);
    } catch (e) {
      setError(e.message || 'The move did not save.');
      setBusy(false);
      if (e.moved?.length) onRefresh?.(); // some did move: the list behind must show it
    }
  };

  const title = `Move ${n} unit${n === 1 ? '' : 's'}`;
  return createPortal(
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-stretch sm:items-center justify-center sm:p-6"
      onClick={(e) => e.target === e.currentTarget && !busy && onClose?.()}>
      <div role="dialog" aria-modal="true" aria-label={title} style={{ background: 'var(--scene)' }}
        className="sm:rounded-2xl shadow-2xl w-full sm:max-w-lg flex flex-col max-h-full sm:max-h-[92vh] min-h-0">

        <div className="px-4 sm:px-5 py-3 border-b border-bdr flex items-center gap-3 shrink-0">
          <ArrowRightLeft size={18} className="text-ember shrink-0" />
          <div className="min-w-0">
            <div className="text-base font-bold text-paper truncate">{title}</div>
            <div className="text-[11px] text-muted truncate">Now at {froms.join('; ')}</div>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close"
            className="ml-auto w-10 h-10 shrink-0 rounded-xl text-muted hover:text-paper hover:bg-card flex items-center justify-center disabled:opacity-50"><X size={18} /></button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-5 py-4 space-y-4">
          <div className="flex flex-wrap gap-1">
            {units.slice(0, 12).map(u => (
              <span key={u.serial} className="px-1.5 py-0.5 rounded bg-card font-mono text-[11px] text-muted">
                {u.serial} <span className="text-dim font-sans">· {u.product_name}</span>
              </span>
            ))}
            {n > 12 && <span className="px-1.5 py-0.5 text-[11px] text-dim">+{n - 12} more</span>}
          </div>

          {loadError && <div className="text-xs text-red-600 font-semibold" role="alert">{loadError}</div>}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <TargetPicker companies={companies} locations={locations} companyId={companyId} locationId={locationId}
              inputClass={field} labelClass={label} disabled={busy}
              onChange={({ companyId: c, locationId: l }) => { setCompanyId(c); setLocationId(l); setTouched(true); setError(''); }} />
          </div>
          {needsPick && (
            <div className="text-xs text-muted bg-card border border-bdr rounded-xl px-3 py-2">
              These units are on different sites. Pick where they are all going.
            </div>
          )}
          {!needsPick && missingSite(locations, companyId, locationId) && (
            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
              No site picked. This kit will show on the company but not on any of its sites.
            </div>
          )}

          <div>
            <label className={label} htmlFor="move-ref">Ref (job / order #)</label>
            <input id="move-ref" className={field} value={ref} disabled={busy} autoComplete="off"
              onChange={e => { setRef(e.target.value); setError(''); }}
              placeholder={sameRef === undefined ? "Leave blank to keep each unit's own ref" : 'Optional reference'} />
          </div>

          {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-3 py-2" role="alert">{error}</div>}
        </div>

        <div className="px-4 sm:px-5 pt-3 border-t border-bdr flex items-center gap-2 shrink-0"
          style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
          <div className="text-[11px] text-dim mr-auto">The install date stays the same. History records the move.</div>
          <button type="button" onClick={onClose} disabled={busy} className="btn-ghost px-4 py-2 rounded-xl text-sm">Cancel</button>
          <button type="button" onClick={save} disabled={busy || unchanged || noTarget || needsPick}
            className="btn-glass px-5 py-2 rounded-xl text-sm font-semibold disabled:opacity-50">
            {busy ? 'Moving…' : 'Move'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

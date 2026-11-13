import { useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { PackageMinus, CheckCircle2, XCircle } from 'lucide-react';
import { parseSerials, stockOut, stageUnits, missingSite, notMoved } from '../../lib/inventoryOps';
import TargetPicker from './TargetPicker';
import { bundleParts, bundleScan } from '../../lib/catalogue';

const input = "w-full px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper placeholder-dim focus:outline-none focus:border-ember";
const label = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block";

export default function StockOutView({ profile, onNavigate }) {
  const [companies, setCompanies] = useState([]);
  const [locations, setLocations] = useState([]);
  const [inStock, setInStock] = useState([]);
  const [staged, setStaged] = useState([]);
  const [companyId, setCompanyId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [ref, setRef] = useState('');
  const [serialText, setSerialText] = useState('');
  // Sending out a bundle (e.g. Kiosk - Counter mounted): scan each part.
  const [bundles, setBundles] = useState([]);
  const [bundleRows, setBundleRows] = useState([]);
  const [partProducts, setPartProducts] = useState([]);
  const [bundleId, setBundleId] = useState('');
  const [region, setRegion] = useState('GBP');
  const [mode, setMode] = useState('dispatch'); // dispatch | stage
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const working = useRef(false); // set at once, before React redraws
  const canWrite = profile?.role === 'owner' || profile?.role === 'editor';
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  useEffect(() => { load(); }, []);
  const load = async () => {
    const [c, l, s, st, pr, br] = await Promise.all([
      supabase.from('companies').select('id, name').order('name'),
      supabase.from('locations').select('id, name, company_id').order('name'),
      supabase.from('inv_serials').select('serial, product_id, product_name, status').in('status', ['in_stock']),
      supabase.from('inv_serials').select('*, company:companies(name), location:locations(name)').eq('status', 'staged').order('updated_at', { ascending: false }),
      supabase.from('products').select('id, name, is_bundle, track_inventory').order('name'),
      supabase.from('product_bundle_items').select('bundle_id, component_id, region, qty, sort'),
    ]);
    setPartProducts(pr.data || []); setBundles((pr.data || []).filter(p => p.is_bundle)); setBundleRows(br.data || []);
    setCompanies(c.data || []); setLocations(l.data || []); setInStock(s.data || []); setStaged(st.data || []);
  };

  const serials = parseSerials(serialText);
  const stockSet = new Set(inStock.map(r => r.serial));
  const invalid = serials.filter(s => !stockSet.has(s));
  const bundle = bundles.find(b => b.id === bundleId) || null;
  const regions = bundle ? ['GBP', 'USD'].filter(r => bundleRows.some(x => x.bundle_id === bundle.id && x.region === r)) : [];
  const bRegion = regions.includes(region) ? region : regions[0] || 'GBP';
  const unitBySerial = new Map(inStock.map(r => [r.serial, r]));
  const scan = bundle ? bundleScan(bundleParts(bundle.id, bundleRows, partProducts, bRegion), serials.filter(x => unitBySerial.has(x)).map(x => unitBySerial.get(x))) : null;

  const submit = async () => {
    if (working.current) return;
    working.current = true; setSaving(true); setError(''); setDone('');
    try {
      if (!serials.length) throw new Error('Enter at least one serial number.');
      if (invalid.length) throw new Error('Not in stock: ' + invalid.join(', '));
      if (scan && !scan.complete) throw new Error(`The ${bundle.name} is not complete yet: scan every part, and nothing else.`);
      // A bundle's parts go out together under one reference.
      const useRef = ref || (bundle ? bundle.name : '');
      if (mode === 'dispatch') {
        await stockOut({ serials, companyId, locationId, customerName, ref: useRef, byName: profile.display_name || profile.email, actorId: profile.id });
        setDone(`Dispatched ${serials.length} unit${serials.length !== 1 ? 's' : ''}.`);
      } else {
        await stageUnits({ serials, companyId, locationId, customerName, ref: useRef });
        setDone(`Staged ${serials.length} unit${serials.length !== 1 ? 's' : ''} for deployment.`);
      }
      setSerialText(''); setRef(''); setBundleId('');
    } catch (e) { setError(e.message); }
    working.current = false; setSaving(false);
    load(); // a partial dispatch changed some units, so the lists must catch up
  };

  // Staged units go out straight from 'staged'. They are never put back to
  // in_stock first: that is what let a double click dispatch them twice.
  const confirmStaged = async (rows) => {
    if (working.current) return;
    working.current = true; setConfirming(true); setError(''); setDone('');
    try {
      const byRef = {};
      rows.forEach(r => { (byRef[r.dispatch_ref || ''] = byRef[r.dispatch_ref || ''] || []).push(r); });
      for (const rs of Object.values(byRef)) {
        const r0 = rs[0];
        await stockOut({
          serials: rs.map(r => r.serial), companyId: r0.company_id, locationId: r0.location_id,
          customerName: r0.customer_name, ref: r0.dispatch_ref, from: ['staged'],
          byName: profile.display_name || profile.email, actorId: profile.id,
        });
      }
      setDone(`Confirmed ${rows.length} deployment${rows.length !== 1 ? 's' : ''}.`);
    } catch (e) { setError(e.message); }
    working.current = false; setConfirming(false);
    load();
  };

  const cancelStaged = async (rows) => {
    if (working.current) return;
    working.current = true; setConfirming(true); setError('');
    const list = rows.map(r => r.serial);
    const { data: back, error: err } = await supabase.from('inv_serials').update({
      status: 'in_stock', company_id: null, location_id: null, customer_name: null, dispatch_ref: null,
    }).in('serial', list).eq('status', 'staged').select('serial');
    if (err) setError(err.message);
    else { const lost = notMoved(list, back, 'move'); if (lost) setError(lost.message); }
    working.current = false; setConfirming(false);
    load();
  };

  // group staged by target for display
  const stagedGroups = {};
  staged.forEach(r => {
    const key = `${r.company_id || ''}|${r.location_id || ''}|${r.customer_name || ''}`;
    (stagedGroups[key] = stagedGroups[key] || []).push(r);
  });

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-5 border-b border-bdr flex items-center gap-2.5">
        <PackageMinus size={20} className="text-ember" />
        <div>
          <div className="text-xl font-bold text-paper">Stock Out</div>
          <div className="text-xs text-muted">Dispatch serials to a customer — or stage kit for a later install</div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-[900px] mx-auto space-y-5">
          <div className="glass-card rounded-2xl p-5 space-y-4">
            <div className="flex gap-1 bg-card rounded-xl p-0.5 w-fit">
              <button onClick={() => setMode('dispatch')} className={`px-4 py-1.5 rounded-lg text-xs font-semibold ${mode === 'dispatch' ? 'bg-ember text-white' : 'text-muted'}`}>Dispatch now</button>
              <button onClick={() => setMode('stage')} className={`px-4 py-1.5 rounded-lg text-xs font-semibold ${mode === 'stage' ? 'bg-ember text-white' : 'text-muted'}`}>Stage for deployment</button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <TargetPicker companies={companies} locations={locations} companyId={companyId} locationId={locationId}
                inputClass={input} labelClass={label} freeText
                onChange={({ companyId: c, locationId: l }) => { setCompanyId(c); setLocationId(l); }} />
              <div><label className={label}>Ref (job / order #)</label>
                <input className={input} value={ref} onChange={e => setRef(e.target.value)} placeholder="Optional reference" /></div>
            </div>
            {missingSite(locations, companyId, locationId) && (
              <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                No site picked. This kit will show on the company but not on any of its sites.
              </div>
            )}
            {!companyId && !locationId && (
              <div><label className={label}>Customer name (free text fallback)</label>
                <input className={input} value={customerName} onChange={e => setCustomerName(e.target.value)} placeholder="One-off customer not in the CRM" /></div>
            )}

            {bundles.length > 0 && (
              <div className="glass-inner rounded-xl p-3 space-y-2">
                <div className="flex flex-wrap items-end gap-3">
                  <div className="flex-1 min-w-[220px]"><label className={label}>Sending a bundle? (optional)</label>
                    <select className={input} value={bundleId} onChange={e => setBundleId(e.target.value)}>
                      <option value="">No, single items</option>
                      {bundles.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </select></div>
                  {regions.length > 1 && (
                    <div className="flex gap-1 bg-card rounded-xl p-0.5">
                      {regions.map(r => <button key={r} onClick={() => setRegion(r)} className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${bRegion === r ? 'bg-ember text-white' : 'text-muted'}`}>{r === 'GBP' ? 'UK parts' : 'US parts'}</button>)}
                    </div>
                  )}
                </div>
                {scan && (scan.parts.length ? (
                  <div className="space-y-1">
                    {scan.parts.map(p => (
                      <div key={p.name} className="flex items-center gap-2 text-sm">
                        <span className={p.got.length === p.need ? 'text-emerald-600' : 'text-dim'}>{p.got.length === p.need ? '✓' : '○'}</span>
                        <span className="text-paper">{p.name}</span>
                        <span className="text-xs text-muted">{p.got.length} of {p.need} scanned</span>
                        {p.got.length > 0 && <span className="font-mono text-[11px] text-dim">{p.got.join(', ')}</span>}
                      </div>
                    ))}
                    {scan.extra.length > 0 && <div className="text-xs text-red-600">Not part of this bundle: {scan.extra.join(', ')}</div>}
                    {scan.complete && <div className="text-xs text-emerald-700 font-semibold">All parts scanned.</div>}
                  </div>
                ) : <div className="text-xs text-muted">None of this bundle's parts are stock tracked, so there is nothing to scan.</div>)}
              </div>
            )}

            <div>
              <label className={label}>Serial numbers ({serials.length}{invalid.length ? ` · ${invalid.length} not in stock` : ''})</label>
              <textarea className={input + ' font-mono resize-none'} rows={4} value={serialText} onChange={e => setSerialText(e.target.value)}
                placeholder="Scan or paste serials…" />
              {serials.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {serials.map(s => (
                    <span key={s} className={`px-1.5 py-0.5 rounded font-mono text-[11px] ${stockSet.has(s) ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                      {s}{!stockSet.has(s) && ' ✕'}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {!canWrite && <div className="text-xs text-muted">Your login can view stock but not dispatch it.</div>}
            <button onClick={submit} disabled={!canWrite || saving || !serials.length || (scan && !scan.complete)}
              className="btn-glass px-6 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-50">
              {saving ? 'Working…' : mode === 'dispatch' ? `Dispatch ${serials.length || ''}` : `Stage ${serials.length || ''}`}
            </button>
            {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-2">{error}</div>}
            {done && <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-2">✓ {done}</div>}
          </div>

          {/* Staged deployments */}
          {Object.keys(stagedGroups).length > 0 && (
            <div className="glass-card rounded-2xl overflow-hidden">
              <div className="px-5 py-3.5 border-b border-bdr"><h3 className="text-[13px] font-bold text-paper">Staged deployments ({staged.length})</h3></div>
              {Object.entries(stagedGroups).map(([key, rows]) => {
                const r0 = rows[0];
                const target = r0.location?.name || r0.company?.name || r0.customer_name || 'Unassigned';
                return (
                  <div key={key} className="px-5 py-3 border-b border-bdr/50 last:border-0">
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-sm font-semibold text-paper">{target}</span>
                      {r0.company?.name && r0.location?.name && <span className="text-xs text-muted">· {r0.company.name}</span>}
                      <span className="text-xs text-dim">· {rows.length} unit{rows.length !== 1 ? 's' : ''}</span>
                      {canWrite && <div className="ml-auto flex gap-2">
                        <button onClick={() => confirmStaged(rows)} disabled={confirming} className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-emerald-500/15 text-emerald-700 border border-emerald-500/30 text-xs font-semibold hover:bg-emerald-500/25 disabled:opacity-50">
                          <CheckCircle2 size={13} /> {confirming ? 'Working…' : 'Confirm dispatch'}</button>
                        <button onClick={() => cancelStaged(rows)} disabled={confirming} className="flex items-center gap-1 px-3 py-1.5 rounded-xl text-red-600 border border-red-200 text-xs font-semibold hover:bg-red-50 disabled:opacity-50">
                          <XCircle size={13} /> Unstage</button>
                      </div>}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {rows.map(r => <span key={r.serial} className="px-1.5 py-0.5 rounded bg-card font-mono text-[11px] text-muted">{r.serial} <span className="text-dim">· {r.product_name}</span></span>)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import { ClipboardCheck } from 'lucide-react';
import { parseSerials, csvExport } from '../../lib/inventoryOps';

const input = "w-full px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper placeholder-dim focus:outline-none focus:border-ember";
const label = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block";

export default function StocktakeView({ profile }) {
  const [serials, setSerials] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [takes, setTakes] = useState([]);
  const [active, setActive] = useState(null);     // in-progress stocktake row
  const [scanText, setScanText] = useState('');
  const [reviewing, setReviewing] = useState(null); // completed record view
  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  useEffect(() => { load(); }, []);
  const load = async () => {
    const [s, w, t] = await Promise.all([
      supabase.from('inv_serials').select('serial, product_name, warehouse_id, status, warehouse:inv_warehouses(name)').eq('status', 'in_stock'),
      supabase.from('inv_warehouses').select('*'),
      supabase.from('inv_stocktakes').select('*').order('started_at', { ascending: false }),
    ]);
    setSerials(s.data || []); setWarehouses(w.data || []); setTakes(t.data || []);
    const open = (t.data || []).find(x => ['in_progress', 'paused'].includes(x.status) && x.started_by === profile.id);
    if (open) { setActive(open); setScanText((open.counted || []).join('\n')); }
  };

  const [scopeWh, setScopeWh] = useState('all');
  const expected = useMemo(() =>
    serials.filter(r => scopeWh === 'all' || r.warehouse_id === scopeWh),
    [serials, scopeWh]);

  const start = async () => {
    const { data } = await supabase.from('inv_stocktakes').insert({
      status: 'in_progress',
      scope: [{ warehouse_id: scopeWh === 'all' ? null : scopeWh }],
      counted: [], started_by: profile.id,
    }).select().single();
    setActive(data); setScanText('');
  };

  const counted = parseSerials(scanText);
  const expectedSet = new Set(expected.map(r => r.serial));
  const found = counted.filter(s => expectedSet.has(s));
  const unexpected = counted.filter(s => !expectedSet.has(s));
  const missing = expected.filter(r => !counted.includes(r.serial));

  const pause = async () => {
    await supabase.from('inv_stocktakes').update({ status: 'paused', counted }).eq('id', active.id);
    setActive(null); setScanText(''); load();
  };

  const complete = async () => {
    const result = {
      expected: expected.length, found: found.length,
      missing: missing.map(r => ({ serial: r.serial, product: r.product_name, warehouse: r.warehouse?.name })),
      unexpected,
    };
    await supabase.from('inv_stocktakes').update({
      status: 'completed', counted, result, completed_at: new Date().toISOString(),
    }).eq('id', active.id);
    setActive(null); setScanText(''); load();
  };

  const writeOff = async (record, serialsToWrite) => {
    if (!confirm(`Write off ${serialsToWrite.length} missing serial${serialsToWrite.length !== 1 ? 's' : ''}? They will leave stock permanently.`)) return;
    // Only units still sitting in stock: one dispatched or moved since the
    // count is not missing, and writing it off would lose live kit.
    const { data: gone, error } = await supabase.from('inv_serials').update({ status: 'written_off' })
      .in('serial', serialsToWrite).eq('status', 'in_stock').select('serial');
    if (error) { alert(error.message); return; }
    const done = (gone || []).map(r => r.serial);
    const skipped = serialsToWrite.filter(s => !done.includes(s));
    if (skipped.length) alert(`Not written off, because they are no longer in stock: ${skipped.join(', ')}`);
    for (const s of done) {
      const m = (record.result?.missing || []).find(x => x.serial === s);
      await supabase.from('inv_movements').insert({
        type: 'writeoff', product_name: m?.product || 'Unknown', serials: [s], qty: 1,
        by_name: profile.display_name || profile.email, actor_id: profile.id,
        notes: 'Stocktake write-off',
      });
    }
    const result = { ...record.result, writtenOff: [...(record.result?.writtenOff || []), ...done] };
    await supabase.from('inv_stocktakes').update({ result }).eq('id', record.id);
    setReviewing(null); load();
  };

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-5 border-b border-bdr flex items-center gap-2.5">
        <ClipboardCheck size={20} className="text-ember" />
        <div>
          <div className="text-xl font-bold text-paper">Stocktake</div>
          <div className="text-xs text-muted">Count what's on the shelf, find variances, write off losses</div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-[1000px] mx-auto space-y-5">

          {!active ? (
            <div className="glass-card rounded-2xl p-5 flex items-end gap-3 flex-wrap">
              <div><label className={label}>Scope</label>
                <select className={input + ' !w-60'} value={scopeWh} onChange={e => setScopeWh(e.target.value)}>
                  <option value="all">All warehouses ({serials.length} serials)</option>
                  {warehouses.map(w => <option key={w.id} value={w.id}>{w.name} ({serials.filter(r => r.warehouse_id === w.id).length})</option>)}
                </select></div>
              {canWrite && <button onClick={start} className="btn-glass px-5 py-2.5 rounded-xl text-sm font-semibold">Start stocktake</button>}
              <div className="text-[11px] text-dim w-full">Counts everything currently in stock{scopeWh !== 'all' ? ' at the chosen warehouse' : ''}. You can pause and resume.</div>
            </div>
          ) : (
            <div className="glass-card rounded-2xl p-5 space-y-4">
              <div className="flex items-center gap-3">
                <span className="text-sm font-bold text-paper">Counting…</span>
                <span className="text-xs text-muted">{found.length} / {expected.length} found</span>
                {unexpected.length > 0 && <span className="text-xs text-amber-600 font-semibold">{unexpected.length} unexpected</span>}
                <div className="ml-auto flex gap-2">
                  <button onClick={pause} className="btn-ghost px-4 py-2 rounded-xl text-sm">Pause</button>
                  <button onClick={complete} className="btn-glass px-5 py-2 rounded-xl text-sm font-semibold">Complete count</button>
                </div>
              </div>
              <div className="h-2 rounded-full bg-card overflow-hidden">
                <div className="h-full bg-ember rounded-full transition-all" style={{ width: `${expected.length ? (found.length / expected.length) * 100 : 0}%` }} />
              </div>
              <div>
                <label className={label}>Scan / paste serials as you count ({counted.length} scanned)</label>
                <textarea className={input + ' font-mono resize-none'} rows={8} value={scanText} onChange={e => setScanText(e.target.value)} autoFocus placeholder="Scan barcodes here — one per line" />
              </div>
              {unexpected.length > 0 && (
                <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                  Not expected in this scope: {unexpected.join(', ')}
                </div>
              )}
            </div>
          )}

          {/* History */}
          <div className="glass-card rounded-2xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-bdr"><h3 className="text-[13px] font-bold text-paper">Stocktake history</h3></div>
            <div className="divide-y divide-bdr">
              {takes.filter(t => t.status === 'completed').map(t => {
                const r = t.result || {};
                const variance = (r.missing || []).length;
                return (
                  <button key={t.id} onClick={() => setReviewing(t)} className="w-full px-5 py-3 flex items-center gap-3 text-sm text-left hover:bg-card/40">
                    <span className="text-paper">{new Date(t.started_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                    <span className="text-muted">{r.found ?? 0}/{r.expected ?? 0} found</span>
                    {variance > 0
                      ? <span className="text-red-600 font-semibold">{variance} missing{(r.writtenOff || []).length ? ` · ${(r.writtenOff || []).length} written off` : ''}</span>
                      : <span className="text-emerald-600 font-semibold">No variance</span>}
                    {(r.unexpected || []).length > 0 && <span className="text-amber-600">{r.unexpected.length} unexpected</span>}
                  </button>
                );
              })}
              {takes.filter(t => t.status === 'completed').length === 0 && <div className="px-5 py-6 text-center text-dim text-sm italic">No completed stocktakes yet.</div>}
            </div>
          </div>
        </div>
      </div>

      {/* Review modal */}
      {reviewing && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setReviewing(null)}>
          <div className="glass-card rounded-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-bdr flex items-center justify-between">
              <div className="text-base font-bold text-paper">Stocktake — {new Date(reviewing.started_at).toLocaleDateString('en-GB')}</div>
              <button onClick={() => setReviewing(null)} className="text-muted hover:text-paper">✕</button>
            </div>
            <div className="p-5 space-y-4 text-sm">
              <div className="text-muted">{reviewing.result?.found}/{reviewing.result?.expected} found</div>
              {(reviewing.result?.missing || []).length > 0 && (
                <div>
                  <div className="flex items-center mb-2">
                    <span className={label + ' !mb-0'}>Missing ({reviewing.result.missing.length})</span>
                    <div className="ml-auto flex gap-2">
                      <button onClick={() => csvExport(reviewing.result.missing, 'stocktake-missing.csv')} className="text-xs text-ember">CSV</button>
                      {canWrite && (
                        <button onClick={() => writeOff(reviewing, reviewing.result.missing.map(m => m.serial).filter(s => !(reviewing.result.writtenOff || []).includes(s)))}
                          className="text-xs text-red-600 font-semibold">Write off all</button>
                      )}
                    </div>
                  </div>
                  <div className="space-y-1">
                    {reviewing.result.missing.map(m => (
                      <div key={m.serial} className="flex items-center gap-2 text-xs">
                        <span className="font-mono text-paper">{m.serial}</span>
                        <span className="text-muted">{m.product}</span>
                        {(reviewing.result.writtenOff || []).includes(m.serial) && <span className="text-[9px] font-bold uppercase px-1 py-0.5 rounded bg-slate-200 text-slate-600">written off</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {(reviewing.result?.unexpected || []).length > 0 && (
                <div><span className={label}>Unexpected serials</span>
                  <div className="text-xs font-mono text-muted">{reviewing.result.unexpected.join(', ')}</div></div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

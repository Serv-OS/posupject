import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { Percent, Plus, X } from 'lucide-react';
import { resolveVat, resolveAmap, resolveAfr } from '../../lib/rates.js';

const today = () => new Date().toISOString().slice(0, 10);
const fmtD = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'open';

// Field specs per rate table — drives both the list columns and the add-row modal.
const KINDS = {
  vat: { table: 'tax_rates', title: 'VAT bands', cols: ['code', 'rate'],
    fields: [['code', 'Code', 'text'], ['label', 'Label', 'text'], ['rate', 'Rate %', 'number'], ['treatment', 'Treatment', 'text']] },
  amap: { table: 'amap_rates', title: 'Mileage (AMAP)', cols: ['vehicle_type', 'tier', 'pence_per_mile'],
    fields: [['vehicle_type', 'Vehicle', 'text'], ['tier', 'Tier', 'text'], ['pence_per_mile', 'Pence/mile', 'number'], ['threshold_miles', 'Threshold miles', 'number']] },
  afr: { table: 'afr_rates', title: 'Advisory Fuel Rates', cols: ['fuel', 'engine_band', 'pence_per_mile'],
    fields: [['fuel', 'Fuel', 'text'], ['engine_band', 'Engine band', 'text'], ['pence_per_mile', 'Pence/mile', 'number']] },
};

export default function RatesPanel({ profile }) {
  const [vat, setVat] = useState([]);
  const [amap, setAmap] = useState([]);
  const [afr, setAfr] = useState([]);
  const [date, setDate] = useState(today());
  const [adding, setAdding] = useState(null); // kind key
  const isOwner = profile.role === 'owner';

  const load = useCallback(async () => {
    const [v, a, f] = await Promise.all([
      supabase.from('tax_rates').select('*').order('valid_from', { ascending: false }),
      supabase.from('amap_rates').select('*').order('valid_from', { ascending: false }),
      supabase.from('afr_rates').select('*').order('fuel').order('valid_from', { ascending: false }),
    ]);
    setVat(v.data || []); setAmap(a.data || []); setAfr(f.data || []);
  }, []);
  useEffect(() => { load(); }, [load]);

  // Resolved values for the chosen effective date
  const r = (x) => x ? `${x.pence_per_mile ?? x.rate}${x.rate != null && x.pence_per_mile == null ? '%' : 'p'}` : '—';
  const preview = [
    ['VAT standard', resolveVat(vat, 'standard', date)?.rate != null ? resolveVat(vat, 'standard', date).rate + '%' : '—'],
    ['Car/van first 10k', r(resolveAmap(amap, 'car_van', 'first_10000', date))],
    ['Car/van over 10k', r(resolveAmap(amap, 'car_van', 'above_10000', date))],
    ['Motorcycle', r(resolveAmap(amap, 'motorcycle', 'all', date))],
    ['Bicycle', r(resolveAmap(amap, 'bicycle', 'all', date))],
    ['Passenger', r(resolveAmap(amap, 'passenger', 'per_passenger', date))],
    ['Petrol ≤1400cc (AFR)', r(resolveAfr(afr, 'petrol', 'up_to_1400cc', date))],
  ];

  const rowsFor = (k) => k === 'vat' ? vat : k === 'amap' ? amap : afr;

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-5 border-b border-bdr flex items-center gap-2.5">
        <Percent size={20} className="text-ember" />
        <div>
          <div className="text-xl font-bold text-paper">Tax rates</div>
          <div className="text-xs text-muted">Date-effective VAT, mileage &amp; fuel rates — verified against GOV.UK</div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-4xl mx-auto space-y-5">
          {/* Effective-date preview */}
          <div className="glass-card rounded-2xl p-4">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="text-sm font-bold text-paper">Rate on date</div>
              <input type="date" value={date} onChange={e => setDate(e.target.value)}
                className="px-3 py-1.5 bg-card border border-bdr rounded-xl text-sm text-paper" />
              <div className="text-[11px] text-dim">Resolves the rate whose effective window contains this date.</div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3">
              {preview.map(([k, v]) => (
                <div key={k} className="glass-inner rounded-xl p-3">
                  <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-dim">{k}</div>
                  <div className="text-lg font-bold tabular-nums text-paper">{v}</div>
                </div>
              ))}
            </div>
          </div>

          {Object.entries(KINDS).map(([k, spec]) => (
            <div key={k} className="glass-card rounded-2xl overflow-hidden">
              <div className="px-5 py-3 border-b border-bdr flex items-center gap-2">
                <h3 className="text-[13px] font-bold text-paper">{spec.title}</h3>
                <span className="text-xs text-dim font-mono">({rowsFor(k).length})</span>
                {isOwner && <button onClick={() => setAdding(k)} className="ml-auto text-xs text-ember hover:text-ember-deep font-medium flex items-center gap-1"><Plus size={13} /> Add rate</button>}
              </div>
              <div className="divide-y divide-bdr/60">
                {rowsFor(k).map(row => (
                  <div key={row.id} className="px-5 py-2.5 flex items-center gap-3 text-sm">
                    <div className="flex-1 min-w-0 text-paper">{spec.cols.map(c => row[c]).filter(v => v != null).join(' · ')}</div>
                    <div className="tabular-nums font-semibold text-paper shrink-0">{k === 'vat' ? `${row.rate}%` : `${row.pence_per_mile}p`}</div>
                    <div className="text-[11px] text-dim shrink-0 w-44 text-right">{fmtD(row.valid_from)} → {fmtD(row.valid_to)}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
          <div className="text-[11px] text-dim">To handle an HMRC change, add a new row with the new <code>valid_from</code> (and set the prior row's <code>valid_to</code>). The app always picks the row whose window contains the expense/journey date. Figures are a preparation aid — verify against GOV.UK.</div>
        </div>
      </div>

      {adding && <RateModal kind={adding} spec={KINDS[adding]} onClose={() => setAdding(null)} onSaved={() => { setAdding(null); load(); }} />}
    </div>
  );
}

function RateModal({ kind, spec, onClose, onSaved }) {
  const [f, setF] = useState(() => ({ valid_from: today(), valid_to: '', source_url: '' }));
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const save = async () => {
    const row = { valid_from: f.valid_from, valid_to: f.valid_to || null, source_url: f.source_url.trim() || null };
    for (const [key, , type] of spec.fields) {
      const val = f[key];
      row[key] = type === 'number' ? (val === '' || val == null ? null : Number(val)) : (val || '').trim() || null;
    }
    const { error } = await supabase.from(spec.table).insert(row);
    if (error) { alert(error.message); return; }
    onSaved();
  };
  const input = "w-full px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper focus:outline-none focus:border-ember";
  const label = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block";
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="glass-card rounded-2xl w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-bdr flex items-center justify-between">
          <div className="text-base font-bold text-paper">Add {spec.title} rate</div>
          <button onClick={onClose} className="text-muted hover:text-paper"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-3">
          {spec.fields.map(([key, lbl, type]) => (
            <div key={key}><label className={label}>{lbl}</label>
              <input type={type} className={input} value={f[key] ?? ''} onChange={e => set(key, e.target.value)} /></div>
          ))}
          <div className="grid grid-cols-2 gap-3">
            <div><label className={label}>Valid from</label><input type="date" className={input} value={f.valid_from} onChange={e => set('valid_from', e.target.value)} /></div>
            <div><label className={label}>Valid to (blank = open)</label><input type="date" className={input} value={f.valid_to} onChange={e => set('valid_to', e.target.value)} /></div>
          </div>
          <div><label className={label}>Source URL (GOV.UK)</label><input className={input} value={f.source_url} onChange={e => set('source_url', e.target.value)} placeholder="https://www.gov.uk/…" /></div>
          <div className="flex gap-2 pt-1">
            <button onClick={save} className="btn-glass px-5 py-2 rounded-xl text-sm font-semibold">Add rate</button>
            <button onClick={onClose} className="btn-ghost px-4 py-2 rounded-xl text-sm">Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}

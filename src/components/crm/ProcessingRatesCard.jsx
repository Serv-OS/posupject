import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { CreditCard } from 'lucide-react';
import { CHANNELS, catsForChannel, rowCalc, accountSavings, marginPct, gbp0, pct2 } from './PaymentsPanel.jsx';

// Shows the card-processing rates assigned to a company or a specific location.
// Renders nothing if there's no processing account, to avoid clutter.
export default function ProcessingRatesCard({ companyId, locationId, onNavigate }) {
  const [accounts, setAccounts] = useState(null);

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [companyId, locationId]);

  const load = async () => {
    let q = supabase.from('processing_accounts').select('*, location:locations(name)');
    if (companyId) q = q.eq('company_id', companyId);          // company owns the location
    else if (locationId) q = q.eq('location_id', locationId);
    else { setAccounts([]); return; }
    let { data: accs } = await q;
    accs = accs || [];
    // On a location record: show this location's account + any company-wide one (no location set)
    if (locationId) accs = accs.filter(a => a.location_id === locationId || a.location_id == null);
    const ids = accs.map(a => a.id);
    let rates = [];
    if (ids.length) {
      const { data } = await supabase.from('processing_rates').select('*').in('account_id', ids);
      rates = data || [];
    }
    setAccounts((accs || []).map(a => ({ ...a, rates: rates.filter(x => x.account_id === a.id) })));
  };

  if (!accounts || accounts.length === 0) return null;

  return (
    <div className="glass-card rounded-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-bdr flex items-center gap-2">
        <CreditCard size={15} className="text-ember" />
        <h3 className="text-sm font-bold text-paper">Card Processing</h3>
        <span className="text-xs text-dim font-mono">({accounts.length})</span>
        {onNavigate && <button onClick={() => onNavigate('processing')} className="ml-auto text-xs text-ember hover:text-ember-deep font-medium">Open</button>}
      </div>
      <div className="divide-y divide-bdr">
        {accounts.map(a => {
          const s = accountSavings(a.rates);
          const rateFor = (key) => a.rates.find(x => x.category === key) || {};
          return (
            <div key={a.id} className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${a.status === 'live' ? 'bg-emerald-100 text-emerald-700' : a.status === 'churned' ? 'bg-slate-200 text-slate-500' : 'bg-amber-100 text-amber-700'}`}>{a.status}</span>
                {!locationId
                  ? <span className="text-xs text-muted">{a.location?.name || a.label || 'All locations'}</span>
                  : (a.location_id == null && <span className="text-xs text-muted">Company-wide</span>)}
                <span className="text-[11px] text-emerald-600 font-semibold ml-auto">{marginPct(a).toFixed(2)}% margin</span>
              </div>

              {s.vol > 0 && (
                <div className="mb-2 text-xs text-emerald-600 font-semibold">Saves {gbp0(s.saving)}/mo ({gbp0(s.savingYr)}/yr) · {pct2(s.currentEff)} → {pct2(s.ourEff)}</div>
              )}

              {CHANNELS.map(ch => {
                const cats = catsForChannel(ch.key);
                if (!cats.some(c => rateFor(c.key).our_rate_pct != null)) return null;
                return (
                  <div key={ch.key} className="space-y-1 mb-2">
                    <div className="flex text-[9px] font-mono font-bold uppercase tracking-[0.12em] text-dim">
                      <span className="flex-1">{ch.label}</span><span className="w-12 text-right">Their</span><span className="w-12 text-right">Our</span>
                    </div>
                    {cats.map(c => {
                      const r = rateFor(c.key);
                      const calc = rowCalc(r);
                      return (
                        <div key={c.key} className="flex items-center text-xs">
                          <span className="flex-1 text-paper">{c.scheme}{c.tier ? <span className="text-dim"> {c.tier}</span> : ''}</span>
                          <span className="w-12 text-right tabular-nums text-muted">{calc.vol ? pct2(calc.currentEff) : pct2(r.current_rate_pct)}</span>
                          <span className="w-12 text-right tabular-nums text-paper font-medium">{calc.vol ? pct2(calc.ourEff) : pct2(r.our_rate_pct)}</span>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

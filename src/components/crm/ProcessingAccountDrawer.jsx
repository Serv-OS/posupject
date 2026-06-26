import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { X, Pencil, Plus, Trash2, Building2, PiggyBank } from 'lucide-react';
import { AccountModal, gbp0, gbp2, pct2, marginPct, marginTxn, revenueOf, RATE_CATEGORIES, CHANNELS, catsForChannel, rowCalc, accountSavings } from './PaymentsPanel.jsx';

const thisMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const periodLabel = (p) => new Date(p).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });

export default function ProcessingAccountDrawer({ account, profile, onClose, onChanged, onNavigate, companies = [], locations = [] }) {
  const [acc, setAcc] = useState(account);
  const [volumes, setVolumes] = useState([]);
  const [adding, setAdding] = useState(false);
  const [editingAcc, setEditingAcc] = useState(false);
  const [vform, setVform] = useState({ month: thisMonth(), amount_processed: '', transactions: '', our_revenue: '' });
  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  const [rates, setRates] = useState([]);

  const loadVolumes = async () => {
    const { data } = await supabase.from('processing_volumes').select('*').eq('account_id', acc.id).order('period', { ascending: false });
    setVolumes(data || []);
  };
  const loadRates = async () => {
    const { data } = await supabase.from('processing_rates').select('*').eq('account_id', acc.id);
    setRates(data || []);
  };
  const reloadAcc = async () => {
    const { data } = await supabase.from('processing_accounts').select('*, company:companies(name), location:locations(name)').eq('id', acc.id).maybeSingle();
    if (data) setAcc(data);
    loadRates();
  };
  useEffect(() => { loadVolumes(); loadRates(); }, [acc.id]);

  const accCalc = { ...acc, rates };
  const name = acc.label || acc.location?.name || acc.company?.name || 'Account';
  const rateFor = (key) => rates.find(r => r.category === key) || {};
  const totals = accountSavings(rates);

  const addVolume = async () => {
    const amount = Number(vform.amount_processed);
    if (!amount) { alert('Enter amount processed'); return; }
    const row = {
      account_id: acc.id, period: `${vform.month}-01`,
      amount_processed: amount,
      transactions: vform.transactions === '' ? null : Number(vform.transactions),
      our_revenue: vform.our_revenue === '' ? null : Number(vform.our_revenue),
      source: 'manual',
    };
    const { error } = await supabase.from('processing_volumes').upsert(row, { onConflict: 'account_id,period' });
    if (error) { alert(error.message); return; }
    setVform({ month: thisMonth(), amount_processed: '', transactions: '', our_revenue: '' });
    setAdding(false); loadVolumes(); onChanged?.();
  };
  const delVolume = async (id) => { await supabase.from('processing_volumes').delete().eq('id', id); loadVolumes(); onChanged?.(); };

  const input = "w-full px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper focus:outline-none focus:border-ember";
  const lbl = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block";

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div className="relative w-full max-w-2xl h-full glass-card border-l border-bdr overflow-y-auto" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="px-6 py-4 border-b border-bdr flex items-center gap-3 sticky top-0 glass-card z-10">
          <div className="flex-1 min-w-0">
            <div className="text-lg font-bold text-paper truncate">{name}</div>
            <div className="text-xs text-muted flex items-center gap-2">
              <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${acc.status === 'live' ? 'bg-emerald-100 text-emerald-700' : acc.status === 'churned' ? 'bg-slate-200 text-slate-500' : 'bg-amber-100 text-amber-700'}`}>{acc.status}</span>
              {acc.company?.name && <button onClick={() => onNavigate?.('company', acc.company_id)} className="hover:text-ember flex items-center gap-1"><Building2 size={12} /> {acc.company.name}</button>}
              {acc.label && acc.location?.name && <span>· {acc.location.name}</span>}
            </div>
          </div>
          {canWrite && <button onClick={() => setEditingAcc(true)} className="btn-ghost px-3 py-1.5 rounded-xl text-xs flex items-center gap-1"><Pencil size={13} /> Edit</button>}
          <button onClick={onClose} className="text-muted hover:text-paper"><X size={18} /></button>
        </div>

        <div className="p-6 space-y-5">
          {/* Savings hero */}
          <div className="glass-inner rounded-xl p-5 text-center bg-emerald-50/40">
            <div className="flex items-center justify-center gap-2 text-emerald-700 mb-1"><PiggyBank size={18} /><span className="text-[10px] font-mono font-bold uppercase tracking-[0.16em]">Customer saves</span></div>
            <div className="text-3xl font-bold tabular-nums text-emerald-600">{totals.vol ? gbp0(totals.savingYr) : '—'}<span className="text-base font-semibold text-emerald-700/70"> / yr</span></div>
            <div className="text-xs text-muted mt-0.5">{totals.vol ? `${gbp2(totals.saving)} / mo · ${pct2(totals.currentEff)} → ${pct2(totals.ourEff)} effective rate` : 'Add volumes & rates to calculate savings'}</div>
          </div>

          {/* Per-channel rate breakdown */}
          {CHANNELS.map(ch => {
            const cats = catsForChannel(ch.key);
            const chHasData = cats.some(c => Number(rateFor(c.key).monthly_volume || 0) > 0 || rateFor(c.key).our_rate_pct != null);
            if (!chHasData) return null;
            return (
              <div key={ch.key} className="glass-inner rounded-xl overflow-hidden">
                <div className="px-4 py-2.5 border-b border-bdr text-[11px] font-bold uppercase tracking-[0.12em] text-paper">{ch.label} <span className="text-dim font-mono font-normal normal-case">· {ch.sub}</span></div>
                <div className="px-4 py-2 border-b border-bdr text-[9px] font-mono font-bold uppercase tracking-[0.1em] text-dim flex">
                  <span className="flex-1">Card type</span>
                  <span className="w-20 text-right">Vol/mo</span>
                  <span className="w-16 text-right">Their</span>
                  <span className="w-16 text-right">Our</span>
                  <span className="w-20 text-right">Saves/mo</span>
                </div>
                {cats.map(c => {
                  const r = rateFor(c.key);
                  const calc = rowCalc(r);
                  return (
                    <div key={c.key} className="px-4 py-2 border-b border-bdr/50 last:border-0 flex items-center text-sm">
                      <div className="flex-1 min-w-0">
                        <div className="text-paper leading-tight">{c.scheme}{c.tier ? <span className="text-dim"> {c.tier}</span> : ''}</div>
                        {calc.avg > 0 && <div className="text-[10px] text-dim">avg £{calc.avg.toFixed(2)} · {calc.txns} txns</div>}
                      </div>
                      <span className="w-20 text-right tabular-nums text-muted">{calc.vol ? gbp0(calc.vol) : '—'}</span>
                      <span className="w-16 text-right tabular-nums text-muted">{calc.vol ? pct2(calc.currentEff) : pct2(r.current_rate_pct)}</span>
                      <span className="w-16 text-right tabular-nums text-paper">{calc.vol ? pct2(calc.ourEff) : pct2(r.our_rate_pct)}</span>
                      <span className="w-20 text-right tabular-nums font-semibold text-emerald-600">{calc.vol ? gbp2(calc.saving) : '—'}</span>
                    </div>
                  );
                })}
              </div>
            );
          })}

          <div className="glass-inner rounded-xl p-4 grid grid-cols-3 gap-3 text-center">
            <Metric value={totals.vol ? gbp0(totals.vol) : '—'} label="Volume / mo" />
            <Metric value={totals.vol ? gbp0(totals.saving) : '—'} label="Customer saves / mo" tone={totals.saving >= 0 ? 'emerald' : 'red'} />
            <Metric value={totals.vol ? gbp0(totals.margin) : '—'} label="Our margin / mo" tone="emerald" />
          </div>
          <div className="text-[11px] text-dim">Effective rate folds the per-transaction fee into a single % using each card type's average transaction size, so small-basket fees are reflected. Buy rate &amp; margin are internal and never shown to the customer.</div>
          {(acc.partner || acc.merchant_ref) && (
            <div className="text-xs text-muted">Partner: <span className="text-paper">{acc.partner || '—'}</span> · MID: <span className="text-paper font-mono">{acc.merchant_ref || '—'}</span></div>
          )}

          {/* Monthly volumes (live processing tracker) */}
          <div className="glass-inner rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-bdr flex items-center justify-between">
              <div className="text-[13px] font-bold text-paper">Actual monthly volume &amp; revenue</div>
              {canWrite && <button onClick={() => setAdding(v => !v)} className="text-xs text-ember hover:text-ember-deep font-medium flex items-center gap-1"><Plus size={13} /> Add month</button>}
            </div>

            {adding && (
              <div className="p-4 border-b border-bdr space-y-3 bg-card/40">
                <div className="grid grid-cols-2 gap-3">
                  <div><label className={lbl}>Month</label><input type="month" className={input} value={vform.month} onChange={e => setVform({ ...vform, month: e.target.value })} /></div>
                  <div><label className={lbl}>Amount processed £</label><input className={input} value={vform.amount_processed} onChange={e => setVform({ ...vform, amount_processed: e.target.value })} placeholder="40000" /></div>
                  <div><label className={lbl}>Transactions</label><input className={input} value={vform.transactions} onChange={e => setVform({ ...vform, transactions: e.target.value })} placeholder="optional" /></div>
                  <div><label className={lbl}>Our revenue £ (override)</label><input className={input} value={vform.our_revenue} onChange={e => setVform({ ...vform, our_revenue: e.target.value })} placeholder="leave blank = estimate" /></div>
                </div>
                <div className="flex gap-2"><button onClick={addVolume} className="btn-glass px-4 py-1.5 rounded-xl text-xs font-semibold">Save</button>
                  <button onClick={() => setAdding(false)} className="btn-ghost px-3 py-1.5 rounded-xl text-xs">Cancel</button></div>
              </div>
            )}

            <table className="w-full text-sm">
              <thead><tr className="text-[10px] font-mono font-bold uppercase tracking-[0.14em] text-dim border-b border-bdr">
                <th className="text-left px-4 py-2 font-bold">Month</th>
                <th className="text-right px-3 py-2 font-bold">Processed</th>
                <th className="text-right px-3 py-2 font-bold">Txns</th>
                <th className="text-right px-4 py-2 font-bold">Our revenue</th>
                <th></th>
              </tr></thead>
              <tbody>
                {volumes.length === 0 ? <tr><td colSpan={5} className="px-4 py-6 text-center text-dim italic text-xs">No volume recorded yet.</td></tr>
                  : volumes.map(v => {
                    const est = v.our_revenue == null;
                    return (
                      <tr key={v.id} className="border-b border-bdr/50">
                        <td className="px-4 py-2.5 text-paper">{periodLabel(v.period)}{v.source === 'partner' && <span className="ml-1 text-[9px] text-emerald-600 uppercase">auto</span>}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-paper">{gbp0(v.amount_processed)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-muted">{v.transactions ?? '—'}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-paper">{gbp2(revenueOf(accCalc, v))}{est && <span className="text-[9px] text-dim ml-1">est</span>}</td>
                        <td className="px-2">{canWrite && <button onClick={() => delVolume(v.id)} className="text-dim hover:text-red-600"><Trash2 size={13} /></button>}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>

          <div className="text-[11px] text-dim">Leave “Our revenue” blank and it’s estimated from your blended margin ({marginPct(accCalc).toFixed(2)}% + £{marginTxn(accCalc).toFixed(2)}/txn). When your processing partner is connected, monthly figures will sync here automatically.</div>
        </div>
      </div>

      {editingAcc && <AccountModal account={acc} companies={companies} locations={locations}
        onClose={() => setEditingAcc(false)} onSaved={() => { setEditingAcc(false); reloadAcc(); onChanged?.(); }} />}
    </div>
  );
}

function Metric({ value, label, tone }) {
  const color = tone === 'emerald' ? 'text-emerald-600' : tone === 'red' ? 'text-red-600' : 'text-paper';
  return <div><div className={`text-lg font-bold tabular-nums ${color}`}>{value}</div><div className="text-[10px] text-dim">{label}</div></div>;
}

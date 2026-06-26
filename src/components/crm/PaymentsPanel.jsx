import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { CreditCard, Plus, X, TrendingUp, Banknote, PiggyBank } from 'lucide-react';
import ProcessingAccountDrawer from './ProcessingAccountDrawer.jsx';

export const gbp0 = (n) => '£' + (Number(n) || 0).toLocaleString('en-GB', { maximumFractionDigits: 0 });
export const gbp2 = (n) => '£' + (Number(n) || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const pct2 = (v) => v == null || v === '' ? '—' : `${Number(v).toFixed(2)}%`;

// Two presentment channels: in-store (card present) and online (card not present)
export const CHANNELS = [
  { key: 'cp', label: 'In-store', sub: 'Card present' },
  { key: 'cnp', label: 'Online', sub: 'Card not present' },
];

// Preset BUY rates (our cost, incl. interchange) per scheme. Same for both channels.
export const BUY_PRESETS = { vm_credit: 0.65, vm_debit: 0.55, amex: 2.0 };
// Preset BUY per-transaction cost (PENCE) — what each transaction costs us. We mark this up in "Our txn".
export const BUY_TXN_PRESETS = { vm_credit: 6, vm_debit: 6, amex: 10 };

// Industry-standard UK card mix (% of each channel's volume), editable per quote.
// Sources: UK Finance UK Payment Markets, BRC Payments Survey, Worldpay GPR.
export const CARD_SPLIT = {
  cp: { vm_credit: 15, vm_debit: 82, amex: 3 },
  cnp: { vm_credit: 35, vm_debit: 60, amex: 5 },
};

const SCHEMES = [
  { sk: 'vm_credit', scheme: 'Visa / Mastercard', tier: 'Credit' },
  { sk: 'vm_debit', scheme: 'Visa / Mastercard', tier: 'Debit' },
  { sk: 'amex', scheme: 'American Express', tier: '' },
];

// 6-row matrix = 2 channels × 3 schemes. key = `${channel}_${scheme}`.
export const RATE_CATEGORIES = CHANNELS.flatMap(ch =>
  SCHEMES.map(s => ({
    key: `${ch.key}_${s.sk}`,
    channel: ch.key, channelLabel: ch.label,
    sk: s.sk, scheme: s.scheme, tier: s.tier,
    label: `${s.scheme}${s.tier ? ' ' + s.tier : ''}`,
    buy: BUY_PRESETS[s.sk],
    buyTxn: BUY_TXN_PRESETS[s.sk],
    split: CARD_SPLIT[ch.key][s.sk],
  }))
);

// Derive a row's monthly volume + txn count from a channel total, its split %, and the avg transaction size.
export const deriveRow = (channelTotal, splitPct, avgTxn) => {
  const vol = (Number(channelTotal) || 0) * (Number(splitPct) || 0) / 100;
  const txns = Number(avgTxn) > 0 ? Math.round(vol / Number(avgTxn)) : 0;
  return { monthly_volume: vol, monthly_txns: txns };
};
export const catsForChannel = (ch) => RATE_CATEGORIES.filter(c => c.channel === ch);

// ---- precise per-row savings math --------------------------------------
// A row carries: current/our/buy rate %, current/our/buy per-txn fee (PENCE),
// monthly_volume (£) and monthly_txns (count). The per-txn fee matters more
// on small baskets, so we fold it into an effective rate via avg txn size.
// Cost = volume × rate% + txns × (pence/100). Adding a txn fee the customer
// doesn't currently pay raises ourCost and reduces (or removes) the saving.
export function rowCalc(r = {}) {
  const vol = Number(r.monthly_volume || 0);
  const txns = Number(r.monthly_txns || 0);
  const avg = txns > 0 ? vol / txns : 0;
  const cur = Number(r.current_rate_pct || 0), our = Number(r.our_rate_pct || 0), buy = Number(r.buy_rate_pct || 0);
  const curTxn = Number(r.current_txn_fee || 0), ourTxn = Number(r.our_txn_fee || 0), buyTxn = Number(r.buy_txn_fee || 0);
  const currentCost = vol * cur / 100 + txns * curTxn / 100;
  const ourCost = vol * our / 100 + txns * ourTxn / 100;
  const buyCost = vol * buy / 100 + txns * buyTxn / 100;
  return {
    vol, txns, avg,
    currentCost, ourCost, buyCost,
    saving: currentCost - ourCost,        // shown to customer
    margin: ourCost - buyCost,            // internal only
    currentEff: vol > 0 ? currentCost / vol * 100 : cur,   // true rate incl. txn fee
    ourEff: vol > 0 ? ourCost / vol * 100 : our,
  };
}
// A row counts toward totals only once it's been PRICED (an "our rate" is set).
// Unpriced rows still carry split volume but shouldn't read as cost/loss.
export const isPriced = (r) => r && r.our_rate_pct !== null && r.our_rate_pct !== '' && r.our_rate_pct !== undefined;

export function accountSavings(rates = []) {
  const t = { vol: 0, txns: 0, currentCost: 0, ourCost: 0, buyCost: 0, saving: 0 };
  for (const r of rates) { if (!isPriced(r)) continue; const c = rowCalc(r); t.vol += c.vol; t.txns += c.txns; t.currentCost += c.currentCost; t.ourCost += c.ourCost; t.buyCost += c.buyCost; }
  t.saving = t.currentCost - t.ourCost;
  return {
    ...t,
    savingYr: t.saving * 12,
    margin: t.ourCost - t.buyCost,
    avg: t.txns > 0 ? t.vol / t.txns : 0,
    currentEff: t.vol > 0 ? t.currentCost / t.vol * 100 : 0,
    ourEff: t.vol > 0 ? t.ourCost / t.vol * 100 : 0,
  };
}

// ---- legacy blended helpers (used by the monthly volume tracker) --------
export const blendedRate = (a, field) => {
  const rows = (a.rates || []).filter(r => r[field] != null && r[field] !== '');
  if (rows.length) return rows.reduce((s, r) => s + Number(r[field]), 0) / rows.length;
  return a[field] != null ? Number(a[field]) : null;
};
export const marginPct = (a) => {
  const rows = (a.rates || []).filter(r => r.our_rate_pct != null && r.buy_rate_pct != null);
  if (rows.length) return rows.reduce((s, r) => s + (Number(r.our_rate_pct) - Number(r.buy_rate_pct)), 0) / rows.length;
  return Number(a.our_rate_pct || 0) - Number(a.buy_rate_pct || 0);
};
export const marginTxn = (a) => Number(a.our_txn_fee || 0) - Number(a.buy_txn_fee || 0);
export const revenueOf = (a, v) =>
  v.our_revenue != null ? Number(v.our_revenue)
    : Number(v.amount_processed || 0) * marginPct(a) / 100 + Number(v.transactions || 0) * marginTxn(a);

const thisMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const periodOf = (m) => `${m}-01`;
const STATUS_STYLE = { prospect: 'bg-amber-100 text-amber-700', live: 'bg-emerald-100 text-emerald-700', churned: 'bg-slate-200 text-slate-500' };

export default function PaymentsPanel({ profile, onNavigate }) {
  const [accounts, setAccounts] = useState([]);
  const [volumes, setVolumes] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [locations, setLocations] = useState([]);
  const [month, setMonth] = useState(thisMonth());
  const [selected, setSelected] = useState(null);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  const load = useCallback(async () => {
    setLoading(true);
    const [a, v, c, l, r] = await Promise.all([
      supabase.from('processing_accounts').select('*, company:companies(name), location:locations(name)').order('created_at', { ascending: false }),
      supabase.from('processing_volumes').select('*'),
      supabase.from('companies').select('id, name').order('name'),
      supabase.from('locations').select('id, name, company_id').order('name'),
      supabase.from('processing_rates').select('*'),
    ]);
    const rates = r.data || [];
    const accts = (a.data || []).map(acc => ({ ...acc, rates: rates.filter(x => x.account_id === acc.id) }));
    setAccounts(accts); setVolumes(v.data || []); setCompanies(c.data || []); setLocations(l.data || []);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const period = periodOf(month);
  const volFor = (accId) => volumes.find(v => v.account_id === accId && v.period === period);

  // headline totals for the selected month
  let totalProcessed = 0, totalRevenue = 0;
  for (const acc of accounts) {
    const v = volFor(acc.id);
    if (v) { totalProcessed += Number(v.amount_processed || 0); totalRevenue += revenueOf(acc, v); }
  }
  const liveCount = accounts.filter(a => a.status === 'live').length;
  // potential customer savings across all accounts (from the per-row quote model)
  const totalSavingMo = accounts.reduce((s, a) => s + accountSavings(a.rates).saving, 0);

  const accName = (a) => a.label || a.location?.name || a.company?.name || 'Unnamed account';

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-5 border-b border-bdr flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2.5">
          <CreditCard size={20} className="text-ember" />
          <div>
            <div className="text-xl font-bold text-paper">Card Processing</div>
            <div className="text-xs text-muted">Rates, savings calculator and our revenue</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input type="month" value={month} onChange={e => setMonth(e.target.value)}
            className="px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper" />
          {canWrite && <button onClick={() => setCreating(true)} className="btn-glass px-4 py-2 rounded-xl text-sm font-semibold flex items-center gap-1.5"><Plus size={15} /> New quote</button>}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-[1200px] mx-auto space-y-5">

          {/* Headline */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Headline icon={<PiggyBank size={18} />} value={gbp0(totalSavingMo)} label="Customer savings / mo" sub={`${gbp0(totalSavingMo * 12)} / yr potential`} accent />
            <Headline icon={<Banknote size={18} />} value={gbp0(totalProcessed)} label="Amount processed" sub={`in ${new Date(period).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}`} accent />
            <Headline icon={<TrendingUp size={18} />} value={gbp0(totalRevenue)} label="Our revenue" sub="margin this month" />
            <Headline value={liveCount} label="Live accounts" sub={`${accounts.length} total`} />
          </div>

          {/* Accounts */}
          <div className="glass-card rounded-2xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-bdr flex items-center gap-2">
              <h3 className="text-[13px] font-bold text-paper">Quotes &amp; accounts</h3>
              <span className="text-xs text-dim font-mono">({accounts.length})</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[820px]">
                <thead>
                  <tr className="text-[10px] font-mono font-bold uppercase tracking-[0.14em] text-dim border-b border-bdr">
                    <th className="text-left px-5 py-2 font-bold">Customer</th>
                    <th className="text-left px-3 py-2 font-bold">Status</th>
                    <th className="text-right px-3 py-2 font-bold">Their eff. rate</th>
                    <th className="text-right px-3 py-2 font-bold">Our eff. rate</th>
                    <th className="text-right px-3 py-2 font-bold">Saving / mo</th>
                    <th className="text-right px-3 py-2 font-bold">Margin</th>
                    <th className="text-right px-5 py-2 font-bold">Our revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? <tr><td colSpan={7} className="px-5 py-8 text-center text-dim">Loading…</td></tr>
                    : accounts.length === 0 ? <tr><td colSpan={7} className="px-5 py-8 text-center text-dim italic">No quotes yet.</td></tr>
                    : accounts.map(a => {
                      const v = volFor(a.id);
                      const s = accountSavings(a.rates);
                      return (
                        <tr key={a.id} onClick={() => setSelected(a)} className="border-b border-bdr/60 hover:bg-card/50 cursor-pointer">
                          <td className="px-5 py-2.5">
                            <div className="text-paper font-medium">{accName(a)}</div>
                            {a.location?.name && a.company?.name && <div className="text-[11px] text-dim">{a.company.name}</div>}
                          </td>
                          <td className="px-3 py-2.5"><span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-lg ${STATUS_STYLE[a.status]}`}>{a.status}</span></td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-muted">{s.vol ? pct2(s.currentEff) : '—'}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-paper">{s.vol ? pct2(s.ourEff) : '—'}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-emerald-600">{s.vol ? gbp0(s.saving) : '—'}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-emerald-600">{marginPct(a).toFixed(2)}%</td>
                          <td className="px-5 py-2.5 text-right tabular-nums font-semibold text-paper">{v ? gbp0(revenueOf(a, v)) : '—'}</td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </div>

        </div>
      </div>

      {creating && <AccountModal companies={companies} locations={locations} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); load(); }} />}
      {selected && <ProcessingAccountDrawer account={selected} profile={profile} onNavigate={onNavigate}
        companies={companies} locations={locations}
        onClose={() => setSelected(null)} onChanged={() => { load(); }} />}
    </div>
  );
}

function Headline({ icon, value, label, sub, accent }) {
  return (
    <div className="glass-card rounded-2xl p-4">
      <div className="flex items-center gap-2 mb-1">
        {icon && <span className={accent ? 'text-ember' : 'text-dim'}>{icon}</span>}
        <span className="text-[10px] font-mono font-bold uppercase tracking-[0.14em] text-dim">{label}</span>
      </div>
      <div className="text-2xl font-bold tabular-nums text-paper">{value}</div>
      {sub && <div className="text-[11px] text-dim mt-0.5">{sub}</div>}
    </div>
  );
}

const input = "w-full px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper focus:outline-none focus:border-ember";
const label = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block";

const emptyRates = () => Object.fromEntries(RATE_CATEGORIES.map(c => [c.key, {
  current_rate_pct: '', our_rate_pct: '', buy_rate_pct: String(c.buy),
  current_txn_fee: '', our_txn_fee: '', buy_txn_fee: String(c.buyTxn), split: String(c.split),
}]));

export function AccountModal({ account, companies, locations, onClose, onSaved }) {
  const a = account || {};
  const [f, setF] = useState({
    company_id: a.company_id || '', location_id: a.location_id || '', label: a.label || '', status: a.status || 'prospect',
    cp_volume: a.cp_volume ?? '', cnp_volume: a.cnp_volume ?? '', avg_txn_size: a.avg_txn_size ?? '',
    partner: a.partner || '', merchant_ref: a.merchant_ref || '',
  });
  const [rates, setRates] = useState(emptyRates());
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const setRate = (cat, field, v) => setRates(p => ({ ...p, [cat]: { ...p[cat], [field]: v } }));
  const num = (v) => v === '' || v == null ? null : Number(v);
  const locs = locations.filter(l => l.company_id === f.company_id);

  useEffect(() => {
    if (!a.id) return;
    supabase.from('processing_rates').select('*').eq('account_id', a.id).then(({ data }) => {
      if (!data?.length) return;
      setRates(prev => {
        const next = { ...prev };
        data.forEach(r => {
          if (!next[r.category]) return; // ignore legacy 3-category keys
          const c = RATE_CATEGORIES.find(x => x.key === r.category);
          next[r.category] = {
            current_rate_pct: r.current_rate_pct ?? '', our_rate_pct: r.our_rate_pct ?? '',
            buy_rate_pct: r.buy_rate_pct ?? next[r.category].buy_rate_pct,
            current_txn_fee: r.current_txn_fee ?? '', our_txn_fee: r.our_txn_fee ?? '',
            buy_txn_fee: r.buy_txn_fee ?? next[r.category].buy_txn_fee,
            split: r.volume_split_pct ?? String(c?.split ?? ''),
          };
        });
        return next;
      });
    });
  }, [a.id]);

  const channelTotal = (ch) => ch === 'cp' ? f.cp_volume : f.cnp_volume;

  const save = async () => {
    if (!f.company_id) { alert('Pick a customer (company)'); return; }
    const row = {
      company_id: f.company_id, location_id: f.location_id || null, label: f.label.trim() || null, status: f.status,
      cp_volume: num(f.cp_volume), cnp_volume: num(f.cnp_volume), avg_txn_size: num(f.avg_txn_size),
      partner: f.partner.trim() || null, merchant_ref: f.merchant_ref.trim() || null, updated_at: new Date().toISOString(),
    };
    let accId = a.id;
    if (a.id) await supabase.from('processing_accounts').update(row).eq('id', a.id);
    else { const { data } = await supabase.from('processing_accounts').insert(row).select('id').single(); accId = data?.id; }
    if (accId) {
      for (const c of RATE_CATEGORIES) {
        const r = rates[c.key];
        const d = deriveRow(channelTotal(c.channel), r.split, f.avg_txn_size);
        const has = ['current_rate_pct', 'our_rate_pct', 'current_txn_fee', 'our_txn_fee'].some(k => r[k] !== '' && r[k] != null) || d.monthly_volume > 0;
        if (has) {
          await supabase.from('processing_rates').upsert({
            account_id: accId, category: c.key,
            current_rate_pct: num(r.current_rate_pct), our_rate_pct: num(r.our_rate_pct),
            buy_rate_pct: num(r.buy_rate_pct) ?? c.buy,
            current_txn_fee: num(r.current_txn_fee), our_txn_fee: num(r.our_txn_fee),
            buy_txn_fee: num(r.buy_txn_fee) ?? c.buyTxn,
            volume_split_pct: num(r.split) ?? c.split,
            monthly_volume: d.monthly_volume, monthly_txns: d.monthly_txns,
          }, { onConflict: 'account_id,category' });
        } else {
          await supabase.from('processing_rates').delete().eq('account_id', accId).eq('category', c.key);
        }
      }
    }
    onSaved();
  };

  // live preview: derive each row's volume/txns from the channel totals + split + avg txn
  const totals = accountSavings(RATE_CATEGORIES.map(c => ({ ...rates[c.key], ...deriveRow(channelTotal(c.channel), rates[c.key].split, f.avg_txn_size) })));
  const splitSum = (ch) => catsForChannel(ch).reduce((s, c) => s + (Number(rates[c.key].split) || 0), 0);

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="glass-card rounded-2xl w-full max-w-5xl max-h-[92vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-bdr flex items-center justify-between sticky top-0 glass-card z-10">
          <div className="text-base font-bold text-paper">{a.id ? 'Edit card-processing quote' : 'New card-processing quote'}</div>
          <button onClick={onClose} className="text-muted hover:text-paper"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div><label className={label}>Customer</label>
              <select className={input} value={f.company_id} onChange={e => { set('company_id', e.target.value); set('location_id', ''); }}>
                <option value="">Select…</option>{companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select></div>
            <div><label className={label}>Location (optional)</label>
              <select className={input} value={f.location_id} onChange={e => set('location_id', e.target.value)}>
                <option value="">All / not set</option>{locs.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select></div>
            <div><label className={label}>Label (optional)</label><input className={input} value={f.label} onChange={e => set('label', e.target.value)} placeholder="Merchant name" /></div>
            <div><label className={label}>Status</label><select className={input} value={f.status} onChange={e => set('status', e.target.value)}>
              <option value="prospect">Prospect</option><option value="live">Live</option><option value="churned">Churned</option></select></div>
          </div>

          {/* The three figures that drive everything */}
          <div className="glass-inner rounded-xl p-3 grid grid-cols-1 md:grid-cols-3 gap-3">
            <div><label className={label}>Total in-store volume £/mo</label><input className={input} value={f.cp_volume} onChange={e => set('cp_volume', e.target.value)} placeholder="30000" /></div>
            <div><label className={label}>Total online volume £/mo</label><input className={input} value={f.cnp_volume} onChange={e => set('cnp_volume', e.target.value)} placeholder="10000" /></div>
            <div><label className={label}>Avg transaction size £</label><input className={input} value={f.avg_txn_size} onChange={e => set('avg_txn_size', e.target.value)} placeholder="20" /></div>
          </div>

          {CHANNELS.map(ch => <RateChannel key={ch.key} ch={ch} rates={rates} setRate={setRate} channelTotal={channelTotal(ch.key)} avgTxn={f.avg_txn_size} splitSum={splitSum(ch.key)} />)}

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div><label className={label}>Processing partner</label><input className={input} value={f.partner} onChange={e => set('partner', e.target.value)} placeholder="e.g. Adyen" /></div>
            <div><label className={label}>Merchant ref</label><input className={input} value={f.merchant_ref} onChange={e => set('merchant_ref', e.target.value)} placeholder="MID" /></div>
          </div>

          {/* Live preview incl. what WE make (internal) */}
          <div className="glass-inner rounded-xl p-4 grid grid-cols-2 md:grid-cols-5 gap-3 text-center">
            <Mini value={gbp0(totals.vol)} label="Monthly volume" />
            <Mini value={totals.vol ? pct2(totals.currentEff) + ' → ' + pct2(totals.ourEff) : '—'} label="Eff. rate (their → ours)" />
            <Mini value={totals.vol ? gbp2(totals.saving) : '—'} label="Customer saves / mo" tone="emerald" />
            <Mini value={totals.vol ? gbp0(totals.savingYr) : '—'} label="Customer saves / yr" tone="emerald" />
            <Mini value={totals.vol ? gbp2(totals.margin) : '—'} label="We earn / mo" tone="amber" />
          </div>
          <div className="text-[10px] text-dim">“We earn” is your margin (our rate − buy rate) — internal only, never shown on the customer quote. Volumes auto-split by industry-standard card mix; adjust Split % per row if you have the customer's real breakdown.</div>

          <div className="flex gap-2 pt-1"><button onClick={save} className="btn-glass px-5 py-2 rounded-xl text-sm font-semibold">Save quote</button>
            <button onClick={onClose} className="btn-ghost px-4 py-2 rounded-xl text-sm">Cancel</button></div>
        </div>
      </div>
    </div>
  );
}

const cell = "w-full px-2 py-1.5 bg-card border border-bdr rounded-lg text-sm text-paper text-right focus:outline-none focus:border-ember";

function RateChannel({ ch, rates, setRate, channelTotal, avgTxn, splitSum }) {
  return (
    <div className="glass-inner rounded-xl p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-paper">{ch.label} <span className="text-dim font-mono font-normal normal-case">· {ch.sub}</span></div>
        <div className={`text-[10px] font-mono ${Math.round(splitSum) === 100 ? 'text-dim' : 'text-amber-600'}`}>split {splitSum}%{Math.round(splitSum) !== 100 ? ' — should total 100' : ''}</div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px]">
          <thead>
            <tr className="text-[9px] font-mono font-bold uppercase tracking-[0.1em] text-dim">
              <th className="text-left font-bold pb-1.5">Card type</th>
              <th className="font-bold pb-1.5 px-1">Split %</th>
              <th className="font-bold pb-1.5 px-1">Vol £/mo</th>
              <th className="font-bold pb-1.5 px-1">Txns/mo</th>
              <th className="font-bold pb-1.5 px-1">Their %</th>
              <th className="font-bold pb-1.5 px-1">Our %</th>
              <th className="font-bold pb-1.5 px-1">Buy %</th>
              <th className="font-bold pb-1.5 px-1">Their txn p</th>
              <th className="font-bold pb-1.5 px-1">Our txn p</th>
              <th className="font-bold pb-1.5 px-1">Buy txn p</th>
              <th className="font-bold pb-1.5 pl-2 text-right">Saves/mo</th>
            </tr>
          </thead>
          <tbody>
            {catsForChannel(ch.key).map(c => {
              const r = rates[c.key];
              const d = deriveRow(channelTotal, r.split, avgTxn);
              const calc = rowCalc({ ...r, ...d });
              return (
                <tr key={c.key}>
                  <td className="py-1 pr-2"><div className="text-sm text-paper leading-tight">{c.scheme}{c.tier ? <span className="text-dim"> {c.tier}</span> : ''}</div></td>
                  <td className="px-1"><input className={cell} value={r.split} onChange={e => setRate(c.key, 'split', e.target.value)} placeholder={String(c.split)} /></td>
                  <td className="px-1 text-right text-sm tabular-nums text-dim">{d.monthly_volume ? gbp0(d.monthly_volume) : '—'}</td>
                  <td className="px-1 text-right text-sm tabular-nums text-dim">{d.monthly_txns || '—'}</td>
                  <td className="px-1"><input className={cell} value={r.current_rate_pct} onChange={e => setRate(c.key, 'current_rate_pct', e.target.value)} placeholder="—" /></td>
                  <td className="px-1"><input className={cell} value={r.our_rate_pct} onChange={e => setRate(c.key, 'our_rate_pct', e.target.value)} placeholder="—" /></td>
                  <td className="px-1"><input className={`${cell} text-dim`} value={r.buy_rate_pct} onChange={e => setRate(c.key, 'buy_rate_pct', e.target.value)} placeholder={String(c.buy)} /></td>
                  <td className="px-1"><input className={cell} value={r.current_txn_fee} onChange={e => setRate(c.key, 'current_txn_fee', e.target.value)} placeholder="0" /></td>
                  <td className="px-1"><input className={cell} value={r.our_txn_fee} onChange={e => setRate(c.key, 'our_txn_fee', e.target.value)} placeholder="—" /></td>
                  <td className="px-1"><input className={`${cell} text-dim`} value={r.buy_txn_fee} onChange={e => setRate(c.key, 'buy_txn_fee', e.target.value)} placeholder={String(c.buyTxn)} /></td>
                  <td className="pl-2 text-right text-sm font-semibold tabular-nums text-emerald-600">{calc.vol ? gbp0(calc.saving) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Mini({ value, label, tone }) {
  const color = tone === 'emerald' ? 'text-emerald-600' : tone === 'amber' ? 'text-amber-600' : 'text-paper';
  return <div><div className={`text-lg font-bold tabular-nums ${color}`}>{value}</div><div className="text-[10px] text-dim">{label}</div></div>;
}

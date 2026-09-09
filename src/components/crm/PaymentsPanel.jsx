import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { CreditCard, Plus, X, TrendingUp, Banknote, PiggyBank } from 'lucide-react';
import ProcessingAccountDrawer from './ProcessingAccountDrawer.jsx';
import { loadCostTemplate, costFor, costExplain, regionForCountry, defaultMarkupFor } from '../../lib/cardCosts';
import { STATEMENT_LINES, blankStatement, statementTotals, statementToRates } from '../../lib/statement';
import { fmtMoney, fmtMoney0, sumByCurrency, fmtByCurrency } from '../../lib/money';

export const gbp0 = (n) => '£' + (Number(n) || 0).toLocaleString('en-GB', { maximumFractionDigits: 0 });
export const gbp2 = (n) => '£' + (Number(n) || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const pct2 = (v) => v == null || v === '' ? '—' : `${Number(v).toFixed(2)}%`;

// A card is priced in the currency of the region whose costs it was built on.
// region_code is set when the card is saved (site country first, then company).
// Cards with no region predate that column and are UK, which is what they were.
export const ccyOf = (account) => (account?.region_code === 'US' ? 'USD' : 'GBP');
/** Money formatters bound to one card's currency. */
export const moneyFor = (ccy) => ({ m0: (n) => fmtMoney0(n, ccy), m2: (n) => fmtMoney(n, ccy) });

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
  const [editingCosts, setEditingCosts] = useState(null);
  const [loading, setLoading] = useState(true);
  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  const load = useCallback(async () => {
    setLoading(true);
    const [a, v, c, l, r] = await Promise.all([
      supabase.from('processing_accounts').select('*, company:companies(name), location:locations(name)').order('created_at', { ascending: false }),
      supabase.from('processing_volumes').select('*'),
      supabase.from('companies').select('id, name, country').order('name'),
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

  // Headline totals for the selected month. Cards are priced in their own
  // region's currency, so these are summed PER CURRENCY and rendered as
  // '£1,200 + $300'. Adding dollars to pounds would invent an exchange rate
  // we have not been given, and quietly overstate every total.
  const withVol = accounts.map(a => ({ acc: a, v: volFor(a.id) })).filter(x => x.v);
  const processedBy = sumByCurrency(withVol, x => Number(x.v.amount_processed || 0), x => ccyOf(x.acc));
  const revenueBy = sumByCurrency(withVol, x => revenueOf(x.acc, x.v), x => ccyOf(x.acc));
  const savingBy = sumByCurrency(accounts, a => accountSavings(a.rates).saving, ccyOf);
  const savingYrBy = sumByCurrency(accounts, a => accountSavings(a.rates).saving * 12, ccyOf);
  const liveCount = accounts.filter(a => a.status === 'live').length;

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
            <Headline icon={<PiggyBank size={18} />} value={fmtByCurrency(savingBy, 0)} label="Customer savings / mo" sub={`${fmtByCurrency(savingYrBy, 0)} / yr potential`} accent />
            <Headline icon={<Banknote size={18} />} value={fmtByCurrency(processedBy, 0)} label="Amount processed" sub={`in ${new Date(period).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}`} accent />
            <Headline icon={<TrendingUp size={18} />} value={fmtByCurrency(revenueBy, 0)} label="Our revenue" sub="margin this month" />
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
                      const { m0 } = moneyFor(ccyOf(a));
                      return (
                        <tr key={a.id} onClick={() => setSelected(a)} className="border-b border-bdr/60 hover:bg-card/50 cursor-pointer">
                          <td className="px-5 py-2.5">
                            <div className="text-paper font-medium">{accName(a)}</div>
                            {a.location?.name && a.company?.name && <div className="text-[11px] text-dim">{a.company.name}</div>}
                          </td>
                          <td className="px-3 py-2.5"><span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-lg ${STATUS_STYLE[a.status]}`}>{a.status}</span></td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-muted">{s.vol ? pct2(s.currentEff) : '—'}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-paper">{s.vol ? pct2(s.ourEff) : '—'}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-emerald-600">{s.vol ? m0(s.saving) : '—'}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-emerald-600">{marginPct(a).toFixed(2)}%</td>
                          <td className="px-5 py-2.5 text-right tabular-nums font-semibold text-paper">{v ? m0(revenueOf(a, v)) : '—'}</td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </div>

          <CostTemplates profile={profile} onEdit={setEditingCosts} editing={editingCosts} onClose={() => setEditingCosts(null)} />

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

// Buy costs come from the region's cost template. With no template loaded this
// is exactly what the app used before templates existed.
const emptyRates = (template = null) => Object.fromEntries(RATE_CATEGORIES.map(c => {
  const cost = costFor(template, c.key, c);
  return [c.key, {
    current_rate_pct: '', our_rate_pct: '', buy_rate_pct: cost.buy == null ? '' : String(cost.buy),
    current_txn_fee: '', our_txn_fee: '', buy_txn_fee: cost.buyTxn == null ? '' : String(cost.buyTxn),
    split: cost.split == null ? '' : String(cost.split),
  }];
}));

function StatementImport({ sym, minor, m2, defaultDebitShare, onApply }) {
  const [open, setOpen] = useState(false);
  const [st, setSt] = useState(blankStatement);
  const [debit, setDebit] = useState(String(defaultDebitShare ?? 55));
  const set = (k, field, v) => setSt(p => ({ ...p, [k]: { ...p[k], [field]: v } }));
  const t = statementTotals(st);
  const cell = "px-2 py-1 bg-card border border-bdr rounded-lg text-sm text-paper w-full focus:outline-none focus:border-ember";

  if (!open) return (
    <button type="button" onClick={() => setOpen(true)} className="w-full text-left glass-inner rounded-xl px-4 py-3 hover:border-ember/40 border border-transparent">
      <div className="text-[13px] font-semibold text-paper">Enter their statement</div>
      <div className="text-[11px] text-dim mt-0.5">Type the four lines off their processing statement and this fills the whole card, volumes and card mix included.</div>
    </button>
  );

  return (
    <div className="glass-inner rounded-xl p-3 space-y-2">
      <div className="flex items-center gap-2">
        <div className="text-[13px] font-semibold text-paper">Their statement</div>
        <button type="button" onClick={() => setOpen(false)} className="ml-auto text-[11px] text-dim hover:text-paper">Hide</button>
      </div>
      <div className="text-[11px] text-dim">
        Straight off the statement. Most US processors bill Visa, Mastercard, Discover and debit as one line, so that is how this is entered.
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px]">
          <thead><tr className="text-[9px] font-mono font-bold uppercase tracking-[0.1em] text-dim">
            <th className="text-left font-bold pb-1.5">Line</th>
            <th className="font-bold pb-1.5 px-1">Rate %</th>
            <th className="font-bold pb-1.5 px-1">+ {minor}</th>
            <th className="font-bold pb-1.5 px-1">Txns</th>
            <th className="font-bold pb-1.5 px-1">Volume {sym}</th>
            <th className="font-bold pb-1.5 px-1 text-right">They pay</th>
          </tr></thead>
          <tbody>
            {STATEMENT_LINES.map(l => {
              const r = st[l.key];
              const paid = Number(r.volume || 0) * (Number(r.rate) || 0) / 100 + Number(r.txns || 0) * (Number(r.fee) || 0) / 100;
              return (
                <tr key={l.key}>
                  <td className="py-1 pr-2"><div className="text-sm text-paper leading-tight">{l.label}</div><div className="text-[10px] text-dim">{l.sub}</div></td>
                  <td className="px-1"><input className={cell} value={r.rate} onChange={e => set(l.key, 'rate', e.target.value)} placeholder="2.49" /></td>
                  <td className="px-1"><input className={cell} value={r.fee} onChange={e => set(l.key, 'fee', e.target.value)} placeholder="15" /></td>
                  <td className="px-1"><input className={cell} value={r.txns} onChange={e => set(l.key, 'txns', e.target.value)} placeholder="2269" /></td>
                  <td className="px-1"><input className={cell} value={r.volume} onChange={e => set(l.key, 'volume', e.target.value)} placeholder="92922" /></td>
                  <td className="px-1 text-right text-sm tabular-nums text-muted">{paid > 0 ? m2(paid) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-end gap-3 pt-1">
        <div className="w-40">
          <span className="text-[9px] text-dim block">Debit share of Visa/MC %</span>
          <input className={cell} value={debit} onChange={e => setDebit(e.target.value)} />
        </div>
        <div className="text-[11px] text-dim flex-1 min-w-[220px] pb-1">
          The one thing the statement cannot tell us, because they are billed one rate for both. It does not change what they pay, only what the book costs <b>us</b>.
        </div>
        <button type="button" disabled={!t.vol} onClick={() => onApply(statementToRates(st, debit))}
          className="px-4 py-2 rounded-xl text-sm font-semibold bg-ember/15 text-ember-deep border border-ember/25 hover:bg-ember/25 disabled:opacity-40">
          Fill the card
        </button>
      </div>
      {t.vol > 0 && (
        <div className="rounded-xl px-3 py-2 bg-card/60 border border-bdr text-[12px] text-paper">
          They pay <b>{m2(t.cost)}</b> a month on <b>{m2(t.vol)}</b> across <b>{t.txns.toLocaleString()}</b> transactions.
          Effective rate <b>{t.eff.toFixed(3)}%</b>, average ticket <b>{m2(t.avg)}</b>.
        </div>
      )}
    </div>
  );
}

export function AccountModal({ account, companies, locations, onClose, onSaved }) {
  const a = account || {};
  const [f, setF] = useState({
    company_id: a.company_id || '', location_id: a.location_id || '', label: a.label || '', status: a.status || 'prospect',
    cp_volume: a.cp_volume ?? '', cnp_volume: a.cnp_volume ?? '', avg_txn_size: a.avg_txn_size ?? '',
    partner: a.partner || '', merchant_ref: a.merchant_ref || '',
    region_code: a.region_code || '',
  });
  const [rates, setRates] = useState(emptyRates());
  const [template, setTemplate] = useState(null);
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const setRate = (cat, field, v) => setRates(p => ({ ...p, [cat]: { ...p[cat], [field]: v } }));
  const num = (v) => v === '' || v == null ? null : Number(v);
  const locs = locations.filter(l => l.company_id === f.company_id);

  // Which country's costs this card is priced against. An explicit choice wins;
  // otherwise the SITE's country, then the company's. The site matters more:
  // the cards are taken where the venue is, and a US site can sit under a
  // company with no country set, which used to read silently as the UK.
  const suggested = regionForCountry(
    locations.find(l => l.id === f.location_id)?.country
    || companies.find(c => c.id === f.company_id)?.country,
  );
  const region = f.region_code || suggested;
  const sym = region === 'US' ? '$' : '£';
  const minor = region === 'US' ? 'c' : 'p';
  const { m0, m2 } = moneyFor(region === 'US' ? 'USD' : 'GBP');
  useEffect(() => {
    let live = true;
    loadCostTemplate(supabase, region).then(t => {
      if (!live) return;
      setTemplate(t);
      // A new card starts on the template's costs. An EXISTING card takes them
      // for any row nobody has priced yet: leaving those blank meant the row
      // read as a zero buy cost, so margin looked bigger than it was. Only
      // blank cells are filled, so a saved rate always wins, and this is safe
      // whichever of the two loads lands first.
      if (!a.id) { setRates(emptyRates(t)); return; }
      setRates(prev => Object.fromEntries(RATE_CATEGORIES.map(c => {
        const cost = costFor(t, c.key);
        const r = prev[c.key] || {};
        const fill = (cur, v) => (cur === '' || cur == null ? (v == null ? '' : String(v)) : cur);
        return [c.key, { ...r,
          buy_rate_pct: fill(r.buy_rate_pct, cost.buy),
          buy_txn_fee: fill(r.buy_txn_fee, cost.buyTxn),
          split: fill(r.split, cost.split) }];
      })));
    });
    return () => { live = false; };
  }, [region, a.id]);

  const applyTemplate = () => setRates(prev => Object.fromEntries(RATE_CATEGORIES.map(c => {
    const cost = costFor(template, c.key, c);
    return [c.key, { ...prev[c.key],
      buy_rate_pct: cost.buy == null ? '' : String(cost.buy),
      buy_txn_fee: cost.buyTxn == null ? '' : String(cost.buyTxn),
      split: prev[c.key]?.split || (cost.split == null ? '' : String(cost.split)) }];
  })));

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
      partner: f.partner.trim() || null, merchant_ref: f.merchant_ref.trim() || null,
      region_code: region, updated_at: new Date().toISOString(),
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
            // Fall back to the REGION's cost, never the old hardcoded UK presets:
            // saving a US card used to write UK buy rates into the database.
            buy_rate_pct: num(r.buy_rate_pct) ?? costFor(template, c.key).buy,
            current_txn_fee: num(r.current_txn_fee), our_txn_fee: num(r.our_txn_fee),
            buy_txn_fee: num(r.buy_txn_fee) ?? costFor(template, c.key).buyTxn,
            volume_split_pct: num(r.split) ?? costFor(template, c.key).split ?? c.split,
            monthly_volume: d.monthly_volume, monthly_txns: d.monthly_txns,
          }, { onConflict: 'account_id,category' });
        } else {
          await supabase.from('processing_rates').delete().eq('account_id', accId).eq('category', c.key);
        }
      }
    }
    onSaved();
  };

  // Fill the card from four statement lines. Only what the statement actually
  // evidences is written: what they pay, how much they take, and the card mix.
  // Our own price and buy costs are left exactly as they were.
  const applyStatement = ({ rows, cp_volume, cnp_volume, avg_txn_size }) => {
    setF(p => ({ ...p, cp_volume: String(cp_volume || ''), cnp_volume: String(cnp_volume || ''), avg_txn_size: String(avg_txn_size || '') }));
    setRates(prev => {
      const next = { ...prev };
      for (const [k, v] of Object.entries(rows)) next[k] = { ...next[k], ...v };
      return next;
    });
  };

  // live preview: derive each row's volume/txns from the channel totals + split + avg txn
  const totals = accountSavings(RATE_CATEGORIES.map(c => ({ ...rates[c.key], ...deriveRow(channelTotal(c.channel), rates[c.key].split, f.avg_txn_size) })));
  const splitSum = (ch) => catsForChannel(ch).reduce((s, c) => s + (Number(rates[c.key].split) || 0), 0);
  // Flag any priced row where we'd charge below our own buy cost (rate or per-txn) — usually a pence/pounds mistake.
  const belowCost = RATE_CATEGORIES.filter(c => {
    const r = rates[c.key]; if (!isPriced(r)) return false;
    const rateUnder = Number(r.our_rate_pct) < Number(r.buy_rate_pct);
    const txnUnder = r.our_txn_fee !== '' && r.our_txn_fee != null && Number(r.our_txn_fee) < Number(r.buy_txn_fee);
    return rateUnder || txnUnder;
  });

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
            <div>
              <label className={label}>Costs</label>
              <select className={input} value={f.region_code || ''} onChange={e => set('region_code', e.target.value)}>
                <option value="">{suggested === 'US' ? 'United States (from the site)' : 'United Kingdom (from the site)'}</option>
                <option value="UK">United Kingdom</option>
                <option value="US">United States</option>
              </select>
            </div>
            <div><label className={label}>Status</label><select className={input} value={f.status} onChange={e => set('status', e.target.value)}>
              <option value="prospect">Prospect</option><option value="live">Live</option><option value="churned">Churned</option></select></div>
          </div>

          {/* The three figures that drive everything */}
          <div className="glass-inner rounded-xl p-3 grid grid-cols-1 md:grid-cols-3 gap-3">
            <div><label className={label}>Total in-store volume {sym}/mo</label><input className={input} value={f.cp_volume} onChange={e => set('cp_volume', e.target.value)} placeholder="30000" /></div>
            <div><label className={label}>Total online volume {sym}/mo</label><input className={input} value={f.cnp_volume} onChange={e => set('cnp_volume', e.target.value)} placeholder="10000" /></div>
            <div><label className={label}>Avg transaction size {sym}</label><input className={input} value={f.avg_txn_size} onChange={e => set('avg_txn_size', e.target.value)} placeholder="20" /></div>
          </div>

          <StatementImport sym={sym} minor={minor} m2={m2}
            defaultDebitShare={costFor(template, 'cp_vm_debit').split ?? 55}
            onApply={applyStatement} />

          {CHANNELS.map(ch => <RateChannel key={ch.key} ch={ch} rates={rates} setRate={setRate} channelTotal={channelTotal(ch.key)} avgTxn={f.avg_txn_size} splitSum={splitSum(ch.key)} sym={sym} minor={minor} m0={m0} template={template} />)}

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div><label className={label}>Processing partner</label><input className={input} value={f.partner} onChange={e => set('partner', e.target.value)} placeholder="e.g. Adyen" /></div>
            <div><label className={label}>Merchant ref</label><input className={input} value={f.merchant_ref} onChange={e => set('merchant_ref', e.target.value)} placeholder="MID" /></div>
          </div>

          {/* Live preview incl. what WE make (internal) */}
          <div className="glass-inner rounded-xl p-4 grid grid-cols-2 md:grid-cols-5 gap-3 text-center">
            <Mini value={fmtMoney0(totals.vol, region === 'US' ? 'USD' : 'GBP')} label="Monthly volume" />
            <Mini value={totals.vol ? pct2(totals.currentEff) + ' → ' + pct2(totals.ourEff) : '—'} label="Eff. rate (their → ours)" />
            <Mini value={totals.vol ? m2(totals.saving) : '—'} label="Customer saves / mo" tone="emerald" />
            <Mini value={totals.vol ? m0(totals.savingYr) : '—'} label="Customer saves / yr" tone="emerald" />
            <Mini value={totals.vol ? m2(totals.margin) : '—'} label="We earn / mo" tone="amber" />
          </div>
          {belowCost.length > 0 && (
            <div className="rounded-xl border border-red-300 bg-red-50 p-3 text-xs text-red-700">
              ⚠ You're priced <b>below what the card costs us</b> on: {belowCost.map(c => `${c.channelLabel} ${c.label}`).join(', ')}. TXN fees are in <b>{minor === 'c' ? 'cents' : 'pence'}</b> — enter <b>8</b> for 8{minor} (not 0.08). Make sure Our % ≥ Cost % and Our txn ≥ Cost txn.
            </div>
          )}
          <CostBuildUp template={template} region={region} minor={minor} />
          <div className="text-[10px] text-dim">
            <b>Cost</b> is what the transaction costs us all in, not a markup on its own. In US merchant services a "buy rate" means only the part above interchange; this is the whole thing. “We earn” is Cost subtracted from what we charge. Both are internal and never reach the customer's copy. Volumes auto-split by card mix; adjust Split % per row if you have their real breakdown.
          </div>

          <div className="flex gap-2 pt-1"><button onClick={save} className="btn-glass px-5 py-2 rounded-xl text-sm font-semibold">Save quote</button>
            <button onClick={onClose} className="btn-ghost px-4 py-2 rounded-xl text-sm">Cancel</button></div>
        </div>
      </div>
    </div>
  );
}

const cell = "w-full px-2 py-1.5 bg-card border border-bdr rounded-lg text-sm text-paper text-right focus:outline-none focus:border-ember";

/**
 * Where a cost comes from, in words, generated from the region's own template.
 * costExplain was written at the start and never rendered anywhere, so a rep
 * looking at "0.40% + 5.8p" had no way to see that 0.8p of it was a scheme fee
 * our acquirer's markup already covers. Showing the build-up is how that kind
 * of error gets caught by the person who actually knows the contract.
 */
function CostBuildUp({ template, region, minor }) {
  const mk = template?.markup || defaultMarkupFor(region);
  const lines = [
    ['Visa / Mastercard debit', 'cp_vm_debit'],
    ['Visa / Mastercard credit', 'cp_vm_credit'],
    ['American Express', 'cp_amex'],
  ].map(([label, key]) => [label, key, costFor(template, key)]);
  const anyFixedInterchange = lines.some(([, , c]) => Number(c.icTxn) > 0);
  return (
    <div className="glass-inner rounded-xl p-3 text-[11px] text-dim space-y-1">
      <div className="text-paper font-semibold text-[12px]">Where the cost comes from · {region}</div>
      {lines.map(([label, key, c]) => (
        <div key={label} className="flex gap-2">
          <span className="w-40 shrink-0 text-muted">{label}</span>
          <span>{c.offered === false
            ? 'we do not sell this card type here'
            : c.ic === null
              ? 'nothing set, so this card type shows no cost'
              : `${c.ic}% + ${c.icTxn}${minor} ${key === 'cp_amex' ? 'Amex wholesale rate' : 'interchange'}, plus ${mk.rate_pct}% + ${mk.txn_minor}${minor} from our acquirer = ${c.buy}% + ${c.buyTxn}${minor}`}</span>
        </div>
      ))}
      <div className="pt-1">
        {anyFixedInterchange
          ? <>Interchange here has a <b>per-transaction</b> part as well as a percentage. In the US that is the Durbin cap, 21c plus a 1c fraud adjustment on regulated debit, which is why the fixed cost looks large next to the UK. That part is interchange passed straight through, not our margin.</>
          : <>Interchange here is a <b>percentage only</b>, capped and with nothing per transaction, so the entire per-transaction cost is our acquirer's {mk.txn_minor}{minor}.</>}
        {' '}Amex is a three-party network, so its figure is a wholesale discount rate rather than interchange. Our acquirer's markup is all in above both, so scheme fees sit inside it and are never added again.
      </div>
    </div>
  );
}

function RateChannel({ ch, rates, setRate, channelTotal, avgTxn, splitSum, sym = '£', minor = 'p', m0 = (n) => fmtMoney0(n, 'GBP'), template = null }) {
  // Placeholders are the region's own costs. They used to be hardcoded UK
  // presets, so every empty cell on a US card quietly suggested a UK number.
  // With nothing set for a card type the cell shows a dash: an unknown cost
  // must look unknown, never like a figure someone has agreed.
  const ph = (v) => (v == null ? '—' : String(v));
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
              <th className="font-bold pb-1.5 px-1">Vol {sym}/mo</th>
              <th className="font-bold pb-1.5 px-1">Txns/mo</th>
              <th className="font-bold pb-1.5 px-1">Their %</th>
              <th className="font-bold pb-1.5 px-1">Our %</th>
              <th className="font-bold pb-1.5 px-1">Cost %</th>
              <th className="font-bold pb-1.5 px-1">Their txn {minor}</th>
              <th className="font-bold pb-1.5 px-1">Our txn {minor}</th>
              <th className="font-bold pb-1.5 px-1">Cost txn {minor}</th>
              <th className="font-bold pb-1.5 pl-2 text-right">Saves/mo</th>
            </tr>
          </thead>
          <tbody>
            {catsForChannel(ch.key).map(c => {
              const r = rates[c.key];
              const cost = costFor(template, c.key);
              const d = deriveRow(channelTotal, r.split, avgTxn);
              const calc = rowCalc({ ...r, ...d });
              return (
                <tr key={c.key}>
                  <td className="py-1 pr-2"><div className="text-sm text-paper leading-tight">{c.scheme}{c.tier ? <span className="text-dim"> {c.tier}</span> : ''}</div></td>
                  <td className="px-1"><input className={cell} value={r.split} onChange={e => setRate(c.key, 'split', e.target.value)} placeholder={ph(cost.split ?? c.split)} /></td>
                  <td className="px-1 text-right text-sm tabular-nums text-dim">{d.monthly_volume ? m0(d.monthly_volume) : '—'}</td>
                  <td className="px-1 text-right text-sm tabular-nums text-dim">{d.monthly_txns || '—'}</td>
                  <td className="px-1"><input className={cell} value={r.current_rate_pct} onChange={e => setRate(c.key, 'current_rate_pct', e.target.value)} placeholder="—" /></td>
                  <td className="px-1"><input className={cell} value={r.our_rate_pct} onChange={e => setRate(c.key, 'our_rate_pct', e.target.value)} placeholder="—" /></td>
                  <td className="px-1"><input title={costExplain(template, c.key, minor)} disabled={cost.offered === false} className={`${cell} text-dim disabled:opacity-40`} value={r.buy_rate_pct} onChange={e => setRate(c.key, 'buy_rate_pct', e.target.value)} placeholder={cost.offered === false ? 'n/a' : ph(cost.buy)} /></td>
                  <td className="px-1"><input className={cell} value={r.current_txn_fee} onChange={e => setRate(c.key, 'current_txn_fee', e.target.value)} placeholder="0" /></td>
                  <td className="px-1"><input className={cell} value={r.our_txn_fee} onChange={e => setRate(c.key, 'our_txn_fee', e.target.value)} placeholder="—" /></td>
                  <td className="px-1"><input title={costExplain(template, c.key, minor)} disabled={cost.offered === false} className={`${cell} text-dim disabled:opacity-40`} value={r.buy_txn_fee} onChange={e => setRate(c.key, 'buy_txn_fee', e.target.value)} placeholder={cost.offered === false ? 'n/a' : ph(cost.buyTxn)} /></td>
                  {/* Only a row we have actually priced can show a saving. Without
                      this an unpriced row reads our rate as zero and claims we save
                      the customer everything they pay, which is how a rate card
                      filled from a statement would flatter itself the moment it
                      was imported. The totals already skip unpriced rows. */}
                  <td className={`pl-2 text-right text-sm font-semibold tabular-nums ${calc.saving < -0.5 ? 'text-red-600' : 'text-emerald-600'}`}>{calc.vol && isPriced(r) ? m0(calc.saving) : '—'}</td>
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


/* What card processing costs us, per region — the base every rate card starts
 * from. Saving writes a NEW effective-dated row rather than editing the old
 * one, so a quote priced last month still explains itself. */
function CostTemplates({ profile, onEdit, editing, onClose }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('processing_cost_templates')
      .select('*').order('region_code').order('effective_from', { ascending: false });
    if (error) { setMissing(true); setLoading(false); return; }
    setMissing(false); setRows(data || []); setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const current = (region) => (rows.filter(r => r.region_code === region && r.effective_from <= new Date().toISOString().slice(0, 10))[0]) || null;

  if (loading) return null;
  return (
    <div className="glass-card rounded-2xl overflow-hidden">
      <div className="px-5 py-3.5 border-b border-bdr flex items-center gap-2">
        <h3 className="text-[13px] font-bold text-paper">What processing costs us</h3>
        <span className="text-xs text-dim">the base every rate card starts from</span>
      </div>
      {missing ? (
        <div className="px-5 py-4 text-xs text-amber-600">
          Cost templates are not set up on this database yet. Apply migration 108 and this section becomes editable.
        </div>
      ) : (
        <div className="divide-y divide-bdr/60">
          {['UK', 'US'].map(region => {
            const t = current(region);
            const versions = rows.filter(r => r.region_code === region).length;
            return (
              <div key={region} className="px-5 py-3 flex items-center gap-3">
                <span className="text-sm font-semibold text-paper w-8">{region}</span>
                {t ? (
                  <>
                    {/* The BUY rate, not just interchange: interchange alone is not
                        what a card costs us, and this line used to read as though it
                        were. It also hardcoded pence, on a row that can be American. */}
                    <span className="text-xs text-muted flex-1">
                      in-store {RATE_CATEGORIES.filter(c => c.channel === 'cp').map(c => {
                        const cost = costFor(t, c.key);
                        const u = region === 'US' ? 'c' : 'p';
                        return `${c.label} ${cost.buy == null ? '—' : `${cost.buy}% + ${cost.buyTxn}${u}`}`;
                      }).join(' · ')}
                    </span>
                    <span className="text-[10px] text-dim">from {new Date(t.effective_from + 'T00:00:00').toLocaleDateString('en-GB')} · {versions} version{versions === 1 ? '' : 's'}</span>
                  </>
                ) : (
                  <span className="text-xs text-amber-600 flex-1">Not set up, so {region} rate cards start with no costs and show no margin.</span>
                )}
                {canWrite && (
                  <button onClick={() => onEdit({ region, from: t })} className="px-3 py-1.5 text-xs font-semibold rounded-xl bg-ember/15 text-ember-deep border border-ember/25 hover:bg-ember/25">
                    {t ? 'New version' : 'Set up'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {editing && <CostTemplateModal region={editing.region} from={editing.from} profile={profile}
        onClose={onClose} onSaved={() => { onClose(); load(); }} />}
    </div>
  );
}

function CostTemplateModal({ region, from, profile, onClose, onSaved }) {
  const seed = () => Object.fromEntries(RATE_CATEGORIES.map(c => {
    const r = from?.rows?.[c.key];
    return [c.key, {
      ic_rate_pct: r?.ic_rate_pct ?? '', ic_txn_minor: r?.ic_txn_minor ?? '',
      scheme_rate_pct: r?.scheme_rate_pct ?? '', scheme_txn_minor: r?.scheme_txn_minor ?? '',
      not_offered: !!r?.not_offered,
      split_pct: r?.split_pct ?? c.split,
    }];
  }));
  const [vals, setVals] = useState(seed);
  // What our acquirer adds on every transaction, whatever the card.
  const [markup, setMarkup] = useState(() => ({
    rate_pct: from?.markup?.rate_pct ?? defaultMarkupFor(region).rate_pct,
    txn_minor: from?.markup?.txn_minor ?? defaultMarkupFor(region).txn_minor,
  }));
  const minor = region === 'US' ? 'c' : 'p';
  // Scheme fees only exist as their own line under IC++ pricing. Ours are inside
  // the acquirer's markup, so the columns stay out of the way unless a region
  // actually uses them, rather than inviting someone to double-count.
  const [showScheme, setShowScheme] = useState(() =>
    RATE_CATEGORIES.some(c => from?.rows?.[c.key]?.scheme_rate_pct != null || from?.rows?.[c.key]?.scheme_txn_minor != null));
  const [effective, setEffective] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const set = (k, field, v) => setVals(p => ({ ...p, [k]: { ...p[k], [field]: v } }));

  const save = async () => {
    setSaving(true); setErr('');
    const rows = Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, {
      ic_rate_pct: v.ic_rate_pct === '' ? null : Number(v.ic_rate_pct),
      ic_txn_minor: v.ic_txn_minor === '' ? null : Number(v.ic_txn_minor),
      scheme_rate_pct: v.scheme_rate_pct === '' ? null : Number(v.scheme_rate_pct),
      scheme_txn_minor: v.scheme_txn_minor === '' ? null : Number(v.scheme_txn_minor),
      not_offered: v.not_offered || undefined,
      split_pct: v.split_pct === '' ? null : Number(v.split_pct),
    }]));
    const { error } = await supabase.from('processing_cost_templates')
      .upsert({ region_code: region, effective_from: effective, rows,
        markup: { rate_pct: Number(markup.rate_pct) || 0, txn_minor: Number(markup.txn_minor) || 0 },
        note: note.trim() || null, created_by: profile.id },
        { onConflict: 'region_code,effective_from' });
    setSaving(false);
    if (error) { setErr(error.message); return; }
    onSaved();
  };

  const cell = "px-2 py-1 bg-card border border-bdr rounded-lg text-sm text-paper w-full focus:outline-none focus:border-ember";
  const label = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block";
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="glass-card rounded-2xl w-full max-w-2xl max-h-[85vh] overflow-y-auto">
        <div className="px-5 py-4 border-b border-bdr flex items-center gap-3">
          <div>
            <div className="text-base font-bold text-paper">{region} processing costs</div>
            <div className="text-[11px] text-dim">What each transaction costs us. What we charge is set per rate card, on top of this.</div>
          </div>
          <button onClick={onClose} className="ml-auto text-muted hover:text-paper"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
            <div><label className={label}>In force from</label>
              <input type="date" className={cell} value={effective} onChange={e => setEffective(e.target.value)} /></div>
            <div className="text-[11px] text-dim pb-2">Earlier quotes keep the costs they were priced on.</div>
          </div>
          <div className="glass-inner rounded-xl p-3">
            <div className={label}>Our acquirer's markup</div>
            <div className="grid grid-cols-[auto_auto_1fr] gap-2 items-end">
              <div className="w-24"><span className="text-[9px] text-dim block">Rate %</span>
                <input type="number" step="0.01" className={cell} value={markup.rate_pct} onChange={e => setMarkup(m => ({ ...m, rate_pct: e.target.value }))} /></div>
              <div className="w-24"><span className="text-[9px] text-dim block">Per txn ({minor})</span>
                <input type="number" step="0.1" className={cell} value={markup.txn_minor} onChange={e => setMarkup(m => ({ ...m, txn_minor: e.target.value }))} /></div>
              <div className="text-[11px] text-dim pb-2">Added to interchange on every card. Our cost is interchange + scheme fees + {markup.rate_pct || 0}% + {markup.txn_minor || 0}{minor}.</div>
            </div>
            <label className="text-[11px] text-dim mt-2 pt-2 border-t border-bdr flex items-start gap-2 cursor-pointer">
              <input type="checkbox" className="mt-0.5" checked={showScheme} onChange={e => setShowScheme(e.target.checked)} />
              <span>
                <b>Scheme fees charged separately (IC++)</b>. Ours are not: the markup above is all in above interchange, so Visa and Mastercard's assessments sit inside it. Only tick this if a settlement invoice shows scheme fees as their own line, or the cost will be counted twice.
              </span>
            </label>
          </div>
          {CHANNELS.map(ch => (
            <div key={ch.key}>
              <div className={label}>{ch.label} <span className="normal-case tracking-normal font-normal">({ch.sub})</span></div>
              <div className="space-y-1.5">
                {RATE_CATEGORIES.filter(c => c.channel === ch.key).map(c => (
                  <div key={c.key} className={`grid ${showScheme ? 'grid-cols-[minmax(0,1.15fr)_repeat(5,minmax(0,1fr))_minmax(0,1.3fr)]' : 'grid-cols-[minmax(0,1.15fr)_repeat(3,minmax(0,1fr))_minmax(0,1.3fr)]'} gap-2 items-center`}>
                    <label className="text-sm text-paper truncate flex items-center gap-1.5">
                      <input type="checkbox" checked={!vals[c.key].not_offered} onChange={e => set(c.key, 'not_offered', !e.target.checked)}
                        title="Untick if we do not sell this card type here — UK Amex is normally the merchant's own agreement" />
                      <span className={vals[c.key].not_offered ? 'line-through text-dim' : ''}>{c.label}</span>
                    </label>
                    <div><span className="text-[9px] text-dim block">Interchange %</span>
                      <input type="number" step="0.01" disabled={vals[c.key].not_offered} className={`${cell} disabled:opacity-40`} value={vals[c.key].ic_rate_pct ?? ''} onChange={e => set(c.key, 'ic_rate_pct', e.target.value)} /></div>
                    <div><span className="text-[9px] text-dim block">Interchange ({minor})</span>
                      <input type="number" step="0.1" disabled={vals[c.key].not_offered} className={`${cell} disabled:opacity-40`} value={vals[c.key].ic_txn_minor ?? ''} onChange={e => set(c.key, 'ic_txn_minor', e.target.value)} /></div>
                    {showScheme && <>
                      <div><span className="text-[9px] text-dim block">Scheme %</span>
                        <input type="number" step="0.001" disabled={vals[c.key].not_offered} className={`${cell} disabled:opacity-40`} value={vals[c.key].scheme_rate_pct ?? ''} onChange={e => set(c.key, 'scheme_rate_pct', e.target.value)} /></div>
                      <div><span className="text-[9px] text-dim block">Scheme ({minor})</span>
                        <input type="number" step="0.1" disabled={vals[c.key].not_offered} className={`${cell} disabled:opacity-40`} value={vals[c.key].scheme_txn_minor ?? ''} onChange={e => set(c.key, 'scheme_txn_minor', e.target.value)} /></div>
                    </>}
                    <div><span className="text-[9px] text-dim block">Card mix %</span>
                      <input type="number" step="1" className={cell} value={vals[c.key].split_pct ?? ''} onChange={e => set(c.key, 'split_pct', e.target.value)} /></div>
                    {/* The sum, as it is typed, so nobody has to do it in their head.
                        Computed by costFor, the same function the rate cards use, so
                        the editor and the card can never disagree by a rounding step. */}
                    <div className="text-right">
                      <span className="text-[9px] text-dim block">We buy at</span>
                      <span className="text-sm font-mono text-paper">{(() => {
                        const cost = costFor({ markup, rows: { [c.key]: vals[c.key] } }, c.key);
                        if (cost.offered === false) return <span className="text-dim text-[11px] font-sans">not sold here</span>;
                        return cost.buy == null ? '—' : `${cost.buy}% + ${cost.buyTxn}${minor}`;
                      })()}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
          <div><label className={label}>Note</label>
            <input className={cell} value={note} onChange={e => setNote(e.target.value)} placeholder="Why these changed, or where they came from" /></div>
          {err && <div className="text-xs text-red-600">{err}</div>}
        </div>
        <div className="px-5 py-4 border-t border-bdr flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm text-muted border border-bdr rounded-xl">Cancel</button>
          <button onClick={save} disabled={saving} className="px-5 py-2 bg-ember text-ink text-sm font-semibold rounded-xl disabled:opacity-50">{saving ? 'Saving…' : 'Save costs'}</button>
        </div>
      </div>
    </div>
  );
}

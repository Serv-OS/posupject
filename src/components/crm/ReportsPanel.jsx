import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { BarChart3, ArrowUpDown } from 'lucide-react';
import { money, invStatus } from './InvoicesPanel.jsx';

// ── date helpers ────────────────────────────────────────────────────────────
const iso = (d) => d.toISOString().slice(0, 10);
const monthKey = (dstr) => (dstr || '').slice(0, 7);           // 'YYYY-MM'
const monthLabel = (key) => { const [y, m] = key.split('-'); return new Date(+y, +m - 1, 1).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }); };
const startOfMonth = (d) => { const x = new Date(d); x.setDate(1); x.setHours(0, 0, 0, 0); return x; };
const addMonths = (d, n) => { const x = new Date(d); x.setMonth(x.getMonth() + n); return x; };
const inRange = (dstr, from, to) => { const d = (dstr || '').slice(0, 10); return !!d && d >= from && d <= to; };
const acctDate = (i) => (i.issue_date || i.created_at || '').slice(0, 10);   // when invoiced
const billed = (i) => Number(i.total || 0);
const owed = (i) => Math.max(0, Number(i.total || 0) - Number(i.amount_paid || 0));   // still outstanding
const collectedAmt = (i) => Number(i.amount_paid ?? i.total ?? 0);

// ── tiny UI atoms (match the codebase idiom) ────────────────────────────────
function Stat({ label, value, tone, sub }) {
  const color = tone === 'good' ? 'text-emerald-600' : tone === 'bad' ? 'text-red-600' : tone === 'accent' ? 'text-ember' : 'text-paper';
  return (
    <div className="glass-card rounded-2xl p-4">
      <div className="text-[10px] font-mono font-bold uppercase tracking-[0.14em] text-dim mb-1">{label}</div>
      <div className={`text-2xl font-bold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted mt-0.5">{sub}</div>}
    </div>
  );
}

const PRESETS = [
  ['This month', () => { const n = new Date(); return [iso(startOfMonth(n)), iso(n)]; }],
  ['Last month', () => { const n = new Date(); const s = startOfMonth(addMonths(n, -1)); const e = new Date(startOfMonth(n).getTime() - 86400000); return [iso(s), iso(e)]; }],
  ['This quarter', () => { const n = new Date(); const q = Math.floor(n.getMonth() / 3) * 3; return [iso(new Date(n.getFullYear(), q, 1)), iso(n)]; }],
  ['YTD', () => { const n = new Date(); return [iso(new Date(n.getFullYear(), 0, 1)), iso(n)]; }],
  ['Last 12m', () => { const n = new Date(); return [iso(startOfMonth(addMonths(n, -11))), iso(n)]; }],
];

export default function ReportsPanel({ profile, onNavigate }) {
  const isGBP = money(0).includes('£');
  const [invoices, setInvoices] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [out, setOut] = useState([]);          // money-out rows (paid bills + expenses)
  const [hasOut, setHasOut] = useState(false);
  const [loading, setLoading] = useState(true);
  const [companyId, setCompanyId] = useState('');
  const [sort, setSort] = useState({ key: 'invoiced', dir: 'desc' });
  const n0 = new Date();
  const [from, setFrom] = useState(() => iso(startOfMonth(addMonths(n0, -11))));
  const [to, setTo] = useState(() => iso(n0));

  useEffect(() => { (async () => {
    setLoading(true);
    const [inv, co] = await Promise.all([
      supabase.from('invoices')
        .select('id, invoice_number, total, amount_paid, status, paid_at, due_date, issue_date, created_at, company_id, location_id, company:companies(name), location:locations(name)')
        .order('issue_date', { ascending: false }),
      supabase.from('companies').select('id, name').order('name'),
    ]);
    setInvoices(inv.data || []);
    setCompanies(co.data || []);
    // Money-out (bills + expenses) only exists on the £ finance module. Query
    // guarded — the table simply won't exist on the construction CRMs.
    if (isGBP) {
      const rows = []; let exists = false;
      for (const t of ['bills', 'expenses']) {
        const r = await supabase.from(t).select('total, amount_paid, status, paid_at, company_id').eq('status', 'paid');
        if (!r.error) { exists = true; if (r.data) rows.push(...r.data); }
      }
      setOut(rows); setHasOut(exists);
    }
    setLoading(false);
  })(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const live = useMemo(() => invoices.filter(i => !['draft', 'void'].includes(i.status)), [invoices]);
  const scoped = useMemo(() => live.filter(i => !companyId || i.company_id === companyId), [live, companyId]);
  const outScoped = useMemo(() => out.filter(o => !companyId || o.company_id === companyId), [out, companyId]);

  // ── period + point-in-time roll-ups ──
  const invoicedPeriod = scoped.filter(i => inRange(acctDate(i), from, to)).reduce((s, i) => s + billed(i), 0);
  const collectedPeriod = scoped.filter(i => i.paid_at && inRange(i.paid_at, from, to)).reduce((s, i) => s + collectedAmt(i), 0);
  const outPeriod = outScoped.filter(o => o.paid_at && inRange(o.paid_at, from, to)).reduce((s, o) => s + Number(o.amount_paid ?? o.total ?? 0), 0);
  const outstandingNow = scoped.filter(i => ['sent', 'viewed'].includes(i.status)).reduce((s, i) => s + owed(i), 0);
  const overdueNow = scoped.filter(i => invStatus(i) === 'overdue').reduce((s, i) => s + owed(i), 0);

  // ── monthly series (invoiced vs collected [vs out]) across the range ──
  const months = useMemo(() => {
    const keys = []; let d = startOfMonth(new Date(from));
    const end = startOfMonth(new Date(to));
    while (d <= end && keys.length < 60) { keys.push(iso(d).slice(0, 7)); d = addMonths(d, 1); }
    return keys;
  }, [from, to]);
  const series = useMemo(() => months.map(mk => ({
    key: mk,
    invoiced: scoped.filter(i => monthKey(acctDate(i)) === mk).reduce((s, i) => s + billed(i), 0),
    collected: scoped.filter(i => i.paid_at && monthKey(i.paid_at) === mk).reduce((s, i) => s + collectedAmt(i), 0),
    out: outScoped.filter(o => o.paid_at && monthKey(o.paid_at) === mk).reduce((s, o) => s + Number(o.amount_paid ?? o.total ?? 0), 0),
  })), [months, scoped, outScoped]);
  const seriesMax = Math.max(1, ...series.map(m => Math.max(m.invoiced, m.collected)));

  // ── per-company breakdown ──
  const byCompany = useMemo(() => {
    const map = new Map();
    const bump = (id, name, patch) => {
      const cur = map.get(id) || { id, name: name || 'No company', invoiced: 0, collected: 0, outstanding: 0, overdue: 0 };
      map.set(id, { ...cur, ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, cur[k] + v])) });
    };
    for (const i of live) {
      if (companyId && i.company_id !== companyId) continue;
      const id = i.company_id || '—'; const name = i.company?.name;
      if (inRange(acctDate(i), from, to)) bump(id, name, { invoiced: billed(i) });
      if (i.paid_at && inRange(i.paid_at, from, to)) bump(id, name, { collected: collectedAmt(i) });
      if (['sent', 'viewed'].includes(i.status)) bump(id, name, { outstanding: owed(i) });
      if (invStatus(i) === 'overdue') bump(id, name, { overdue: owed(i) });
    }
    const rows = [...map.values()].filter(r => r.invoiced || r.collected || r.outstanding);
    const dir = sort.dir === 'asc' ? 1 : -1;
    rows.sort((a, b) => sort.key === 'name' ? a.name.localeCompare(b.name) * dir : (a[sort.key] - b[sort.key]) * dir);
    return rows;
  }, [live, companyId, from, to, sort]);

  // ── aged debtors (as of today) ──
  const aged = useMemo(() => {
    const buckets = [['Not due', 0], ['1–30', 0], ['31–60', 0], ['61–90', 0], ['90+', 0]];
    const today = iso(new Date());
    for (const i of scoped) {
      if (!['sent', 'viewed'].includes(i.status)) continue;
      const amt = owed(i); if (amt <= 0) continue;
      const due = (i.due_date || '').slice(0, 10);
      let idx = 0;
      if (due && due < today) {
        const days = Math.floor((new Date(today) - new Date(due)) / 86400000);
        idx = days <= 30 ? 1 : days <= 60 ? 2 : days <= 90 ? 3 : 4;
      }
      buckets[idx][1] += amt;
    }
    return buckets;
  }, [scoped]);
  const agedMax = Math.max(1, ...aged.map(b => b[1]));

  const applyPreset = (fn) => { const [f, t] = fn(); setFrom(f); setTo(t); };
  const sortBy = (key) => setSort(s => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }));
  const input = "px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper focus:outline-none focus:border-ember";
  const th = (key, label, align = 'right') => (
    <th onClick={() => sortBy(key)} className={`px-3 py-2 text-${align} cursor-pointer select-none hover:text-paper ${sort.key === key ? 'text-ember' : ''}`}>
      <span className="inline-flex items-center gap-1">{label}{sort.key === key && <ArrowUpDown size={10} />}</span>
    </th>
  );

  return (
    <div className="h-full flex flex-col overflow-y-auto">
      <div className="px-6 py-5 border-b border-bdr flex items-center gap-2.5 flex-wrap">
        <BarChart3 size={20} className="text-ember" />
        <div>
          <div className="text-xl font-bold text-paper">Reports</div>
          <div className="text-xs text-muted">Invoicing &amp; cash flow — what you're taking, have taken, and who owes</div>
        </div>
      </div>

      {/* Filters */}
      <div className="px-6 pt-4">
        <div className="glass-card rounded-2xl p-4 flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1 flex-wrap">
            {PRESETS.map(([lbl, fn]) => (
              <button key={lbl} onClick={() => applyPreset(fn)}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold text-muted hover:text-paper hover:bg-card transition">{lbl}</button>
            ))}
          </div>
          <div className="flex items-center gap-2 ml-auto flex-wrap">
            <input type="date" className={input + ' !py-1.5 text-xs'} value={from} onChange={e => setFrom(e.target.value)} />
            <span className="text-dim text-xs">→</span>
            <input type="date" className={input + ' !py-1.5 text-xs'} value={to} onChange={e => setTo(e.target.value)} />
            <select className={input + ' !py-1.5 text-xs'} value={companyId} onChange={e => setCompanyId(e.target.value)}>
              <option value="">All companies</option>
              {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        </div>
      </div>

      {loading ? <div className="p-10 text-center text-dim text-sm">Loading…</div> : (
      <div className="px-6 py-4 space-y-4">
        {/* KPI row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Stat label="Invoiced (period)" value={money(invoicedPeriod)} tone="accent" sub={`${from} → ${to}`} />
          <Stat label="Collected (period)" value={money(collectedPeriod)} tone="good" sub="Payments received" />
          <Stat label="Outstanding (now)" value={money(outstandingNow)} sub="Sent, not yet paid" />
          <Stat label="Overdue (now)" value={money(overdueNow)} tone="bad" sub="Past due date" />
        </div>
        {hasOut && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Stat label="Money out (period)" value={money(outPeriod)} tone="bad" sub="Bills + expenses paid" />
            <Stat label="Net cash flow (period)" value={money(collectedPeriod - outPeriod)} tone={collectedPeriod - outPeriod >= 0 ? 'good' : 'bad'} sub="Collected − paid out" />
          </div>
        )}

        {/* Revenue over time */}
        <div className="glass-card rounded-2xl p-5">
          <div className="flex items-center gap-3 mb-4">
            <h3 className="text-[13px] font-bold text-paper">Revenue over time</h3>
            <div className="flex items-center gap-3 ml-auto text-[11px] text-muted">
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-ember/70" /> Invoiced</span>
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-emerald-500" /> Collected</span>
              {hasOut && <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-red-400" /> Paid out</span>}
            </div>
          </div>
          <div className="flex items-end gap-2 h-40 overflow-x-auto">
            {series.map(m => (
              <div key={m.key} className="flex-1 min-w-[26px] flex flex-col items-center gap-1" title={`${monthLabel(m.key)}\nInvoiced ${money(m.invoiced)}\nCollected ${money(m.collected)}${hasOut ? `\nPaid out ${money(m.out)}` : ''}`}>
                <div className="w-full flex items-end justify-center gap-0.5 h-full">
                  <div className="w-1/3 rounded-t bg-ember/70" style={{ height: `${(m.invoiced / seriesMax) * 100}%`, minHeight: m.invoiced ? 2 : 0 }} />
                  <div className="w-1/3 rounded-t bg-emerald-500" style={{ height: `${(m.collected / seriesMax) * 100}%`, minHeight: m.collected ? 2 : 0 }} />
                  {hasOut && <div className="w-1/3 rounded-t bg-red-400/80" style={{ height: `${(m.out / seriesMax) * 100}%`, minHeight: m.out ? 2 : 0 }} />}
                </div>
                <div className="text-[9px] text-dim font-mono whitespace-nowrap">{monthLabel(m.key)}</div>
              </div>
            ))}
            {series.length === 0 && <div className="text-dim text-sm italic m-auto">No data in range.</div>}
          </div>
        </div>

        {/* Per-company breakdown */}
        <div className="glass-card rounded-2xl overflow-hidden">
          <div className="px-5 py-3 border-b border-bdr flex items-center gap-2">
            <h3 className="text-[13px] font-bold text-paper">Per company</h3>
            <span className="text-xs text-dim font-mono">({byCompany.length})</span>
            <span className="text-[11px] text-dim ml-2">invoiced &amp; collected in period · outstanding &amp; overdue now</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead>
                <tr className="text-[10px] font-mono font-bold uppercase tracking-[0.12em] text-dim border-b border-bdr">
                  {th('name', 'Company', 'left')}{th('invoiced', 'Invoiced')}{th('collected', 'Collected')}{th('outstanding', 'Outstanding')}{th('overdue', 'Overdue')}
                </tr>
              </thead>
              <tbody>
                {byCompany.map(r => (
                  <tr key={r.id} onClick={() => r.id !== '—' && onNavigate?.('company', r.id)}
                    className="border-b border-bdr/60 hover:bg-card/50 cursor-pointer">
                    <td className="px-3 py-2 text-paper font-medium">{r.name}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(r.invoiced)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-emerald-600">{money(r.collected)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(r.outstanding)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${r.overdue > 0 ? 'text-red-600 font-semibold' : 'text-dim'}`}>{money(r.overdue)}</td>
                  </tr>
                ))}
                {byCompany.length === 0 && <tr><td colSpan={5} className="px-3 py-8 text-center text-dim text-sm italic">No activity in range.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        {/* Aged debtors */}
        <div className="glass-card rounded-2xl p-5">
          <h3 className="text-[13px] font-bold text-paper mb-1">Aged debtors</h3>
          <div className="text-[11px] text-dim mb-4">Unpaid balance by how long it's been due (as of today)</div>
          <div className="space-y-2.5">
            {aged.map(([lbl, amt]) => (
              <div key={lbl} className="flex items-center gap-3">
                <div className="w-16 text-xs text-muted font-mono shrink-0">{lbl}</div>
                <div className="flex-1 h-3.5 rounded bg-card overflow-hidden">
                  <div className={`h-full rounded ${lbl === 'Not due' ? 'bg-ember/50' : lbl === '90+' ? 'bg-red-500' : 'bg-amber-400'}`} style={{ width: `${(amt / agedMax) * 100}%` }} />
                </div>
                <div className="w-24 text-right text-sm tabular-nums text-paper shrink-0">{money(amt)}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
      )}
    </div>
  );
}

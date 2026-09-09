import { useEffect, useState, useCallback, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import { FileText, Download, AlertTriangle } from 'lucide-react';
import { gbp2, round2, fmtMoney, sumByCurrency, fmtByCurrency, CURRENCIES } from '../../lib/money.js';
import { computeVatReturn, vatReturnCsv } from '../../lib/vatReturn.js';
import { isUkVat } from '../../lib/branding.js';

const fmtD = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }) : '—';
const startOfQuarter = () => { const d = new Date(); const m = Math.floor(d.getMonth() / 3) * 3; return new Date(d.getFullYear(), m, 1).toISOString().slice(0, 10); };
const downloadCsv = (text, filename) => {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
};

export default function VatReturnPanel({ profile }) {
  const uk = isUkVat();
  const [tab, setTab] = useState('vat');
  const [from, setFrom] = useState(startOfQuarter());
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [b, e] = await Promise.all([
      supabase.from('bills').select('*, supplier:inv_suppliers(name), category:expense_categories(label)')
        .neq('status', 'void').gte('issue_date', from).lte('issue_date', to),
      supabase.from('expenses').select('*, category:expense_categories(label), submitter:profiles!expenses_submitter_id_fkey(display_name)')
        .in('status', ['approved', 'paid']).gte('expense_date', from).lte('expense_date', to),
    ]);
    const bills = (b.data || []).map(x => ({
      source: 'bill', ref: `BILL-${x.bill_number}`, date: x.issue_date, supplier: x.supplier?.name || x.description || '—',
      category: x.category?.label || 'Uncategorised', net: Number(x.subtotal || 0), tax_amount: Number(x.tax_amount || 0),
      vat_reclaimable: x.vat_reclaimable, has_vat_invoice: x.has_vat_invoice, vat_reclaim_amount: x.vat_reclaim_amount,
      cost_context: x.cost_context, total: Number(x.total || 0), currency: x.currency || 'GBP',
    }));
    const exps = (e.data || []).map(x => ({
      source: 'expense', ref: `EXP-${x.expense_number}`, date: x.expense_date, supplier: x.submitter?.display_name || 'Staff',
      category: x.category?.label || (x.type === 'mileage' ? 'Mileage' : 'Uncategorised'), net: Number(x.subtotal || 0), tax_amount: Number(x.tax_amount || 0),
      vat_reclaimable: x.vat_reclaimable, has_vat_invoice: x.has_vat_invoice, vat_reclaim_amount: x.vat_reclaim_amount,
      cost_context: x.cost_context, total: Number(x.total || 0), currency: x.currency || 'GBP',
    }));
    setItems([...bills, ...exps]); setLoading(false);
  }, [from, to]);
  useEffect(() => { load(); }, [load]);

  // HMRC input VAT is sterling only: a USD bill's tax is US sales tax, never Box 4, and
  // £ + $ must never be added. Only GBP records reach the reclaim maths + the MTD CSV.
  const vatItems = useMemo(() => items.filter(i => i.currency === 'GBP'), [items]);
  const vat = useMemo(() => computeVatReturn(vatItems), [vatItems]);
  // spend reports — every figure is per currency ({ GBP, USD }), never one number across both.
  // A zero has no currency of its own: a zero group keeps the one it was summed in, and an
  // empty subset takes the screen's currency when everything on screen is one currency, so a
  // US-only period never shows a stray "£0.00" (fmtByCurrency's fallback) for "Deal costs".
  const screenCcy = useMemo(() => { const s = new Set(items.map(i => i.currency)); return s.size === 1 ? [...s][0] : 'GBP'; }, [items]);
  const fmtSums = (sums) => {
    if (CURRENCIES.some(c => sums[c])) return fmtByCurrency(sums);
    const keys = Object.keys(sums);
    return fmtMoney(0, keys.length === 1 ? keys[0] : screenCcy);
  };
  const spend = (rows) => fmtSums(sumByCurrency(rows, i => i.total));
  // Ranked by the largest single-currency figure: ordering only, nothing is added or converted.
  const rank = (sums) => Math.max(0, ...Object.values(sums));
  const spendBy = (key) => {
    const groups = {};
    for (const it of items) { const k = it[key] || '—'; if (!groups[k]) groups[k] = []; groups[k].push(it); }
    return Object.entries(groups).map(([k, rows]) => [k, sumByCurrency(rows, i => i.total)]).sort((a, b) => rank(b[1]) - rank(a[1]));
  };
  // CSV: one row per key per currency, so a spreadsheet never sees £ and $ in one cell.
  const spendCsv = (label, rows) => toCsv([label, 'Currency', 'Spend'], rows.flatMap(([k, sums]) => CURRENCIES.filter(c => c in sums).map(c => [k, c, round2(sums[c])])));

  const input = "px-3 py-1.5 bg-card border border-bdr rounded-xl text-sm text-paper";

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-5 border-b border-bdr flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2.5">
          <FileText size={20} className="text-ember" />
          <div>
            <div className="text-xl font-bold text-paper">VAT &amp; reports</div>
            <div className="text-xs text-muted">Reclaim preparation + expense reporting</div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {uk && <div className="flex items-center gap-0.5 bg-card rounded-xl p-0.5">
            <button onClick={() => setTab('vat')} className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${tab === 'vat' ? 'bg-ember text-white' : 'text-muted'}`}>VAT reclaim</button>
            <button onClick={() => setTab('reports')} className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${tab === 'reports' ? 'bg-ember text-white' : 'text-muted'}`}>Reports</button>
          </div>}
          <input type="date" className={input} value={from} onChange={e => setFrom(e.target.value)} />
          <span className="text-dim text-sm">→</span>
          <input type="date" className={input} value={to} onChange={e => setTo(e.target.value)} />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-3xl mx-auto space-y-5">
          {loading ? <div className="p-6 text-center text-dim text-sm">Loading…</div>
            : (!uk || tab === 'reports') ? (
              <>
                <div className="grid grid-cols-3 gap-4">
                  <Stat label="Total spend" value={spend(items)} sub={`${items.length} records`} />
                  <Stat label="Deal costs" value={spend(items.filter(i => i.cost_context === 'deal'))} />
                  <Stat label="Ongoing costs" value={spend(items.filter(i => i.cost_context !== 'deal'))} />
                </div>
                <Breakdown title="By category" rows={spendBy('category')} fmt={fmtSums} onExport={() => downloadCsv(spendCsv('Category', spendBy('category')), `spend-by-category_${from}_${to}.csv`)} />
                <Breakdown title="By supplier / staff" rows={spendBy('supplier')} fmt={fmtSums} onExport={() => downloadCsv(spendCsv('Supplier', spendBy('supplier')), `spend-by-supplier_${from}_${to}.csv`)} />
              </>
            ) : (
              <>
                <div className="glass-card rounded-2xl p-5 text-center" style={{ background: 'rgba(16,185,129,0.06)' }}>
                  <div className="text-[10px] font-mono font-bold uppercase tracking-[0.16em] text-emerald-700 mb-1">Reclaimable input VAT · Box 4</div>
                  <div className="text-4xl font-bold tabular-nums text-emerald-600">{gbp2(vat.box4)}</div>
                  <div className="text-xs text-muted mt-1">VAT period {fmtD(from)} → {fmtD(to)} · {vat.count} records</div>
                  <button onClick={() => downloadCsv(vatReturnCsv(vatItems, from, to), `vat-reclaim_${from}_${to}.csv`)} className="btn-glass mt-3 px-4 py-2 rounded-xl text-sm font-semibold inline-flex items-center gap-1.5"><Download size={15} /> Export (MTD-ready CSV)</button>
                </div>

                {vat.flaggedCount > 0 && (
                  <div className="glass-card rounded-2xl overflow-hidden border border-amber-300">
                    <div className="px-5 py-3 border-b border-bdr flex items-center gap-2 text-amber-700">
                      <AlertTriangle size={15} /><h3 className="text-[13px] font-bold">Missing a valid VAT invoice — {gbp2(vat.flaggedVat)} not yet reclaimable</h3>
                    </div>
                    <div className="divide-y divide-bdr/60">
                      {vat.flagged.map((it, i) => (
                        <div key={i} className="px-5 py-2 flex items-center gap-3 text-sm">
                          <span className="font-mono text-xs text-dim w-20 shrink-0">{it.ref}</span>
                          <span className="flex-1 truncate text-paper">{it.supplier} · {it.category}</span>
                          <span className="tabular-nums text-amber-700">{gbp2(it.tax_amount)}</span>
                        </div>
                      ))}
                    </div>
                    <div className="px-5 py-2 text-[11px] text-dim">Chase a valid VAT invoice (showing the supplier's VAT number) before reclaiming these.</div>
                  </div>
                )}

                {/* HMRC figures — GBP by construction (vatItems), so the bare-£ formatter is the truth here */}
                <Breakdown title="Reclaimable by category" rows={Object.entries(vat.byCategory).sort((a, b) => b[1] - a[1])} fmt={gbp2} />
                <Breakdown title="Reclaimable by supplier" rows={Object.entries(vat.bySupplier).sort((a, b) => b[1] - a[1])} fmt={gbp2} />
              </>
            )}
          <div className="text-[11px] text-dim leading-relaxed border-t border-bdr pt-3">
            {uk
              ? <><strong>Preparation aid only</strong> — not a filed VAT return and not tax advice. Verify every figure with your accountant before submitting to HMRC. Records are retained for 6 years.</>
              : <><strong>Preparation aid only</strong> — not a tax filing and not tax advice. Verify every figure with your accountant before filing.</>}
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, sub }) {
  return (
    <div className="glass-card rounded-2xl p-4">
      <div className="text-[10px] font-mono font-bold uppercase tracking-[0.14em] text-dim mb-1">{label}</div>
      <div className="text-2xl font-bold tabular-nums text-paper">{value}</div>
      {sub && <div className="text-[11px] text-dim mt-0.5">{sub}</div>}
    </div>
  );
}

// rows: [key, value] — value is a per-currency sums object by default, or a plain GBP number when fmt={gbp2}.
function Breakdown({ title, rows, onExport, fmt = fmtByCurrency }) {
  return (
    <div className="glass-card rounded-2xl overflow-hidden">
      <div className="px-5 py-3 border-b border-bdr flex items-center gap-2">
        <h3 className="text-[13px] font-bold text-paper">{title}</h3>
        <span className="text-xs text-dim font-mono">({rows.length})</span>
        {onExport && <button onClick={onExport} className="ml-auto text-xs text-ember hover:text-ember-deep font-medium inline-flex items-center gap-1"><Download size={12} /> CSV</button>}
      </div>
      <div className="divide-y divide-bdr/60">
        {rows.length === 0 ? <div className="p-6 text-center text-dim text-sm italic">Nothing in this period.</div>
          : rows.map(([k, v]) => (
            <div key={k} className="px-5 py-2 flex items-center gap-3 text-sm">
              <span className="flex-1 truncate text-paper">{k}</span>
              <span className="tabular-nums font-semibold text-paper">{fmt(v)}</span>
            </div>
          ))}
      </div>
    </div>
  );
}

function toCsv(head, rows) {
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return '﻿' + [head, ...rows].map(r => r.map(esc).join(',')).join('\r\n');
}

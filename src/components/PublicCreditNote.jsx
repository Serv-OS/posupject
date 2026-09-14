import { useEffect, useState } from 'react';
import { currencyLocale, fmtMoney, taxLabelFor } from '../lib/money';
import { creditNoteLabel, creditNoteStatusLabel, creditTotals } from '../lib/creditNotes';
import { creditNotePdf } from '../lib/invoicePdf';
import { Badge, Page } from './PublicInvoice.jsx';

// Public hosted credit note page (/c/<token>), linked from the credit note
// email and from the invoice page. Same look as the invoice page; the customer
// can read it and download it as a PDF. credit-note-public answers 404 for a
// cancelled note, so an old link never promises a credit that was taken back.
//
// jsPDF comes in with a normal import, not import() on click: the catch-all
// rewrite in vercel.json serves index.html for a chunk that went stale after a
// deploy, and the download would fail.

const FN = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;
const money = (v, currency = 'GBP') => fmtMoney(v, currency);
// A bare date is read as local midnight so it never shows as the day before.
const fmtDate = (d, locale = 'en-GB') => {
  if (!d) return '';
  const date = new Date(String(d).length <= 10 ? `${d}T00:00:00` : d);
  return isNaN(date) ? String(d) : date.toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' });
};

const STATUS_BADGE = {
  Issued: { bg: '#e0e7ff', color: '#3730a3' },
  'Refund owed': { bg: '#fef3c7', color: '#92400e' },
  Refunded: { bg: '#d1fae5', color: '#065f46' },
  Cancelled: { bg: '#fee2e2', color: '#991b1b' },
};
// How the refund went back, as the end of a sentence. 'Other' says nothing.
const REFUND_HOW = { 'Bank transfer': ' by bank transfer', 'Card refund': ' as a card refund' };

export default function PublicCreditNote({ token }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pdfBusy, setPdfBusy] = useState(false);

  useEffect(() => { (async () => {
    try {
      const res = await fetch(`${FN}/credit-note-public?token=${encodeURIComponent(token)}`);
      const d = await res.json();
      if (!res.ok) setError(res.status === 404 ? 'Credit note not found.' : (d.error || 'Could not load this credit note.'));
      else setData(d);
    } catch { setError('Could not load this credit note.'); }
    setLoading(false);
  })(); }, [token]);

  if (loading) return <Page><div className="text-center text-slate-400 py-20">Loading credit note…</div></Page>;
  if (error && !data) return <Page><div className="text-center text-slate-600 py-20">{error}</div></Page>;

  const note = data.credit_note || {};
  const inv = data.invoice || {};
  const { company, contact, location } = data;
  const seller = data.seller || {};
  const items = data.items || [];
  const accent = seller.accent || '#15C26A';
  const currency = note.currency || inv.currency || 'GBP';
  const locale = currencyLocale(currency);
  const taxLabel = taxLabelFor(currency);
  const number = note.number ?? note.credit_number;
  const label = creditNoteLabel(number);
  const invLabel = inv.number != null && inv.number !== '' ? `INV-${inv.number}` : '';
  const status = creditNoteStatusLabel(note);
  const cancelled = note.status === 'cancelled';
  // The stored figures are what was issued; the lines only stand in if missing.
  const sums = creditTotals(items);
  const subtotal = note.subtotal ?? sums.subtotal;
  const taxAmount = note.tax_amount ?? sums.tax_amount;
  const total = note.total ?? sums.total;
  const invBalance = inv.balance_due == null ? null : Math.max(0, Number(inv.balance_due) || 0);

  const downloadPdf = async () => {
    setPdfBusy(true); setError('');
    try {
      await creditNotePdf({
        note: { ...note, credit_number: number, subtotal, tax_amount: taxAmount, total },
        lines: items,
        invoice: { invoice_number: inv.number, issue_date: inv.issue_date },
        seller,
        billTo: {
          companyName: company?.name, companyAddress: company?.address,
          contactName: contact?.name, contactEmail: contact?.email,
          locationName: location?.name, locationAddress: location?.address,
        },
        fmt: (v) => money(v, currency), taxLabel, dateLocale: locale,
      });
    } catch { setError('Could not make the PDF. Please try again.'); }
    setPdfBusy(false);
  };

  const pad = 'px-5 sm:px-8';

  return (
    <Page>
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
        {/* Header */}
        <div className={`${pad} py-6 flex items-start justify-between gap-4 border-b border-slate-100`}>
          <div className="min-w-0">
            {seller.logo_url
              ? <img src={seller.logo_url} alt={seller.name} className="h-12 max-w-full object-contain mb-2" />
              : <div className="text-2xl font-bold text-slate-900 mb-1 break-words">{seller.name}</div>}
            <div className="text-xs text-slate-500 whitespace-pre-line break-words">{[seller.address, seller.email, seller.phone].filter(Boolean).join('\n')}</div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-xs font-bold uppercase tracking-widest text-slate-400">Credit note</div>
            <div className={`text-xl font-bold text-slate-900 ${cancelled ? 'line-through' : ''}`}>{label}</div>
            <div className="text-xs text-slate-500 mt-1">Issued {fmtDate(note.issue_date, locale)}</div>
            {invLabel && <div className="text-xs text-slate-500">For invoice {invLabel}</div>}
            <div className="mt-2">
              <Badge {...(STATUS_BADGE[status] || STATUS_BADGE.Issued)}>{status}</Badge>
            </div>
          </div>
        </div>

        {/* Credited to */}
        {(company || contact || location) && (
          <div className={`${pad} py-4 border-b border-slate-100`}>
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">Credited to</div>
            <div className="text-sm text-slate-800 font-semibold">{company?.name || contact?.name}</div>
            {location && <div className="text-xs text-slate-500">{location.name}{location.address ? ` · ${location.address}` : ''}</div>}
            {company?.address && <div className="text-xs text-slate-500">{company.address}</div>}
            {contact && company && <div className="text-xs text-slate-500">Attn: {contact.name}</div>}
          </div>
        )}

        {/* Reason */}
        {note.reason && (
          <div className={`${pad} py-4 border-b border-slate-100`}>
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">Reason</div>
            <div className="text-sm text-slate-700 whitespace-pre-wrap break-words">{note.reason}</div>
          </div>
        )}

        {/* Lines. On a phone the price and tax move under the item name so the
            amounts keep their own column. */}
        <div className={`${pad} py-5`}>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] font-bold uppercase tracking-widest text-slate-400 border-b border-slate-100">
                <th className="text-left py-2 font-bold">Item</th>
                <th className="text-right py-2 font-bold w-12">Qty</th>
                <th className="hidden sm:table-cell text-right py-2 font-bold w-24">Price</th>
                <th className="hidden sm:table-cell text-right py-2 font-bold w-16">{taxLabel}</th>
                <th className="text-right py-2 font-bold w-24">Amount</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={it.id || i} className="border-b border-slate-50 align-top">
                  <td className="py-2.5 pr-2">
                    <div className="text-slate-800 font-medium break-words">{it.name}</div>
                    {it.description && <div className="text-xs text-slate-500 break-words">{it.description}</div>}
                    <div className="sm:hidden text-xs text-slate-500 tabular-nums">
                      {money(it.unit_price, currency)} each · {Number(it.tax_rate ?? 0)}% {taxLabel}
                    </div>
                  </td>
                  <td className="py-2.5 text-right text-slate-600 tabular-nums">{Number(it.qty)}</td>
                  <td className="hidden sm:table-cell py-2.5 text-right text-slate-600 tabular-nums">{money(it.unit_price, currency)}</td>
                  <td className="hidden sm:table-cell py-2.5 text-right text-slate-600 tabular-nums">{Number(it.tax_rate ?? 0)}%</td>
                  <td className="py-2.5 text-right text-slate-800 font-medium tabular-nums">{money(Number(it.qty) * Number(it.unit_price), currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Totals */}
          <div className="flex justify-end mt-4">
            <div className="w-full max-w-[15rem] space-y-1.5 text-sm">
              <div className="flex justify-between text-slate-500"><span>Subtotal</span><span className="tabular-nums">{money(subtotal, currency)}</span></div>
              <div className="flex justify-between text-slate-500"><span>{taxLabel}</span><span className="tabular-nums">{money(taxAmount, currency)}</span></div>
              <div className="flex justify-between text-base font-bold text-slate-900 pt-1.5 border-t border-slate-200"><span>Total credited</span><span className="tabular-nums">{money(total, currency)}</span></div>
            </div>
          </div>
        </div>

        {/* What it means for the customer, then the download */}
        <div className={`${pad} pb-6 space-y-3`}>
          {cancelled ? (
            <div className="rounded-xl p-4 text-center font-semibold" style={{ background: '#fef2f2', color: '#991b1b' }}>
              This credit note was cancelled. It no longer reduces the invoice.
            </div>
          ) : note.refund_status === 'owed' ? (
            <div className="rounded-xl p-4 text-center" style={{ background: '#fffbeb', color: '#92400e' }}>
              <div className="font-semibold">Refund owed to you: {money(note.refund_due, currency)}</div>
              <div className="text-xs mt-1">You had already paid for what this note credits, so this will be paid back to you.</div>
            </div>
          ) : note.refund_status === 'refunded' ? (
            <div className="rounded-xl p-4 text-center font-semibold" style={{ background: '#ecfdf5', color: '#065f46' }}>
              ✓ Refunded {money(note.refund_due, currency)}{note.refunded_at ? ` on ${fmtDate(note.refunded_at, locale)}` : ''}{REFUND_HOW[note.refund_method] || ''}
            </div>
          ) : null}

          {!cancelled && invLabel && invBalance != null && (invBalance > 0 || !inv.paid) && (
            <div className="rounded-xl p-4 bg-slate-50 flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm text-slate-700">
                {invBalance > 0
                  ? <>Left to pay on {invLabel}: <span className="font-semibold tabular-nums">{money(invBalance, currency)}</span></>
                  : <>Nothing left to pay on {invLabel}.</>}
              </div>
              {inv.public_token && (
                <a href={`/i/${encodeURIComponent(inv.public_token)}`} className="text-sm font-semibold" style={{ color: accent }}>
                  View invoice
                </a>
              )}
            </div>
          )}

          <button onClick={downloadPdf} disabled={pdfBusy}
            className="w-full py-3.5 rounded-xl text-white font-bold text-base transition hover:opacity-90 disabled:opacity-50"
            style={{ background: accent }}>
            {pdfBusy ? 'Making PDF…' : 'Download PDF'}
          </button>
          {error && <div className="text-sm text-red-600 text-center">{error}</div>}
        </div>
      </div>
      <div className="text-center text-[10px] text-slate-300 pt-3">Powered by ServOS</div>
    </Page>
  );
}

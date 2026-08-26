import { useEffect, useState } from 'react';
import { fmtMoney, taxLabelFor } from '../lib/money';

// Public hosted invoice page (/i/<token>). Branded from support_settings,
// customer pays by card via Stripe Checkout.

const FN = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;
const money = (v, currency = 'GBP') => fmtMoney(v, currency);
const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '';

export default function PublicInvoice({ token }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [paying, setPaying] = useState(false);
  const justPaid = new URLSearchParams(window.location.search).get('paid') === '1';

  useEffect(() => { (async () => {
    try {
      const res = await fetch(`${FN}/invoice-public?token=${encodeURIComponent(token)}`);
      const d = await res.json();
      if (!res.ok) setError(d.error || 'Invoice not found.');
      else setData(d);
    } catch { setError('Could not load this invoice.'); }
    setLoading(false);
  })(); }, [token]);

  const pay = async () => {
    setPaying(true); setError('');
    try {
      const res = await fetch(`${FN}/invoice-checkout`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, origin: window.location.origin }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Could not start payment.');
      window.location.href = d.url;
      return;
    } catch (e) { setError(e.message); }
    setPaying(false);
  };

  if (loading) return <Page><div className="text-center text-slate-400 py-20">Loading invoice…</div></Page>;
  if (error && !data) return <Page><div className="text-center text-slate-600 py-20">{error}</div></Page>;

  const { invoice: inv, seller, company, contact, location, items } = data;
  const accent = seller.accent || '#15C26A';
  const isPaid = inv.status === 'paid' || justPaid;
  const currency = inv.currency || 'GBP';
  const taxLabel = taxLabelFor(currency);

  return (
    <Page>
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
        {/* Header */}
        <div className="px-8 py-6 flex items-start justify-between gap-4 border-b border-slate-100">
          <div>
            {seller.logo_url
              ? <img src={seller.logo_url} alt={seller.name} className="h-12 object-contain mb-2" />
              : <div className="text-2xl font-bold text-slate-900 mb-1">{seller.name}</div>}
            <div className="text-xs text-slate-500 whitespace-pre-line">{[seller.address, seller.email, seller.phone].filter(Boolean).join('\n')}</div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-xs font-bold uppercase tracking-widest text-slate-400">Invoice</div>
            <div className="text-xl font-bold text-slate-900">INV-{inv.number}</div>
            <div className="text-xs text-slate-500 mt-1">Issued {fmtDate(inv.issue_date)}</div>
            {inv.due_date && <div className="text-xs text-slate-500">Due {fmtDate(inv.due_date)}</div>}
            {inv.po_number && <div className="text-xs text-slate-500">PO {inv.po_number}</div>}
            <div className="mt-2">
              {isPaid
                ? <Badge bg="#d1fae5" color="#065f46">Paid</Badge>
                : inv.overdue
                  ? <Badge bg="#fee2e2" color="#991b1b">Overdue</Badge>
                  : <Badge bg="#fef3c7" color="#92400e">Awaiting payment</Badge>}
            </div>
          </div>
        </div>

        {/* Bill to */}
        {(company || contact || location) && (
          <div className="px-8 py-4 border-b border-slate-100">
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">Billed to</div>
            <div className="text-sm text-slate-800 font-semibold">{company?.name || contact?.name}</div>
            {location && <div className="text-xs text-slate-500">{location.name}{location.address ? ` · ${location.address}` : ''}</div>}
            {company?.address && <div className="text-xs text-slate-500">{company.address}</div>}
            {contact && company && <div className="text-xs text-slate-500">Attn: {contact.name}</div>}
          </div>
        )}

        {/* Lines */}
        <div className="px-8 py-5">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] font-bold uppercase tracking-widest text-slate-400 border-b border-slate-100">
                <th className="text-left py-2 font-bold">Item</th>
                <th className="text-right py-2 font-bold w-14">Qty</th>
                <th className="text-right py-2 font-bold w-24">Price</th>
                <th className="text-right py-2 font-bold w-14">{taxLabel}</th>
                <th className="text-right py-2 font-bold w-24">Amount</th>
              </tr>
            </thead>
            <tbody>
              {items.map(it => (
                <tr key={it.id} className="border-b border-slate-50">
                  <td className="py-2.5">
                    <div className="text-slate-800 font-medium">{it.name}</div>
                    {it.description && <div className="text-xs text-slate-500">{it.description}</div>}
                  </td>
                  <td className="py-2.5 text-right text-slate-600 tabular-nums">{Number(it.qty)}</td>
                  <td className="py-2.5 text-right text-slate-600 tabular-nums">{money(it.unit_price, currency)}</td>
                  <td className="py-2.5 text-right text-slate-600 tabular-nums">{Number(it.tax_rate ?? 0)}%</td>
                  <td className="py-2.5 text-right text-slate-800 font-medium tabular-nums">{money(Number(it.qty) * Number(it.unit_price), currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Totals */}
          <div className="flex justify-end mt-4">
            <div className="w-60 space-y-1.5 text-sm">
              <div className="flex justify-between text-slate-500"><span>Subtotal</span><span className="tabular-nums">{money(inv.subtotal, currency)}</span></div>
              <div className="flex justify-between text-slate-500"><span>{taxLabel}</span><span className="tabular-nums">{money(inv.tax_amount, currency)}</span></div>
              <div className="flex justify-between text-base font-bold text-slate-900 pt-1.5 border-t border-slate-200"><span>Total due</span><span className="tabular-nums">{money(inv.total, currency)}</span></div>
            </div>
          </div>
        </div>

        {/* Pay */}
        <div className="px-8 pb-6">
          {isPaid ? (
            <div className="rounded-xl p-4 text-center font-semibold" style={{ background: '#ecfdf5', color: '#065f46' }}>
              ✓ Paid{inv.paid_at ? ` on ${fmtDate(inv.paid_at.slice(0, 10))}` : ''} — thank you!
            </div>
          ) : (
            <>
              <button onClick={pay} disabled={paying}
                className="w-full py-3.5 rounded-xl text-white font-bold text-base transition hover:opacity-90 disabled:opacity-50"
                style={{ background: accent }}>
                {paying ? 'Redirecting…' : `Pay ${money(inv.total, currency)} by card`}
              </button>
              {error && <div className="text-sm text-red-600 text-center mt-2">{error}</div>}
              <div className="text-[11px] text-slate-400 text-center mt-2">Secure card payment powered by Stripe</div>
            </>
          )}
        </div>

        {/* Terms */}
        {(inv.terms || inv.notes) && (
          <div className="px-8 py-4 bg-slate-50 border-t border-slate-100">
            {inv.notes && <div className="text-xs text-slate-600 mb-2 whitespace-pre-wrap">{inv.notes}</div>}
            {inv.terms && <>
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">Terms</div>
              <div className="text-[11px] text-slate-500 whitespace-pre-wrap leading-relaxed">{inv.terms}</div>
            </>}
          </div>
        )}
      </div>
      <div className="text-center text-[10px] text-slate-300 pt-3">Powered by ServOS</div>
    </Page>
  );
}

function Page({ children }) {
  return (
    <div className="min-h-screen w-full bg-slate-100 py-8 px-4">
      <div className="max-w-2xl mx-auto">{children}</div>
    </div>
  );
}
function Badge({ bg, color, children }) {
  return <span className="inline-block px-2.5 py-1 rounded-lg text-[11px] font-bold uppercase tracking-wide" style={{ background: bg, color }}>{children}</span>;
}

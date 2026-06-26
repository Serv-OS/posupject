import { useEffect, useRef, useState } from 'react';
import { LogoLockup } from './ServOSLogo.jsx';

const FN = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;
const money = (v) => `£${Number(v || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const money0 = (v) => `£${Number(v || 0).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`;
const pct = (v) => v == null ? '—' : `${Number(v).toFixed(2)}%`;
const CAT = { hardware: 'Hardware', services: 'Services', saas: 'SaaS plan', payments: 'Payments' };
const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '';

export default function PublicQuote({ token }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const paid = new URLSearchParams(window.location.search).get('paid') === '1';

  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const hasSig = useRef(false);

  useEffect(() => { (async () => {
    try {
      const res = await fetch(`${FN}/quote-public?token=${encodeURIComponent(token)}`);
      const d = await res.json();
      if (!res.ok) setError(d.error || 'Quote not found.');
      else { setData(d); setName(d.contact?.name || ''); }
    } catch { setError('Could not load this quote.'); }
    setLoading(false);
  })(); }, [token]);

  const pos = (e) => { const c = canvasRef.current; const r = c.getBoundingClientRect(); const t = e.touches ? e.touches[0] : e; return { x: t.clientX - r.left, y: t.clientY - r.top }; };
  const startDraw = (e) => { e.preventDefault(); drawing.current = true; const ctx = canvasRef.current.getContext('2d'); const { x, y } = pos(e); ctx.beginPath(); ctx.moveTo(x, y); };
  const moveDraw = (e) => { if (!drawing.current) return; e.preventDefault(); const ctx = canvasRef.current.getContext('2d'); const { x, y } = pos(e); ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.strokeStyle = '#1a1a1a'; ctx.lineTo(x, y); ctx.stroke(); hasSig.current = true; };
  const endDraw = () => { drawing.current = false; };
  const clearSig = () => { const c = canvasRef.current; c.getContext('2d').clearRect(0, 0, c.width, c.height); hasSig.current = false; };

  const submit = async () => {
    if (!name.trim()) { setError('Please type your full name.'); return; }
    if (!hasSig.current) { setError('Please draw your signature.'); return; }
    setSubmitting(true); setError('');
    const signature = canvasRef.current.toDataURL('image/png');
    try {
      const res = await fetch(`${FN}/quote-public`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, name: name.trim(), signature }) });
      const d = await res.json();
      if (!res.ok) { setError(d.error || 'Could not submit.'); setSubmitting(false); return; }
      // Deal is closed-won on signature; still collect payment if the quote requires it
      if (d.needs_payment) {
        const cs = await fetch(`${FN}/quote-checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, origin: window.location.origin }) });
        const cd = await cs.json();
        if (cs.ok && cd.url) { window.location.href = cd.url; return; }
        // Payment couldn't start (e.g. Stripe not connected) — signature + close already done
        setDone(true); setSubmitting(false); return;
      }
      if (d.executed) { setDone(true); setSubmitting(false); return; }
    } catch { setError('Could not submit. Please try again.'); setSubmitting(false); }
  };

  const wrap = (children) => (
    <div className="min-h-screen w-full bg-slate-100 py-6 px-3 sm:px-4 flex justify-center">
      <div className="w-full max-w-3xl">{children}</div>
    </div>
  );

  if (loading) return wrap(<div className="text-center text-slate-400 text-sm py-16">Loading quote…</div>);
  if (error && !data) return wrap(<div className="text-center text-slate-600 text-sm py-16">{error}</div>);

  const q = data.quote;
  const seller = data.seller || {};
  const accent = seller.accent || '#E8743C';
  const accepted = paid || done || ['signed', 'paid', 'won'].includes(q.status);

  return wrap(
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
      {/* Header */}
      <div className="px-6 sm:px-8 py-6 border-b border-slate-200 flex items-start justify-between gap-4 flex-wrap">
        {seller.logo_url ? <img src={seller.logo_url} alt={seller.name} className="h-20 sm:h-24 object-contain" /> : <LogoLockup size={48} />}
        <div className="text-right text-sm">
          <div className="text-lg font-bold text-slate-800">Order Form</div>
          <div className="text-slate-500">Quote #{q.number}</div>
          <div className="text-slate-400 text-xs mt-1">Issued {fmtDate(q.created_at)}</div>
          {q.valid_until && <div className="text-slate-400 text-xs">Valid until {fmtDate(q.valid_until)}</div>}
        </div>
      </div>

      {/* From / To */}
      <div className="px-6 sm:px-8 py-5 grid grid-cols-1 sm:grid-cols-2 gap-6 border-b border-slate-200">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400 mb-1">From</div>
          <div className="text-sm font-semibold text-slate-800">{seller.name}</div>
          {seller.address && <div className="text-xs text-slate-500 whitespace-pre-line">{seller.address}</div>}
          {seller.email && <div className="text-xs text-slate-500">{seller.email}</div>}
          {seller.phone && <div className="text-xs text-slate-500">{seller.phone}</div>}
        </div>
        <div>
          <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400 mb-1">Prepared for</div>
          <div className="text-sm font-semibold text-slate-800">{data.company?.name || data.contact?.name || '—'}</div>
          {data.company?.address && <div className="text-xs text-slate-500">{data.company.address}</div>}
          {data.location && (
            <div className="text-xs text-slate-500 mt-1">
              <span className="text-slate-400">Install at:</span> {data.location.name}{data.location.address ? `, ${data.location.address}` : ''}
            </div>
          )}
          {data.contact && (
            <div className="text-xs text-slate-500 mt-1">
              {data.contact.name}{data.contact.email ? ` · ${data.contact.email}` : ''}
            </div>
          )}
        </div>
      </div>

      {/* Line items */}
      <div className="px-6 sm:px-8 py-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[10px] font-bold uppercase tracking-wide text-slate-400 border-b border-slate-200">
              <th className="text-left py-2">Item</th>
              <th className="text-center py-2 w-12">Qty</th>
              <th className="text-right py-2 w-20">Unit</th>
              <th className="text-right py-2 w-14">Disc</th>
              <th className="text-right py-2 w-24">Total</th>
            </tr>
          </thead>
          <tbody>
            {(data.items || []).map(it => (
              <tr key={it.id} className="border-b border-slate-100 align-top">
                <td className="py-2.5 pr-2">
                  <div className="font-medium text-slate-800">{it.name}</div>
                  {it.description && <div className="text-xs text-slate-500 mt-0.5 whitespace-pre-line">{it.description}</div>}
                  <div className="text-[10px] text-slate-400 mt-0.5">{CAT[it.category]}{it.billing_type === 'monthly' ? ' · billed monthly' : it.billing_type === 'annual' ? ' · billed annually' : ''}</div>
                </td>
                <td className="py-2.5 text-center text-slate-600">{it.qty}</td>
                <td className="py-2.5 text-right text-slate-600">{money(it.unit_price)}</td>
                <td className="py-2.5 text-right text-slate-500">{it.discount > 0 ? `${it.discount}%` : '—'}</td>
                <td className="py-2.5 text-right font-mono text-slate-800">{money(it.line_total)}{it.billing_type === 'monthly' ? '/mo' : it.category === 'payments' ? '/yr' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Totals */}
      <div className="px-6 sm:px-8 py-4 bg-slate-50 border-y border-slate-200">
        <div className="ml-auto max-w-xs space-y-1">
          <Row k="One-off subtotal" v={money(q.one_off_subtotal)} />
          <Row k="VAT" v={money(q.tax_amount)} />
          <Row k="Due on acceptance" v={money(q.one_off_total)} bold accent={accent} />
          {q.recurring_arr > 0 && <Row k="Ongoing (per year)" v={money(q.recurring_arr)} sub />}
        </div>
        {q.go_live_date && <div className="text-xs text-slate-500 mt-3">Planned go-live: <strong>{fmtDate(q.go_live_date)}</strong></div>}
      </div>

      {/* Card-processing savings */}
      {q.card_processing && Number(q.card_processing.saving_yr) > 0 && (
        <div className="px-6 sm:px-8 py-5 border-b border-slate-200">
          <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400 mb-3">Your card-processing savings</div>
          <div className="rounded-xl p-5 text-center mb-4" style={{ backgroundColor: accent + '14' }}>
            <div className="text-3xl sm:text-4xl font-bold" style={{ color: accent }}>{money0(q.card_processing.saving_yr)}<span className="text-base font-semibold opacity-70"> / year</span></div>
            <div className="text-sm text-slate-500 mt-1">{money(q.card_processing.saving_mo)} / month · {pct(q.card_processing.current_eff)} → {pct(q.card_processing.our_eff)} effective rate</div>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] font-bold uppercase tracking-wide text-slate-400 border-b border-slate-200">
                <th className="text-left py-2">Card type</th>
                <th className="text-right py-2">Your rate now</th>
                <th className="text-right py-2">With us</th>
                <th className="text-right py-2">You save / mo</th>
              </tr>
            </thead>
            <tbody>
              {(q.card_processing.rows || []).map((r, i) => (
                <tr key={i} className="border-b border-slate-100">
                  <td className="py-2 text-slate-700">{r.label}{r.channel ? <span className="text-slate-400 text-xs"> · {r.channel}</span> : ''}</td>
                  <td className="py-2 text-right text-slate-500">{pct(r.current)}</td>
                  <td className="py-2 text-right text-slate-800 font-medium">{pct(r.our)}</td>
                  <td className="py-2 text-right font-mono text-emerald-600">{money(r.saving)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="text-[10px] text-slate-400 mt-2">Effective rate includes per-transaction fees based on your average transaction size. Figures based on the volumes provided.</div>
        </div>
      )}

      {/* Terms */}
      {q.terms && (
        <div className="px-6 sm:px-8 py-4 border-b border-slate-200">
          <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400 mb-1">Terms &amp; conditions</div>
          <div className="text-xs text-slate-600 whitespace-pre-wrap leading-relaxed">{q.terms}</div>
        </div>
      )}

      {/* Acceptance */}
      <div className="px-6 sm:px-8 py-6">
        <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400 mb-3">Acceptance</div>
        {accepted ? (
          <div className="text-center py-4">
            <div className="w-12 h-12 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center text-2xl mx-auto mb-2">✓</div>
            <div className="text-lg font-bold text-slate-800">{paid || q.status === 'paid' || q.status === 'won' ? 'Accepted & paid' : 'Accepted & signed'}</div>
            {q.signed_by_name && <div className="text-sm text-slate-500">Signed by {q.signed_by_name}</div>}
            <div className="text-sm text-slate-500">Thank you — we'll be in touch to get you started.</div>
          </div>
        ) : q.expired ? (
          <div className="text-center text-slate-500 text-sm py-4">This quote has expired. Please contact us for an updated quote.</div>
        ) : (
          <>
            <div className="text-sm text-slate-600 mb-3">By signing below you accept this order form and its terms.</div>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Type your full name"
              className="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-sm mb-2 focus:outline-none focus:ring-2 focus:ring-orange-400" />
            <div className="text-xs text-slate-500 mb-1">Draw your signature</div>
            <div className="border border-slate-300 rounded-lg bg-white">
              <canvas ref={canvasRef} width={620} height={150} className="w-full touch-none"
                onMouseDown={startDraw} onMouseMove={moveDraw} onMouseUp={endDraw} onMouseLeave={endDraw}
                onTouchStart={startDraw} onTouchMove={moveDraw} onTouchEnd={endDraw} />
            </div>
            <button onClick={clearSig} className="text-xs text-slate-400 mt-1 hover:text-slate-600">Clear signature</button>
            {error && <div className="text-sm text-red-600 mt-2">{error}</div>}
            <button onClick={submit} disabled={submitting}
              style={{ backgroundColor: accent }}
              className="w-full mt-3 py-3 text-white text-sm font-semibold rounded-lg transition hover:opacity-90 disabled:opacity-50">
              {submitting ? 'Processing…'
                : q.payment_terms === 'invoice_later' ? 'Accept & sign'
                : q.payment_terms === 'deposit' ? `Accept, sign & pay ${q.deposit_percent}% deposit`
                : 'Accept, sign & pay'}
            </button>
          </>
        )}
        <div className="text-center text-[10px] text-slate-300 pt-3">Powered by ServOS</div>
      </div>
    </div>
  );
}

function Row({ k, v, bold, sub, accent }) {
  return (
    <div className="flex justify-between text-sm">
      <span className={sub ? 'text-slate-400 text-xs' : 'text-slate-500'}>{k}</span>
      <span className="font-mono font-semibold" style={bold ? { color: accent } : undefined}>
        <span className={bold ? '' : sub ? 'text-slate-400 text-xs font-normal' : 'text-slate-700 font-normal'}>{v}</span>
      </span>
    </div>
  );
}

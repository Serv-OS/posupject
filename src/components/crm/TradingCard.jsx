import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { CURRENCIES, fmtMoney, fmtMoney0, currencySymbol, sumByCurrency, fmtByCurrency } from '../../lib/money';
import { currencyForCountry } from '../../lib/region';
import { transactionsFrom, estimateAccuracy } from '../../lib/trading';

/* What the VENUE turns over — asked in discovery, not what we charge.
 *
 * Two sets on purpose: what they told us during the sale, and what the site
 * really does once live. Keeping both is the only way to learn whether
 * prospects over-state their turnover, and it separates forecast volume from
 * volume actually running through the system.
 *
 * Transactions a month is never typed. It is turnover ÷ average transaction,
 * computed here as you type and stored as a generated column in the database,
 * so the two can never disagree.
 */

const n = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
const txt = (v) => (v === null || v === undefined ? '' : String(v));
const count = (v) => (v === null ? '—' : Number(v).toLocaleString('en-GB'));

function Row({ label, revenue, atv, editable, onSave, ccy = 'GBP' }) {
  const [rev, setRev] = useState(txt(revenue));
  const [av, setAv] = useState(txt(atv));
  useEffect(() => { setRev(txt(revenue)); setAv(txt(atv)); }, [revenue, atv]);

  // The site's currency labels the money inputs as well as the yearly figure,
  // so a rep typing a Provo site's turnover sees they are entering dollars.
  const sym = currencySymbol(ccy);
  const fmt0 = (v) => fmtMoney0(v, ccy);
  const txns = transactionsFrom(rev, av);
  const input = 'w-full px-2.5 py-1.5 bg-card border border-bdr rounded-lg text-sm text-paper tabular-nums focus:outline-none focus:border-ember disabled:opacity-60';

  return (
    <div className="glass-inner rounded-xl p-3">
      <div className="text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-2">{label}</div>
      <div className="grid grid-cols-3 gap-2">
        <div>
          <div className="text-[10px] text-muted mb-1">Turnover / month {sym}</div>
          <input className={input} type="number" min="0" step="100" inputMode="decimal" disabled={!editable}
            value={rev} placeholder="—"
            onChange={(e) => setRev(e.target.value)}
            onBlur={(e) => onSave?.({ revenue: n(e.target.value) })} />
        </div>
        <div>
          <div className="text-[10px] text-muted mb-1">Avg transaction {sym}</div>
          <input className={input} type="number" min="0" step="0.01" inputMode="decimal" disabled={!editable}
            value={av} placeholder="—"
            onChange={(e) => setAv(e.target.value)}
            onBlur={(e) => onSave?.({ atv: n(e.target.value) })} />
        </div>
        <div>
          <div className="text-[10px] text-muted mb-1">Transactions</div>
          <div className="px-2.5 py-1.5 text-sm text-paper tabular-nums font-semibold" title="Turnover divided by average transaction — calculated, not entered">
            {count(txns)}
          </div>
        </div>
      </div>
      {n(rev) !== null && (
        <div className="text-[11px] text-dim mt-2">{fmt0(n(rev) * 12)} a year</div>
      )}
    </div>
  );
}

/** Location-level: the source of truth a deal rolls up from. */
export function LocationTradingCard({ location, company, canWrite, onSaved }) {
  const [err, setErr] = useState('');
  if (!location) return null;
  // A site in Provo trades in dollars. Take the country from the site, falling
  // back to its company, rather than assuming everyone is in the UK.
  const ccy = currencyForCountry(location.country || company?.country);

  const save = async (patch) => {
    const { error } = await supabase.from('locations')
      .update({ ...patch, trading_updated_at: new Date().toISOString() })
      .eq('id', location.id);
    if (error) { setErr(error.message); return; }
    setErr('');
    onSaved?.();
  };

  const acc = estimateAccuracy(location.est_monthly_revenue, location.actual_monthly_revenue);

  return (
    <div className="glass-card rounded-2xl overflow-hidden">
      <div className="px-5 py-3.5 border-b border-bdr flex items-center gap-2">
        <h3 className="text-[13px] font-bold text-paper tracking-tight">Trading</h3>
        <span className="text-[10px] text-dim">what the venue takes</span>
        {location.trading_updated_at && (
          <span className="ml-auto text-[10px] text-dim">
            updated {new Date(location.trading_updated_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })}
          </span>
        )}
      </div>
      <div className="p-5 space-y-3">
        {err && <div className="text-xs text-red-600">{err}</div>}

        <Row label="Expected — what they told us" editable={canWrite} ccy={ccy}
          revenue={location.est_monthly_revenue} atv={location.est_avg_transaction}
          onSave={({ revenue, atv }) => save(
            revenue !== undefined ? { est_monthly_revenue: revenue } : { est_avg_transaction: atv },
          )} />

        <Row label="Actual — once trading" editable={canWrite} ccy={ccy}
          revenue={location.actual_monthly_revenue} atv={location.actual_avg_transaction}
          onSave={({ revenue, atv }) => save(
            revenue !== undefined ? { actual_monthly_revenue: revenue } : { actual_avg_transaction: atv },
          )} />

        {acc !== null && (
          <div className={`text-xs rounded-xl px-3 py-2 ${
            acc >= 0 ? 'bg-emerald-500/10 text-emerald-700' : 'bg-amber-500/10 text-amber-700'
          }`}>
            Trading <strong>{Math.abs(acc * 100).toFixed(0)}% {acc >= 0 ? 'above' : 'below'}</strong> what they estimated
            {acc < -0.2 && ' — worth knowing before you believe the next forecast from this group'}
          </div>
        )}

        <textarea rows={2} disabled={!canWrite}
          className="w-full px-3 py-2 bg-card border border-bdr rounded-xl text-xs text-paper placeholder-dim focus:outline-none focus:border-ember disabled:opacity-60 resize-none"
          placeholder="Anything worth noting — seasonal swing, second site opening, card vs cash split…"
          defaultValue={location.trading_notes || ''}
          onBlur={(e) => save({ trading_notes: e.target.value.trim() || null })} />
      </div>
    </div>
  );
}

/** Deal-level: rolls up its sites, unless someone has typed an override. */
export function DealTradingCard({ dealId, currency = 'GBP', canWrite, onNavigate }) {
  const [row, setRow] = useState(null);
  const [over, setOver] = useState({ rev: null, atv: null });   // typed on the deal itself
  const [sites, setSites] = useState([]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ rev: '', atv: '' });
  const [err, setErr] = useState('');

  const load = async () => {
    const [t, d] = await Promise.all([
      supabase.from('deal_trading').select('*').eq('deal_id', dealId).maybeSingle(),
      supabase.from('deals').select('est_monthly_revenue, est_avg_transaction').eq('id', dealId).maybeSingle(),
    ]);
    if (t.error) { setErr(t.error.message); return; }
    setOver({ rev: n(d.data?.est_monthly_revenue), atv: n(d.data?.est_avg_transaction) });
    setDraft({ rev: txt(d.data?.est_monthly_revenue), atv: txt(d.data?.est_avg_transaction) });

    // The sites behind the number, so it is never a figure with no explanation.
    // They also decide the currency of every figure on the card, so the row is
    // NOT set until they have arrived: setting it first painted the view's
    // cross-country total with the deal's currency for one round-trip, a
    // "£30,000" that flipped to "$30,000" a moment later.
    const { data: assoc } = await supabase.from('associations').select('*')
      .or(`and(from_type.eq.deal,from_id.eq.${dealId},to_type.eq.location),and(to_type.eq.deal,to_id.eq.${dealId},from_type.eq.location)`);
    const ids = (assoc || []).map((a) => (a.from_type === 'location' ? a.from_id : a.to_id));
    let locs = [];
    if (ids.length) {
      // Country decides the money a site trades in — same chain as LocationTradingCard.
      const res = await supabase.from('locations')
        .select('id, name, country, company:companies(country), est_monthly_revenue, est_avg_transaction, est_monthly_transactions').in('id', ids);
      locs = res.data || [];
    }
    setSites(locs);
    setRow(t.data || null);
  };
  useEffect(() => { load(); }, [dealId]);   // eslint-disable-line react-hooks/exhaustive-deps

  const saveOverride = async () => {
    const { error } = await supabase.from('deals').update({
      est_monthly_revenue: n(draft.rev), est_avg_transaction: n(draft.atv),
    }).eq('id', dealId);
    if (error) { setErr(error.message); return; }
    setEditing(false); setErr(''); load();
  };
  const clearOverride = async () => {
    await supabase.from('deals').update({ est_monthly_revenue: null, est_avg_transaction: null }).eq('id', dealId);
    setEditing(false); load();
  };

  if (!row) return null;
  const has = row.est_monthly_revenue !== null && row.est_monthly_revenue !== undefined;

  // A Leeds site takes pounds and a Provo site takes dollars, so the roll-up is
  // summed per currency and never across it. The view's blended figure is only
  // trusted when every site trades in the same money; a figure typed on the
  // deal is one number and belongs to the deal's currency.
  const siteCcy = (s) => currencyForCountry(s.country || s.company?.country);
  const priced = sites.filter((s) => s.est_monthly_revenue != null);
  const revByCcy = sumByCurrency(priced, (s) => s.est_monthly_revenue, siteCcy);
  const txnByCcy = sumByCurrency(priced, (s) => s.est_monthly_transactions || 0, siteCcy);
  const ccys = CURRENCIES.filter((c) => revByCcy[c]);
  const mixed = ccys.length > 1;
  const rollCcy = ccys.length === 1 ? ccys[0] : currency;
  const revCcy = over.rev !== null ? currency : rollCcy;
  const atvCcy = over.atv !== null ? currency : rollCcy;
  // An override is typed in the deal's currency, so its inputs say which.
  const overSym = currencySymbol(currency);
  const mixedRev = mixed && over.rev === null;
  const mixedAtv = mixed && over.atv === null;
  // Average inside each currency: pounds are never divided by dollar transactions.
  const atvByCcy = ccys.filter((c) => txnByCcy[c] > 0)
    .map((c) => fmtMoney(revByCcy[c] / txnByCcy[c], c)).join(' + ');

  return (
    <div className="glass-card rounded-2xl overflow-hidden">
      <div className="px-5 py-3.5 border-b border-bdr flex items-center gap-2">
        <h3 className="text-[13px] font-bold text-paper tracking-tight">Venue trading</h3>
        <span className="text-[10px] text-dim">their turnover, not ours</span>
        {canWrite && (
          <button onClick={() => setEditing((v) => !v)} className="ml-auto text-xs text-ember hover:text-ember-deep font-medium">
            {editing ? 'Cancel' : row.is_override ? 'Edit override' : 'Override'}
          </button>
        )}
      </div>
      <div className="p-5 space-y-3">
        {err && <div className="text-xs text-red-600">{err}</div>}

        {!has && !editing && (
          <div className="text-xs text-dim italic py-2">
            No figures yet. Add them on a linked location, or override here.
          </div>
        )}

        {has && (
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Turnover / month"
              value={mixedRev ? fmtByCurrency(revByCcy, 0) : fmtMoney0(row.est_monthly_revenue, revCcy)}
              sub={mixedRev
                ? `${fmtByCurrency(Object.fromEntries(ccys.map((c) => [c, revByCcy[c] * 12])), 0)} a year`
                : `${fmtMoney0(row.est_monthly_revenue * 12, revCcy)} a year`} />
            <Stat label="Avg transaction"
              value={mixedAtv ? (atvByCcy || '—') : (row.est_avg_transaction ? fmtMoney(row.est_avg_transaction, atvCcy) : '—')}
              sub={mixedAtv ? 'per currency, never blended' : (row.site_count > 1 ? 'blended across sites' : null)} />
            <Stat label="Transactions / month" value={count(row.est_monthly_transactions)} />
          </div>
        )}

        {row.is_override && !editing && (
          <div className="text-[11px] text-amber-700 bg-amber-500/10 rounded-lg px-3 py-2">
            Typed on the deal, so the site figures below are not being used.
          </div>
        )}

        {editing && (
          <div className="glass-inner rounded-xl p-3 space-y-2">
            <div className="text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim">Override the roll-up</div>
            <div className="grid grid-cols-2 gap-2">
              <input className="px-2.5 py-1.5 bg-card border border-bdr rounded-lg text-sm text-paper" type="number" min="0"
                placeholder={`Turnover / month ${overSym}`} value={draft.rev} onChange={(e) => setDraft({ ...draft, rev: e.target.value })} />
              <input className="px-2.5 py-1.5 bg-card border border-bdr rounded-lg text-sm text-paper" type="number" min="0" step="0.01"
                placeholder={`Avg transaction ${overSym}`} value={draft.atv} onChange={(e) => setDraft({ ...draft, atv: e.target.value })} />
            </div>
            <div className="flex gap-2">
              <button onClick={saveOverride} className="btn-glass px-4 py-1.5 rounded-xl text-xs font-semibold">Save</button>
              <button onClick={clearOverride} className="btn-ghost px-3 py-1.5 rounded-xl text-xs">Use the sites instead</button>
            </div>
          </div>
        )}

        {sites.length > 0 && (
          <div>
            <div className="text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1.5">
              {sites.length} site{sites.length === 1 ? '' : 's'} on this deal
            </div>
            <div className="space-y-1">
              {sites.map((s) => (
                <div key={s.id} onClick={() => onNavigate?.('location', s.id)}
                  className="flex items-center gap-2 px-3 py-2 glass-inner rounded-lg cursor-pointer text-xs">
                  <span className="flex-1 min-w-0 truncate text-paper">{s.name}</span>
                  <span className="text-muted tabular-nums shrink-0">
                    {s.est_monthly_revenue ? fmtMoney0(s.est_monthly_revenue, siteCcy(s)) : <span className="text-dim italic">no figures</span>}
                  </span>
                  <span className="text-dim tabular-nums shrink-0 w-20 text-right">
                    {s.est_monthly_transactions ? `${count(s.est_monthly_transactions)} txns` : ''}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, sub }) {
  return (
    <div>
      <div className="text-[10px] font-mono font-bold uppercase tracking-[0.16em] text-dim mb-0.5">{label}</div>
      <div className="text-lg font-bold text-paper tabular-nums">{value}</div>
      {sub && <div className="text-[10px] text-dim">{sub}</div>}
    </div>
  );
}

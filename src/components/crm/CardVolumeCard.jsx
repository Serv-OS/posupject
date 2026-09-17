import { Fragment, useMemo, useState } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { volumeByCompany, volumeBySite } from '../../lib/cardVolume';
import { fmtMoney0 } from '../../lib/money';

/* Gross card volume per company and per site: everything the venues take on
 * cards, in-store plus online, before fees. The monthly figures come off each
 * card's statement; the Actual column fills in once processed volume is
 * recorded for the chosen month. Pounds and dollars are always separate. */

const STATUS_STYLE = { prospect: 'bg-amber-100 text-amber-700', live: 'bg-emerald-100 text-emerald-700', churned: 'bg-slate-200 text-slate-500' };
const CCYS = ['GBP', 'USD'];

export default function CardVolumeCard({ accounts = [], volumes = [], period, periodLabel, onOpenAccount, onNavigate }) {
  const [view, setView] = useState('company');   // 'company' | 'site'
  const [status, setStatus] = useState('all');
  const [open, setOpen] = useState(() => new Set());

  const { companies, totals } = useMemo(() => volumeByCompany(accounts, volumes, { period, status }), [accounts, volumes, period, status]);
  const sites = useMemo(() => volumeBySite(accounts, volumes, { period, status }), [accounts, volumes, period, status]);
  const anyActual = Object.values(totals).some(t => t.hasActual);
  const counts = useMemo(() => ({
    all: accounts.length,
    live: accounts.filter(a => a.status === 'live').length,
    prospect: accounts.filter(a => a.status === 'prospect').length,
  }), [accounts]);

  const toggle = (id) => setOpen(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const m = (n, c) => fmtMoney0(n, c);
  // One cell per currency present, stacked, so £ and $ never share a figure.
  const cell = (t, field) => {
    const parts = CCYS.filter(c => t[c]).map(c => {
      if (field === 'actual') return t[c].hasActual ? m(t[c].actual, c) : null;
      if (field === 'year') return m(t[c].gross * 12, c);
      return m(t[c][field], c);
    }).filter(Boolean);
    return parts.length ? parts.map((p, i) => <div key={i}>{p}</div>) : '—';
  };
  const chip = (on) => `px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition ${on ? 'bg-ember/15 text-ember-deep border-ember/25' : 'bg-card text-muted border-bdr hover:text-paper'}`;
  const th = 'text-right px-3 py-2 font-bold';
  const td = 'px-3 py-2.5 text-right tabular-nums';

  const siteRow = (s, { indent = false, company = null } = {}) => {
    const single = s.accounts.length === 1 ? s.accounts[0] : null;
    return (
      <tr key={s.key} onClick={() => single && onOpenAccount?.(single)}
        className={`border-b border-bdr/60 ${single ? 'hover:bg-card/50 cursor-pointer' : ''}`}>
        <td className={`py-2.5 ${indent ? 'pl-11 pr-3' : 'px-5'}`}>
          <div className="text-paper">{s.name}{s.noSite && <span className="ml-1.5 text-[10px] text-dim">(card with no site)</span>}</div>
          {company && <div className="text-[11px] text-dim">{company}</div>}
          {s.accounts.length > 1 && <div className="text-[11px] text-dim">{s.accounts.length} cards on this site</div>}
        </td>
        <td className="px-3 py-2.5">
          {s.statuses.map(st => <span key={st} className={`mr-1 text-[10px] font-bold uppercase px-2 py-0.5 rounded-lg ${STATUS_STYLE[st] || STATUS_STYLE.prospect}`}>{st}</span>)}
        </td>
        <td className={`${td} text-muted`}>{cell(s.totals, 'inStore')}</td>
        <td className={`${td} text-muted`}>{cell(s.totals, 'online')}</td>
        <td className={`${td} font-semibold text-paper`}>{cell(s.totals, 'gross')}</td>
        <td className={`${td} text-muted`}>{cell(s.totals, 'year')}</td>
        {anyActual && <td className={`${td} text-emerald-700`}>{cell(s.totals, 'actual')}</td>}
      </tr>
    );
  };

  return (
    <div className="glass-card rounded-2xl overflow-hidden">
      <div className="px-5 py-3.5 border-b border-bdr flex items-center gap-2 flex-wrap">
        <h3 className="text-[13px] font-bold text-paper">Gross card volume</h3>
        <span className="text-[11px] text-dim">in-store plus online, before fees, per month</span>
        <div className="ml-auto flex items-center gap-1.5 flex-wrap">
          <button className={chip(view === 'company')} onClick={() => setView('company')}>By company</button>
          <button className={chip(view === 'site')} onClick={() => setView('site')}>By site</button>
          <span className="w-px h-5 bg-bdr mx-1" />
          {[['all', 'All'], ['live', 'Live'], ['prospect', 'Prospect']].map(([k, l]) => (
            <button key={k} className={chip(status === k)} onClick={() => setStatus(k)}>{l} <span className="text-dim">{counts[k]}</span></button>
          ))}
        </div>
      </div>

      {/* Totals, one per currency */}
      <div className="px-5 py-3 border-b border-bdr flex flex-wrap gap-x-8 gap-y-2">
        {CCYS.filter(c => totals[c]).length === 0 && <div className="text-sm text-dim italic">No cards with volume for this filter.</div>}
        {CCYS.filter(c => totals[c]).map(c => (
          <div key={c}>
            <div className="text-[10px] font-mono font-bold uppercase tracking-[0.14em] text-dim">{c === 'USD' ? 'US' : 'UK'} gross / mo</div>
            <div className="text-xl font-bold tabular-nums text-paper">{m(totals[c].gross, c)}</div>
            <div className="text-[11px] text-dim">{m(totals[c].gross * 12, c)} a year · {totals[c].cards} card{totals[c].cards === 1 ? '' : 's'}
              {totals[c].hasActual && <> · actual {periodLabel}: <span className="text-emerald-700 font-semibold">{m(totals[c].actual, c)}</span></>}
            </div>
          </div>
        ))}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[760px]">
          <thead>
            <tr className="text-[10px] font-mono font-bold uppercase tracking-[0.14em] text-dim border-b border-bdr">
              <th className="text-left px-5 py-2 font-bold">{view === 'company' ? 'Company / site' : 'Site'}</th>
              <th className="text-left px-3 py-2 font-bold">Status</th>
              <th className={th}>In-store / mo</th>
              <th className={th}>Online / mo</th>
              <th className={th}>Gross / mo</th>
              <th className={th}>Gross / yr</th>
              {anyActual && <th className={th}>Actual {periodLabel}</th>}
            </tr>
          </thead>
          <tbody>
            {view === 'company' ? companies.map(co => {
              const isOpen = open.has(co.id || co.name);
              return (
                <Fragment key={co.id || co.name}>
                  <tr onClick={() => toggle(co.id || co.name)} className="border-b border-bdr/60 bg-card/30 hover:bg-card/60 cursor-pointer">
                    <td className="px-5 py-2.5">
                      <div className="flex items-center gap-1.5">
                        {isOpen ? <ChevronDown size={14} className="text-dim shrink-0" /> : <ChevronRight size={14} className="text-dim shrink-0" />}
                        <span className="text-paper font-semibold">{co.name}</span>
                        {co.id && onNavigate && (
                          <button onClick={(e) => { e.stopPropagation(); onNavigate('company', co.id); }} className="text-[11px] text-ember hover:underline ml-1">open</button>
                        )}
                      </div>
                      <div className="text-[11px] text-dim pl-5">{co.sites.length} site{co.sites.length === 1 ? '' : 's'}</div>
                    </td>
                    <td className="px-3 py-2.5" />
                    <td className={`${td} text-muted`}>{cell(co.totals, 'inStore')}</td>
                    <td className={`${td} text-muted`}>{cell(co.totals, 'online')}</td>
                    <td className={`${td} font-bold text-paper`}>{cell(co.totals, 'gross')}</td>
                    <td className={`${td} text-muted`}>{cell(co.totals, 'year')}</td>
                    {anyActual && <td className={`${td} text-emerald-700 font-semibold`}>{cell(co.totals, 'actual')}</td>}
                  </tr>
                  {isOpen && co.sites.map(s => siteRow(s, { indent: true }))}
                </Fragment>
              );
            }) : sites.map(s => siteRow(s, { company: s.companyName }))}
            {(view === 'company' ? companies.length : sites.length) === 0 && (
              <tr><td colSpan={anyActual ? 7 : 6} className="px-5 py-8 text-center text-dim italic">Nothing to show for this filter.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {!anyActual && (
        <div className="px-5 py-2.5 border-t border-bdr text-[11px] text-dim">
          Figures are the monthly volumes typed off each card's statement. Once a card is live, add its processed volume on the card and an Actual column appears here.
        </div>
      )}
    </div>
  );
}

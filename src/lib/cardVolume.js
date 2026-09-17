/* Gross card volume per company and per site.
 *
 * Gross volume is everything a venue takes on cards before any fees: in-store
 * plus online. Each card-processing account holds the monthly figures typed
 * off the venue's statement (cp_volume, cnp_volume), and processing_volumes
 * holds what was actually processed month by month once they are live.
 *
 * Money is kept per currency and never added across: a US site's dollars and
 * a UK site's pounds are two totals, because we hold no exchange rate.
 * Pure, so the grouping and the sums can be tested.
 */
import { round2 } from './money.js';

const ccy = (acc) => (acc?.region_code === 'US' ? 'USD' : 'GBP');
const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);

/** One account's monthly figures. `actual` is null when nothing was recorded for the period. */
export function accountVolume(acc, volumes = [], period = null) {
  const inStore = round2(num(acc?.cp_volume));
  const online = round2(num(acc?.cnp_volume));
  const rec = period ? (volumes || []).find(v => v.account_id === acc?.id && v.period === period) : null;
  return {
    currency: ccy(acc),
    inStore, online,
    gross: round2(inStore + online),
    actual: rec ? round2(num(rec.amount_processed)) : null,
    transactions: rec && rec.transactions != null ? Number(rec.transactions) : null,
  };
}

const blank = () => ({ inStore: 0, online: 0, gross: 0, actual: 0, hasActual: false, cards: 0 });
const add = (t, v) => {
  t.inStore = round2(t.inStore + v.inStore);
  t.online = round2(t.online + v.online);
  t.gross = round2(t.gross + v.gross);
  if (v.actual !== null) { t.actual = round2(t.actual + v.actual); t.hasActual = true; }
  t.cards += 1;
  return t;
};

/**
 * Group accounts by company, then by site inside each company.
 * A card with no site (a group card, or one not yet tied to a venue) sits in
 * its company under its own name, flagged `noSite`.
 * `status` filters: 'all' | 'live' | 'prospect' | 'churned'.
 * Returns { companies, totals } where totals and every company carry one
 * entry per currency present, e.g. { GBP: {...}, USD: {...} }.
 */
export function volumeByCompany(accounts = [], volumes = [], { period = null, status = 'all' } = {}) {
  const byCompany = new Map();
  const totals = {};
  for (const acc of accounts || []) {
    if (status !== 'all' && acc.status !== status) continue;
    const v = accountVolume(acc, volumes, period);
    const cKey = acc.company_id || 'none';
    if (!byCompany.has(cKey)) {
      byCompany.set(cKey, { id: acc.company_id || null, name: acc.company?.name || 'No company', totals: {}, sites: new Map() });
    }
    const co = byCompany.get(cKey);
    const sKey = acc.location_id || `card:${acc.id}`;
    if (!co.sites.has(sKey)) {
      co.sites.set(sKey, {
        key: sKey,
        locationId: acc.location_id || null,
        name: acc.location_id ? (acc.location?.name || 'Unnamed site') : (acc.label || 'Card with no site'),
        noSite: !acc.location_id,
        currency: v.currency,
        statuses: new Set(),
        accounts: [],
        totals: {},
      });
    }
    const site = co.sites.get(sKey);
    site.accounts.push(acc);
    site.statuses.add(acc.status || 'prospect');
    site.totals[v.currency] = add(site.totals[v.currency] || blank(), v);
    co.totals[v.currency] = add(co.totals[v.currency] || blank(), v);
    totals[v.currency] = add(totals[v.currency] || blank(), v);
  }
  // Biggest first. A company in two currencies ranks by its larger bucket; the
  // screen never compares pounds with dollars beyond putting rows in order.
  const biggest = (t) => Math.max(0, ...Object.values(t).map(x => x.gross));
  const companies = [...byCompany.values()].map(co => ({
    id: co.id, name: co.name, totals: co.totals,
    sites: [...co.sites.values()]
      .map(s => ({ ...s, statuses: [...s.statuses] }))
      .sort((a, b) => biggest(b.totals) - biggest(a.totals) || a.name.localeCompare(b.name)),
  })).sort((a, b) => biggest(b.totals) - biggest(a.totals) || a.name.localeCompare(b.name));
  return { companies, totals };
}

/** Every site as its own row, biggest first, carrying its company's name. */
export function volumeBySite(accounts = [], volumes = [], opts = {}) {
  const { companies } = volumeByCompany(accounts, volumes, opts);
  const rows = companies.flatMap(co => co.sites.map(s => ({ ...s, companyId: co.id, companyName: co.name })));
  const biggest = (t) => Math.max(0, ...Object.values(t).map(x => x.gross));
  return rows.sort((a, b) => biggest(b.totals) - biggest(a.totals) || a.name.localeCompare(b.name));
}

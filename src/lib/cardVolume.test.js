import { describe, it, expect } from 'vitest';
import { accountVolume, volumeByCompany, volumeBySite } from './cardVolume.js';

const acc = (o) => ({ status: 'prospect', region_code: 'UK', cp_volume: null, cnp_volume: null, ...o });
const accounts = [
  acc({ id: 'a1', company_id: 'cb', company: { name: 'Coffee Boy Retail' }, location_id: 'hud', location: { name: 'Huddersfield' }, cp_volume: '61439', cnp_volume: '1009' }),
  acc({ id: 'a2', company_id: 'cb', company: { name: 'Coffee Boy Retail' }, location_id: 'lds', location: { name: 'Leeds' }, cp_volume: 25000, cnp_volume: 1500, status: 'live' }),
  acc({ id: 'a3', company_id: 'cb', company: { name: 'Coffee Boy Retail' }, location_id: null, label: 'Barnsley Train Station', cp_volume: 10000, cnp_volume: 3000 }),
  acc({ id: 'a4', company_id: 'mz', company: { name: 'Mozz Pizza' }, location_id: 'provo', location: { name: 'Provo' }, region_code: 'US', cp_volume: 110192.37, cnp_volume: 21362.14 }),
  acc({ id: 'a5', company_id: 'mz', company: { name: 'Mozz Pizza' }, location_id: 'wood', location: { name: 'Woodbrine' }, region_code: 'US', cp_volume: 112420, cnp_volume: 41580 }),
  acc({ id: 'a6', company_id: 'bg', company: { name: 'S & G Brigante' }, location_id: 'lee', location: { name: 'Cafe Brigante Leeds' }, cp_volume: 24000, cnp_volume: null }),
];

describe('accountVolume', () => {
  it('adds in-store and online into gross, reading typed strings and blanks', () => {
    expect(accountVolume(accounts[0])).toMatchObject({ currency: 'GBP', inStore: 61439, online: 1009, gross: 62448, actual: null });
    expect(accountVolume(accounts[5])).toMatchObject({ inStore: 24000, online: 0, gross: 24000 });
  });
  it('takes the actual for the chosen month when one was recorded', () => {
    const vols = [{ account_id: 'a2', period: '2026-09-01', amount_processed: '27123.456', transactions: 3100 }];
    expect(accountVolume(accounts[1], vols, '2026-09-01')).toMatchObject({ actual: 27123.46, transactions: 3100 });
    expect(accountVolume(accounts[1], vols, '2026-08-01').actual).toBeNull();
  });
  it('is dollars for a US card', () => {
    expect(accountVolume(accounts[3])).toMatchObject({ currency: 'USD', gross: 131554.51 });
  });
});

describe('volumeByCompany', () => {
  const { companies, totals } = volumeByCompany(accounts);
  it('never adds pounds and dollars together', () => {
    expect(totals.GBP.gross).toBe(62448 + 26500 + 13000 + 24000);
    expect(totals.USD.gross).toBe(131554.51 + 154000);
    expect(totals.GBP.cards).toBe(4);
    expect(totals.USD.cards).toBe(2);
  });
  it('groups sites under their company, biggest first, with a site-less card kept by its own name', () => {
    const cb = companies.find(c => c.id === 'cb');
    expect(cb.totals.GBP.gross).toBe(101948);
    expect(cb.sites.map(s => s.name)).toEqual(['Huddersfield', 'Leeds', 'Barnsley Train Station']);
    expect(cb.sites[2].noSite).toBe(true);
  });
  it('orders companies by their largest total', () => {
    expect(companies.map(c => c.name)).toEqual(['Mozz Pizza', 'Coffee Boy Retail', 'S & G Brigante']);
  });
  it('filters by status', () => {
    const live = volumeByCompany(accounts, [], { status: 'live' });
    expect(live.companies.map(c => c.name)).toEqual(['Coffee Boy Retail']);
    expect(live.totals.GBP.gross).toBe(26500);
    expect(live.totals.USD).toBeUndefined();
  });
  it('adds actuals only where they exist, and says so', () => {
    const vols = [{ account_id: 'a2', period: '2026-09-01', amount_processed: 27000 }];
    const r = volumeByCompany(accounts, vols, { period: '2026-09-01' });
    expect(r.totals.GBP).toMatchObject({ actual: 27000, hasActual: true });
    expect(r.totals.USD.hasActual).toBe(false);
  });
  it('puts two cards for the same site together', () => {
    const two = [...accounts, acc({ id: 'a7', company_id: 'cb', company: { name: 'Coffee Boy Retail' }, location_id: 'hud', location: { name: 'Huddersfield' }, cp_volume: 100, cnp_volume: 0 })];
    const hud = volumeByCompany(two).companies.find(c => c.id === 'cb').sites.find(s => s.locationId === 'hud');
    expect(hud.accounts).toHaveLength(2);
    expect(hud.totals.GBP.gross).toBe(62548);
  });
});

describe('volumeBySite', () => {
  it('lists every site biggest first with its company', () => {
    const rows = volumeBySite(accounts);
    expect(rows[0]).toMatchObject({ name: 'Woodbrine', companyName: 'Mozz Pizza' });
    expect(rows).toHaveLength(6);
  });
});

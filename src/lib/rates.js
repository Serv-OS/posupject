// Date-effective rate resolution + AMAP mileage maths for the Finance module.
// Rates live in DB tables (tax_rates / amap_rates / afr_rates) and are passed in as
// row arrays — this module is pure so it can be exhaustively unit-tested (rates.test.js).
// Money is pounds; see src/lib/money.js for the formatting/rounding contract.
import { round2, vatFractionOfGross } from './money.js';

const iso = (d) => {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  try { return new Date(d).toISOString().slice(0, 10); } catch { return null; }
};

// Pick the row whose [valid_from, valid_to] window contains `date`. If several match,
// the latest valid_from wins. ISO date strings compare lexicographically, so no Date math.
export function resolveEffective(rows = [], date) {
  const d = iso(date);
  if (!d) return null;
  let best = null;
  for (const r of rows) {
    const from = iso(r.valid_from);
    if (!from || from > d) continue;
    const to = iso(r.valid_to);
    if (to && d > to) continue;
    if (!best || iso(best.valid_from) < from) best = r;
  }
  return best;
}

export const resolveVat = (taxRates, code, date) =>
  resolveEffective((taxRates || []).filter(r => r.code === code), date);

export const resolveAmap = (rows, vehicleType, tier, date) =>
  resolveEffective((rows || []).filter(r => r.vehicle_type === vehicleType && r.tier === tier), date);

export const resolveAfr = (rows, fuel, engineBand, date) =>
  resolveEffective((rows || []).filter(r => r.fuel === fuel && r.engine_band === engineBand), date);

// UK tax year runs 6 Apr – 5 Apr. Returns the start calendar year for `date`.
export function taxYearStartYear(date) {
  const d = iso(date);
  if (!d) return null;
  const [y, m, day] = d.split('-').map(Number);
  // on/after 6 April => this year's tax year, else previous
  return (m > 4 || (m === 4 && day >= 6)) ? y : y - 1;
}
export function taxYearBounds(date) {
  const sy = taxYearStartYear(date);
  return sy == null ? null : { start: `${sy}-04-06`, end: `${sy + 1}-04-05`, label: `${sy}/${String(sy + 1).slice(-2)}` };
}

const AMAP_THRESHOLD = 10000;

// AMAP reimbursement for one journey. For cars/vans the first-10,000-business-miles tier
// (per tax year, per employee) is split using `ytdMilesBefore` (miles already claimed this
// tax year before this journey); the passenger supplement applies per fellow-employee.
export function computeMileage({ amapRows = [], vehicleType = 'car_van', journeyDate, miles = 0, ytdMilesBefore = 0, passengers = 0 }) {
  const m = Number(miles) || 0;
  const zero = { miles: 0, firstMiles: 0, aboveMiles: 0, firstRate: 0, aboveRate: 0, mileageAmount: 0, passengerAmount: 0, amount: 0 };
  if (m <= 0) return zero;

  if (vehicleType === 'car_van') {
    const ytd = Math.max(0, Number(ytdMilesBefore) || 0);
    const underLeft = Math.max(0, AMAP_THRESHOLD - ytd);
    const firstMiles = Math.min(m, underLeft);
    const aboveMiles = m - firstMiles;
    const firstRate = Number(resolveAmap(amapRows, 'car_van', 'first_10000', journeyDate)?.pence_per_mile || 0);
    const aboveRate = Number(resolveAmap(amapRows, 'car_van', 'above_10000', journeyDate)?.pence_per_mile || 0);
    const passRate = Number(resolveAmap(amapRows, 'passenger', 'per_passenger', journeyDate)?.pence_per_mile || 0);
    const mileageAmount = round2((firstMiles * firstRate + aboveMiles * aboveRate) / 100);
    const passengerAmount = round2((Number(passengers) || 0) * m * passRate / 100);
    return { miles: m, firstMiles, aboveMiles, firstRate, aboveRate, mileageAmount, passengerAmount, amount: round2(mileageAmount + passengerAmount) };
  }

  // motorcycle / bicycle: single rate, no 10k tier, no passenger supplement
  const rate = Number(resolveAmap(amapRows, vehicleType, 'all', journeyDate)?.pence_per_mile || 0);
  const mileageAmount = round2(m * rate / 100);
  return { miles: m, firstMiles: m, aboveMiles: 0, firstRate: rate, aboveRate: rate, mileageAmount, passengerAmount: 0, amount: mileageAmount };
}

// Reclaimable VAT on the fuel element of business mileage (requires a fuel VAT receipt).
// fuel element = miles × AFR; reclaimable VAT = fuel element × 1/6 (the 20% VAT fraction).
export function mileageFuelVat({ afrRows = [], fuel, engineBand, journeyDate, miles = 0, vatRate = 20 }) {
  const afr = Number(resolveAfr(afrRows, fuel, engineBand, journeyDate)?.pence_per_mile || 0);
  const fuelElement = round2((Number(miles) || 0) * afr / 100);
  return { afr, fuelElement, reclaimableVat: vatFractionOfGross(fuelElement, vatRate) };
}

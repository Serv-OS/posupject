import { describe, it, expect } from 'vitest';
import {
  resolveEffective, resolveVat, resolveAmap, resolveAfr,
  taxYearStartYear, taxYearBounds, computeMileage, mileageFuelVat,
} from './rates.js';

// Fixtures mirroring the 058_finance_rates.sql seed.
const VAT = [
  { code: 'standard', rate: 20, valid_from: '2011-01-04', valid_to: null },
  { code: 'reduced', rate: 5, valid_from: '2011-01-04', valid_to: null },
  { code: 'zero', rate: 0, valid_from: '2011-01-04', valid_to: null },
];
const AMAP = [
  { vehicle_type: 'car_van', tier: 'first_10000', pence_per_mile: 45, valid_from: '2011-04-06', valid_to: '2026-04-05' },
  { vehicle_type: 'car_van', tier: 'first_10000', pence_per_mile: 55, valid_from: '2026-04-06', valid_to: null },
  { vehicle_type: 'car_van', tier: 'above_10000', pence_per_mile: 25, valid_from: '2011-04-06', valid_to: null },
  { vehicle_type: 'motorcycle', tier: 'all', pence_per_mile: 24, valid_from: '2011-04-06', valid_to: null },
  { vehicle_type: 'bicycle', tier: 'all', pence_per_mile: 20, valid_from: '2011-04-06', valid_to: null },
  { vehicle_type: 'passenger', tier: 'per_passenger', pence_per_mile: 5, valid_from: '2002-04-06', valid_to: null },
];
const AFR = [
  { fuel: 'petrol', engine_band: 'up_to_1400cc', pence_per_mile: 14, valid_from: '2026-06-01', valid_to: null },
];

describe('resolveEffective (date windows)', () => {
  it('picks the row whose window contains the date', () => {
    expect(resolveAmap(AMAP, 'car_van', 'first_10000', '2026-03-01').pence_per_mile).toBe(45);
    expect(resolveAmap(AMAP, 'car_van', 'first_10000', '2026-06-01').pence_per_mile).toBe(55);
  });
  it('switches exactly on 6 Apr 2026 (the AMAP change)', () => {
    expect(resolveAmap(AMAP, 'car_van', 'first_10000', '2026-04-05').pence_per_mile).toBe(45); // last day of old
    expect(resolveAmap(AMAP, 'car_van', 'first_10000', '2026-04-06').pence_per_mile).toBe(55); // first day of new
  });
  it('returns null before any window / for unknown keys', () => {
    expect(resolveAmap(AMAP, 'car_van', 'first_10000', '2010-01-01')).toBe(null);
    expect(resolveEffective([], '2026-06-01')).toBe(null);
  });
});

describe('resolveVat / resolveAfr', () => {
  it('VAT standard = 20', () => { expect(resolveVat(VAT, 'standard', '2026-06-01').rate).toBe(20); });
  it('AFR petrol small engine = 14p', () => { expect(resolveAfr(AFR, 'petrol', 'up_to_1400cc', '2026-06-01').pence_per_mile).toBe(14); });
});

describe('UK tax year (6 Apr–5 Apr)', () => {
  it('start year', () => {
    expect(taxYearStartYear('2026-04-05')).toBe(2025);
    expect(taxYearStartYear('2026-04-06')).toBe(2026);
    expect(taxYearStartYear('2026-12-01')).toBe(2026);
    expect(taxYearStartYear('2027-01-31')).toBe(2026);
  });
  it('bounds + label', () => {
    expect(taxYearBounds('2026-06-01')).toEqual({ start: '2026-04-06', end: '2027-04-05', label: '2026/27' });
  });
});

describe('computeMileage — cars/vans', () => {
  it('under the 10k threshold uses the current first-tier rate', () => {
    const r = computeMileage({ amapRows: AMAP, vehicleType: 'car_van', journeyDate: '2026-06-01', miles: 100 });
    expect(r.amount).toBe(55); // 100 × 55p
  });
  it('honours the 6 Apr 2026 change for a pre-change journey', () => {
    const r = computeMileage({ amapRows: AMAP, vehicleType: 'car_van', journeyDate: '2026-03-01', miles: 100 });
    expect(r.amount).toBe(45); // 100 × 45p
  });
  it('crosses the 10,000-mile tier mid-journey', () => {
    // 9,500 already this tax year; a 1,000-mile trip → 500 @ 55p + 500 @ 25p = £400
    const r = computeMileage({ amapRows: AMAP, vehicleType: 'car_van', journeyDate: '2026-06-01', miles: 1000, ytdMilesBefore: 9500 });
    expect(r.firstMiles).toBe(500);
    expect(r.aboveMiles).toBe(500);
    expect(r.amount).toBe(400); // (500×55 + 500×25)/100
  });
  it('all miles above threshold use 25p', () => {
    const r = computeMileage({ amapRows: AMAP, vehicleType: 'car_van', journeyDate: '2026-06-01', miles: 200, ytdMilesBefore: 12000 });
    expect(r.amount).toBe(50); // 200 × 25p
  });
  it('adds the passenger supplement', () => {
    const r = computeMileage({ amapRows: AMAP, vehicleType: 'car_van', journeyDate: '2026-06-01', miles: 100, passengers: 2 });
    expect(r.passengerAmount).toBe(10); // 2 × 100 × 5p
    expect(r.amount).toBe(65); // 55 + 10
  });
});

describe('computeMileage — motorcycle / bicycle', () => {
  it('motorcycle flat 24p, no threshold/passenger', () => {
    const r = computeMileage({ amapRows: AMAP, vehicleType: 'motorcycle', journeyDate: '2026-06-01', miles: 100, ytdMilesBefore: 50000, passengers: 3 });
    expect(r.amount).toBe(24);
  });
  it('bicycle flat 20p', () => {
    expect(computeMileage({ amapRows: AMAP, vehicleType: 'bicycle', journeyDate: '2026-06-01', miles: 100 }).amount).toBe(20);
  });
});

describe('mileageFuelVat (reclaimable VAT on fuel element)', () => {
  it('100 mi petrol ≤1400cc @14p → £14 fuel, VAT £2.33 (1/6)', () => {
    const r = mileageFuelVat({ afrRows: AFR, fuel: 'petrol', engineBand: 'up_to_1400cc', journeyDate: '2026-06-01', miles: 100 });
    expect(r.fuelElement).toBe(14);
    expect(r.reclaimableVat).toBe(2.33); // 14 × 1/6 = 2.333 → 2.33
  });
});

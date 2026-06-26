import { describe, it, expect } from 'vitest';
import { round2, gbp0, gbp2, pct, lineNet, computeVat, lineTotals, computeTotals, vatFractionOfGross } from './money.js';

describe('round2 (half-up, float-safe)', () => {
  it('rounds half up to 2dp', () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(2.675)).toBe(2.68);
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(round2(10)).toBe(10);
    expect(round2(99.999)).toBe(100);
  });
});

describe('formatters', () => {
  it('gbp0 = whole pounds', () => {
    expect(gbp0(1234.56)).toBe('£1,235');
    expect(gbp0(0)).toBe('£0');
  });
  it('gbp2 = always 2dp', () => {
    expect(gbp2(1234.5)).toBe('£1,234.50');
    expect(gbp2(0)).toBe('£0.00');
  });
  it('pct', () => {
    expect(pct(20)).toBe('20.00%');
    expect(pct(null)).toBe('—');
    expect(pct('')).toBe('—');
  });
});

describe('lineNet', () => {
  it('qty × unit_price', () => { expect(lineNet({ qty: 2, unit_price: 10 })).toBe(20); });
  it('applies discount %', () => { expect(lineNet({ qty: 1, unit_price: 100, discount: 10 })).toBe(90); });
  it('defaults qty to 1', () => { expect(lineNet({ unit_price: 42 })).toBe(42); });
  it('empty line = 0', () => { expect(lineNet()).toBe(0); });
});

describe('computeVat (per-record snapshot rate)', () => {
  it('20% standard', () => { expect(computeVat(100, 20)).toBe(20); });
  it('5% reduced', () => { expect(computeVat(50, 5)).toBe(2.5); });
  it('0% zero-rated', () => { expect(computeVat(99.99, 0)).toBe(0); });
  it('rounds to the penny', () => { expect(computeVat(33.33, 20)).toBe(6.67); }); // 6.666 -> 6.67
});

describe('lineTotals', () => {
  it('returns net/vat/gross', () => {
    expect(lineTotals({ qty: 1, unit_price: 100, tax_rate: 20 })).toEqual({ net: 100, vat: 20, gross: 120 });
  });
  it('honours vat_rate alias + discount', () => {
    expect(lineTotals({ qty: 1, unit_price: 200, discount: 50, vat_rate: 20 })).toEqual({ net: 100, vat: 20, gross: 120 });
  });
});

describe('computeTotals (mixed VAT rates)', () => {
  it('sums net/vat/gross across rates', () => {
    const t = computeTotals([
      { qty: 2, unit_price: 10, tax_rate: 20 }, // net 20, vat 4
      { qty: 1, unit_price: 50, tax_rate: 5 },  // net 50, vat 2.5
      { qty: 1, unit_price: 30, tax_rate: 0 },  // net 30, vat 0
    ]);
    expect(t).toEqual({ net: 100, vat: 6.5, gross: 106.5 });
  });
  it('empty = zeros', () => { expect(computeTotals([])).toEqual({ net: 0, vat: 0, gross: 0 }); });
});

describe('vatFractionOfGross (mileage fuel reclaim)', () => {
  it('1/6 of a 20% gross amount', () => { expect(vatFractionOfGross(120, 20)).toBe(20); });
  it('reclaimable VAT on a £15 fuel element = £2.50', () => {
    // 100 business miles × 15p advisory fuel rate = £15 gross fuel; VAT = 15 × 1/6 = 2.50
    expect(vatFractionOfGross(15, 20)).toBe(2.5);
  });
  it('0% gives 0', () => { expect(vatFractionOfGross(100, 0)).toBe(0); });
});

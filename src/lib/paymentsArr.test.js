import { describe, it, expect } from 'vitest';
import { paymentsArrFromRates } from './paymentsArr.js';

describe('paymentsArrFromRates', () => {
  it('is twelve months of the margin between our rate and the buy rate', () => {
    // £100,000/mo at 1.20% charged against a 0.90% buy = £300/mo = £3,600/yr
    const r = paymentsArrFromRates([
      { monthly_volume: 100000, monthly_txns: 0, our_rate_pct: 1.2, buy_rate_pct: 0.9 },
    ]);
    expect(r.marginMonthly).toBeCloseTo(300, 6);
    expect(r.arr).toBeCloseTo(3600, 6);
    expect(r.priced).toBe(1);
  });

  it('counts per-transaction fees on both sides', () => {
    // 10,000 txns at 5p charged vs 3p bought = £2/mo on the fees alone
    const r = paymentsArrFromRates([
      { monthly_volume: 0, monthly_txns: 10000, our_rate_pct: 0, buy_rate_pct: 0, our_txn_fee: 5, buy_txn_fee: 3 },
    ]);
    expect(r.marginMonthly).toBeCloseTo(200, 6);
  });

  it('ignores rows that have not been priced, so we never invent revenue', () => {
    const r = paymentsArrFromRates([
      { monthly_volume: 50000, our_rate_pct: null, buy_rate_pct: 0.9 },
      { monthly_volume: 50000, our_rate_pct: '', buy_rate_pct: 0.9 },
      { monthly_volume: 50000, our_rate_pct: 1.4, buy_rate_pct: 0.9 },
    ]);
    expect(r.priced).toBe(1);
    expect(r.arr).toBeCloseTo(50000 * 0.005 * 12, 6);
  });

  it('a rate card we sell at cost earns nothing', () => {
    expect(paymentsArrFromRates([{ monthly_volume: 80000, our_rate_pct: 1, buy_rate_pct: 1 }]).arr).toBe(0);
  });

  it('survives an empty or missing account', () => {
    expect(paymentsArrFromRates().arr).toBe(0);
    expect(paymentsArrFromRates([]).priced).toBe(0);
  });
});

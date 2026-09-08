import { describe, it, expect } from 'vitest';
import { costFor, FALLBACK_ROWS, regionForCountry } from './cardCosts.js';

describe('regionForCountry', () => {
  it('maps the countries we trade in, and defaults to UK', () => {
    expect(regionForCountry('US')).toBe('US');
    expect(regionForCountry('us')).toBe('US');
    expect(regionForCountry('GB')).toBe('UK');
    expect(regionForCountry(null)).toBe('UK');
    expect(regionForCountry('FR')).toBe('UK');
  });
});

describe('costFor', () => {
  const tpl = { rows: { cp_vm_debit: { buy_rate_pct: 0.42, buy_txn_fee: 4, split_pct: 80 } } };

  it('reads the template when it has the row', () => {
    expect(costFor(tpl, 'cp_vm_debit')).toEqual({ buy: 0.42, buyTxn: 4, split: 80 });
  });

  it('falls back to the old constants for a row the template omits', () => {
    expect(costFor(tpl, 'cp_amex')).toEqual({
      buy: FALLBACK_ROWS.cp_amex.buy_rate_pct,
      buyTxn: FALLBACK_ROWS.cp_amex.buy_txn_fee,
      split: FALLBACK_ROWS.cp_amex.split_pct,
    });
  });

  it('treats a blank as unset rather than as free', () => {
    const blank = { rows: { cp_amex: { buy_rate_pct: '', buy_txn_fee: null, split_pct: 3 } } };
    const c = costFor(blank, 'cp_amex', { buy: 2, buyTxn: 10, split: 3 });
    expect(c.buy).toBe(2);      // the category's own value, not 0
    expect(c.buyTxn).toBe(10);
    expect(c.split).toBe(3);
  });

  it('keeps a genuine zero, which is a real cost', () => {
    const free = { rows: { cp_vm_debit: { buy_rate_pct: 0, buy_txn_fee: 0, split_pct: 50 } } };
    expect(costFor(free, 'cp_vm_debit')).toEqual({ buy: 0, buyTxn: 0, split: 50 });
  });

  it('survives no template at all', () => {
    expect(costFor(null, 'cp_vm_credit').buy).toBe(FALLBACK_ROWS.cp_vm_credit.buy_rate_pct);
  });
});

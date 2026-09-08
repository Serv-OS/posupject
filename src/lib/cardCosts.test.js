import { describe, it, expect } from 'vitest';
import { costFor, costExplain, regionForCountry, DEFAULT_MARKUP } from './cardCosts.js';

// UK consumer debit is capped at 0.20% with no fixed interchange.
// Our acquirer adds 0.10% + 5p, so we buy it at 0.30% + 5p.
const UK = {
  markup: { rate_pct: 0.10, txn_minor: 5 },
  rows: {
    cp_vm_debit: { ic_rate_pct: 0.20, ic_txn_minor: 0, split_pct: 82 },
    cp_vm_credit: { ic_rate_pct: 0.30, ic_txn_minor: 0, split_pct: 15 },
  },
};

describe('costFor', () => {
  it('adds our acquirer markup to interchange', () => {
    const c = costFor(UK, 'cp_vm_debit');
    expect(c.ic).toBe(0.20);
    expect(c.buy).toBe(0.30);      // 0.20 + 0.10
    expect(c.buyTxn).toBe(5);      // 0 + 5p
    expect(c.split).toBe(82);
  });

  it('adds a fixed interchange fee to the fixed markup', () => {
    // US regulated debit: 0.05% + 21c, plus our 0.10% + 5c = 0.15% + 26c
    const US = { markup: { rate_pct: 0.10, txn_minor: 5 }, rows: { cp_vm_debit: { ic_rate_pct: 0.05, ic_txn_minor: 21 } } };
    const c = costFor(US, 'cp_vm_debit');
    expect(c.buy).toBe(0.15);
    expect(c.buyTxn).toBe(26);
  });

  it('reports a card type with no interchange as unknown, never as free', () => {
    const c = costFor(UK, 'cp_amex');
    expect(c.buy).toBeNull();
    expect(c.buyTxn).toBeNull();
  });

  it('reports everything as unknown when the region has no template', () => {
    const c = costFor(null, 'cp_vm_debit');
    expect(c.buy).toBeNull();
    expect(c.markup).toEqual(DEFAULT_MARKUP);
  });

  it('rounds to the penny rather than trailing float noise', () => {
    const t = { markup: { rate_pct: 0.10, txn_minor: 5 }, rows: { x: { ic_rate_pct: 0.29, ic_txn_minor: 0 } } };
    expect(costFor(t, 'x').buy).toBe(0.39);
  });
});

describe('costExplain', () => {
  it('shows a rep exactly where the buy rate came from', () => {
    expect(costExplain(UK, 'cp_vm_debit')).toBe('0.2% + 0p interchange, plus 0.1% + 5p');
  });
  it('says plainly when nothing is set', () => {
    expect(costExplain(UK, 'cnp_amex')).toBe('No interchange set for this card type');
  });
});

describe('regionForCountry', () => {
  it('maps the countries we trade in', () => {
    expect(regionForCountry('US')).toBe('US');
    expect(regionForCountry('GB')).toBe('UK');
    expect(regionForCountry(null)).toBe('UK');
  });
});

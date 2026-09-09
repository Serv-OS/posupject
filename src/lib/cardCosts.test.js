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

  // Scheme fees (Visa and Mastercard assessments, auth and clearing) are a third
  // layer we pay on top of interchange. Forgetting them understated US credit
  // cost by roughly 0.14% + 2c, about 6% of the margin on a $45 ticket.
  it('adds scheme fees on top of interchange and markup', () => {
    const US = { markup: { rate_pct: 0.10, txn_minor: 5 },
      rows: { cp_vm_credit: { ic_rate_pct: 2.29, ic_txn_minor: 4, scheme_rate_pct: 0.14, scheme_txn_minor: 2 } } };
    const c = costFor(US, 'cp_vm_credit');
    expect(c.scheme).toBe(0.14);
    expect(c.schemeTxn).toBe(2);
    expect(c.buy).toBe(2.53);      // 2.29 + 0.14 + 0.10
    expect(c.buyTxn).toBe(11);     // 4 + 2 + 5
  });

  // Under IC+ pricing the acquirer's markup absorbs scheme fees, so leaving the
  // fields empty is a real answer and must not void the buy rate.
  it('treats an unset scheme fee as nothing to add, not as unknown', () => {
    const c = costFor(UK, 'cp_vm_debit');
    expect(c.scheme).toBeNull();
    expect(c.buy).toBe(0.30);
    expect(c.buyTxn).toBe(5);
  });

  it('still reports unknown INTERCHANGE as unknown even when scheme fees are set', () => {
    const t = { markup: DEFAULT_MARKUP, rows: { cp_amex: { scheme_rate_pct: 0.15, scheme_txn_minor: 2 } } };
    const c = costFor(t, 'cp_amex');
    expect(c.buy).toBeNull();
    expect(c.buyTxn).toBeNull();
  });

  // UK Amex is the case: the merchant holds their own agreement with American
  // Express, so there is nothing for us to buy. That is not the same as a cost
  // nobody has looked up yet, and the card should stop asking for it.
  it('distinguishes a card type we do not sell from one we have not priced', () => {
    const t = { markup: DEFAULT_MARKUP, rows: { cp_amex: { not_offered: true, split_pct: 3 } } };
    const c = costFor(t, 'cp_amex');
    expect(c.offered).toBe(false);
    expect(c.buy).toBeNull();
    expect(c.split).toBe(3);
    expect(costExplain(t, 'cp_amex')).toMatch(/direct/);
    // and a card type simply missing from the template is still "unknown"
    expect(costFor(t, 'cnp_amex').offered).toBe(true);
    expect(costExplain(t, 'cnp_amex')).toMatch(/No interchange set/);
  });

  it('rounds to the penny rather than trailing float noise', () => {
    const t = { markup: { rate_pct: 0.10, txn_minor: 5 }, rows: { x: { ic_rate_pct: 0.29, ic_txn_minor: 0 } } };
    expect(costFor(t, 'x').buy).toBe(0.39);
  });
});

describe('costExplain', () => {
  it('shows a rep exactly where the buy rate came from', () => {
    expect(costExplain(UK, 'cp_vm_debit')).toBe('0.2% + 0p interchange, plus 0.1% + 5p acquirer');
  });
  it('names the scheme layer when the region is charged one separately', () => {
    const US = { markup: { rate_pct: 0.10, txn_minor: 5 },
      rows: { cp_vm_credit: { ic_rate_pct: 2.29, ic_txn_minor: 4, scheme_rate_pct: 0.14, scheme_txn_minor: 2 } } };
    expect(costExplain(US, 'cp_vm_credit', 'c'))
      .toBe('2.29% + 4c interchange, plus 0.14% + 2c scheme fees, plus 0.1% + 5c acquirer');
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

import { describe, it, expect } from 'vitest';
import { hasName, lineValue, savableLines, namelessWithValue, invoiceTotals } from './invoiceLines.js';

const line = (o = {}) => ({ name: '', description: '', qty: 1, unit_price: 0, tax_rate: 20, ...o });

describe('the bug this file exists for (INV-1119)', () => {
  // Peter typed 268 into Unit £ and left the item name empty. The line was
  // dropped on save while the total was added up from it, so the invoice was
  // stored at 321.60 with no lines: the list said 321.60, the invoice 0.
  const typedPriceNoName = [line({ unit_price: 268 })];

  it('does not count a line the save would throw away', () => {
    expect(invoiceTotals(typedPriceNoName)).toMatchObject({ subtotal: 0, taxAmount: 0, total: 0 });
    expect(savableLines(typedPriceNoName)).toEqual([]);
  });

  it('flags it instead, so the save can stop and say which line', () => {
    const flagged = namelessWithValue(typedPriceNoName);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].index).toBe(0);
  });

  it('is happy once the line has a name', () => {
    const named = [line({ name: 'Monthly software', unit_price: 268 })];
    expect(namelessWithValue(named)).toEqual([]);
    expect(invoiceTotals(named)).toMatchObject({ subtotal: 268, taxAmount: 53.6, total: 321.6 });
  });
});

describe('hasName and lineValue', () => {
  it('treats blanks and spaces as no name', () => {
    expect(hasName(line())).toBe(false);
    expect(hasName(line({ name: '   ' }))).toBe(false);
    expect(hasName(line({ name: 'Card terminal' }))).toBe(true);
    expect(hasName(undefined)).toBe(false);
  });

  it('multiplies quantity by price, blanks counting as zero', () => {
    expect(lineValue(line({ qty: 3, unit_price: 50 }))).toBe(150);
    expect(lineValue(line({ qty: '2', unit_price: '12.50' }))).toBe(25);
    expect(lineValue(line({ qty: null, unit_price: 99 }))).toBe(0);
    expect(lineValue(undefined)).toBe(0);
  });
});

describe('namelessWithValue', () => {
  it('ignores an empty line, which is just an unused row', () => {
    expect(namelessWithValue([line()])).toEqual([]);
    expect(namelessWithValue([line({ qty: 4 })])).toEqual([]); // quantity alone is not money
  });

  it('catches a negative line too, and reports every position', () => {
    const rows = [line({ name: 'Install', unit_price: 100 }), line({ unit_price: -40 }), line({ unit_price: 10 })];
    expect(namelessWithValue(rows).map((x) => x.index)).toEqual([1, 2]);
  });

  it('copes with nothing at all', () => {
    expect(namelessWithValue(null)).toEqual([]);
    expect(savableLines(null)).toEqual([]);
  });
});

describe('invoiceTotals', () => {
  it('adds tax per line, so mixed rates are right', () => {
    const rows = [
      line({ name: 'Hardware', qty: 2, unit_price: 100, tax_rate: 20 }),
      line({ name: 'Book', qty: 1, unit_price: 50, tax_rate: 0 }),
    ];
    expect(invoiceTotals(rows)).toMatchObject({ subtotal: 250, taxAmount: 40, total: 290 });
  });

  it('counts only the named lines when both kinds are present', () => {
    const rows = [line({ name: 'Monthly software', unit_price: 268 }), line({ unit_price: 999 })];
    const t = invoiceTotals(rows);
    expect(t.kept).toHaveLength(1);
    expect(t.total).toBe(321.6);
  });

  it('is zero for an empty invoice', () => {
    expect(invoiceTotals([])).toMatchObject({ subtotal: 0, taxAmount: 0, total: 0 });
  });
});

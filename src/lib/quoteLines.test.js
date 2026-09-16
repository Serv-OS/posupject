import { describe, it, expect } from 'vitest';
import { sortQuoteLines, groupQuoteLines, saasStartText, lineCaption, softwareMonthly, customerRecurring, customerLines } from './quoteLines.js';

const lines = [
  { id: 1, name: 'ServOS Growth', category: 'saas', billing_type: 'monthly', line_total: 149, sort: 0 },
  { id: 2, name: 'Card reader', category: 'hardware', billing_type: 'one_off', line_total: 149, sort: 1 },
  { id: 3, name: 'Card processing', category: 'payments', billing_type: 'monthly', line_total: 400, sort: 2 },
  { id: 4, name: 'Install', category: 'services', billing_type: 'one_off', line_total: 216, sort: 3 },
  { id: 5, name: 'Terminal', category: 'hardware', billing_type: 'one_off', line_total: 780, sort: 4 },
  { id: 6, name: 'Support plan', category: 'saas', billing_type: 'annual', line_total: 1200, sort: 5 },
];

describe('sortQuoteLines', () => {
  it('puts hardware first, then services, software, card processing, keeping order within a section', () => {
    expect(sortQuoteLines(lines).map(l => l.id)).toEqual([2, 5, 4, 1, 6, 3]);
  });
  it('does not mutate the input', () => {
    const copy = [...lines]; sortQuoteLines(lines); expect(lines).toEqual(copy);
  });
  it('treats an unknown category as hardware-ish, at the front, and a missing sort as insertion order', () => {
    expect(sortQuoteLines([{ id: 'a', category: 'saas' }, { id: 'b' }]).map(l => l.id)).toEqual(['b', 'a']);
  });
});

describe('groupQuoteLines', () => {
  it('returns only the sections that have lines, with their titles', () => {
    const g = groupQuoteLines(lines);
    expect(g.map(x => x.category)).toEqual(['hardware', 'services', 'saas', 'payments']);
    expect(g[0].title).toBe('Hardware & setup');
    expect(g[2].items.map(i => i.id)).toEqual([1, 6]);
    expect(groupQuoteLines(lines.filter(l => l.category === 'saas')).map(x => x.category)).toEqual(['saas']);
  });
});

describe('saasStartText / lineCaption', () => {
  it('says from the go-live day when there is no delay', () => {
    expect(saasStartText(0)).toBe('from the day your account goes live');
    expect(saasStartText(undefined)).toBe('from the day your account goes live');
  });
  it('says the delay in days, singular and plural', () => {
    expect(saasStartText(30)).toBe('starting 30 days after your account goes live');
    expect(saasStartText(1)).toBe('starting 1 day after your account goes live');
  });
  it('captions software lines by billing type and one-off lines not at all', () => {
    expect(lineCaption({ billing_type: 'monthly' }, 30)).toBe('billed monthly, starting 30 days after your account goes live');
    expect(lineCaption({ billing_type: 'annual' }, 0)).toBe('billed annually, from the day your account goes live');
    expect(lineCaption({ billing_type: 'one_off' }, 30)).toBeNull();
  });
});

describe('softwareMonthly', () => {
  it('adds monthly software and spreads annual software, ignoring hardware and card processing', () => {
    expect(softwareMonthly(lines)).toBe(149 + 100);
  });
});

describe('customerRecurring', () => {
  const saas = (line_total, billing_type, tax_rate) => ({ category: 'saas', billing_type, line_total, tax_rate });

  it('299 a month at 20% is 299 ex, 59.80 tax, 358.80 inc, and no yearly figure', () => {
    const r = customerRecurring([saas(299, 'monthly', 20)]);
    expect(r).toEqual({
      monthlyEx: 299, monthlyTax: 59.8, monthlyInc: 358.8,
      annualEx: 0, annualTax: 0, annualInc: 0,
      hasMonthly: true, hasAnnual: false,
    });
  });

  it('a US quote at 0% tax shows no tax at all', () => {
    const r = customerRecurring([saas(349, 'monthly', 0)]);
    expect(r.monthlyEx).toBe(349);
    expect(r.monthlyTax).toBe(0);
    expect(r.monthlyInc).toBe(349);
    expect(r.hasMonthly).toBe(true);
  });

  it('keeps monthly and annual apart instead of spreading the annual line', () => {
    const r = customerRecurring([saas(149, 'monthly', 20), saas(1200, 'annual', 20)]);
    expect(r.monthlyEx).toBe(149);
    expect(r.monthlyTax).toBe(29.8);
    expect(r.monthlyInc).toBe(178.8);
    expect(r.annualEx).toBe(1200);
    expect(r.annualTax).toBe(240);
    expect(r.annualInc).toBe(1440);
    expect(r.hasMonthly).toBe(true);
    expect(r.hasAnnual).toBe(true);
  });

  it('ignores payments and hardware, so a card margin never reaches the customer', () => {
    const r = customerRecurring([
      { category: 'payments', billing_type: 'monthly', line_total: 6349.32, tax_rate: 0 },
      { category: 'hardware', billing_type: 'one_off', line_total: 780, tax_rate: 20 },
      { category: 'services', billing_type: 'one_off', line_total: 216, tax_rate: 20 },
    ]);
    expect(r).toEqual({
      monthlyEx: 0, monthlyTax: 0, monthlyInc: 0,
      annualEx: 0, annualTax: 0, annualInc: 0,
      hasMonthly: false, hasAnnual: false,
    });
  });

  it('rounds float noise away: three monthly lines whose tax sums to 175.39999999999998', () => {
    const r = customerRecurring([saas(299, 'monthly', 20), saas(149, 'monthly', 20), saas(429, 'monthly', 20)]);
    expect(r.monthlyEx).toBe(877);
    expect(r.monthlyTax).toBe(175.4);
    expect(r.monthlyInc).toBe(1052.4);
    expect(customerRecurring([saas(0.1, 'monthly', 0), saas(0.2, 'monthly', 0)]).monthlyEx).toBe(0.3);
  });

  it('copes with no lines and with lines missing a tax rate', () => {
    expect(customerRecurring([]).hasMonthly).toBe(false);
    expect(customerRecurring().monthlyEx).toBe(0);
    expect(customerRecurring([{ category: 'saas', billing_type: 'monthly', line_total: 50 }]).monthlyTax).toBe(0);
  });
});

describe('customerLines', () => {
  const hw = { id: 'a', category: 'hardware', billing_type: 'one_off', name: 'Terminal', qty: 2, unit_price: 390, discount: 0, line_total: 780, tax_rate: 20 };
  const sw = { id: 'b', category: 'saas', billing_type: 'monthly', name: 'Software', qty: 1, unit_price: 299, discount: 10, line_total: 269.1, tax_rate: 20 };
  // What the builder documents: the typed payments line is our internal margin override.
  const pay = { id: 'c', category: 'payments', billing_type: 'usage', name: 'ServOS Payments', qty: 1, unit_price: 6349.32, discount: 0, line_total: 6349.32, tax_rate: 0 };

  it('drops every figure on a payments line so the margin never reaches the customer in any column', () => {
    const out = customerLines([hw, sw, pay]);
    expect(out[2]).toEqual({ id: 'c', category: 'payments', billing_type: 'usage', name: 'ServOS Payments', qty: null, unit_price: null, discount: null, line_total: null, tax_rate: 0 });
    expect(JSON.stringify(out)).not.toContain('6349.32');
  });

  it('leaves every other line exactly as it was, and does not touch the input', () => {
    const out = customerLines([hw, sw, pay]);
    expect(out[0]).toBe(hw);
    expect(out[1]).toBe(sw);
    expect(pay.unit_price).toBe(6349.32);
    expect(pay.line_total).toBe(6349.32);
  });

  it('gives the same software figures as the raw lines, so the totals block is unchanged by it', () => {
    expect(customerRecurring(customerLines([hw, sw, pay]))).toEqual(customerRecurring([hw, sw, pay]));
  });

  it('copes with no lines', () => {
    expect(customerLines()).toEqual([]);
    expect(customerLines([])).toEqual([]);
  });
});

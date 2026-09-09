import { describe, it, expect } from 'vitest';
import { sortQuoteLines, groupQuoteLines, saasStartText, lineCaption, softwareMonthly } from './quoteLines.js';

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

import { describe, it, expect } from 'vitest';
import { advanceRunDate, buildBillFromSchedule, isDue } from './recurringBills.js';

describe('advanceRunDate', () => {
  it('monthly', () => { expect(advanceRunDate('2026-01-15', 'monthly', 15)).toBe('2026-02-15'); });
  it('quarterly', () => { expect(advanceRunDate('2026-01-01', 'quarterly', 1)).toBe('2026-04-01'); });
  it('annual', () => { expect(advanceRunDate('2026-06-01', 'annual', 1)).toBe('2027-06-01'); });
  it('clamps day_of_month to 28', () => { expect(advanceRunDate('2026-01-31', 'monthly', 31)).toBe('2026-02-28'); });
  it('rolls over the year', () => { expect(advanceRunDate('2026-12-10', 'monthly', 10)).toBe('2027-01-10'); });
});

describe('buildBillFromSchedule', () => {
  const sched = {
    id: 's1', label: 'Office rent', supplier_id: 'sup1', category_id: 'cat1', cost_context: 'ongoing',
    due_days: 14, created_by: 'u1',
    lines: [{ name: 'Rent', qty: 1, unit_price: 1000, tax_rate: 20 }, { name: 'Service charge', qty: 1, unit_price: 100, tax_rate: 20 }],
  };
  it('totals net/vat/gross via money lib', () => {
    const { bill } = buildBillFromSchedule(sched, '2026-06-01');
    expect(bill.subtotal).toBe(1100);
    expect(bill.tax_amount).toBe(220);
    expect(bill.total).toBe(1320);
  });
  it('creates as to_pay, never paid', () => {
    expect(buildBillFromSchedule(sched, '2026-06-01').bill.status).toBe('to_pay');
  });
  it('sets due date from due_days and carries recurring_id', () => {
    const { bill } = buildBillFromSchedule(sched, '2026-06-01');
    expect(bill.due_date).toBe('2026-06-15');
    expect(bill.recurring_id).toBe('s1');
  });
  it('maps line rows with sort + line_total', () => {
    const { billLines } = buildBillFromSchedule(sched, '2026-06-01');
    expect(billLines).toHaveLength(2);
    expect(billLines[1]).toMatchObject({ name: 'Service charge', line_total: 100, sort: 1 });
  });
});

describe('isDue', () => {
  it('due when active and next_run on/before today', () => {
    expect(isDue({ active: true, next_run: '2026-06-01' }, '2026-06-01')).toBe(true);
    expect(isDue({ active: true, next_run: '2026-05-01' }, '2026-06-01')).toBe(true);
  });
  it('not due when future or inactive', () => {
    expect(isDue({ active: true, next_run: '2026-07-01' }, '2026-06-01')).toBe(false);
    expect(isDue({ active: false, next_run: '2026-01-01' }, '2026-06-01')).toBe(false);
  });
});

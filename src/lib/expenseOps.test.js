import { describe, it, expect } from 'vitest';
import { ytdMilesBefore, canDo, buildApprovePatch, personOf, expenseMatches, sumExpenses } from './expenseOps.js';

const claims = [
  { id: 'a', type: 'mileage', journey_date: '2026-05-01', miles: 4000 },   // TY 2026
  { id: 'b', type: 'mileage', journey_date: '2026-06-01', miles: 3000 },   // TY 2026
  { id: 'c', type: 'mileage', journey_date: '2026-03-01', miles: 9000 },   // TY 2025 (before 6 Apr 2026)
  { id: 'd', type: 'staff_claim', journey_date: null, miles: null },       // not mileage
];

describe('ytdMilesBefore', () => {
  it('sums same-tax-year mileage on earlier journeys only', () => {
    // a 2026-06-15 journey, TY2026: a(4000)+b(3000)=7000; c is TY2025 (excluded)
    expect(ytdMilesBefore(claims, '2026-06-15')).toBe(7000);
  });
  it('excludes the claim being edited', () => {
    expect(ytdMilesBefore(claims, '2026-06-15', 'b')).toBe(4000); // only a
  });
  it('only counts strictly-earlier journeys', () => {
    expect(ytdMilesBefore(claims, '2026-05-01')).toBe(0); // nothing before 1 May in TY2026
  });
  it('respects the 6 Apr tax-year boundary', () => {
    // a journey on 2026-03-15 is TY2025 → only c (TY2025) counts, and only if earlier
    expect(ytdMilesBefore(claims, '2026-03-15')).toBe(9000);
  });
});

describe('canDo (workflow guards)', () => {
  const staff = { id: 'u1', role: 'viewer' };
  const owner = { id: 'u2', role: 'owner' };
  const mine = (status) => ({ status, submitter_id: 'u1' });

  it('submitter can submit a draft', () => { expect(canDo('submit', mine('draft'), staff)).toBe(true); });
  it('submitter can resubmit a rejected claim', () => { expect(canDo('submit', mine('rejected'), staff)).toBe(true); });
  it('staff cannot approve their own claim', () => { expect(canDo('approve', mine('submitted'), staff)).toBe(false); });
  it('approver can approve a submitted claim', () => { expect(canDo('approve', mine('submitted'), owner)).toBe(true); });
  it('approver can reject a submitted claim', () => { expect(canDo('reject', mine('submitted'), owner)).toBe(true); });
  it('approver can pay an approved claim', () => { expect(canDo('pay', mine('approved'), owner)).toBe(true); });
  it('cannot pay a claim that is not approved', () => { expect(canDo('pay', mine('submitted'), owner)).toBe(false); });
  it('staff cannot submit someone else’s claim', () => {
    expect(canDo('submit', { status: 'draft', submitter_id: 'other' }, staff)).toBe(false);
  });
});

describe('buildApprovePatch', () => {
  const now = '2026-09-01T10:00:00.000Z';

  it('stops a personal claim at approved, so it still has to be paid back', () => {
    const r = buildApprovePatch({ paid_by: 'personal' }, 'me', now);
    expect(r.status).toBe('approved');
    expect(r.patch.status).toBe('approved');
    expect(r.patch.approver_id).toBe('me');
    expect(r.patch.approved_at).toBe(now);
    expect(r.patch.rejection_reason).toBeNull();
    expect(r.patch.paid_at).toBeUndefined();       // nothing paid yet
  });

  // The one that matters for bulk approve: the company already spent this
  // money, so approving it must CLOSE it, not queue up a reimbursement.
  it('closes a company-card claim as paid, with nothing to reimburse', () => {
    const r = buildApprovePatch({ paid_by: 'company_card' }, 'me', now);
    expect(r.status).toBe('paid');
    expect(r.patch.status).toBe('paid');
    expect(r.patch.paid_at).toBe(now);
    expect(r.patch.payment_method).toBe('company_card');
    expect(r.note).toMatch(/no reimbursement/i);
  });

  it('treats a missing paid_by as personal', () => {
    expect(buildApprovePatch({}, 'me', now).status).toBe('approved');
  });
});

describe('personOf', () => {
  it('is who the money goes to, not who typed it in', () => {
    expect(personOf({ submitter_id: 'a', reimburse_to_user_id: 'b' })).toBe('b');
  });
  it('falls back to the submitter', () => {
    expect(personOf({ submitter_id: 'a', reimburse_to_user_id: null })).toBe('a');
  });
});

describe('expenseMatches', () => {
  const e = {
    expense_number: 1015, submitter_id: 'a', reimburse_to_user_id: 'b', category_id: 'fuel',
    type: 'staff_claim', paid_by: 'company_card', status: 'submitted',
    expense_date: '2026-08-25', total: 20, description: 'Fuel', category: { label: 'Fuel' },
  };
  it('matches an empty filter', () => expect(expenseMatches(e, {})).toBe(true));
  it('filters on the person being reimbursed, not the submitter', () => {
    expect(expenseMatches(e, { person: 'b' })).toBe(true);
    expect(expenseMatches(e, { person: 'a' })).toBe(false);
  });
  it('honours an inclusive date range', () => {
    expect(expenseMatches(e, { from: '2026-08-25', to: '2026-08-25' })).toBe(true);
    expect(expenseMatches(e, { from: '2026-08-26' })).toBe(false);
    expect(expenseMatches(e, { to: '2026-08-24' })).toBe(false);
  });
  it('separates company card from personal', () => {
    expect(expenseMatches(e, { paidBy: 'company_card' })).toBe(true);
    expect(expenseMatches(e, { paidBy: 'personal' })).toBe(false);
  });
  it('treats a missing paid_by as personal when filtering', () => {
    expect(expenseMatches({ ...e, paid_by: null }, { paidBy: 'personal' })).toBe(true);
  });
  it('searches the reference and the description', () => {
    expect(expenseMatches(e, { q: 'exp-1015' })).toBe(true);
    expect(expenseMatches(e, { q: 'fuel' })).toBe(true);
    expect(expenseMatches(e, { q: 'parking' })).toBe(false);
  });
  it('does not treat an amount of 0 as "no filter"', () => {
    expect(expenseMatches({ ...e, total: 0 }, { min: 0, max: 0 })).toBe(true);
    expect(expenseMatches(e, { max: 10 })).toBe(false);
  });
});

describe('sumExpenses', () => {
  it('keeps reclaimable VAT separate from VAT charged', () => {
    const t = sumExpenses([
      { subtotal: 100, tax_amount: 20, total: 120, vat_reclaimable: true, vat_reclaim_amount: 20 },
      { subtotal: 50, tax_amount: 10, total: 60, vat_reclaimable: false },   // no VAT invoice held
    ]);
    expect(t.count).toBe(2);
    expect(t.net).toBe(150);
    expect(t.tax).toBe(30);
    expect(t.gross).toBe(180);
    expect(t.reclaimable).toBe(20);
  });
  it('handles an empty list', () => expect(sumExpenses([]).gross).toBe(0));
});

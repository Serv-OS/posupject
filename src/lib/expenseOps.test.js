import { describe, it, expect } from 'vitest';
import { ytdMilesBefore, canDo } from './expenseOps.js';

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

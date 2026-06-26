// Pure helpers for staff expense/mileage claims — workflow guards + the per-tax-year
// mileage tally that decides which AMAP tier new miles fall in. Unit-tested (expenseOps.test.js).
import { taxYearStartYear } from './rates.js';

// Miles a staff member has already claimed in the SAME UK tax year, on journeys before
// this one — so computeMileage knows how much of the 10,000-mile first tier is left.
export function ytdMilesBefore(claims, journeyDate, excludeId) {
  const ty = taxYearStartYear(journeyDate);
  if (ty == null) return 0;
  return (claims || [])
    .filter(c => c.id !== excludeId && c.type === 'mileage' && c.journey_date && Number(c.miles)
      && taxYearStartYear(c.journey_date) === ty && c.journey_date < journeyDate)
    .reduce((s, c) => s + Number(c.miles), 0);
}

// Allowed status transitions. who: 'self' = submitter (or an approver acting on their behalf);
// 'approver' = editor/owner only.
export const EXPENSE_ACTIONS = {
  submit:   { from: ['draft', 'rejected'], to: 'submitted', who: 'self' },
  unsubmit: { from: ['submitted'], to: 'draft', who: 'self' },
  approve:  { from: ['submitted'], to: 'approved', who: 'approver' },
  reject:   { from: ['submitted'], to: 'rejected', who: 'approver' },
  pay:      { from: ['approved'], to: 'paid', who: 'approver' },
};

export function isApprover(profile) {
  return profile?.role === 'owner' || profile?.role === 'editor';
}

export function canDo(action, expense, profile) {
  const a = EXPENSE_ACTIONS[action];
  if (!a || !expense || !a.from.includes(expense.status)) return false;
  if (a.who === 'approver') return isApprover(profile);
  // 'self': the submitter, or an approver acting for them
  return expense.submitter_id === profile?.id || isApprover(profile);
}

export const STATUS_LABEL = { draft: 'Draft', submitted: 'Submitted', approved: 'Approved', rejected: 'Rejected', paid: 'Paid' };
export const STATUS_BADGE = {
  draft: 'bg-slate-200 text-slate-600', submitted: 'bg-blue-100 text-blue-700',
  approved: 'bg-indigo-100 text-indigo-700', rejected: 'bg-red-100 text-red-700', paid: 'bg-emerald-100 text-emerald-700',
};

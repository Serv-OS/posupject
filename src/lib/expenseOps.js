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

// Who actually paid. 'personal' claims are reimbursed to the claimant;
// 'company_card' spend is already settled by the company — it must still be
// recorded and VAT-reclaimed, but must never enter a reimbursement run.
export const PAID_BY = { personal: 'Personal (reimburse)', company_card: 'Company card (no reimbursement)' };
export const PAID_BY_SHORT = { personal: 'Reimburse', company_card: 'Company card' };
export const isCompanyPaid = (e) => e?.paid_by === 'company_card';

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

// ── Approving ────────────────────────────────────────────────────────────────
// Approving a COMPANY-CARD claim is not the same as approving a personal one.
// The company has already paid the money, so there is nothing to reimburse and
// the claim goes straight to `paid`. A personal claim stops at `approved` and
// waits for a reimbursement run.
//
// This lives here, shared, because the single-claim screen and the bulk action
// must never drift apart: bulk-approving eight company-card fuel receipts into
// `approved` would invent eight reimbursements that nobody is owed.
export function buildApprovePatch(expense, approverId, nowIso) {
  const base = { approver_id: approverId, approved_at: nowIso, rejection_reason: null };
  if (isCompanyPaid(expense)) {
    return {
      status: 'paid',
      patch: { ...base, status: 'paid', paid_at: nowIso, payment_method: 'company_card' },
      note: 'paid on the company card - no reimbursement due',
    };
  }
  return { status: 'approved', patch: { ...base, status: 'approved' }, note: null };
}

// Who a claim is FOR. Usually the submitter, but a claim can be raised on
// somebody else's behalf and reimbursed to them, and it is the person getting
// the money who matters when you are filtering a list before paying it.
export const personOf = (e) => e?.reimburse_to_user_id || e?.submitter_id || null;

// One filter predicate, used by the list, the bulk selection and the report, so
// "approve everything shown" and "everything shown" can never mean two things.
export function expenseMatches(e, f = {}) {
  if (!e) return false;
  if (f.person && personOf(e) !== f.person) return false;
  if (f.categoryId && e.category_id !== f.categoryId) return false;
  if (f.type && e.type !== f.type) return false;
  if (f.paidBy && (e.paid_by || 'personal') !== f.paidBy) return false;
  if (f.status && e.status !== f.status) return false;
  if (f.from && (!e.expense_date || e.expense_date < f.from)) return false;
  if (f.to && (!e.expense_date || e.expense_date > f.to)) return false;
  if (f.min !== '' && f.min != null && !(Number(e.total) >= Number(f.min))) return false;
  if (f.max !== '' && f.max != null && !(Number(e.total) <= Number(f.max))) return false;
  if (f.q) {
    const q = String(f.q).toLowerCase();
    const hay = [e.description, e.notes, e.purpose, e.from_location, e.to_location,
      `exp-${e.expense_number}`, e.category?.label, e.submitter?.display_name].filter(Boolean).join(' ').toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

// Totals for a report line. VAT is kept separate because the reclaimable figure
// is the one that has to agree with the VAT return, and it is NOT simply the
// tax on every row: a claim without a VAT invoice cannot be reclaimed.
export function sumExpenses(list) {
  return (list || []).reduce((a, e) => ({
    count: a.count + 1,
    net: a.net + Number(e.subtotal || 0),
    tax: a.tax + Number(e.tax_amount || 0),
    gross: a.gross + Number(e.total || 0),
    reclaimable: a.reclaimable + (e.vat_reclaimable ? Number(e.vat_reclaim_amount ?? e.tax_amount ?? 0) : 0),
  }), { count: 0, net: 0, tax: 0, gross: 0, reclaimable: 0 });
}

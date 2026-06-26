// Pure helpers for recurring supplier bills — schedule advancement + building a bill
// from a schedule. Shared shape with the expense-recurring edge fn. Unit-tested.
import { round2, computeTotals } from './money.js';

// Next occurrence: advance by frequency, clamped to day_of_month (1-28 for safety).
export function advanceRunDate(fromIso, frequency, dayOfMonth) {
  const d = new Date(fromIso + 'T00:00:00Z');
  const months = frequency === 'annual' ? 12 : frequency === 'quarterly' ? 3 : 1;
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, Math.min(Number(dayOfMonth) || 1, 28)));
  return next.toISOString().slice(0, 10);
}

const addDays = (iso, n) => new Date(new Date(iso + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);

// Build the bill header + line rows from a schedule for a given run date.
// Generated bills are 'to_pay' (never auto-paid) and carry recurring_id for traceability.
export function buildBillFromSchedule(sched, todayIso) {
  const lines = Array.isArray(sched.lines) ? sched.lines : [];
  const totals = computeTotals(lines);
  const bill = {
    supplier_id: sched.supplier_id || null, category_id: sched.category_id || null,
    company_id: sched.company_id || null, location_id: sched.location_id || null, deal_id: sched.deal_id || null,
    cost_context: sched.cost_context || 'ongoing', status: 'to_pay',
    description: sched.label || null, currency: sched.currency || 'GBP',
    issue_date: todayIso, due_date: addDays(todayIso, Number(sched.due_days) || 14),
    subtotal: totals.net, tax_amount: totals.vat, total: totals.gross,
    recurring_id: sched.id, created_by: sched.created_by || null,
  };
  const billLines = lines.map((l, i) => ({
    name: l.name || 'Item', description: l.description || null,
    qty: Number(l.qty) || 1, unit_price: Number(l.unit_price) || 0,
    tax_rate: Number(l.tax_rate ?? 20) || 0, category_id: l.category_id || sched.category_id || null,
    line_total: round2((Number(l.qty) || 1) * (Number(l.unit_price) || 0)), sort: i,
  }));
  return { bill, billLines };
}

export const isDue = (sched, todayIso) => !!sched.active && sched.next_run <= todayIso;

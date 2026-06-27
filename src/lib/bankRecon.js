// Pure reconciliation helpers for bank feeds — payee normalisation, dedup key,
// match suggestion (txn -> existing bill/expense), and payee->rule lookup. Unit-tested.
// The GoCardless fetch/auth lives in the edge functions; this is the matching brain.
import { round2 } from './money.js';

// Normalise a bank payee/description for matching + rules: uppercase, strip common
// card-network/scheme noise + punctuation, collapse whitespace.
export function normalizePayee(s) {
  return String(s || '').toUpperCase()
    .replace(/\b(LTD|LIMITED|PLC|UK|GBP|CARD PAYMENT|CARD|PAYMENT|DD|BGC|FPS|VISA|MASTERCARD|AMEX|CONTACTLESS)\b/g, ' ')
    .replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Stable-ish dedup key for a GoCardless transaction entry (transactionId preferred,
// then internalTransactionId, then a content hash for entries lacking both — e.g. pending).
export function dedupKey(t = {}) {
  if (t.transactionId) return 't:' + t.transactionId;
  if (t.internalTransactionId) return 'i:' + t.internalTransactionId;
  const a = t.transactionAmount || {};
  return 'h:' + [t.bookingDate || '', t.valueDate || '', a.amount || '', a.currency || '', (t.remittanceInformationUnstructured || '').slice(0, 60)].join('|');
}

// Suggest the best existing bill/expense for an OUTGOING transaction (negative amount).
// Amount must match to the penny; score adds date proximity + payee similarity.
export function suggestMatch(txn = {}, bills = [], expenses = []) {
  const amt = Number(txn.amount || 0);
  if (amt >= 0) return null;          // only money OUT matches a bill/expense
  const out = -amt;
  const txDate = txn.booking_date || txn.value_date;
  const payee = normalizePayee(txn.payee || txn.description);
  let best = null;
  const consider = (type, id, total, dateStr, name) => {
    if (round2(Math.abs(Number(total || 0))) !== round2(out)) return;     // penny-exact amount
    const days = txDate && dateStr ? Math.abs((new Date(txDate) - new Date(dateStr)) / 86400000) : 99;
    let score = 100 - Math.min(days, 60);
    const n = normalizePayee(name);
    if (n && payee && (n.includes(payee) || payee.includes(n))) score += 50;
    if (!best || score > best.score) best = { type, id, score };
  };
  for (const b of bills) consider('bill', b.id, b.total, b.due_date || b.issue_date, b.supplier_name);
  for (const e of expenses) consider('expense', e.id, e.total, e.expense_date, e.supplier_name);
  return best;
}

// First payee->rule whose pattern is contained in the transaction payee.
export function applyRule(txn = {}, rules = []) {
  const payee = normalizePayee(txn.payee || txn.description);
  if (!payee) return null;
  return rules.find(r => { const p = normalizePayee(r.payee_pattern); return p && payee.includes(p); }) || null;
}

// Build a paid bill from a transaction (money already left the account).
export function txnToBill(txn, { supplier_id = null, category_id = null, cost_context = 'ongoing' } = {}) {
  const gross = round2(Math.abs(Number(txn.amount || 0)));
  return {
    supplier_id, category_id, cost_context, status: 'paid',
    description: txn.payee || txn.description || 'Bank transaction',
    currency: txn.currency || 'GBP', issue_date: txn.booking_date || txn.value_date,
    subtotal: gross, tax_amount: 0, total: gross,
    amount_paid: gross, paid_at: txn.booking_date || txn.value_date,
    payment_method: 'bank', payment_reference: txn.dedup_key || null,
  };
}

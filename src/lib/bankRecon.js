// Pure reconciliation helpers for bank feeds — payee normalisation, dedup key,
// match suggestion (txn -> existing bill/expense), and payee->rule lookup. Unit-tested.
// The Enable Banking fetch/auth + JWT signing live in the edge functions; this is the
// matching brain plus pure mirrors of the Enable Banking transaction mapping (kept
// byte-for-byte identical to supabase/functions/_shared/enablebanking.ts so vitest covers it).
import { round2 } from './money.js';
import { balanceDue } from './creditNotes.js';

// Normalise a bank payee/description for matching + rules: uppercase, strip common
// card-network/scheme noise + punctuation, collapse whitespace.
export function normalizePayee(s) {
  return String(s || '').toUpperCase()
    .replace(/\b(LTD|LIMITED|PLC|UK|GBP|CARD PAYMENT|CARD|PAYMENT|DD|BGC|FPS|VISA|MASTERCARD|AMEX|CONTACTLESS)\b/g, ' ')
    .replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// --- Enable Banking transaction mapping (pure mirror of _shared/enablebanking.ts) ---
// entry_reference is the bank's unique tx id -> dedup key; fall back to a content hash.
export function ebDedupKey(t = {}) {
  if (t.entry_reference) return 'e:' + t.entry_reference;
  const a = t.transaction_amount || {};
  const rem = Array.isArray(t.remittance_information) ? t.remittance_information.join(' ') : (t.remittance_information || '');
  return 'h:' + [t.booking_date || '', t.value_date || '', a.amount || '', a.currency || '', t.credit_debit_indicator || '', String(rem).slice(0, 60)].join('|');
}
// Amount arrives as a POSITIVE string; the sign lives in credit_debit_indicator
// (CRDT = money in / +, DBIT = money out / -). bank_transactions stores it signed.
export function ebSignedAmount(t = {}) {
  const raw = Math.abs(Number(t.transaction_amount?.amount || 0));
  return t.credit_debit_indicator === 'DBIT' ? -raw : raw;
}
// Normalise one Enable Banking transaction into a bank_transactions row shape.
export function ebMapTransaction(t = {}) {
  const rem = Array.isArray(t.remittance_information) ? t.remittance_information.join(' ') : (t.remittance_information || null);
  const cdi = t.credit_debit_indicator;
  const payee = (cdi === 'DBIT' ? t.creditor?.name : t.debtor?.name) || t.creditor?.name || t.debtor?.name || null;
  return {
    dedup_key: ebDedupKey(t),
    status: t.status === 'PEND' ? 'pending' : 'booked',
    booking_date: t.booking_date || null,
    value_date: t.value_date || null,
    amount: ebSignedAmount(t),
    currency: t.transaction_amount?.currency || null,
    payee,
    description: rem,
  };
}

// --- Google Sheets (Monzo Business auto-export) mapping (pure mirror of _shared/gsheets.ts) ---
const _norm = (s) => String(s || '').trim().toLowerCase();
const _SHEET_COLS = {
  txnId: ['transaction id', 'id'], date: ['date'], time: ['time'], type: ['type'],
  name: ['name', 'merchant', 'counterparty', 'payee'], amount: ['amount'],
  moneyOut: ['money out', 'out'], moneyIn: ['money in', 'in'], currency: ['currency'],
  category: ['category'], notes: ['notes and #tags', 'notes', 'note'], description: ['description', 'reference'],
};
export function sheetHeaderIndex(headers = []) {
  const h = headers.map(_norm);
  const idx = {};
  for (const [k, names] of Object.entries(_SHEET_COLS)) {
    for (const n of names) { const i = h.indexOf(n); if (i >= 0) { idx[k] = i; break; } }
  }
  return idx;
}
// DD/MM/YYYY, YYYY-MM-DD, or anything Date can parse -> YYYY-MM-DD.
export function parseSheetDate(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
const _numOr0 = (v) => { const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; };
export function mapSheetRow(idx = {}, row = [], defCur = 'GBP') {
  const get = (k) => (idx[k] != null ? row[idx[k]] : undefined);
  const date = parseSheetDate(get('date'));
  let amount;
  if (idx.amount != null && String(get('amount') ?? '').trim() !== '') amount = _numOr0(get('amount'));
  else amount = _numOr0(get('moneyIn')) - Math.abs(_numOr0(get('moneyOut')));
  const txnId = String(get('txnId') ?? '').trim();
  const name = get('name') || null;
  const notes = get('notes') || get('description') || null;
  const dedup = txnId ? 'm:' + txnId
    : 'h:' + [date || '', get('time') || '', amount, name || '', String(notes || '').slice(0, 40)].join('|');
  if (!date && !txnId && !amount) return null;
  return { dedup_key: dedup, status: 'booked', booking_date: date, value_date: null, amount, currency: get('currency') || defCur, payee: name, description: notes };
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

// --- Monzo Developer API mapping (pure mirror of supabase/functions/_shared/monzo.ts) ---
// Amount is integer pence, negative = money out. Declined or zero lines never
// moved money and are skipped. settled === '' means authorised, not complete.
export function mapMonzoTransaction(t) {
  if (!t || !t.id || t.decline_reason) return null;
  const pence = Number(t.amount || 0);
  if (!pence) return null;
  const merchant = t.merchant && typeof t.merchant === 'object' ? t.merchant : null;
  const counterparty = t.counterparty && typeof t.counterparty === 'object' ? t.counterparty : null;
  const payee = merchant?.name || counterparty?.name || counterparty?.preferred_name || t.description || null;
  const ref = [t.notes, t.metadata?.notes, counterparty ? t.description : null]
    .map((x) => String(x ?? '').trim()).filter(Boolean);
  const day = (s) => (typeof s === 'string' && s.length >= 10 ? s.slice(0, 10) : null);
  return {
    dedup_key: 'mz:' + t.id,
    status: t.settled ? 'booked' : 'pending',
    booking_date: day(t.created),
    value_date: day(t.settled) || null,
    amount: Math.round(pence) / 100,
    currency: t.currency || 'GBP',
    payee,
    description: [...new Set(ref)].join(' · ') || t.description || null,
  };
}

// What is still owed on an invoice: the invoice screen's own rule (cash paid,
// credit notes and credit applied all come off), so a match never disagrees
// with what the invoice says is due.
export const invoiceBalance = (inv = {}) => balanceDue(inv);

// Does the bank reference carry this invoice's number? "INV-1021", "inv 1021",
// "1021" as a whole word. Short numbers need the INV prefix, so a £100
// payment never reads as invoice 100.
export function referencesInvoice(text, number) {
  if (number == null) return false;
  const s = String(text || '').toUpperCase();
  const n = String(number);
  if (new RegExp(`INV[\\s#:-]*0*${n}(?!\\d)`).test(s)) return true;
  return n.length >= 4 && new RegExp(`(^|\\D)${n}(?!\\d)`).test(s);
}

// Suggest the open invoice an INCOMING payment settles. The amount must equal
// what is still owed, to the penny, unless the reference names the invoice
// (a part payment). Score: reference names it, then payer looks like the
// customer, then closeness to the due date.
export function suggestInvoice(txn = {}, invoices = []) {
  const amt = round2(Number(txn.amount || 0));
  if (amt <= 0) return null;
  const text = `${txn.payee || ''} ${txn.description || ''}`;
  const payer = normalizePayee(txn.payee || txn.description);
  const txDate = txn.booking_date || txn.value_date;
  let best = null;
  for (const inv of invoices) {
    const owed = invoiceBalance(inv);
    if (owed <= 0) continue;
    const named = referencesInvoice(text, inv.invoice_number);
    const exact = owed === amt;
    if (!exact && !(named && amt < owed)) continue;
    const due = inv.due_date || inv.issue_date;
    const days = txDate && due ? Math.abs((new Date(txDate) - new Date(due)) / 86400000) : 60;
    let score = 100 - Math.min(days, 60);
    if (named) score += 200;
    const cust = normalizePayee(inv.company_name);
    if (cust && payer && (cust.includes(payer) || payer.includes(cust))) score += 80;
    if (!exact) score -= 50;
    if (!best || score > best.score) best = { type: 'invoice', id: inv.id, score, part: !exact };
  }
  return best;
}

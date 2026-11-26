import { describe, it, expect } from 'vitest';
import { normalizePayee, ebDedupKey, ebSignedAmount, ebMapTransaction, sheetHeaderIndex, parseSheetDate, mapSheetRow, suggestMatch, applyRule, txnToBill } from './bankRecon.js';

describe('normalizePayee', () => {
  it('strips scheme noise + punctuation', () => {
    expect(normalizePayee('ADOBE SYSTEMS LTD CARD PAYMENT')).toBe('ADOBE SYSTEMS');
    expect(normalizePayee('Tesco Stores 2847 VISA')).toBe('TESCO STORES 2847');
  });
});

describe('ebDedupKey', () => {
  it('prefers entry_reference, then a content hash', () => {
    expect(ebDedupKey({ entry_reference: 'abc' })).toBe('e:abc');
    expect(ebDedupKey({ booking_date: '2026-06-01', transaction_amount: { amount: '45.00', currency: 'GBP' }, credit_debit_indicator: 'DBIT', remittance_information: ['ADOBE'] }))
      .toBe('h:2026-06-01||45.00|GBP|DBIT|ADOBE');
  });
});

describe('ebSignedAmount', () => {
  it('signs DBIT negative, CRDT positive from a positive string', () => {
    expect(ebSignedAmount({ transaction_amount: { amount: '45.00' }, credit_debit_indicator: 'DBIT' })).toBe(-45);
    expect(ebSignedAmount({ transaction_amount: { amount: '45.00' }, credit_debit_indicator: 'CRDT' })).toBe(45);
  });
  it('never trusts a stray negative in the payload (sign comes from the indicator)', () => {
    expect(ebSignedAmount({ transaction_amount: { amount: '-45.00' }, credit_debit_indicator: 'DBIT' })).toBe(-45);
  });
});

describe('ebMapTransaction', () => {
  it('maps an outgoing (DBIT) payment to a signed, reconcile-ready row', () => {
    const m = ebMapTransaction({
      entry_reference: 'tx1', status: 'BOOK', booking_date: '2026-06-10', value_date: '2026-06-11',
      transaction_amount: { amount: '45.00', currency: 'GBP' }, credit_debit_indicator: 'DBIT',
      creditor: { name: 'Adobe Systems' }, remittance_information: ['CARD PAYMENT', 'ADOBE'],
    });
    expect(m).toEqual({ dedup_key: 'e:tx1', status: 'booked', booking_date: '2026-06-10', value_date: '2026-06-11', amount: -45, currency: 'GBP', payee: 'Adobe Systems', description: 'CARD PAYMENT ADOBE' });
  });
  it('marks pending and uses the debtor name for incoming credits', () => {
    const m = ebMapTransaction({ entry_reference: 'tx2', status: 'PEND', transaction_amount: { amount: '100.00', currency: 'GBP' }, credit_debit_indicator: 'CRDT', debtor: { name: 'A Client' } });
    expect(m.status).toBe('pending'); expect(m.amount).toBe(100); expect(m.payee).toBe('A Client');
  });
});

describe('Google Sheets (Monzo export) mapping', () => {
  // Representative Monzo Business auto-export header row.
  const headers = ['Transaction ID', 'Date', 'Time', 'Type', 'Name', 'Category', 'Amount', 'Currency', 'Notes and #tags', 'Description'];
  const idx = sheetHeaderIndex(headers);
  it('maps headers by name (order-independent)', () => {
    expect(idx.txnId).toBe(0); expect(idx.amount).toBe(6); expect(idx.name).toBe(4); expect(idx.notes).toBe(8);
  });
  it('parses Monzo DD/MM/YYYY and ISO dates', () => {
    expect(parseSheetDate('27/06/2026')).toBe('2026-06-27');
    expect(parseSheetDate('2026-06-27')).toBe('2026-06-27');
    expect(parseSheetDate('')).toBe(null);
  });
  it('maps an outgoing Monzo row (signed amount, txnId dedup)', () => {
    const row = ['tx_abc', '27/06/2026', '09:14:00', 'Card payment', 'ADOBE', 'Software', '-45.00', 'GBP', 'monthly', ''];
    expect(mapSheetRow(idx, row)).toEqual({ dedup_key: 'm:tx_abc', status: 'booked', booking_date: '2026-06-27', value_date: null, amount: -45, currency: 'GBP', payee: 'ADOBE', description: 'monthly' });
  });
  it('falls back to Money In/Out when there is no Amount column', () => {
    const h2 = ['Date', 'Name', 'Money Out', 'Money In', 'Currency'];
    const i2 = sheetHeaderIndex(h2);
    expect(mapSheetRow(i2, ['01/06/2026', 'Client Co', '', '1200.00', 'GBP']).amount).toBe(1200);
    expect(mapSheetRow(i2, ['02/06/2026', 'Rent', '950.00', '', 'GBP']).amount).toBe(-950);
  });
  it('skips blank spacer rows', () => {
    expect(mapSheetRow(idx, ['', '', '', '', '', '', '', '', '', ''])).toBe(null);
  });
});

describe('suggestMatch', () => {
  const txn = { amount: -45.0, booking_date: '2026-06-10', payee: 'ADOBE SYSTEMS LTD' };
  const bills = [
    { id: 'b1', total: 45.0, due_date: '2026-06-12', supplier_name: 'Adobe' },
    { id: 'b2', total: 99.0, due_date: '2026-06-10', supplier_name: 'Other' },
  ];
  it('matches on penny-exact amount + boosts payee similarity', () => {
    const m = suggestMatch(txn, bills, []);
    expect(m.type).toBe('bill'); expect(m.id).toBe('b1');
  });
  it('ignores amount mismatches', () => {
    expect(suggestMatch({ amount: -50, booking_date: '2026-06-10' }, bills, [])).toBe(null);
  });
  it('ignores incoming (positive) transactions', () => {
    expect(suggestMatch({ amount: 45, booking_date: '2026-06-10' }, bills, [])).toBe(null);
  });
  it('can match an expense too', () => {
    const m = suggestMatch({ amount: -12.5, booking_date: '2026-06-01', payee: 'PRET' }, [], [{ id: 'e1', total: 12.5, expense_date: '2026-06-01', supplier_name: 'Pret' }]);
    expect(m).toMatchObject({ type: 'expense', id: 'e1' });
  });
});

describe('applyRule', () => {
  const rules = [{ payee_pattern: 'ADOBE', category_id: 'cat-sw', supplier_id: 'sup-adobe' }];
  it('matches a payee pattern', () => {
    expect(applyRule({ payee: 'ADOBE SYSTEMS LTD' }, rules).category_id).toBe('cat-sw');
  });
  it('returns null when no rule matches', () => {
    expect(applyRule({ payee: 'TESCO' }, rules)).toBe(null);
  });
});

describe('txnToBill', () => {
  it('creates a paid bill from a transaction', () => {
    const b = txnToBill({ amount: -120, booking_date: '2026-06-01', payee: 'Rent Co', dedup_key: 't:1', currency: 'GBP' }, { supplier_id: 's1', category_id: 'c1' });
    expect(b).toMatchObject({ status: 'paid', total: 120, subtotal: 120, amount_paid: 120, paid_at: '2026-06-01', payment_method: 'bank', payment_reference: 't:1', supplier_id: 's1' });
  });
});

import { mapMonzoTransaction as mzWeb, suggestInvoice, referencesInvoice, invoiceBalance } from './bankRecon.js';
import { mapMonzoTransaction as mzServer } from '../../supabase/functions/_shared/monzo.ts';

describe('Monzo transactions', () => {
  const card = { id: 'tx_1', created: '2026-11-20T10:00:00Z', settled: '2026-11-21T09:00:00Z', amount: -1250, currency: 'GBP',
    description: 'AMAZON MKTPLACE', merchant: { name: 'Amazon' }, notes: '' };
  const bacs = { id: 'tx_2', created: '2026-11-22T08:00:00Z', settled: '', amount: 269160, currency: 'GBP',
    description: 'INV-1021', counterparty: { name: 'COFFEE BOY RETAIL LTD' }, notes: '' };

  it('maps money out and money in, signed, in pounds', () => {
    expect(mzWeb(card)).toEqual({ dedup_key: 'mz:tx_1', status: 'booked', booking_date: '2026-11-20', value_date: '2026-11-21',
      amount: -12.5, currency: 'GBP', payee: 'Amazon', description: 'AMAZON MKTPLACE' });
    expect(mzWeb(bacs)).toMatchObject({ status: 'pending', amount: 2691.6, payee: 'COFFEE BOY RETAIL LTD', description: 'INV-1021' });
  });

  it('skips declined and zero lines', () => {
    expect(mzWeb({ ...card, decline_reason: 'INSUFFICIENT_FUNDS' })).toBeNull();
    expect(mzWeb({ ...card, amount: 0 })).toBeNull();
    expect(mzWeb(null)).toBeNull();
  });

  it('the server copy maps the same', () => {
    for (const t of [card, bacs, { ...card, merchant: 'merch_1' }, { ...bacs, notes: 'Thanks', metadata: { notes: 'Thanks' } }]) {
      expect(mzServer(t)).toEqual(mzWeb(t));
    }
  });
});

describe('matching money in to invoices', () => {
  const inv = (o) => ({ id: o.id, invoice_number: o.n, total: o.total, amount_paid: o.paid || 0, due_date: o.due || '2026-11-25', company_name: o.co });
  const invoices = [
    inv({ id: 'a', n: 1021, total: 2691.6, co: 'Coffee Boy Retail' }),
    inv({ id: 'b', n: 1030, total: 500, co: 'Verde' }),
    inv({ id: 'c', n: 1031, total: 500, co: 'Mozz Sourdough Pizza' }),
  ];

  it('finds the invoice by the reference', () => {
    expect(referencesInvoice('INV-1021', 1021)).toBe(true);
    expect(referencesInvoice('inv 1021 thanks', 1021)).toBe(true);
    expect(referencesInvoice('Payment 1021', 1021)).toBe(true);
    expect(referencesInvoice('INV-10210', 1021)).toBe(false);
    expect(referencesInvoice('100 pounds', 100)).toBe(false);
    expect(referencesInvoice('INV 100', 100)).toBe(true);
  });

  it('suggests the exact amount, and the customer breaks a tie', () => {
    expect(suggestInvoice({ amount: 2691.6, payee: 'COFFEE BOY RETAIL LTD' }, invoices)).toMatchObject({ id: 'a', part: false });
    expect(suggestInvoice({ amount: 500, payee: 'MOZZ SOURDOUGH PIZZA LLC' }, invoices).id).toBe('c');
    expect(suggestInvoice({ amount: 500, payee: 'Someone', description: 'INV-1030' }, invoices).id).toBe('b');
  });

  it('allows a part payment only when the reference names the invoice', () => {
    expect(suggestInvoice({ amount: 1000, payee: 'Coffee Boy' }, invoices)).toBeNull();
    expect(suggestInvoice({ amount: 1000, payee: 'Coffee Boy', description: 'INV-1021 part' }, invoices)).toMatchObject({ id: 'a', part: true });
  });

  it('never matches money out, or a paid invoice', () => {
    expect(suggestInvoice({ amount: -500 }, invoices)).toBeNull();
    expect(suggestInvoice({ amount: 500, description: 'INV-1030' }, [inv({ id: 'b', n: 1030, total: 500, paid: 500 })])).toBeNull();
    expect(invoiceBalance({ total: 100, amount_paid: 40, amount_allocated: 10 })).toBe(50);
    expect(invoiceBalance({ total: 100, amount_paid: 0, amount_credited: 30 })).toBe(70);
  });
});

import { suggestPaidInvoice } from './bankRecon.js';
describe('linking money in to an invoice already marked paid', () => {
  const paid = [
    { id: 'p1', invoice_number: 1140, total: 474, amount_paid: 474, paid_at: '2026-11-25T18:20:00Z', company_name: 'Herberts Yard Operations LTD' },
    { id: 'p2', invoice_number: 1133, total: 474, amount_paid: 474, paid_at: '2026-11-25T18:18:00Z', company_name: 'Dudley DW Operations Ltd' },
  ];
  it('finds it by the reference', () => {
    expect(suggestPaidInvoice({ amount: 474, payee: 'HERBERTS YARD OPER', description: '1140', booking_date: '2026-11-11' }, paid)).toMatchObject({ id: 'p1', type: 'invoice_paid' });
    expect(suggestPaidInvoice({ amount: 474, payee: 'DUDLEY DW OPERATIO', description: '1133', booking_date: '2026-11-11' }, paid).id).toBe('p2');
  });
  it('never claims an invoice another line is linked to, or a different amount', () => {
    expect(suggestPaidInvoice({ amount: 474, description: '1140' }, paid, new Set(['p1']))).toBeNull();
    expect(suggestPaidInvoice({ amount: 470, description: '1140' }, paid)).toBeNull();
    expect(suggestPaidInvoice({ amount: -474, description: '1140' }, paid)).toBeNull();
  });
});

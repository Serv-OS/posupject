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

import { describe, it, expect } from 'vitest';
import { normalizePayee, dedupKey, suggestMatch, applyRule, txnToBill } from './bankRecon.js';

describe('normalizePayee', () => {
  it('strips scheme noise + punctuation', () => {
    expect(normalizePayee('ADOBE SYSTEMS LTD CARD PAYMENT')).toBe('ADOBE SYSTEMS');
    expect(normalizePayee('Tesco Stores 2847 VISA')).toBe('TESCO STORES 2847');
  });
});

describe('dedupKey', () => {
  it('prefers transactionId, then internal, then content hash', () => {
    expect(dedupKey({ transactionId: 'abc' })).toBe('t:abc');
    expect(dedupKey({ internalTransactionId: 'xyz' })).toBe('i:xyz');
    expect(dedupKey({ bookingDate: '2026-06-01', transactionAmount: { amount: '-45.00', currency: 'GBP' }, remittanceInformationUnstructured: 'ADOBE' }))
      .toBe('h:2026-06-01||-45.00|GBP|ADOBE');
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

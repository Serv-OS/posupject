import { describe, it, expect } from 'vitest';
import { statementTotals, statementToRates, blankStatement, STATEMENT_LINES } from './statement.js';

// A REAL Toast statement: MOZZ Provo, August 2026. Every figure below is off
// the page, so if this test ever fails the maths has drifted from a document
// we can hold up next to it.
const MOZZ = {
  cp_vm:    { rate: '2.49', fee: '15', txns: '2269', volume: '92922.34' },
  cnp_vm:   { rate: '3.50', fee: '15', txns: '334',  volume: '17365.31' },
  cp_amex:  { rate: '3.29', fee: '15', txns: '335',  volume: '17270.03' },
  cnp_amex: { rate: '3.89', fee: '15', txns: '66',   volume: '3996.83' },
};

describe('statementTotals', () => {
  it('reproduces what the statement says the merchant paid', () => {
    const t = statementTotals(MOZZ);
    expect(t.vol).toBeCloseTo(131554.51, 2);   // statement Total, Payments
    expect(t.txns).toBe(3004);                 // statement Total, count
    // Within a cent of the statement's $4,095.82. It is not exact because Toast
    // rounds each of the four lines to the cent before adding them up, and this
    // adds first. Anything larger than a cent would mean the maths has drifted.
    expect(Math.abs(t.cost - 4095.82)).toBeLessThan(0.01);
  });

  it('gives the effective rate the merchant is actually paying', () => {
    const t = statementTotals(MOZZ);
    expect(t.eff).toBeCloseTo(3.113, 2);
    expect(t.avg).toBeCloseTo(43.79, 2);
  });

  it('reads an empty statement as nothing rather than dividing by zero', () => {
    const t = statementTotals(blankStatement());
    expect(t.vol).toBe(0);
    expect(t.eff).toBe(0);
    expect(t.avg).toBe(0);
  });
});

describe('statementToRates', () => {
  const out = statementToRates(MOZZ, 55);

  it('splits volume into the two channels the rate card uses', () => {
    expect(out.cp_volume).toBeCloseTo(92922.34 + 17270.03, 2);
    expect(out.cnp_volume).toBeCloseTo(17365.31 + 3996.83, 2);
    expect(out.avg_txn_size).toBeCloseTo(43.79, 2);
  });

  // The whole point: the customer pays ONE rate on Visa/Mastercard, so both
  // our credit and our debit row must carry it. Splitting the price here would
  // misstate what they pay today and flatter the saving.
  it('writes the one Visa/Mastercard rate onto BOTH the credit and debit rows', () => {
    expect(out.rows.cp_vm_debit.current_rate_pct).toBe('2.49');
    expect(out.rows.cp_vm_credit.current_rate_pct).toBe('2.49');
    expect(out.rows.cp_vm_debit.current_txn_fee).toBe('15');
    expect(out.rows.cnp_vm_credit.current_rate_pct).toBe('3.50');
    expect(out.rows.cp_amex.current_rate_pct).toBe('3.29');
    expect(out.rows.cnp_amex.current_rate_pct).toBe('3.89');
  });

  it('splits each channel by card mix, and the splits total 100', () => {
    const cp = ['cp_vm_debit', 'cp_vm_credit', 'cp_amex'].reduce((s, k) => s + Number(out.rows[k].split), 0);
    const cnp = ['cnp_vm_debit', 'cnp_vm_credit', 'cnp_amex'].reduce((s, k) => s + Number(out.rows[k].split), 0);
    expect(cp).toBeCloseTo(100, 1);
    expect(cnp).toBeCloseTo(100, 1);
    // Amex was 17,270 of the 110,192 swiped, so 15.67%.
    expect(Number(out.rows.cp_amex.split)).toBeCloseTo(15.67, 1);
  });

  it('moves volume between debit and credit as the debit share changes, without changing the total', () => {
    const a = statementToRates(MOZZ, 40), b = statementToRates(MOZZ, 70);
    expect(Number(a.rows.cp_vm_debit.split)).toBeLessThan(Number(b.rows.cp_vm_debit.split));
    const sum = (o) => Number(o.rows.cp_vm_debit.split) + Number(o.rows.cp_vm_credit.split);
    expect(sum(a)).toBeCloseTo(sum(b), 1);
  });

  it('clamps a nonsense debit share instead of inventing negative volume', () => {
    for (const bad of [-20, 140, 'abc']) {
      const r = statementToRates(MOZZ, bad);
      const d = Number(r.rows.cp_vm_debit.split), c = Number(r.rows.cp_vm_credit.split);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(c).toBeGreaterThanOrEqual(0);
    }
  });

  it('survives a statement with only some lines filled in', () => {
    const partial = { ...blankStatement(), cp_vm: { rate: '2.6', fee: '10', txns: '100', volume: '4000' } };
    const r = statementToRates(partial, 55);
    expect(r.cp_volume).toBe(4000);
    expect(r.cnp_volume).toBe(0);
    expect(Number(r.rows.cnp_amex.split)).toBe(0);
  });
});

describe('STATEMENT_LINES', () => {
  it('matches the four lines a real US statement prints', () => {
    expect(STATEMENT_LINES.map(l => l.key)).toEqual(['cp_vm', 'cnp_vm', 'cp_amex', 'cnp_amex']);
  });
});

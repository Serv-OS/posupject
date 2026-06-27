import { describe, it, expect } from 'vitest';
import { classifyVat, computeVatReturn, vatReturnCsv } from './vatReturn.js';

describe('classifyVat', () => {
  it('reclaimable when marked + has VAT invoice + vat > 0', () => {
    expect(classifyVat({ tax_amount: 20, vat_reclaimable: true, has_vat_invoice: true }).reclaimable).toBe(true);
  });
  it('flagged when reclaimable but no valid VAT invoice', () => {
    const c = classifyVat({ tax_amount: 20, vat_reclaimable: true, has_vat_invoice: false });
    expect(c.reclaimable).toBe(false);
    expect(c.flaggedMissingInvoice).toBe(true);
  });
  it('not reclaimable when category blocks it (e.g. entertainment)', () => {
    const c = classifyVat({ tax_amount: 20, vat_reclaimable: false, has_vat_invoice: true });
    expect(c.reclaimable).toBe(false);
    expect(c.flaggedMissingInvoice).toBe(false);
  });
  it('honours a partial vat_reclaim_amount override', () => {
    expect(classifyVat({ tax_amount: 20, vat_reclaim_amount: 10, vat_reclaimable: true, has_vat_invoice: true }).reclaimAmt).toBe(10);
  });
});

describe('computeVatReturn', () => {
  const items = [
    { source: 'bill', supplier: 'Adobe', category: 'Software', tax_amount: 20, vat_reclaimable: true, has_vat_invoice: true },
    { source: 'bill', supplier: 'Landlord', category: 'Rent', tax_amount: 0, vat_reclaimable: false, has_vat_invoice: false },
    { source: 'expense', supplier: 'Pret', category: 'Subsistence', tax_amount: 2, vat_reclaimable: true, has_vat_invoice: true },
    { source: 'expense', supplier: 'Cabs', category: 'Travel', tax_amount: 5, vat_reclaimable: true, has_vat_invoice: false }, // flagged
    { source: 'bill', supplier: 'Client dinner', category: 'Entertainment', tax_amount: 12, vat_reclaimable: false, has_vat_invoice: true }, // blocked
  ];
  const r = computeVatReturn(items);
  it('box4 sums only reclaimable VAT', () => { expect(r.box4).toBe(22); }); // 20 + 2
  it('flags missing-invoice items separately', () => {
    expect(r.flaggedCount).toBe(1);
    expect(r.flaggedVat).toBe(5);
  });
  it('breaks down by category + supplier', () => {
    expect(r.byCategory).toEqual({ Software: 20, Subsistence: 2 });
    expect(r.bySupplier).toEqual({ Adobe: 20, Pret: 2 });
  });
});

describe('vatReturnCsv', () => {
  it('has a header + escapes + flags status; guards formula injection', () => {
    const csv = vatReturnCsv([
      { source: 'bill', ref: 'BILL-1', date: '2026-06-01', supplier: '=cmd()', category: 'Software', net: 100, tax_amount: 20, vat_reclaimable: true, has_vat_invoice: true },
    ], '2026-04-06', '2026-07-05');
    expect(csv).toContain('Reclaimable VAT');
    expect(csv).toContain("'=cmd()"); // neutralised leading =
    expect(csv).toContain('reclaimable');
  });
});

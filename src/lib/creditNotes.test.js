import { describe, it, expect } from 'vitest';
import {
  lineNet, lineTax, creditTotals, creditableLeft, balanceDue, creditState, canRaiseCredit,
  linesFromInvoice, validateCredit, refundFor, creditNoteLabel, creditNoteStatusLabel, creditNoteStatusKind,
  issuedTotal, amountPaid, taxRatesFor, MAX_LINES,
  lineCreditLeft, creditIssueDate, cancelCreditEffect, overpaidNotOnCredit,
  creditAvailable, creditUse, settledAmount, markPaidAmount, allocationProblems, allocationDefault,
  allocationEffect, removeAllocationEffect, companyCreditAvailable, ALLOCATABLE_STATUSES, refundProblem,
  amountReceivedEffect, markPaymentTotal, RECEIVED_KINDS, PAYMENT_REASON, overpaidAdvice,
} from './creditNotes.js';

// An invoice exactly as the app stores one. The two reduces are copied from
// InvoiceBuilder.jsx (and invoice-recurring does the same): nothing is rounded
// per line or in total. The JSON round trip is what happens on the way into
// Postgres and back out through PostgREST, so the header carries the same float
// noise a real saved invoice does.
let nextId = 1;
function savedInvoice(lines, extra = {}) {
  const subtotal = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unit_price) || 0), 0);
  const taxAmount = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unit_price) || 0) * (Number(l.tax_rate) || 0) / 100, 0);
  const total = subtotal + taxAmount;
  const invoice = JSON.parse(JSON.stringify({ status: 'sent', subtotal, tax_amount: taxAmount, total, amount_paid: null, amount_credited: 0, ...extra }));
  const invoiceLines = JSON.parse(JSON.stringify(lines.map((l, i) => ({ id: `line-${nextId++}`, sort: i, ...l }))));
  return { invoice, invoiceLines };
}

// The total the customer was shown: the app formats with toLocaleString at 2dp.
const shown = (n) => Number(Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false }));

// What issue_credit_note does to the invoice, so a sequence of credits can be followed.
const afterCredit = (invoice, total) => ({ ...invoice, amount_credited: Math.round((invoice.amount_credited + total) * 100) / 100 });

describe('creditNoteLabel and status', () => {
  it('numbers credit notes CN-1001 on', () => {
    expect(creditNoteLabel(1001)).toBe('CN-1001');
    expect(creditNoteLabel({ credit_number: 1002 })).toBe('CN-1002');
    expect(creditNoteLabel(null)).toBe('');
  });
  it('keys the chip from status, refund and credit used', () => {
    expect(creditNoteStatusKind({ status: 'issued', refund_status: 'none' })).toBe('Issued');
    expect(creditNoteStatusKind({ status: 'issued', refund_status: 'owed', refund_due: 224, amount_allocated: 0 })).toBe('Available');
    expect(creditNoteStatusKind({ status: 'issued', refund_status: 'owed', refund_due: 224 })).toBe('Available');
    expect(creditNoteStatusKind({ status: 'issued', refund_status: 'owed', refund_due: 224, amount_allocated: 100 })).toBe('Part used');
    expect(creditNoteStatusKind({ status: 'issued', refund_status: 'allocated', refund_due: 224, amount_allocated: 224 })).toBe('Used');
    expect(creditNoteStatusKind({ status: 'issued', refund_status: 'refunded' })).toBe('Refunded');
    expect(creditNoteStatusKind({ status: 'issued', refund_status: 'refunded', refund_due: 224, amount_allocated: 100, refunded_amount: 124 })).toBe('Refunded');
    expect(creditNoteStatusKind({ status: 'cancelled', refund_status: 'none' })).toBe('Cancelled');
  });

  it('says what happened to the credit in plain words', () => {
    // Nothing owed: it reduced its own invoice's balance.
    expect(creditNoteStatusLabel({ status: 'issued', refund_status: 'none', invoice: { invoice_number: 1036 } })).toBe('Used on INV-1036');
    expect(creditNoteStatusLabel({ status: 'issued', refund_status: 'none', invoice_number: 1036 })).toBe('Used on INV-1036');
    expect(creditNoteStatusLabel({ status: 'issued', refund_status: 'none' }, { invoiceNumber: 1036 })).toBe('Used on INV-1036');
    expect(creditNoteStatusLabel({ status: 'issued', refund_status: 'none' })).toBe('Used on its invoice');
    // Credit to use, whole or part used.
    expect(creditNoteStatusLabel({ status: 'issued', refund_status: 'owed', refund_due: 224 })).toBe('£224.00 to use');
    expect(creditNoteStatusLabel({ status: 'issued', refund_status: 'owed', refund_due: 224, amount_allocated: 100 })).toBe('£100.00 used, £124.00 to use');
    expect(creditNoteStatusLabel({ status: 'issued', refund_status: 'owed', refund_due: 1344, amount_allocated: 0.5, currency: 'USD' })).toBe('$0.50 used, $1,343.50 to use');
    // Credit applied from a note that had a refund on it, then removed, owes again.
    expect(creditNoteStatusLabel({ status: 'issued', refund_status: 'owed', refund_due: 224, refunded_amount: 124 })).toBe('£124.00 refunded, £100.00 to use');
    // The screen's own money format when it passes one.
    expect(creditNoteStatusLabel({ status: 'issued', refund_status: 'owed', refund_due: 224, currency: 'GBP' }, { money: (n, c) => `${c} ${n}` })).toBe('GBP 224 to use');
    // All applied: every invoice it went to, removed ones left out.
    const used = { status: 'issued', refund_status: 'allocated', refund_due: 224, amount_allocated: 224 };
    expect(creditNoteStatusLabel(used, { usedOn: [1050] })).toBe('Used on INV-1050');
    expect(creditNoteStatusLabel(used, { usedOn: [{ invoice: { invoice_number: 1051 } }, { invoice_number: 1050 }, 'INV-1050'] })).toBe('Used on INV-1050 and INV-1051');
    expect(creditNoteStatusLabel(used, { usedOn: [1100, 999, 1050, { invoice: { invoice_number: 7 }, removed_at: '2026-09-14' }] })).toBe('Used on INV-999, INV-1050 and INV-1100');
    expect(creditNoteStatusLabel({ ...used, used_on: [1050] })).toBe('Used on INV-1050');
    expect(creditNoteStatusLabel(used)).toBe('Used on another invoice');
    // Refunded and Cancelled as they were.
    expect(creditNoteStatusLabel({ status: 'issued', refund_status: 'refunded', refund_due: 224, amount_allocated: 100, refunded_amount: 124 })).toBe('Refunded');
    expect(creditNoteStatusLabel({ status: 'cancelled', refund_status: 'none', invoice_number: 1036 })).toBe('Cancelled');
    expect(creditNoteStatusLabel(null)).toBe('Used on its invoice');
  });
  it('adds up issued notes only', () => {
    expect(issuedTotal([{ status: 'issued', total: 10.1 }, { status: 'cancelled', total: 99 }, { status: 'issued', total: 0.2 }])).toBe(10.3);
    expect(issuedTotal([])).toBe(0);
  });
});

describe('line and credit totals', () => {
  it('leaves lines unrounded, like an invoice line', () => {
    const line = { qty: 3, unit_price: 33.33, tax_rate: 20 };
    expect(lineNet(line)).toBe(99.99);
    expect(lineTax(line)).toBe(19.998);
  });

  it('rounds 3 x 33.33 at 20% once, on the totals', () => {
    expect(creditTotals([{ qty: 3, unit_price: 33.33, tax_rate: 20 }])).toEqual({ subtotal: 99.99, tax_amount: 20, total: 119.99 });
  });

  it('does not round line by line (that would credit more than the invoice)', () => {
    const lines = [1, 2, 3].map(() => ({ qty: 1, unit_price: 0.03, tax_rate: 20 }));
    // Each line has 0.006 of tax. Rounded per line that is 0.03 of tax and 0.12 in all.
    expect(creditTotals(lines)).toEqual({ subtotal: 0.09, tax_amount: 0.02, total: 0.11 });
    const { invoice } = savedInvoice(lines);
    expect(shown(invoice.total)).toBe(0.11);
  });

  it('keeps subtotal + tax = total on the note', () => {
    const t = creditTotals([{ qty: 0.5, unit_price: 0.01, tax_rate: 0 }, { qty: 0.5, unit_price: 0.01, tax_rate: 100 }]);
    expect(Math.round((t.subtotal + t.tax_amount) * 100)).toBe(Math.round(t.total * 100));
  });

  it('rounds exactly at half a penny the way the database does, not the way floats do', () => {
    // 0.5 x 2469.99 = 1234.995. In floats that rounds to 1234.99; Postgres and the invoice screen say 1235.00.
    expect(creditTotals([{ qty: 0.5, unit_price: 2469.99, tax_rate: 0 }]).total).toBe(1235);
    // 1.5 x 100.01 = 150.015, which the browser holds as 150.01500000000001.
    expect(creditTotals([{ qty: 1.5, unit_price: 100.01, tax_rate: 0 }]).total).toBe(150.02);
    expect(creditTotals([{ qty: 1, unit_price: 1.005, tax_rate: 0 }]).total).toBe(1.01);
  });

  it('treats a missing tax rate as 0 and reads numbers typed as text', () => {
    expect(creditTotals([{ qty: '2', unit_price: '10.50' }])).toEqual({ subtotal: 21, tax_amount: 0, total: 21 });
    expect(creditTotals([{ qty: '1e1', unit_price: 1, tax_rate: '20' }]).total).toBe(12);
    expect(creditTotals([])).toEqual({ subtotal: 0, tax_amount: 0, total: 0 });
  });
});

describe('a full credit equals the invoice total to the penny', () => {
  const cases = {
    'UK, mixed 20%, 5% and zero rated': [
      { name: 'POS terminal', qty: 2, unit_price: 499.99, tax_rate: 20 },
      { name: 'Printed menus', qty: 3, unit_price: 33.33, tax_rate: 5 },
      { name: 'Card processing setup', qty: 1, unit_price: 49.95, tax_rate: 0 },
    ],
    'US sales tax at 8.875% and 0%': [
      { name: 'Kitchen display', qty: 1, unit_price: 1299.0, tax_rate: 8.875 },
      { name: 'Install', qty: 3.5, unit_price: 85.25, tax_rate: 0 },
      { name: 'Cable kit', qty: 7, unit_price: 12.49, tax_rate: 8.875 },
    ],
    'hours at half a penny': [
      { name: 'Training (hours)', qty: 1.5, unit_price: 100.01, tax_rate: 0 },
      { name: 'Consulting (hours)', qty: 0.5, unit_price: 2469.99, tax_rate: 0 },
    ],
    'many small lines whose tax rounds up one by one': [1, 2, 3, 4, 5, 6, 7].map((i) => ({ name: `Sticker ${i}`, qty: 1, unit_price: 0.03, tax_rate: 20 })),
    'a discounted quote line (unit price with float noise)': [
      { name: 'Hardware bundle', qty: 3, unit_price: 33.33 * (1 - 10 / 100), tax_rate: 20 },
      { name: 'Setup', qty: 1, unit_price: 149 * (1 - 12.5 / 100), tax_rate: 20 },
    ],
  };

  for (const [label, lines] of Object.entries(cases)) {
    it(label, () => {
      const { invoice, invoiceLines } = savedInvoice(lines);
      const credit = linesFromInvoice(invoiceLines);
      const t = creditTotals(credit);
      expect(t.total).toBe(shown(invoice.total));
      expect(t.total).toBe(creditableLeft(invoice));
      expect(validateCredit({ invoice, lines: credit, reason: 'Order cancelled', invoiceLines })).toEqual([]);
      const credited = afterCredit(invoice, t.total);
      expect(creditState(credited)).toBe('full');
      expect(creditableLeft(credited)).toBe(0);
      expect(balanceDue(credited)).toBe(0);
      expect(canRaiseCredit(credited)).toBe(false);
    });
  }

  it('holds for 2,000 random invoices built the InvoiceBuilder way', () => {
    // A fixed seed, so a failure can be replayed.
    let seed = 20260914;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const pick = (a) => a[Math.floor(rand() * a.length)];
    for (let k = 0; k < 2000; k++) {
      const lines = Array.from({ length: 1 + Math.floor(rand() * 12) }, (_, i) => ({
        name: `Line ${i + 1}`,
        qty: pick([1, 1, 2, 3, 0.5, 1.5, 2.25, 10, 12]),
        unit_price: Math.round(rand() * pick([10, 100, 5000]) * 100) / 100,
        tax_rate: pick([20, 20, 5, 0, 8.875, 7.25, 6.35]),
      }));
      const { invoice, invoiceLines } = savedInvoice(lines);
      if (!(invoice.total > 0)) continue;
      const credit = linesFromInvoice(invoiceLines);
      const { total } = creditTotals(credit);
      expect(total, JSON.stringify(lines)).toBe(shown(invoice.total));
      expect(validateCredit({ invoice, lines: credit, reason: 'Full credit', invoiceLines }), JSON.stringify(lines)).toEqual([]);
      expect(creditState(afterCredit(invoice, total))).toBe('full');
    }
  });
});

describe('partial credits', () => {
  const { invoice, invoiceLines } = savedInvoice([
    { name: 'Terminal', qty: 2, unit_price: 499.99, tax_rate: 20 },
    { name: 'Menus', qty: 3, unit_price: 33.33, tax_rate: 5 },
  ]);
  // 999.98 + 199.996 + 99.99 + 4.9995 = 1304.9655, shown as 1304.97.

  it('lowers a line and leaves the rest creditable', () => {
    const lines = linesFromInvoice(invoiceLines).slice(0, 1).map((l) => ({ ...l, qty: 1 }));
    const t = creditTotals(lines);
    expect(t).toEqual({ subtotal: 499.99, tax_amount: 100, total: 599.99 });
    expect(validateCredit({ invoice, lines, reason: 'One returned', invoiceLines })).toEqual([]);
    const after = afterCredit(invoice, t.total);
    expect(creditableLeft(after)).toBe(704.98);
    expect(creditState(after)).toBe('part');
    expect(canRaiseCredit(after)).toBe(true);
  });

  it('allows a free goodwill line at 0% or at a rate the invoice charged', () => {
    const goodwill = { name: 'Goodwill credit', qty: 1, unit_price: 25, tax_rate: 0 };
    expect(validateCredit({ invoice, lines: [goodwill], reason: 'Late install', invoiceLines })).toEqual([]);
    expect(validateCredit({ invoice, lines: [{ ...goodwill, tax_rate: 5 }], reason: 'Late install', invoiceLines })).toEqual([]);
    expect(validateCredit({ invoice, lines: [{ ...goodwill, tax_rate: 17.5 }], reason: 'Late install', invoiceLines }))
      .toEqual(['Line 1: the tax rate can only be 0 or the rate on the invoice.']);
  });

  it('refuses a second credit that goes past what is left, by even a penny', () => {
    const after = afterCredit(invoice, 599.99);
    const exact = [{ name: 'Rest', qty: 1, unit_price: 704.98, tax_rate: 0 }];
    expect(validateCredit({ invoice: after, lines: exact, reason: 'The rest' })).toEqual([]);
    const over = [{ name: 'Rest', qty: 1, unit_price: 704.99, tax_rate: 0 }];
    expect(validateCredit({ invoice: after, lines: over, reason: 'The rest' })).toEqual(['This credit is more than is left on the invoice.']);
  });

  it('refuses any credit once the invoice is fully credited', () => {
    const done = { ...invoice, amount_credited: 1304.97 };
    expect(validateCredit({ invoice: done, lines: [{ name: 'More', qty: 1, unit_price: 0.01 }], reason: 'Again' }))
      .toEqual(['This credit is more than is left on the invoice.']);
  });
});

describe('refundFor', () => {
  const base = { status: 'sent', total: 100, amount_credited: 0, amount_paid: null };

  it('owes nothing on an unpaid invoice', () => {
    expect(refundFor({ invoice: base, creditTotal: 40 })).toEqual({ refund_status: 'none', refund_due: 0 });
  });

  it('owes the whole credit back when the invoice was paid in full', () => {
    const paid = { ...base, status: 'paid', amount_paid: 100 };
    expect(refundFor({ invoice: paid, creditTotal: 30 })).toEqual({ refund_status: 'owed', refund_due: 30 });
    // A second credit after the first: still only its own amount.
    expect(refundFor({ invoice: { ...paid, amount_credited: 30 }, creditTotal: 20 })).toEqual({ refund_status: 'owed', refund_due: 20 });
  });

  it('owes only what was paid beyond the new total on a part paid invoice', () => {
    const part = { ...base, amount_paid: 40 };
    expect(refundFor({ invoice: part, creditTotal: 70 })).toEqual({ refund_status: 'owed', refund_due: 10 });
    expect(refundFor({ invoice: part, creditTotal: 60 })).toEqual({ refund_status: 'none', refund_due: 0 });
    expect(refundFor({ invoice: part, creditTotal: 50 })).toEqual({ refund_status: 'none', refund_due: 0 });
  });

  it('owes nothing when a full credit on an unpaid invoice rounds up its half penny', () => {
    // 1150.625 stored, 468 credited, 682.63 left: the exact remainder is
    // 682.625, and that half penny is not money anyone paid.
    const unpaid = { status: 'sent', total: 1150.625, amount_paid: null, amount_credited: 468 };
    expect(refundFor({ invoice: unpaid, creditTotal: 682.63 })).toEqual({ refund_status: 'none', refund_due: 0 });
    expect(refundFor({ invoice: { ...unpaid, amount_paid: 0 }, creditTotal: 682.63 })).toEqual({ refund_status: 'none', refund_due: 0 });
    // Paid for the balance as shown (682.63 after the first credit): the whole credit is owed back.
    expect(refundFor({ invoice: { ...unpaid, status: 'paid', amount_paid: 682.63 }, creditTotal: 682.63 })).toEqual({ refund_status: 'owed', refund_due: 682.63 });
    expect(overpaidNotOnCredit({ ...unpaid, amount_credited: 1150.63 })).toBe(0);
    expect(cancelCreditEffect({
      invoice: { ...unpaid, amount_credited: 1150.63 },
      notes: [{ id: 'a', credit_number: 1, status: 'issued', total: 468, refund_status: 'none', refund_due: 0 },
        { id: 'b', credit_number: 2, status: 'issued', total: 682.63, refund_status: 'none', refund_due: 0 }],
      noteId: 'a',
    }).problem).toBe(null);
  });

  it('treats a paid invoice with no amount_paid as paid in full', () => {
    expect(refundFor({ invoice: { ...base, status: 'paid' }, creditTotal: 25 })).toEqual({ refund_status: 'owed', refund_due: 25 });
  });

  it('handles Mark paid, which stores the unrounded total as amount_paid', () => {
    const { invoice } = savedInvoice([{ name: 'Menus', qty: 3, unit_price: 33.33, tax_rate: 20 }]);
    const paid = { ...invoice, status: 'paid', amount_paid: invoice.total }; // 119.988
    expect(refundFor({ invoice: paid, creditTotal: 119.99 })).toEqual({ refund_status: 'owed', refund_due: 119.99 });
    expect(refundFor({ invoice: paid, creditTotal: 10 })).toEqual({ refund_status: 'owed', refund_due: 10 });
  });
});

describe('balanceDue', () => {
  it('takes payments and credit off the total, never below 0', () => {
    expect(balanceDue({ status: 'sent', total: 100, amount_paid: null, amount_credited: 0 })).toBe(100);
    expect(balanceDue({ status: 'sent', total: 100, amount_paid: 40, amount_credited: 25 })).toBe(35);
    expect(balanceDue({ status: 'sent', total: 100, amount_paid: 40, amount_credited: 70 })).toBe(0);
    expect(balanceDue({ status: 'sent', total: 100, amount_credited: 100 })).toBe(0);
  });
  it('reads a stored total the way the invoice shows it', () => {
    expect(balanceDue({ status: 'viewed', total: 119.98799999999999, amount_credited: 0 })).toBe(119.99);
    expect(balanceDue({ status: 'viewed', total: 119.98799999999999, amount_credited: 19.99 })).toBe(100);
  });
  it('is 0 on a paid invoice, with or without amount_paid', () => {
    expect(balanceDue({ status: 'paid', total: 119.988, amount_paid: 119.988 })).toBe(0);
    expect(balanceDue({ status: 'paid', total: 119.988, amount_paid: null })).toBe(0);
  });
  it('amountPaid rounds to the penny and falls back for paid invoices', () => {
    expect(amountPaid({ status: 'paid', total: 119.988, amount_paid: null })).toBe(119.99);
    expect(amountPaid({ status: 'sent', total: 119.988, amount_paid: null })).toBe(0);
    expect(amountPaid({ status: 'sent', total: 50, amount_paid: 20.5 })).toBe(20.5);
  });
});

describe('creditState boundaries', () => {
  const inv = (amount_credited, total = 100) => ({ status: 'sent', total, amount_credited });
  it('none, part and full', () => {
    expect(creditState(inv(0))).toBe('none');
    expect(creditState(inv(null))).toBe('none');
    expect(creditState(inv(0.01))).toBe('part');
    expect(creditState(inv(99.99))).toBe('part');
    expect(creditState(inv(100))).toBe('full');
  });
  it('is full exactly when nothing is left to credit', () => {
    // Stored 100.005 shows as 100.01, so 100.00 credited still leaves a penny.
    expect(creditState(inv(100, 100.005))).toBe('part');
    expect(creditableLeft(inv(100, 100.005))).toBe(0.01);
    expect(creditState(inv(100.01, 100.005))).toBe('full');
    expect(creditState(inv(119.99, 119.98799999999999))).toBe('full');
  });
});

describe('canRaiseCredit', () => {
  const inv = (status, extra = {}) => ({ status, total: 120, amount_credited: 0, ...extra });
  it('only from sent, viewed or paid invoices with something left', () => {
    expect(canRaiseCredit(inv('sent'))).toBe(true);
    expect(canRaiseCredit(inv('viewed', { due_date: '2020-01-01' }))).toBe(true); // overdue
    expect(canRaiseCredit(inv('paid'))).toBe(true);
    expect(canRaiseCredit(inv('draft'))).toBe(false);
    expect(canRaiseCredit(inv('void'))).toBe(false);
    expect(canRaiseCredit(inv('sent', { amount_credited: 120 }))).toBe(false);
    expect(canRaiseCredit(inv('sent', { total: 0 }))).toBe(false);
    expect(canRaiseCredit(null)).toBe(false);
  });
});

describe('linesFromInvoice', () => {
  it('copies every line at full value, in order, with its invoice line id', () => {
    const lines = linesFromInvoice([
      { id: 'b', sort: 1, name: 'Second', description: null, qty: '2', unit_price: 5, tax_rate: null },
      { id: 'a', sort: 0, name: 'First', description: 'Detail', qty: 1, unit_price: 9.99, tax_rate: 20, invoice_id: 'x' },
    ]);
    expect(lines).toEqual([
      { invoice_line_id: 'a', name: 'First', description: 'Detail', qty: 1, unit_price: 9.99, tax_rate: 20 },
      { invoice_line_id: 'b', name: 'Second', description: '', qty: 2, unit_price: 5, tax_rate: 0 },
    ]);
    expect(linesFromInvoice(null)).toEqual([]);
  });
});

describe('taxRatesFor', () => {
  const invoiceLines = [{ id: 'a', tax_rate: 20 }, { id: 'b', tax_rate: 5 }, { id: 'c', tax_rate: 20 }];
  it('a copied line keeps its own rate or drops to 0', () => {
    expect(taxRatesFor({ line: { invoice_line_id: 'b' }, invoiceLines })).toEqual([0, 5]);
  });
  it('a free line may use 0 or any rate on the invoice', () => {
    expect(taxRatesFor({ line: {}, invoiceLines })).toEqual([0, 5, 20]);
  });
  it('an invoice with no lines falls back to its header rate', () => {
    expect(taxRatesFor({ line: {}, invoiceLines: [], invoice: { tax_rate: 20 } })).toEqual([0, 20]);
  });
});

describe('validateCredit', () => {
  const { invoice, invoiceLines } = savedInvoice([{ name: 'Terminal', qty: 1, unit_price: 100, tax_rate: 20 }]);
  const good = linesFromInvoice(invoiceLines);

  it('accepts a good credit', () => {
    expect(validateCredit({ invoice, lines: good, reason: 'Returned', invoiceLines })).toEqual([]);
  });

  it('refuses drafts, void invoices and a missing invoice', () => {
    expect(validateCredit({ invoice: { ...invoice, status: 'draft' }, lines: good, reason: 'Returned' }))
      .toEqual(['A draft invoice cannot be credited. Edit the invoice instead.']);
    expect(validateCredit({ invoice: { ...invoice, status: 'void' }, lines: good, reason: 'Returned' }))
      .toEqual(['Only a sent, viewed or paid invoice can be credited.']);
    expect(validateCredit({ lines: good, reason: 'Returned' })).toEqual(['Invoice not found.']);
  });

  it('needs a reason of 3 to 500 characters, counted as the database counts them', () => {
    const msg = 'Give a reason of 3 to 500 characters.';
    expect(validateCredit({ invoice, lines: good, reason: '  ab  ' })).toEqual([msg]);
    expect(validateCredit({ invoice, lines: good, reason: null })).toEqual([msg]);
    expect(validateCredit({ invoice, lines: good, reason: 'x'.repeat(501) })).toEqual([msg]);
    expect(validateCredit({ invoice, lines: good, reason: 'x'.repeat(500) })).toEqual([]);
    // 500 emoji are 1,000 UTF-16 units but 500 characters.
    expect(validateCredit({ invoice, lines: good, reason: '👍'.repeat(500) })).toEqual([]);
  });

  it('needs between 1 and 100 lines', () => {
    expect(validateCredit({ invoice, lines: [], reason: 'Returned' })).toEqual(['Add at least one line to credit.']);
    const many = Array.from({ length: MAX_LINES + 1 }, () => ({ name: 'Penny', qty: 1, unit_price: 0.01 }));
    expect(validateCredit({ invoice, lines: many, reason: 'Returned' })).toEqual(['A credit note can have at most 100 lines.']);
  });

  it('checks every line', () => {
    const lines = [
      { name: ' ', qty: 1, unit_price: 1 },
      { name: 'Zero qty', qty: 0, unit_price: 1 },
      { name: 'Text qty', qty: 'abc', unit_price: 1 },
      { name: 'Negative price', qty: 1, unit_price: -1 },
      { name: 'Negative rate', qty: 1, unit_price: 1, tax_rate: -5 },
      { name: 'Blank price', qty: 1, unit_price: '' },
    ];
    expect(validateCredit({ invoice, lines, reason: 'Returned' })).toEqual([
      'Line 1 needs a name.',
      'Line 2: the quantity must be more than 0.',
      'Line 3: the quantity must be more than 0.',
      'Line 4: the unit price must be 0 or more.',
      'Line 5: the tax rate must be 0 or more.',
      'Line 6: the unit price must be 0 or more.',
    ]);
  });

  it('refuses a line that is not on the invoice, and a raised tax rate', () => {
    expect(validateCredit({ invoice, lines: [{ ...good[0], invoice_line_id: 'someone-elses' }], reason: 'Returned', invoiceLines }))
      .toEqual(['Line 1 is not on this invoice.']);
    expect(validateCredit({ invoice, lines: [{ ...good[0], unit_price: 50, tax_rate: 25 }], reason: 'Returned', invoiceLines }))
      .toEqual(['Line 1: the tax rate can only be 0 or the rate on the invoice.']);
    // Dropping the rate to 0 is allowed.
    expect(validateCredit({ invoice, lines: [{ ...good[0], tax_rate: 0 }], reason: 'Returned', invoiceLines })).toEqual([]);
  });

  it('needs a total above 0', () => {
    expect(validateCredit({ invoice, lines: [{ name: 'Free', qty: 1, unit_price: 0 }], reason: 'Returned' }))
      .toEqual(['The credit must be more than 0.']);
    // Rounds to nothing: 0.004 is not a penny.
    expect(validateCredit({ invoice, lines: [{ name: 'Crumb', qty: 1, unit_price: 0.004 }], reason: 'Returned' }))
      .toEqual(['The credit must be more than 0.']);
  });
});

describe('earlier credit notes limit each line and each tax rate', () => {
  // The case that let VAT credited pass VAT charged: a 20% terminal and a 0%
  // set up fee, 200 VAT in all.
  const { invoice, invoiceLines } = savedInvoice([
    { name: 'Terminal', qty: 1, unit_price: 1000, tax_rate: 20 },
    { name: 'Setup', qty: 1, unit_price: 1000, tax_rate: 0 },
  ]);
  const [terminal, setup] = invoiceLines;
  const firstNote = [{ invoice_line_id: terminal.id, name: 'Terminal', qty: 1, unit_price: 1000, tax_rate: 20 }];
  const afterFirst = { ...invoice, amount_credited: 1200 };

  it('refuses the same line credited again, even when the total still fits', () => {
    const again = [{ invoice_line_id: terminal.id, name: 'Terminal', qty: 1, unit_price: 833.33, tax_rate: 20 }];
    expect(creditTotals(again).total).toBe(1000);
    expect(validateCredit({ invoice: afterFirst, lines: again, reason: 'Duplicate', invoiceLines, creditedLines: firstNote }))
      .toEqual(['Line 1: more than is left to credit on this line.']);
    // Dropping the rate to 0 does not get round it: the line itself is used up.
    expect(validateCredit({ invoice: afterFirst, lines: [{ ...again[0], tax_rate: 0 }], reason: 'Duplicate', invoiceLines, creditedLines: firstNote }))
      .toEqual(['Line 1: more than is left to credit on this line.']);
    // The set up line is untouched and can still be credited.
    expect(validateCredit({ invoice: afterFirst, lines: linesFromInvoice(invoiceLines, firstNote), reason: 'The rest', invoiceLines, creditedLines: firstNote }))
      .toEqual([]);
  });

  it('adds up two lines of one note against the same invoice line', () => {
    const half = { invoice_line_id: terminal.id, name: 'Terminal', qty: 0.6, unit_price: 1000, tax_rate: 20 };
    expect(validateCredit({ invoice, lines: [half, half], reason: 'Split', invoiceLines }))
      .toEqual(['Line 2: more than is left to credit on this line.']);
  });

  it('refuses a free line that would hand back more tax than a rate charged', () => {
    const goodwill = { invoice_line_id: null, name: 'Goodwill', qty: 1, unit_price: 100, tax_rate: 20 };
    const partOfTerminal = [{ invoice_line_id: terminal.id, name: 'Terminal', qty: 1, unit_price: 950, tax_rate: 20 }];
    expect(validateCredit({ invoice: { ...invoice, amount_credited: 1140 }, lines: [goodwill], reason: 'Late', invoiceLines, creditedLines: partOfTerminal }))
      .toEqual(['Line 1: more than is left to credit at 20%.']);
    expect(validateCredit({ invoice: { ...invoice, amount_credited: 1140 }, lines: [{ ...goodwill, unit_price: 50 }], reason: 'Late', invoiceLines, creditedLines: partOfTerminal }))
      .toEqual([]);
    // A goodwill credit with no tax is only held to what is left in total.
    expect(validateCredit({ invoice, lines: [{ ...goodwill, unit_price: 1500, tax_rate: 0 }], reason: 'Late', invoiceLines })).toEqual([]);
  });

  it('starts each line at what is left on it', () => {
    const { invoiceLines: lines } = savedInvoice([
      { name: 'Terminal', qty: 3, unit_price: 390, tax_rate: 20 },
      { name: 'Reader', qty: 1, unit_price: 1000, tax_rate: 20 },
      { name: 'Hours', qty: 0.5, unit_price: 90, tax_rate: 0 },
      { name: 'Menus', qty: 2, unit_price: 10, tax_rate: 5 },
    ]);
    const [t, r, h, mn] = lines;
    const credited = [
      { invoice_line_id: t.id, qty: 1, unit_price: 390, tax_rate: 20 },
      { invoice_line_id: r.id, qty: 1, unit_price: 833.33, tax_rate: 20 },
      { invoice_line_id: h.id, qty: 0.3, unit_price: 50, tax_rate: 0 },
      { invoice_line_id: mn.id, qty: 2, unit_price: 10, tax_rate: 0 },
    ];
    const start = linesFromInvoice(lines, credited);
    expect(start.map((l) => [l.name, l.qty, l.unit_price])).toEqual([
      ['Terminal', 2, 390],        // 2 of 3 left: the price stays
      ['Reader', 1, 166.67],       // not a whole number of units: 1 at what is left
      ['Hours', 0.5, 60],          // under 1 unit: the quantity stays, the price drops
    ]);                             // Menus credited in full: left out
    expect(lineCreditLeft(r, credited)).toBe(166.67);
    expect(lineCreditLeft(mn, credited)).toBe(0);
    // Crediting what is left is accepted, and uses every line up.
    const inv = { status: 'sent', total: 10000, amount_credited: 0 };
    expect(validateCredit({ invoice: inv, lines: start, reason: 'The rest', invoiceLines: lines, creditedLines: credited })).toEqual([]);
    expect(linesFromInvoice(lines, [...credited, ...start])).toEqual([]);
    // With no earlier credit notes every line is at full value, as before.
    expect(linesFromInvoice(lines)).toHaveLength(4);
  });
});

describe('the date a credit note carries', () => {
  const { invoice, invoiceLines } = savedInvoice([{ name: 'Terminal', qty: 1, unit_price: 100, tax_rate: 20 }], { issue_date: '2026-09-10' });
  const lines = linesFromInvoice(invoiceLines);
  const check = (issueDate, today) => validateCredit({ invoice, lines, reason: 'Returned', invoiceLines, issueDate, today });

  it('is never before the invoice or more than a day ahead', () => {
    expect(check('2026-09-14', '2026-09-14')).toEqual([]);
    expect(check('2026-09-10', '2026-09-14')).toEqual([]);
    expect(check('2026-09-15', '2026-09-14')).toEqual([]);
    expect(check('2026-09-09', '2026-09-14')).toEqual(['A credit note cannot be dated before the invoice it credits.']);
    expect(check('2019-01-01', '2026-09-14')).toEqual(['A credit note cannot be dated before the invoice it credits.']);
    expect(check('2026-09-16', '2026-09-14')).toEqual(['A credit note cannot be dated in the future.']);
    expect(check('2031-01-01', '2026-12-31')).toEqual(['A credit note cannot be dated in the future.']);
  });

  it('takes the invoice date when the invoice is dated after today', () => {
    expect(creditIssueDate({ issue_date: '2026-09-15' }, '2026-09-14')).toBe('2026-09-15');
    expect(creditIssueDate({ issue_date: '2026-09-10' }, '2026-09-14')).toBe('2026-09-14');
    expect(creditIssueDate({}, '2026-09-14')).toBe('2026-09-14');
  });
});

describe('cancelCreditEffect', () => {
  const note = (n, total, refund_status = 'none', refund_due = 0, status = 'issued') =>
    ({ id: `cn${n}`, credit_number: n, total, refund_status, refund_due, status });

  it('clears the refund a newer note no longer owes', () => {
    // 1200 invoice, 200 credited while unpaid, the 1000 balance paid by card,
    // then a duplicate 200 raised on the paid invoice (refund owed 200).
    const invoice = { status: 'paid', total: 1200, amount_paid: 1000, amount_credited: 400 };
    const notes = [note(1001, 200), note(1002, 200, 'owed', 200)];
    expect(cancelCreditEffect({ invoice, notes, noteId: 'cn1001', reason: 'Duplicate' })).toEqual({
      problem: null, amount_credited: 200, reopen: false, balance_due: 0,
      refunds: [{ id: 'cn1002', refund_status: 'none', refund_due: 0 }],
    });
  });

  it('lowers a refund on a part paid invoice, newest first', () => {
    // 1000 invoice, 400 deposit, 500 credit (nothing owed), 300 credit (200 owed).
    const invoice = { status: 'sent', total: 1000, amount_paid: 400, amount_credited: 800 };
    const notes = [note(1, 500), note(2, 300, 'owed', 200)];
    const effect = cancelCreditEffect({ invoice, notes, noteId: 'cn1' });
    expect(effect.refunds).toEqual([{ id: 'cn2', refund_status: 'none', refund_due: 0 }]);
    expect(effect.balance_due).toBe(300);
    expect(effect.reopen).toBe(false);

    // Paid in full, three credits all owed back; cancelling the middle one
    // leaves the oldest whole and takes the rest off the newest.
    const paid = { status: 'paid', total: 1000, amount_paid: 1000, amount_credited: 600 };
    const three = [note(1, 100, 'owed', 100), note(2, 200, 'owed', 200), note(3, 300, 'owed', 300)];
    expect(cancelCreditEffect({ invoice: paid, notes: three, noteId: 'cn2' }).refunds).toEqual([]);
    const underpaid = { ...paid, amount_paid: 750 };
    const owedThree = [note(1, 100, 'owed', 0), note(2, 200, 'owed', 50), note(3, 300, 'owed', 300)]
      .map((c) => ({ ...c, refund_status: c.refund_due > 0 ? 'owed' : 'none' }));
    // 750 paid on 500 still asked leaves 250 to hand back: CN-2 keeps its 50,
    // CN-3 drops from 300 to 200.
    expect(cancelCreditEffect({ invoice: underpaid, notes: owedThree, noteId: 'cn1' }).refunds).toEqual([
      { id: 'cn3', refund_status: 'owed', refund_due: 200 },
    ]);
  });

  it('reopens a paid invoice that now asks for more than was paid', () => {
    const invoice = { status: 'paid', total: 1200, amount_paid: 1000, amount_credited: 200 };
    expect(cancelCreditEffect({ invoice, notes: [note(1, 200)], noteId: 'cn1' }))
      .toEqual({ problem: null, amount_credited: 0, reopen: true, balance_due: 200, refunds: [] });
    // Paid in full with no amount_paid, or paid for the whole total: nothing changes.
    expect(cancelCreditEffect({ invoice: { ...invoice, amount_paid: null }, notes: [note(1, 200, 'owed', 200)], noteId: 'cn1' }).reopen).toBe(false);
    // A float in amount_paid a hair under the penny is not a balance.
    expect(cancelCreditEffect({ invoice: { ...invoice, amount_paid: 1199.9999999999998 }, notes: [note(1, 200, 'owed', 200)], noteId: 'cn1' }).reopen).toBe(false);
  });

  it('refuses when refunds already paid would be more than is owed back', () => {
    // 1000 invoice, 300 credited unpaid, 700 balance paid, 200 credit refunded.
    const invoice = { status: 'paid', total: 1000, amount_paid: 700, amount_credited: 500 };
    const notes = [note(1, 300), note(2, 200, 'refunded', 200)];
    expect(cancelCreditEffect({ invoice, notes, noteId: 'cn1' }).problem)
      .toBe('A refund has already been paid on this invoice. Without this credit it would be more than the customer overpaid, so this credit cannot be cancelled.');
  });

  it('refuses in the same order as the database', () => {
    const invoice = { status: 'sent', total: 100, amount_credited: 10 };
    expect(cancelCreditEffect({ invoice, notes: [], noteId: 'x' }).problem).toBe('Credit note not found.');
    expect(cancelCreditEffect({ invoice, notes: [note(1, 10, 'none', 0, 'cancelled')], noteId: 'cn1', reason: 'x' }).problem).toBe('This credit note is already cancelled.');
    expect(cancelCreditEffect({ invoice, notes: [note(1, 10, 'refunded', 10)], noteId: 'cn1', reason: 'x' }).problem).toBe('This credit has already been refunded.');
    expect(cancelCreditEffect({ invoice, notes: [note(1, 10)], noteId: 'cn1', reason: 'x' }).problem).toBe('Give a reason of 3 to 500 characters.');
  });
});

describe('overpaidNotOnCredit', () => {
  const invoice = { status: 'paid', total: 1200, amount_paid: 1200, amount_credited: 200 };
  it('counts money taken beyond the balance that no credit note owes back', () => {
    expect(overpaidNotOnCredit(invoice, [{ status: 'issued', total: 200, refund_status: 'none', refund_due: 0 }])).toBe(200);
    expect(overpaidNotOnCredit(invoice, [{ status: 'issued', total: 200, refund_status: 'owed', refund_due: 200 }])).toBe(0);
    expect(overpaidNotOnCredit(invoice, [{ status: 'issued', total: 200, refund_status: 'refunded', refund_due: 200 }])).toBe(0);
    expect(overpaidNotOnCredit({ ...invoice, amount_credited: 0 }, [])).toBe(0);
    expect(overpaidNotOnCredit({ status: 'sent', total: 100, amount_paid: 40, amount_credited: 0 })).toBe(0);
  });
});

// ── Applying credit to another invoice ──────────────────────────────────────
// What allocate_credit and remove_credit_allocation do to the rows, so a
// sequence can be followed. The effect functions are the library's own
// prediction of the database; these helpers only write it back onto copies.
function apply({ note, invoice, amount, allocationNote }) {
  const effect = allocationEffect({ note, invoice, amount, allocationNote });
  if (effect.problem) throw new Error(effect.problem);
  return {
    effect,
    note: { ...note, amount_allocated: effect.note.amount_allocated, refund_status: effect.note.refund_status },
    invoice: { ...invoice, amount_allocated: effect.invoice.amount_allocated, status: effect.invoice.status, amount_paid: effect.invoice.amount_paid },
    allocation: { id: `al-${nextId++}`, credit_note_id: note.id, invoice_id: invoice.id, amount: effect.amount, removed_at: null },
  };
}
// A credit note as issue_credit_note stores it on an invoice.
const issued = (invoice, total, extra = {}) => ({
  id: `cn-${nextId++}`, credit_number: nextId, invoice_id: invoice.id, status: 'issued', total,
  amount_allocated: 0, refunded_amount: 0, currency: invoice.currency, ...refundFor({ invoice, creditTotal: total }), ...extra,
});

describe("Peter's example: 224 credit taken off the next invoice", () => {
  // INV A for 1,000 paid in full, then a credit of 224 for returned kit.
  const invA = { id: 'inv-a', status: 'paid', total: 1000, amount_paid: 1000, amount_credited: 0, amount_allocated: 0, currency: 'GBP' };
  const cn = issued(invA, 224);
  // INV B, the next month's 1,000, sent to the same company.
  const invB = { id: 'inv-b', status: 'sent', total: 1000, amount_paid: null, amount_credited: 0, amount_allocated: 0, currency: 'GBP' };

  it('the credit note has 224 available', () => {
    expect(cn).toMatchObject({ refund_status: 'owed', refund_due: 224 });
    expect(creditAvailable(cn)).toBe(224);
    expect(creditNoteStatusKind(cn)).toBe('Available');
    expect(creditNoteStatusLabel(cn)).toBe('£224.00 to use');
    expect(companyCreditAvailable([cn])).toBe(224);
  });

  it('applies 224 to INV B: balance 776, the note shows Used, no cash moves', () => {
    expect(allocationDefault({ note: cn, invoice: invB })).toBe(224);
    expect(allocationProblems({ note: cn, invoice: invB, amount: 224 })).toEqual([]);
    const { note, invoice, effect } = apply({ note: cn, invoice: invB, amount: 224 });
    expect(effect.invoice).toEqual({ amount_allocated: 224, balance_due: 776, settles: false, status: 'sent', amount_paid: null });
    expect(balanceDue(invoice)).toBe(776);
    expect(amountPaid(invoice)).toBe(0);
    expect(settledAmount(invoice)).toBe(224);
    expect(note).toMatchObject({ amount_allocated: 224, refund_status: 'allocated' });
    expect(creditAvailable(note)).toBe(0);
    expect(creditNoteStatusKind(note)).toBe('Used');
    expect(creditNoteStatusLabel(note, { usedOn: [{ invoice_number: 1050 }] })).toBe('Used on INV-1050');
    expect(creditUse(note)).toEqual({ used: 224, refunded: 0, left: 0 });
    expect(companyCreditAvailable([note])).toBe(0);
    // Nothing left to apply, and INV A's revenue and cash are untouched.
    expect(allocationProblems({ note, invoice, amount: 1 })).toEqual(['There is no credit left to use on this credit note.']);
    expect(amountPaid(invA)).toBe(1000);
  });

  it('Mark paid on INV B records the 776 actually received, never the full 1,000', () => {
    const { invoice } = apply({ note: cn, invoice: invB, amount: 224 });
    expect(markPaidAmount(invoice)).toBe(776);
    const paid = { ...invoice, status: 'paid', amount_paid: markPaidAmount(invoice) };
    expect(balanceDue(paid)).toBe(0);
    expect(amountPaid(paid)).toBe(776);
    expect(settledAmount(paid)).toBe(1000);
    // Without any credit Mark paid still records the whole total.
    expect(markPaidAmount({ status: 'sent', total: 119.988, amount_paid: null, amount_credited: 0 })).toBe(119.99);
    // Part paid by card already: the card money plus what is left.
    expect(markPaidAmount({ status: 'sent', total: 1000, amount_paid: 300, amount_credited: 100, amount_allocated: 224 })).toBe(676);
  });
});

describe('part use, then refund the rest', () => {
  const invA = { id: 'inv-a', status: 'paid', total: 1000, amount_paid: 1000, amount_credited: 0 };
  const cn = issued(invA, 224);
  const invC = { id: 'inv-c', status: 'viewed', total: 100, amount_paid: null, amount_credited: 0, amount_allocated: 0 };

  it('shows 100 used, 124 left, and Mark refunded refunds only the 124', () => {
    // The default is the smaller of the credit and the balance.
    expect(allocationDefault({ note: cn, invoice: invC })).toBe(100);
    const { note, invoice, effect } = apply({ note: cn, invoice: invC, amount: 100 });
    // 100 settles INV C on its own: paid, with no cash, amount_paid 0 not null.
    expect(effect.invoice).toEqual({ amount_allocated: 100, balance_due: 0, settles: true, status: 'paid', amount_paid: 0 });
    expect(invoice.amount_paid).toBe(0);
    expect(note.refund_status).toBe('owed');
    expect(creditNoteStatusKind(note)).toBe('Part used');
    expect(creditNoteStatusLabel(note)).toBe('£100.00 used, £124.00 to use');
    expect(creditUse(note)).toEqual({ used: 100, refunded: 0, left: 124 });
    // mark_credit_note_refunded sets refunded_amount to what is left.
    const refunded = { ...note, refund_status: 'refunded', refunded_amount: creditAvailable(note) };
    expect(refunded.refunded_amount).toBe(124);
    expect(creditNoteStatusKind(refunded)).toBe('Refunded');
    expect(creditUse(refunded)).toEqual({ used: 100, refunded: 124, left: 0 });
    expect(creditAvailable(refunded)).toBe(0);
  });

  it('reads a refund marked before applied credit existed as the whole refund_due', () => {
    const old = { status: 'issued', refund_status: 'refunded', refund_due: 80 };
    expect(creditUse(old)).toEqual({ used: 0, refunded: 80, left: 0 });
    expect(cancelCreditEffect({ invoice: invA, notes: [{ ...old, id: 'x' }], noteId: 'x' }).problem).toBe('This credit has already been refunded.');
  });
});

describe('removing applied credit', () => {
  const invA = { id: 'inv-a', status: 'paid', total: 500, amount_paid: 500, amount_credited: 0 };
  const cn = issued(invA, 300);
  const invE = { id: 'inv-e', status: 'sent', total: 200, amount_paid: null, amount_credited: 0, amount_allocated: 0 };

  it('reopens a paid invoice and puts the credit back', () => {
    const { note, invoice, allocation } = apply({ note: cn, invoice: invE, amount: 200 });
    expect(invoice).toMatchObject({ status: 'paid', amount_paid: 0, amount_allocated: 200 });
    const effect = removeAllocationEffect({ allocation, note, invoice, invoiceNotes: [], reason: 'Wrong invoice' });
    expect(effect).toEqual({
      problem: null,
      note: { amount_allocated: 0, refund_status: 'owed', credit_available: 300 },
      invoice: { amount_allocated: 0, balance_due: 200, reopen: true, status: 'sent' },
      refunds: [],
    });
  });

  it('gives a Used note its credit back as owed, and a part refunded one too', () => {
    const invF = { ...invE, id: 'inv-f', total: 300 };
    const { note, invoice, allocation } = apply({ note: cn, invoice: invF, amount: 300 });
    expect(note.refund_status).toBe('allocated');
    expect(removeAllocationEffect({ allocation, note, invoice, reason: 'Wrong invoice' }).note).toEqual({ amount_allocated: 0, refund_status: 'owed', credit_available: 300 });
    // 100 applied, 200 refunded, then the 100 removed: 100 is owed again.
    const part = apply({ note: cn, invoice: invE, amount: 100 });
    const mixed = { ...part.note, refund_status: 'refunded', refunded_amount: 200 };
    expect(removeAllocationEffect({ allocation: part.allocation, note: mixed, invoice: part.invoice, reason: 'Wrong invoice' }).note)
      .toEqual({ amount_allocated: 0, refund_status: 'owed', credit_available: 100 });
    // And a note with a refund on it can never be cancelled, even once it owes again.
    expect(cancelCreditEffect({ invoice: invA, notes: [{ ...mixed, amount_allocated: 0, refund_status: 'owed' }], noteId: mixed.id }).problem)
      .toBe('This credit has already been refunded.');
  });

  it('keeps a paid invoice paid when its cash still covers it', () => {
    const { invoice, note, allocation } = apply({ note: cn, invoice: { ...invE, amount_paid: 50 }, amount: 150 });
    const paidByCash = { ...invoice, amount_paid: 200 }; // paid twice over: card and credit
    expect(removeAllocationEffect({ allocation, note, invoice: paidByCash, reason: 'Paid by card after all' }).invoice)
      .toEqual({ amount_allocated: 0, balance_due: 0, reopen: false, status: 'paid' });
  });

  it('refuses in the same order as the database', () => {
    const { invoice, note, allocation } = apply({ note: cn, invoice: invE, amount: 20 });
    expect(removeAllocationEffect({ note, invoice, reason: 'Wrong' }).problem).toBe('Applied credit not found.');
    expect(removeAllocationEffect({ allocation: { ...allocation, removed_at: '2026-09-14T10:00:00Z' }, note, invoice, reason: 'x' }).problem)
      .toBe('This applied credit has already been removed.');
    expect(removeAllocationEffect({ allocation, note, invoice, reason: ' ab ' }).problem).toBe('Give a reason of 3 to 500 characters.');
  });

  it("shrinks the credit available on the invoice's own notes that came from it", () => {
    // T for 1,000 settled by 1,000 of credit, then a 300 credit on T owes 300.
    const big = issued({ id: 'src', status: 'paid', total: 1000, amount_paid: 1000, amount_credited: 0 }, 1000);
    const t0 = { id: 'inv-t', status: 'sent', total: 1000, amount_paid: null, amount_credited: 0, amount_allocated: 0 };
    const { invoice: tPaid, note, allocation } = apply({ note: big, invoice: t0, amount: 1000 });
    const tNote = issued(tPaid, 300);
    expect(tNote).toMatchObject({ refund_status: 'owed', refund_due: 300 });
    const t = { ...tPaid, amount_credited: 300 };
    const effect = removeAllocationEffect({ allocation, note, invoice: t, invoiceNotes: [tNote], reason: 'Wrong customer' });
    expect(effect.refunds).toEqual([{ id: tNote.id, refund_status: 'none', refund_due: 0 }]);
    expect(effect.invoice).toEqual({ amount_allocated: 0, balance_due: 700, reopen: true, status: 'sent' });
    // Refused once that credit has been refunded, or applied elsewhere.
    expect(removeAllocationEffect({ allocation, note, invoice: t, invoiceNotes: [{ ...tNote, refund_status: 'refunded', refunded_amount: 300 }], reason: 'Wrong customer' }).problem)
      .toBe('A refund has already been paid on a credit note of this invoice. Without the credit applied it would be more than the customer overpaid, so the credit cannot be removed.');
    expect(removeAllocationEffect({ allocation, note, invoice: t, invoiceNotes: [{ ...tNote, refund_status: 'allocated', amount_allocated: 300 }], reason: 'Wrong customer' }).problem)
      .toBe('Credit from a credit note of this invoice has already been used on an invoice. Without the credit applied it would be more than the customer overpaid, so the credit cannot be removed.');
  });
});

describe('one refund per credit note', () => {
  // CN of 224 on a paid invoice: 100 applied to INV B, the other 124 refunded
  // by bank transfer. Then the owner removes the 100 from INV B.
  const invA = { id: 'inv-a', status: 'paid', total: 1000, amount_paid: 1000, amount_credited: 0 };
  const cn = issued(invA, 224);
  const invB = { id: 'inv-b', status: 'sent', total: 500, amount_paid: null, amount_credited: 0, amount_allocated: 0 };
  const REFUNDED_TWICE = 'A refund has already been marked on this credit note, and a second one cannot be recorded. Apply the credit left to an invoice instead.';

  it('lets Mark refunded refund what is left once', () => {
    const { note } = apply({ note: cn, invoice: invB, amount: 100 });
    expect(refundProblem({ note })).toBe(null);
    expect(refundProblem({ note, method: 'Bank transfer' })).toBe(null);
    const refunded = { ...note, refund_status: 'refunded', refunded_amount: creditAvailable(note) };
    expect(refundProblem({ note: refunded })).toBe('This refund is already marked as refunded.');
  });

  it('refuses a second refund once the credit applied is removed, but the credit can be applied again', () => {
    const { note, invoice, allocation } = apply({ note: cn, invoice: invB, amount: 100 });
    const refunded = { ...note, refund_status: 'refunded', refunded_amount: 124 };
    const effect = removeAllocationEffect({ allocation, note: refunded, invoice, reason: 'Applied to the wrong invoice' });
    expect(effect.note).toEqual({ amount_allocated: 0, refund_status: 'owed', credit_available: 100 });
    const owesAgain = { ...refunded, amount_allocated: 0, refund_status: 'owed' };
    expect(creditUse(owesAgain)).toEqual({ used: 0, refunded: 124, left: 100 });
    // The first refund's date and method stay as they were: a second Mark
    // refunded would overwrite them and move the first refund in the reports.
    expect(refundProblem({ note: owesAgain })).toBe(REFUNDED_TWICE);
    expect(refundProblem({ note: owesAgain, method: 'Card refund' })).toBe(REFUNDED_TWICE);
    // The 100 can go onto the right invoice instead, and the note is then Refunded.
    const invC = { ...invB, id: 'inv-c' };
    expect(allocationProblems({ note: owesAgain, invoice: invC, amount: 100 })).toEqual([]);
    expect(allocationEffect({ note: owesAgain, invoice: invC, amount: 100 }).note).toEqual({ amount_allocated: 100, refund_status: 'refunded', credit_available: 0 });
    // And a note with a refund on it is never cancelled.
    expect(cancelCreditEffect({ invoice: invA, notes: [owesAgain], noteId: owesAgain.id }).problem).toBe('This credit has already been refunded.');
  });

  it('refuses in the same order and with the same words as mark_credit_note_refunded', () => {
    expect(refundProblem({})).toBe('Credit note not found.');
    expect(refundProblem({ note: { ...cn, status: 'cancelled', refund_status: 'none', refund_due: 0 } })).toBe('This credit note is cancelled.');
    expect(refundProblem({ note: { ...cn, refund_status: 'allocated', amount_allocated: 224 } }))
      .toBe('All of this credit has been used on invoices, so there is nothing left to refund.');
    expect(refundProblem({ note: { ...cn, refund_status: 'none', refund_due: 0 } })).toBe('There is no refund owed on this credit note.');
    expect(refundProblem({ note: cn, method: 'Cash' })).toBe('Choose how it was refunded: Bank transfer, Card refund or Other.');
    // A refund marked before refunded_amount existed still counts as one.
    expect(refundProblem({ note: { status: 'issued', refund_status: 'refunded', refund_due: 80 } })).toBe('This refund is already marked as refunded.');
  });
});

describe('a later credit on an invoice credit helped to settle', () => {
  it('counts cash plus applied credit as settled', () => {
    // 1,000 with 224 applied and 776 paid by card: a 100 credit hands back 100.
    const inv = { status: 'paid', total: 1000, amount_paid: 776, amount_credited: 0, amount_allocated: 224 };
    expect(settledAmount(inv)).toBe(1000);
    expect(refundFor({ invoice: inv, creditTotal: 100 })).toEqual({ refund_status: 'owed', refund_due: 100 });
    // Before applied credit counted, only the 776 was seen and nothing was owed.
    expect(refundFor({ invoice: { ...inv, amount_allocated: 0 }, creditTotal: 100 })).toEqual({ refund_status: 'none', refund_due: 0 });
  });
  it('hands back what the applied credit covered beyond the new total', () => {
    // 1,000 with 224 applied and no cash, then 900 credited: it now asks 100, so 124 comes back.
    const inv = { status: 'sent', total: 1000, amount_paid: null, amount_credited: 0, amount_allocated: 224 };
    expect(balanceDue(inv)).toBe(776);
    expect(refundFor({ invoice: inv, creditTotal: 900 })).toEqual({ refund_status: 'owed', refund_due: 124 });
    expect(refundFor({ invoice: inv, creditTotal: 776 })).toEqual({ refund_status: 'none', refund_due: 0 });
    expect(overpaidNotOnCredit({ ...inv, amount_credited: 900 }, [])).toBe(124);
  });
  it('reads a paid invoice with no amount_paid as settled in full, applied credit included', () => {
    const inv = { status: 'paid', total: 1000, amount_paid: null, amount_credited: 0, amount_allocated: 224 };
    expect(amountPaid(inv)).toBe(776);
    expect(settledAmount(inv)).toBe(1000);
    expect(balanceDue(inv)).toBe(0);
    expect(refundFor({ invoice: inv, creditTotal: 50 })).toEqual({ refund_status: 'owed', refund_due: 50 });
  });
});

describe('allocationProblems', () => {
  const invA = { id: 'inv-a', status: 'paid', total: 1000, amount_paid: 1000, amount_credited: 0, currency: 'GBP' };
  const cn = issued(invA, 224);
  const target = { id: 'inv-b', status: 'sent', total: 150.005, amount_paid: null, amount_credited: 0, amount_allocated: 0, currency: 'GBP' };
  const check = (amount, extra = {}) => allocationProblems({ note: cn, invoice: target, amount, ...extra });

  it('only to a sent or viewed invoice that is not the one the credit came from', () => {
    expect(ALLOCATABLE_STATUSES).toEqual(['sent', 'viewed']);
    expect(check(10, { invoice: { ...target, status: 'viewed' } })).toEqual([]);
    for (const status of ['draft', 'paid', 'void']) {
      expect(check(10, { invoice: { ...target, status } })).toEqual(['Credit can only be applied to a sent or viewed invoice.']);
    }
    expect(check(10, { invoice: { ...invA, status: 'sent' } })).toEqual(['Credit cannot be applied to the invoice it was raised on.']);
    expect(allocationProblems({ invoice: target, amount: 1 })).toEqual(['Credit note not found.']);
    expect(allocationProblems({ note: cn, amount: 1 })).toEqual(['Invoice not found.']);
  });

  it('refuses a cancelled note, a note with nothing owed and an invoice with nothing to pay', () => {
    expect(check(10, { note: { ...cn, status: 'cancelled', refund_status: 'none', refund_due: 0 } })).toEqual(['This credit note is cancelled.']);
    expect(check(10, { note: { ...cn, refund_status: 'none', refund_due: 0 } })).toEqual(['There is no credit left to use on this credit note.']);
    expect(check(10, { invoice: { ...target, amount_credited: 150.01 } })).toEqual(['This invoice has nothing left to pay.']);
  });

  it('refuses more than the credit left or the balance, by a penny', () => {
    // 150.005 stored shows as 150.01, and 150.01 settles it.
    expect(balanceDue(target)).toBe(150.01);
    expect(check(150.01)).toEqual([]);
    expect(check(150.02)).toEqual(['This is more than is left to pay on this invoice.']);
    const big = { ...target, total: 5000 };
    expect(check(224, { invoice: big })).toEqual([]);
    expect(check(224.01, { invoice: big })).toEqual(['This is more than the credit left on this credit note.']);
    expect(check(99, { invoice: big, note: { ...cn, amount_allocated: 125 } })).toEqual([]);
    expect(check(100, { invoice: big, note: { ...cn, amount_allocated: 125 } })).toEqual(['This is more than the credit left on this credit note.']);
  });

  it('needs an amount above 0 in whole pennies', () => {
    for (const bad of [0, -1, '', null, undefined, 'abc', NaN, Infinity, '0.00']) {
      expect(check(bad)).toEqual(['The amount must be more than 0.']);
    }
    expect(check(1.005)).toEqual(['The amount can have at most 2 decimal places.']);
    expect(check(0.001)).toEqual(['The amount can have at most 2 decimal places.']);
    // Float noise left by the browser is still whole pennies.
    expect(check(0.1 + 0.2)).toEqual([]);
    expect(check('12.50')).toEqual([]);
    expect(check('1.2e1')).toEqual([]);
  });

  it('keeps the note to 500 characters, counted as the database counts them', () => {
    expect(check(10, { allocationNote: 'x'.repeat(500) })).toEqual([]);
    expect(check(10, { allocationNote: '👍'.repeat(500) })).toEqual([]);
    expect(check(10, { allocationNote: `  ${'x'.repeat(500)}  ` })).toEqual([]);
    expect(check(10, { allocationNote: 'x'.repeat(501) })).toEqual(['Keep the note to 500 characters or fewer.']);
  });

  it('refuses a different currency (posupject rows carry one; posupcrm rows do not)', () => {
    const usd = { ...target, currency: 'USD' };
    expect(check(10, { invoice: usd })).toEqual(['This invoice is in a different currency from the credit note.']);
    const { currency: _n, ...crmNote } = cn;
    const { currency: _i, ...crmInvoice } = target;
    expect(allocationProblems({ note: crmNote, invoice: crmInvoice, amount: 10 })).toEqual([]);
    // Credit available across a company is added up per currency when asked.
    const usdNote = { ...cn, id: 'usd', currency: 'USD', refund_due: 50 };
    expect(companyCreditAvailable([cn, usdNote], 'GBP')).toBe(224);
    expect(companyCreditAvailable([cn, usdNote], 'USD')).toBe(50);
    expect(companyCreditAvailable([cn, usdNote, { ...cn, status: 'cancelled' }, { ...cn, refund_status: 'refunded', refunded_amount: 224 }])).toBe(274);
    expect(companyCreditAvailable(null)).toBe(0);
  });

  it('agrees with allocationEffect on the first problem', () => {
    expect(allocationEffect({ note: cn, invoice: target, amount: 0 })).toEqual({ problem: 'The amount must be more than 0.' });
    expect(allocationDefault({ note: cn, invoice: { ...target, status: 'paid', amount_paid: 150.01 } })).toBe(0);
  });
});

describe('cancelling with credit applied', () => {
  const note = (n, total, refund_status = 'none', refund_due = 0, extra = {}) =>
    ({ id: `cn${n}`, credit_number: n, total, refund_status, refund_due, status: 'issued', amount_allocated: 0, refunded_amount: 0, ...extra });

  it('refuses a note whose credit is applied to an invoice', () => {
    const invoice = { status: 'paid', total: 1000, amount_paid: 1000, amount_credited: 224 };
    expect(cancelCreditEffect({ invoice, notes: [note(1, 224, 'allocated', 224, { amount_allocated: 224 })], noteId: 'cn1', reason: 'Wrong' }).problem)
      .toBe('Remove the credit applied from this note first.');
    expect(cancelCreditEffect({ invoice, notes: [note(1, 224, 'owed', 224, { amount_allocated: 1 })], noteId: 'cn1' }).problem)
      .toBe('Remove the credit applied from this note first.');
  });

  it('refuses when credit another note applied would have to come back', () => {
    // 1,000 unpaid, Z credit 300, 700 paid, W credit 200 (200 owed) applied elsewhere.
    const invoice = { status: 'paid', total: 1000, amount_paid: 700, amount_credited: 500 };
    const notes = [note(1, 300), note(2, 200, 'allocated', 200, { amount_allocated: 200 })];
    expect(cancelCreditEffect({ invoice, notes, noteId: 'cn1' }).problem)
      .toBe('Credit from another credit note on this invoice has already been used on an invoice. Without this credit it would be more than the customer overpaid, so this credit cannot be cancelled.');
    // Part applied: the part applied stays, the rest can shrink.
    const part = [note(1, 100), note(2, 300, 'owed', 300, { amount_allocated: 50 })];
    const paid = { status: 'paid', total: 1000, amount_paid: 1000, amount_credited: 400 };
    expect(cancelCreditEffect({ invoice: { ...paid, amount_paid: 950 }, notes: part, noteId: 'cn1' }).refunds)
      .toEqual([{ id: 'cn2', refund_status: 'owed', refund_due: 250 }]);
    expect(cancelCreditEffect({ invoice: { ...paid, amount_paid: 750 }, notes: part, noteId: 'cn1' }).refunds)
      .toEqual([{ id: 'cn2', refund_status: 'allocated', refund_due: 50 }]);
  });

  it('counts credit applied TO the invoice as settled', () => {
    // 1,000 settled by 300 applied and 700 card, a 200 credit owes 200: cancelling it keeps it paid.
    const invoice = { status: 'paid', total: 1000, amount_paid: 700, amount_allocated: 300, amount_credited: 200 };
    expect(cancelCreditEffect({ invoice, notes: [note(1, 200, 'owed', 200)], noteId: 'cn1' }))
      .toEqual({ problem: null, amount_credited: 0, reopen: false, balance_due: 0, refunds: [] });
  });
});

describe('overpaidNotOnCredit with credit used', () => {
  it('counts what a Used note holds', () => {
    const invoice = { status: 'paid', total: 1000, amount_paid: 1000, amount_credited: 224 };
    expect(overpaidNotOnCredit(invoice, [{ status: 'issued', total: 224, refund_status: 'allocated', refund_due: 224, amount_allocated: 224 }])).toBe(0);
    expect(overpaidNotOnCredit(invoice, [{ status: 'issued', total: 224, refund_status: 'none', refund_due: 0 }])).toBe(224);
  });
});

describe('applying and removing credit at random keeps the books straight', () => {
  it('holds for 1,500 random sequences', () => {
    let seed = 20260915;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const pick = (a) => a[Math.floor(rand() * a.length)];
    const cents = (n) => Math.round(n * 100);
    for (let k = 0; k < 1500; k++) {
      // Two paid invoices with credit notes owing money back, three open invoices.
      const sources = [0, 1].map((i) => {
        const { invoice } = savedInvoice([{ name: 'Kit', qty: pick([1, 2, 0.5]), unit_price: Math.round(rand() * 200000) / 100 + 1, tax_rate: pick([20, 0, 8.875]) }],
          { id: `s${i}`, status: 'paid' });
        invoice.amount_paid = pick([invoice.total, null, Math.round(invoice.total * 100) / 100]);
        return invoice;
      });
      let notes = sources.map((inv) => {
        const credit = Math.round(creditableLeft(inv) * pick([1, 0.5, 0.1]) * 100) / 100 || 0.01;
        return issued(inv, credit);
      });
      let invoices = [0, 1, 2].map((i) => savedInvoice([{ name: 'Next', qty: 1, unit_price: Math.round(rand() * 150000) / 100 + 0.01, tax_rate: pick([20, 0]) }],
        { id: `t${i}`, status: pick(['sent', 'viewed', 'sent']), amount_allocated: 0 }).invoice);
      const cash = new Map(invoices.map((inv) => [inv.id, amountPaid(inv)]));
      let allocations = [];
      const startCredit = cents(notes.reduce((s, c) => s + creditAvailable(c), 0));

      for (let step = 0; step < 12; step++) {
        if (rand() < 0.65 || !allocations.some((a) => !a.removed_at)) {
          const note = pick(notes), invoice = pick(invoices);
          const amount = pick([allocationDefault({ note, invoice }), Math.round(allocationDefault({ note, invoice }) * 50) / 100, 0.01, creditAvailable(note) + 0.01]);
          const effect = allocationEffect({ note, invoice, amount });
          const problems = allocationProblems({ note, invoice, amount });
          expect(effect.problem ?? null).toBe(problems[0] ?? null);
          // The default is always accepted while there is credit and a balance.
          if (ALLOCATABLE_STATUSES.includes(invoice.status) && creditAvailable(note) > 0 && balanceDue(invoice) > 0) {
            expect(allocationProblems({ note, invoice, amount: allocationDefault({ note, invoice }) })).toEqual([]);
          }
          if (effect.problem) continue;
          const done = apply({ note, invoice, amount });
          notes = notes.map((c) => (c.id === note.id ? done.note : c));
          invoices = invoices.map((i) => (i.id === invoice.id ? done.invoice : i));
          allocations.push(done.allocation);
          expect(balanceDue(done.invoice)).toBe(effect.invoice.balance_due);
          expect(done.invoice.status === 'paid').toBe(balanceDue(done.invoice) === 0);
        } else {
          const allocation = pick(allocations.filter((a) => !a.removed_at));
          const note = notes.find((c) => c.id === allocation.credit_note_id);
          const invoice = invoices.find((i) => i.id === allocation.invoice_id);
          const effect = removeAllocationEffect({ allocation, note, invoice, invoiceNotes: [], reason: 'Wrong invoice' });
          expect(effect.problem).toBe(null);
          notes = notes.map((c) => (c.id === note.id ? { ...c, amount_allocated: effect.note.amount_allocated, refund_status: effect.note.refund_status } : c));
          invoices = invoices.map((i) => (i.id === invoice.id ? { ...i, amount_allocated: effect.invoice.amount_allocated, status: effect.invoice.status } : i));
          allocations = allocations.map((a) => (a.id === allocation.id ? { ...a, removed_at: 'now' } : a));
          expect(effect.invoice.reopen).toBe(invoice.status === 'paid');
        }
        // Credit only moves: what the notes have left plus what is applied is what they started with.
        const applied = cents(allocations.filter((a) => !a.removed_at).reduce((s, a) => s + a.amount, 0));
        expect(cents(notes.reduce((s, c) => s + creditAvailable(c), 0)) + applied).toBe(startCredit);
        expect(cents(invoices.reduce((s, i) => s + i.amount_allocated, 0))).toBe(applied);
        for (const inv of invoices) {
          // Applied credit is never cash, and never takes a balance below 0.
          expect(amountPaid(inv)).toBe(cash.get(inv.id));
          expect(balanceDue(inv)).toBeGreaterThanOrEqual(0);
          expect(cents(balanceDue(inv)) + cents(inv.amount_allocated) + cents(amountPaid(inv))).toBe(cents(creditableLeft(inv)));
        }
        for (const c of notes) {
          expect(creditAvailable(c)).toBeGreaterThanOrEqual(0);
          expect(creditNoteStatusKind(c)).toBe(creditAvailable(c) === 0 ? (c.amount_allocated > 0 ? 'Used' : 'Issued') : c.amount_allocated > 0 ? 'Part used' : 'Available');
        }
      }
    }
  });
});

// ── The amount received ─────────────────────────────────────────────────────
// What set_invoice_amount_received does to the rows, so a sequence can be
// followed: the effect is the library's own prediction of the database.
function receive(args) {
  const effect = amountReceivedEffect(args);
  if (effect.problem) throw new Error(effect.problem);
  const paidAt = effect.paid_at === 'now' ? RECEIVED_AT : effect.paid_at === 'clear' ? null : args.invoice.paid_at;
  const invoice = { ...args.invoice, amount_paid: effect.amount_paid, status: effect.status, paid_at: paidAt };
  const notes = (args.notes || []).map((c) => {
    const m = effect.credit_moved.find((x) => x.id === c.id);
    return m ? { ...c, refund_due: m.refund_due, refund_status: m.refund_status } : c;
  });
  return { effect, invoice, notes };
}
const cents = (n) => Math.round(Number(n) * 100);
const RECEIVED_AT = '2026-09-14T15:00:00Z';
const USED_OR_REFUNDED = (x, y, sign = '£') => `${sign}${x} of the credit from this invoice has already been used or refunded, so the amount received cannot go below ${sign}${y}.`;

describe('INV-1036: correcting what the customer actually paid', () => {
  // 1,344 with VAT wrongly built in. CN-1001 (224) was raised, then Mark paid
  // recorded the 1,120 balance although the customer had sent 1,344.
  const inv1036 = { id: 'inv-1036', invoice_number: 1036, status: 'paid', total: 1344, amount_paid: 1120, amount_credited: 224, amount_allocated: 0, currency: 'GBP' };
  const cn1001 = { id: 'cn-1001', credit_number: 1001, invoice_id: 'inv-1036', status: 'issued', total: 224, refund_status: 'none', refund_due: 0, amount_allocated: 0, refunded_amount: 0, currency: 'GBP' };
  const inv1050 = { id: 'inv-1050', invoice_number: 1050, status: 'sent', total: 1000, amount_paid: null, amount_credited: 0, amount_allocated: 0, currency: 'GBP' };

  it('was stuck: nothing overpaid on record, so no credit to use', () => {
    expect(creditNoteStatusLabel(cn1001, { invoiceNumber: 1036 })).toBe('Used on INV-1036');
    expect(creditAvailable(cn1001)).toBe(0);
    expect(overpaidNotOnCredit(inv1036, [cn1001])).toBe(0);
    expect(amountPaid(inv1036)).toBe(1120);
  });

  it('corrects to 1,344: CN-1001 holds the 224 as credit to use, then it goes on INV-1050, and going back to 1,120 is refused', () => {
    const fixed = receive({ invoice: inv1036, notes: [cn1001], amount: 1344, reason: 'Customer paid the full 1,344 by bank transfer' });
    expect(fixed.effect).toEqual({
      problem: null, kind: 'correction', reason: 'Customer paid the full 1,344 by bank transfer',
      from_amount: 1120, amount_paid: 1344, status: 'paid', paid_at: 'keep', balance_due: 0, overpaid: 224,
      credit_moved: [{ id: 'cn-1001', credit_number: 1001, refund_due: 224, refund_status: 'owed', credit_available: 224 }],
      not_on_a_credit_note: 0,
    });
    const [cn] = fixed.notes;
    expect(cn).toMatchObject({ refund_status: 'owed', refund_due: 224 });
    expect(creditAvailable(cn)).toBe(224);
    expect(creditNoteStatusLabel(cn)).toBe('£224.00 to use');
    expect(overpaidNotOnCredit(fixed.invoice, fixed.notes)).toBe(0);
    expect(balanceDue(fixed.invoice)).toBe(0);

    // Apply the 224 to the next 1,000 invoice.
    const applied = apply({ note: cn, invoice: inv1050, amount: 224 });
    expect(balanceDue(applied.invoice)).toBe(776);
    expect(creditNoteStatusLabel(applied.note, { usedOn: [applied.invoice] })).toBe('Used on INV-1050');

    // Now the 224 is spent, INV-1036 cannot go back to 1,120, or a penny under 1,344.
    const rows = [applied.allocation];
    const back = { invoice: fixed.invoice, notes: [applied.note], allocationsFromNotes: rows, reason: 'Back to what Mark paid said' };
    expect(amountReceivedEffect({ ...back, amount: 1120 }).problem).toBe(USED_OR_REFUNDED('224.00', '1,344.00'));
    expect(amountReceivedEffect({ ...back, amount: 1343.99 }).problem).toBe(USED_OR_REFUNDED('224.00', '1,344.00'));
    // The same without the rows, from the note's own amount_allocated.
    expect(amountReceivedEffect({ ...back, allocationsFromNotes: undefined, amount: 1120 }).problem).toBe(USED_OR_REFUNDED('224.00', '1,344.00'));
    // More than the note can hold is allowed; the rest is not on a credit note.
    expect(amountReceivedEffect({ ...back, amount: 1400 })).toMatchObject({ problem: null, overpaid: 280, credit_moved: [], not_on_a_credit_note: 56 });

    // Once the applied credit is removed (the row marked removed), 1,120 is allowed again and CN-1001 goes back to none.
    const removed = removeAllocationEffect({ allocation: applied.allocation, note: applied.note, invoice: applied.invoice, reason: 'Applied by mistake' });
    const noteBack = { ...applied.note, amount_allocated: removed.note.amount_allocated, refund_status: removed.note.refund_status };
    const again = amountReceivedEffect({ ...back, notes: [noteBack], allocationsFromNotes: [{ ...applied.allocation, removed_at: '2026-09-14T12:00:00Z' }], amount: 1120 });
    expect(again).toMatchObject({ problem: null, status: 'paid', paid_at: 'keep', overpaid: 0,
      credit_moved: [{ id: 'cn-1001', credit_number: 1001, refund_due: 0, refund_status: 'none', credit_available: 0 }] });
  });

  it('Mark paid asks what they paid, so the live mistake cannot happen again', () => {
    // INV-1036 as it stood when Mark paid was pressed: sent, CN-1001 on it.
    const sent = { ...inv1036, status: 'sent', amount_paid: null };
    expect(balanceDue(sent)).toBe(1120);
    // The sheet starts at the balance; the customer actually paid 1,344.
    const total = markPaymentTotal(sent, 1344);
    expect(total).toBe(1344);
    const { effect, notes } = receive({ invoice: sent, notes: [cn1001], amount: total, kind: 'payment' });
    expect(effect).toMatchObject({ kind: 'payment', reason: PAYMENT_REASON, from_amount: 0, amount_paid: 1344, status: 'paid', paid_at: 'now', overpaid: 224, not_on_a_credit_note: 0 });
    expect(creditAvailable(notes[0])).toBe(224);
    // Paying just the balance settles it with nothing over.
    expect(amountReceivedEffect({ invoice: sent, notes: [cn1001], amount: markPaymentTotal(sent, balanceDue(sent)), kind: 'payment' }))
      .toMatchObject({ problem: null, status: 'paid', overpaid: 0, credit_moved: [], amount_paid: 1120 });
  });
});

describe('markPaymentTotal', () => {
  it('adds this payment to the cash already received', () => {
    expect(markPaymentTotal({ status: 'sent', total: 1000, amount_paid: null }, 400)).toBe(400);
    expect(markPaymentTotal({ status: 'viewed', total: 1000, amount_paid: 300, amount_credited: 100, amount_allocated: 224 }, 376)).toBe(676);
    expect(markPaymentTotal({ status: 'sent', total: 1000, amount_paid: 250.5 }, '12.50')).toBe(263);
    // A paid invoice with no amount_paid counts as paid in full, in pennies.
    expect(markPaymentTotal({ status: 'paid', total: 119.988, amount_paid: null }, 10)).toBe(129.99);
    // Float noise in the stored cash is washed to the penny first.
    expect(markPaymentTotal({ status: 'sent', total: 500, amount_paid: 0.1 + 0.2 }, 0.7)).toBe(1);
  });
  it('keeps extra places and bad input for the database to refuse', () => {
    const inv = { status: 'sent', total: 1000, amount_paid: 100 };
    expect(markPaymentTotal(inv, 1.005)).toBe(101.005);
    expect(amountReceivedEffect({ invoice: inv, amount: markPaymentTotal(inv, 1.005), kind: 'payment' }).problem).toBe('The payment can have at most 2 decimal places.');
    for (const bad of ['', 'abc', null, undefined, NaN, Infinity]) expect(markPaymentTotal(inv, bad)).toBe(null);
    expect(amountReceivedEffect({ invoice: inv, amount: markPaymentTotal(inv, 'abc'), kind: 'payment' }).problem).toBe('The payment must be more than 0.');
    expect(amountReceivedEffect({ invoice: inv, amount: markPaymentTotal(inv, -5), kind: 'payment' }).problem).toBe('The payment must be more than 0.');
    expect(amountReceivedEffect({ invoice: inv, amount: markPaymentTotal(inv, 0), kind: 'payment' }).problem).toBe('The payment must be more than 0.');
  });
});

describe('amountReceivedEffect refuses in the same order and with the same words as the database', () => {
  const inv = { status: 'sent', total: 100, amount_paid: null, amount_credited: 0, amount_allocated: 0 };
  const check = (args) => amountReceivedEffect({ invoice: inv, amount: 50, reason: 'Paid by bank', ...args }).problem;

  it('kind, invoice and status first', () => {
    expect(RECEIVED_KINDS).toEqual(['correction', 'payment']);
    expect(check({ kind: 'refund' })).toBe('Choose correction or payment.');
    expect(check({ kind: null })).toBe(null);
    expect(amountReceivedEffect({ amount: 1 }).problem).toBe('Invoice not found.');
    for (const status of ['draft', 'void']) {
      expect(check({ invoice: { ...inv, status }, amount: -1, reason: 'x' })).toBe('The amount received can only be changed on a sent, viewed or paid invoice.');
    }
    for (const status of ['sent', 'viewed', 'paid']) expect(check({ invoice: { ...inv, status, amount_paid: 0 } })).toBe(null);
  });

  it('then the amount', () => {
    for (const bad of [-1, -0.0000001, null, undefined, '', 'abc', NaN, Infinity, -Infinity]) {
      expect(check({ amount: bad, reason: 'x' })).toBe('The amount received must be 0 or more.');
    }
    expect(check({ amount: 1.005, reason: 'x' })).toBe('The amount received can have at most 2 decimal places.');
    expect(check({ amount: 0, reason: 'x' })).toBe('That is already the amount received on this invoice.');
    // Float noise from the browser is whole pennies.
    expect(amountReceivedEffect({ invoice: inv, amount: 20.000000000000004, reason: 'Paid by bank' }).amount_paid).toBe(20);
    expect(check({ amount: '1.2e1' })).toBe(null);
    // A paid invoice with no amount_paid was paid in full, in pennies.
    const paid = { status: 'paid', total: 119.988, amount_paid: null, amount_credited: 0, paid_at: '2026-08-01T12:00:00Z' };
    expect(amountReceivedEffect({ invoice: paid, amount: 119.99, reason: 'Same' }).problem).toBe('That is already the amount received on this invoice.');
    expect(amountReceivedEffect({ invoice: paid, amount: 100, reason: 'Short paid' })).toMatchObject({ from_amount: 119.99, balance_due: 19.99, status: 'sent', paid_at: 'keep' });
  });

  it('then the reason, only when passed; a payment has a default', () => {
    const msg = 'Give a reason of 3 to 500 characters.';
    expect(check({ reason: '  ab ' })).toBe(msg);
    expect(check({ reason: null })).toBe(msg);
    expect(check({ reason: 'x'.repeat(501) })).toBe(msg);
    expect(check({ reason: '👍'.repeat(500) })).toBe(null);
    expect(check({ reason: undefined })).toBe(null);
    expect(amountReceivedEffect({ invoice: inv, amount: 50, reason: '  Paid by bank  ' }).reason).toBe('Paid by bank');
    expect(amountReceivedEffect({ invoice: inv, amount: 50, reason: '  ', kind: 'payment' }).reason).toBe(PAYMENT_REASON);
    expect(amountReceivedEffect({ invoice: inv, amount: 50, kind: 'payment' }).reason).toBe(PAYMENT_REASON);
    expect(check({ reason: 'x'.repeat(501), kind: 'payment' })).toBe(msg);
    // The amount before the reason, and the reason before the money.
    expect(check({ amount: -1, reason: 'ab' })).toBe('The amount received must be 0 or more.');
  });

  it('then the credit already used or refunded, in the invoice currency', () => {
    const src = { id: 's', status: 'paid', total: 12500, amount_paid: 12500, amount_credited: 1234.5, amount_allocated: 0, currency: 'USD' };
    const note = { id: 'n', credit_number: 5, invoice_id: 's', status: 'issued', total: 1234.5, refund_status: 'allocated', refund_due: 1234.5, amount_allocated: 1234.5, refunded_amount: 0, currency: 'USD' };
    expect(amountReceivedEffect({ invoice: src, notes: [note], amount: 11000, reason: 'Wire was short' }).problem).toBe(USED_OR_REFUNDED('1,234.50', '12,500.00', '$'));
    expect(amountReceivedEffect({ invoice: src, notes: [note], amount: 11000, reason: 'ab' }).problem).toBe('Give a reason of 3 to 500 characters.');
    // posupcrm rows carry no currency: pounds.
    const { currency: _c, ...crm } = src;
    expect(amountReceivedEffect({ invoice: crm, notes: [note], amount: 0, reason: 'Never paid' }).problem).toBe(USED_OR_REFUNDED('1,234.50', '12,500.00'));
    // Cancelled notes hold nothing.
    expect(amountReceivedEffect({ invoice: crm, notes: [{ ...note, status: 'cancelled' }], amount: 0, reason: 'Never paid' }).problem).toBe(null);
  });
});

describe('status, paid_at and credit applied', () => {
  const base = { status: 'sent', total: 1000, amount_paid: null, amount_credited: 0, amount_allocated: 0 };
  const eff = (invoice, amount) => amountReceivedEffect({ invoice, amount, reason: 'Bank statement' });

  it('paid once cash covers it, back to sent when a paid invoice no longer is', () => {
    const paid = { ...base, status: 'paid', amount_paid: 1000, paid_at: '2026-08-03T10:00:00Z' };
    expect(eff(base, 1000)).toMatchObject({ status: 'paid', paid_at: 'now', balance_due: 0 });
    expect(eff(base, 400)).toMatchObject({ status: 'sent', paid_at: 'now', balance_due: 600 });
    expect(eff({ ...base, status: 'viewed' }, 400)).toMatchObject({ status: 'viewed', paid_at: 'now' });
    expect(eff(paid, 1200)).toMatchObject({ status: 'paid', paid_at: 'keep', overpaid: 200, not_on_a_credit_note: 200 });
    expect(eff(paid, 999.99)).toMatchObject({ status: 'sent', paid_at: 'keep', balance_due: 0.01 });
    expect(eff(paid, 0)).toMatchObject({ status: 'sent', paid_at: 'clear', balance_due: 1000 });
  });

  it('paid_at stays the day the money came in, so Collected keeps it in its month', () => {
    // Paid 1,000 on 3 Aug. On 14 Sep a 400 cheque bounces: 600 really came in,
    // in August, so August keeps it while the invoice is open again.
    const aug = { ...base, id: 'inv', status: 'paid', amount_paid: 1000, paid_at: '2026-08-03T10:00:00Z' };
    let step = receive({ invoice: aug, amount: 600, reason: 'Cheque for 400 bounced' });
    expect(step.effect).toMatchObject({ status: 'sent', paid_at: 'keep', balance_due: 400 });
    expect(step.invoice.paid_at).toBe('2026-08-03T10:00:00Z');
    // The rest comes in: paid, still dated the day the first money came in.
    step = receive({ invoice: step.invoice, amount: markPaymentTotal(step.invoice, 400), kind: 'payment' });
    expect(step.effect).toMatchObject({ status: 'paid', paid_at: 'keep' });
    // A part payment counts straight away: the first cash dates the invoice.
    step = receive({ invoice: base, amount: markPaymentTotal(base, 400), kind: 'payment' });
    expect(step.effect).toMatchObject({ status: 'sent', paid_at: 'now', amount_paid: 400 });
    expect(step.invoice.paid_at).toBe(RECEIVED_AT);
    // A second part payment keeps that day.
    expect(eff(step.invoice, 700)).toMatchObject({ status: 'sent', paid_at: 'keep' });
    // Recorded on the wrong invoice: no cash and not paid, so no day either.
    expect(eff(step.invoice, 0)).toMatchObject({ status: 'sent', paid_at: 'clear' });
    // Nothing to clear stays as it is.
    expect(eff({ ...base, amount_paid: 50 }, 0)).toMatchObject({ status: 'sent', paid_at: 'keep' });
    // Settled with no cash at all (credit notes and credit applied) is dated when it becomes paid.
    const credit = { ...base, amount_paid: 100, amount_credited: 500, amount_allocated: 500 };
    expect(eff(credit, 0)).toMatchObject({ status: 'paid', paid_at: 'now', amount_paid: 0 });
    expect(eff({ ...credit, paid_at: '2026-08-03T10:00:00Z' }, 0)).toMatchObject({ status: 'paid', paid_at: 'keep' });
    // A paid invoice that never had a date stays that way while it stays paid.
    expect(eff({ ...base, status: 'paid', amount_paid: 1000 }, 1100)).toMatchObject({ status: 'paid', paid_at: 'keep' });
  });

  it('counts credit applied TO the invoice as settling it, never as cash', () => {
    const inv = { ...base, amount_allocated: 224 };
    expect(eff(inv, 776)).toMatchObject({ status: 'paid', amount_paid: 776, balance_due: 0, overpaid: 0 });
    expect(eff(inv, 775.99)).toMatchObject({ status: 'sent', balance_due: 0.01 });
    // A paid invoice with no amount_paid and credit applied had cash of the rest.
    expect(eff({ ...inv, status: 'paid' }, 1000)).toMatchObject({ from_amount: 776, overpaid: 224, not_on_a_credit_note: 224 });
  });

  it('overpaid with no credit note: allowed, and not on a credit note', () => {
    const { effect, invoice } = receive({ invoice: { ...base, total: 100 }, amount: 150, reason: 'Paid twice by bank' });
    expect(effect).toMatchObject({ status: 'paid', overpaid: 50, credit_moved: [], not_on_a_credit_note: 50 });
    expect(overpaidNotOnCredit(invoice, [])).toBe(50);
  });
});

describe('a payment is never recorded twice', () => {
  const paidMsg = (name) => `${name} has already been paid. Use Change to correct the amount received.`;
  const nothingMsg = (name) => `${name} has nothing left to pay. Use Change to correct the amount received.`;

  it('two people with INV-1036 open: the second Mark paid is refused, and Change still works', () => {
    const sent = { id: 'inv-1036', invoice_number: 1036, status: 'sent', total: 1344, amount_paid: null, amount_credited: 0, amount_allocated: 0 };
    // A records the 1,344 bank transfer.
    const first = receive({ invoice: sent, amount: markPaymentTotal(sent, 1344), kind: 'payment' });
    expect(first.invoice).toMatchObject({ status: 'paid', amount_paid: 1344 });
    // B's screen still showed Mark paid; the sheet reads the invoice again, now paid.
    const again = amountReceivedEffect({ invoice: first.invoice, amount: markPaymentTotal(first.invoice, 1344), kind: 'payment' });
    expect(again.problem).toBe(paidMsg('INV-1036'));
    // Before the amount and the reason are looked at.
    expect(amountReceivedEffect({ invoice: first.invoice, amount: 'abc', reason: 'ab', kind: 'payment' }).problem).toBe(paidMsg('INV-1036'));
    // Money that really did come in on top is a correction.
    expect(amountReceivedEffect({ invoice: first.invoice, amount: 2688, reason: 'Paid twice by bank' })).toMatchObject({ problem: null, overpaid: 1344 });
    // Without a number it is "This invoice".
    expect(amountReceivedEffect({ invoice: { ...first.invoice, invoice_number: undefined }, amount: 1, kind: 'payment' }).problem).toBe(paidMsg('This invoice'));
  });

  it('refuses a payment on a sent invoice with nothing left to pay', () => {
    // Fully credited, never paid.
    const credited = { invoice_number: 7, status: 'sent', total: 500, amount_paid: null, amount_credited: 500, amount_allocated: 0 };
    expect(balanceDue(credited)).toBe(0);
    expect(amountReceivedEffect({ invoice: credited, amount: 50, kind: 'payment' }).problem).toBe(nothingMsg('INV-7'));
    // Settled by cash and credit applied together, a penny under the total in cash.
    const settled = { invoice_number: 8, status: 'viewed', total: 1000, amount_paid: 775.999999, amount_credited: 0, amount_allocated: 224 };
    expect(amountReceivedEffect({ invoice: settled, amount: 900, kind: 'payment' }).problem).toBe(nothingMsg('INV-8'));
    // A penny left to pay takes a payment.
    expect(amountReceivedEffect({ invoice: { ...settled, amount_paid: 775.99 }, amount: 776, kind: 'payment' })).toMatchObject({ problem: null, status: 'paid' });
    // A correction on it is fine.
    expect(amountReceivedEffect({ invoice: credited, amount: 50, reason: 'Paid anyway' })).toMatchObject({ problem: null, overpaid: 50 });
  });
});

describe('the amount received the sheet worked from (expectedFrom)', () => {
  const changed = 'The amount received on this invoice changed while this was open. Check the figures and save again.';
  const base = { invoice_number: 1040, status: 'sent', total: 1000, amount_paid: null, amount_credited: 0, amount_allocated: 0 };

  it('a payment that lands while the sheet is open is never swallowed', () => {
    // Both sheets opened on 0 received. The first records 400.
    const first = receive({ invoice: base, amount: markPaymentTotal(base, 400), kind: 'payment', expectedFrom: 0 });
    expect(first.invoice.amount_paid).toBe(400);
    // The second still works from 0: 0 + 500 would be taken as 400 to 500.
    const stale = markPaymentTotal(base, 500);
    expect(stale).toBe(500);
    expect(amountReceivedEffect({ invoice: first.invoice, amount: stale, kind: 'payment', expectedFrom: 0 }).problem).toBe(changed);
    // Read again, the 500 goes on top of the 400.
    expect(amountReceivedEffect({ invoice: first.invoice, amount: markPaymentTotal(first.invoice, 500), kind: 'payment', expectedFrom: 400 }))
      .toMatchObject({ problem: null, from_amount: 400, amount_paid: 900, balance_due: 100 });
    // A stale total at or under the new cash says it changed, not "more than 0".
    expect(amountReceivedEffect({ invoice: first.invoice, amount: 300, kind: 'payment', expectedFrom: 0 }).problem).toBe(changed);
  });

  it('pins a correction too, compared in pennies, and is only checked when passed', () => {
    const inv = { ...base, amount_paid: 400.0000000001 };
    expect(amountReceivedEffect({ invoice: inv, amount: 1000, reason: 'Bank shows 1,000', expectedFrom: 0 }).problem).toBe(changed);
    expect(amountReceivedEffect({ invoice: inv, amount: 1000, reason: 'Bank shows 1,000', expectedFrom: '400.000000000001' }).problem).toBe(null);
    expect(amountReceivedEffect({ invoice: inv, amount: 1000, reason: 'Bank shows 1,000', expectedFrom: 400.004 }).problem).toBe(null);
    expect(amountReceivedEffect({ invoice: inv, amount: 1000, reason: 'Bank shows 1,000', expectedFrom: 400.005 }).problem).toBe(changed);
    for (const bad of ['NaN', 'abc', '', NaN, Infinity]) {
      expect(amountReceivedEffect({ invoice: inv, amount: 1000, reason: 'Bank shows 1,000', expectedFrom: bad }).problem).toBe(changed);
    }
    for (const skip of [null, undefined]) {
      expect(amountReceivedEffect({ invoice: inv, amount: 1000, reason: 'Bank shows 1,000', expectedFrom: skip }).problem).toBe(null);
    }
    // A paid invoice with no amount_paid was paid in full: that is the figure.
    const paid = { ...base, status: 'paid', amount_paid: null, amount_allocated: 224 };
    expect(amountReceivedEffect({ invoice: paid, amount: 1000, reason: 'Paid in full', expectedFrom: 776 }).problem).toBe(null);
  });

  it('comes after the status, and before a payment on a paid invoice', () => {
    expect(amountReceivedEffect({ invoice: { ...base, status: 'draft' }, amount: 1, expectedFrom: 5 }).problem)
      .toBe('The amount received can only be changed on a sent, viewed or paid invoice.');
    expect(amountReceivedEffect({ invoice: { ...base, status: 'paid', amount_paid: 1000 }, amount: 1100, kind: 'payment', expectedFrom: 0 }).problem).toBe(changed);
  });
});

describe('overpaidAdvice', () => {
  const removeCredit = 'An owner can remove the credit applied so it goes back on the credit note.';

  it('credit applied that the customer did not use: remove it, never a credit note', () => {
    // CN-1001's 224 applied to INV-1050 (1,000) and 776 recorded, so it is paid.
    // The customer ignored the credit and paid 1,000.
    const inv1050 = { id: 'inv-1050', invoice_number: 1050, status: 'paid', total: 1000, amount_paid: 776, amount_credited: 0, amount_allocated: 224 };
    const { effect, invoice } = receive({ invoice: inv1050, amount: 1000, reason: 'Customer paid the full 1,000' });
    expect(effect).toMatchObject({ overpaid: 224, not_on_a_credit_note: 224, credit_moved: [] });
    expect(overpaidAdvice({ invoice, overpaid: effect.not_on_a_credit_note, canCredit: true }))
      .toBe(`The customer paid in full without using the credit applied. ${removeCredit}`);
    expect(overpaidAdvice({ invoice, overpaid: overpaidNotOnCredit(invoice, []), canCredit: false }))
      .toBe(`The customer paid in full without using the credit applied. ${removeCredit}`);
    // Paid more than the balance after the credit, but not the full total.
    expect(overpaidAdvice({ invoice: { ...invoice, amount_paid: 900 }, overpaid: 124, canCredit: true }))
      .toBe(`The customer paid more than was left to pay after the credit applied. ${removeCredit}`);
    // Removing the credit puts it right: nothing overpaid, 224 to pay.
    expect(balanceDue({ ...invoice, amount_allocated: 0 })).toBe(0);
    expect(overpaidNotOnCredit({ ...invoice, amount_allocated: 0 }, [])).toBe(0);
  });

  it('otherwise raise a credit note, or refund when none can be raised; nothing when not overpaid', () => {
    const inv = { status: 'paid', total: 500, amount_paid: 600, amount_credited: 0, amount_allocated: 0 };
    expect(overpaidAdvice({ invoice: inv, overpaid: 100, canCredit: true })).toBe('Raise a credit note to use or refund it.');
    expect(overpaidAdvice({ invoice: inv, overpaid: 100, canCredit: false }))
      .toBe('More was paid than this invoice asks for and no credit note holds it as credit. Refund it to the customer.');
    // More overpaid than the credit applied: the credit does not explain it all.
    expect(overpaidAdvice({ invoice: { ...inv, amount_allocated: 50 }, overpaid: 150, canCredit: true })).toBe('Raise a credit note to use or refund it.');
    expect(overpaidAdvice({ invoice: { ...inv, amount_allocated: 50 }, overpaid: 50.004, canCredit: true })).toBe(`The customer paid in full without using the credit applied. ${removeCredit}`);
    for (const none of [0, -1, null, undefined, 0.004]) expect(overpaidAdvice({ invoice: inv, overpaid: none, canCredit: true })).toBe(null);
  });
});

describe('moving credit to use onto and off the credit notes', () => {
  const note = (n, total, refund_status = 'none', refund_due = 0, extra = {}) =>
    ({ id: `cn${n}`, credit_number: n, invoice_id: 'inv', status: 'issued', total, refund_status, refund_due, amount_allocated: 0, refunded_amount: 0, ...extra });

  it('lowers after a part refund, never into the refund', () => {
    // 1,000 paid by card. CN-1 200 refunded by bank, CN-2 300 still to use.
    const inv = { id: 'inv', status: 'paid', total: 1000, amount_paid: 1000, amount_credited: 500, amount_allocated: 0 };
    let notes = [note(1, 200, 'refunded', 200, { refunded_amount: 200 }), note(2, 300, 'owed', 300)];
    const args = { invoice: inv, notes, reason: 'Bank statement' };
    expect(amountReceivedEffect({ ...args, amount: 699.99 }).problem).toBe(USED_OR_REFUNDED('200.00', '700.00'));
    expect(amountReceivedEffect({ ...args, amount: 0 }).problem).toBe(USED_OR_REFUNDED('200.00', '700.00'));
    let step = receive({ ...args, amount: 850 });
    expect(step.effect.credit_moved).toEqual([{ id: 'cn2', credit_number: 2, refund_due: 150, refund_status: 'owed', credit_available: 150 }]);
    expect(creditNoteStatusLabel(step.notes[1])).toBe('£150.00 to use');
    step = receive({ ...args, invoice: step.invoice, notes: step.notes, amount: 700 });
    expect(step.effect).toMatchObject({ status: 'paid', overpaid: 200, credit_moved: [{ id: 'cn2', refund_due: 0, refund_status: 'none' }] });
    notes = step.notes;
    expect(notes[0]).toMatchObject({ refund_status: 'refunded', refund_due: 200 });
    // Raised again, the refunded note never takes more (as record_invoice_payment).
    step = receive({ ...args, invoice: step.invoice, notes, amount: 1100 });
    expect(step.effect).toMatchObject({ overpaid: 600, not_on_a_credit_note: 100, credit_moved: [{ id: 'cn2', refund_due: 300, refund_status: 'owed' }] });
  });

  it('lowers a part used note down to what was used, then it takes more again', () => {
    // 900 paid on 1,000, a 300 credit owes 200; 150 of it applied elsewhere.
    const inv = { id: 'inv', status: 'sent', total: 1000, amount_paid: 900, amount_credited: 300, amount_allocated: 0 };
    const cn = note(1, 300, 'owed', 200, { amount_allocated: 150 });
    const args = { invoice: inv, notes: [cn], reason: 'Bank statement' };
    expect(creditNoteStatusLabel(cn)).toBe('£150.00 used, £50.00 to use');
    expect(amountReceivedEffect({ ...args, amount: 849.99 }).problem).toBe(USED_OR_REFUNDED('150.00', '850.00'));
    const down = receive({ ...args, amount: 850 });
    expect(down.effect).toMatchObject({ status: 'paid', paid_at: 'now', credit_moved: [{ refund_due: 150, refund_status: 'allocated', credit_available: 0 }] });
    expect(creditNoteStatusKind(down.notes[0])).toBe('Used');
    const up = receive({ ...args, invoice: down.invoice, notes: down.notes, amount: 1000 });
    expect(up.effect.credit_moved).toEqual([{ id: 'cn1', credit_number: 1, refund_due: 300, refund_status: 'owed', credit_available: 150 }]);
  });

  it('fills the newest note first, each up to its total, and takes from the newest first', () => {
    const inv = { id: 'inv', status: 'sent', total: 1000, amount_paid: null, amount_credited: 150, amount_allocated: 0 };
    const notes = [note(1, 100), note(2, 50), note(3, 10, 'none', 0, { status: 'cancelled' })];
    const up = receive({ invoice: inv, notes, amount: 1000, reason: 'Paid the original total' });
    expect(up.effect.credit_moved.map((m) => [m.credit_number, m.refund_due, m.refund_status])).toEqual([[2, 50, 'owed'], [1, 100, 'owed']]);
    const down = receive({ invoice: up.invoice, notes: up.notes, amount: 900, reason: 'Bank shows 900' });
    expect(down.effect.credit_moved.map((m) => [m.credit_number, m.refund_due, m.refund_status])).toEqual([[2, 0, 'none'], [1, 50, 'owed']]);
    const short = receive({ invoice: down.invoice, notes: down.notes, amount: 849.99, reason: 'One penny short' });
    expect(short.effect).toMatchObject({ status: 'sent', paid_at: 'keep', balance_due: 0.01, overpaid: 0 });
    expect(short.invoice.paid_at).toBe(RECEIVED_AT);
    expect(short.notes.every((c) => Number(c.refund_due) === 0)).toBe(true);
    const over = receive({ invoice: short.invoice, notes: short.notes, amount: 1200, reason: 'Paid far too much' });
    expect(over.effect).toMatchObject({ overpaid: 350, not_on_a_credit_note: 200 });
  });

  it('takes a note that owes again after a refund back to Refunded, never into the refund', () => {
    // 1,000 paid, CN 224: 100 applied, 124 refunded, then the 100 removed, so 100 is to use again.
    const inv = { id: 'inv', status: 'paid', total: 1000, amount_paid: 1000, amount_credited: 224, amount_allocated: 0 };
    const cn = note(1, 224, 'owed', 224, { refunded_amount: 124 });
    expect(creditNoteStatusLabel(cn)).toBe('£124.00 refunded, £100.00 to use');
    expect(amountReceivedEffect({ invoice: inv, notes: [cn], amount: 899.99, reason: 'Card fee kept back' }).problem).toBe(USED_OR_REFUNDED('124.00', '900.00'));
    const { effect, notes } = receive({ invoice: inv, notes: [cn], amount: 900, reason: 'Card fee kept back' });
    expect(effect.credit_moved).toEqual([{ id: 'cn1', credit_number: 1, refund_due: 124, refund_status: 'refunded', credit_available: 0 }]);
    expect(creditNoteStatusLabel(notes[0])).toBe('Refunded');
    expect(creditUse(notes[0])).toEqual({ used: 0, refunded: 124, left: 0 });
  });

  it('sums applied credit from the rows when they are passed, as the database does', () => {
    const inv = { id: 'inv', status: 'paid', total: 1000, amount_paid: 1000, amount_credited: 300, amount_allocated: 0 };
    // The note's column says 100 used, the rows say 250 (one of 50 removed).
    const cn = note(1, 300, 'owed', 300, { amount_allocated: 100 });
    const rows = [{ credit_note_id: 'cn1', amount: 200, removed_at: null }, { credit_note_id: 'cn1', amount: 50, removed_at: null },
      { credit_note_id: 'cn1', amount: 50, removed_at: '2026-09-14' }, { credit_note_id: 'other', amount: 999, removed_at: null }];
    expect(amountReceivedEffect({ invoice: inv, notes: [cn], allocationsFromNotes: rows, amount: 900, reason: 'Short' }).problem).toBe(USED_OR_REFUNDED('250.00', '950.00'));
    expect(amountReceivedEffect({ invoice: inv, notes: [cn], amount: 900, reason: 'Short' }).problem).toBe(null);
  });
});

describe('correcting the amount received at random keeps the books straight', () => {
  it('holds for 1,500 random sequences', () => {
    let seed = 20260914;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const pick = (a) => a[Math.floor(rand() * a.length)];
    for (let k = 0; k < 1500; k++) {
      const { invoice: start } = savedInvoice([{ name: 'Kit', qty: pick([1, 2, 0.5]), unit_price: Math.round(rand() * 200000) / 100 + 1, tax_rate: pick([20, 0, 8.875]) }],
        { id: 'src', status: pick(['sent', 'viewed', 'paid']), amount_allocated: pick([0, 0, 0, 25]), currency: pick(['GBP', 'USD', undefined]) });
      start.amount_paid = start.status === 'paid' ? pick([start.total, null]) : pick([null, 0, Math.round(start.total * 40) / 100]);
      let invoice = start;
      let notes = [];
      // One to three credit notes as issue_credit_note would store them.
      for (let n = 0; n < 1 + Math.floor(rand() * 3); n++) {
        const left = creditableLeft(invoice);
        const total = Math.round(left * pick([0.1, 0.3, 0.5]) * 100) / 100;
        if (!(total > 0)) break;
        const cn = { ...issued(invoice, total), credit_number: n + 1, id: `cn${n + 1}` };
        notes.push(cn);
        invoice = afterCredit(invoice, total);
      }
      const others = [{ id: 't', status: 'sent', total: 100000, amount_paid: null, amount_credited: 0, amount_allocated: 0, currency: invoice.currency }];
      for (let step = 0; step < 10; step++) {
        const r = rand();
        if (r < 0.2) {
          // Apply some credit elsewhere, or refund what is left.
          const cn = pick(notes);
          if (creditAvailable(cn) > 0) {
            if (rand() < 0.7) {
              const done = apply({ note: cn, invoice: others[0], amount: Math.max(0.01, Math.round(creditAvailable(cn) * pick([0.5, 1]) * 100) / 100) });
              notes = notes.map((c) => (c.id === cn.id ? done.note : c));
              others[0] = done.invoice;
            } else if (refundProblem({ note: cn }) === null) {
              notes = notes.map((c) => (c.id === cn.id ? { ...c, refund_status: 'refunded', refunded_amount: cents(c.refunded_amount) / 100 + creditAvailable(c) } : c));
            }
          }
          continue;
        }
        const settledNow = settledAmount(invoice);
        const amount = pick([0, settledNow + 0.01, settledNow - 0.01, creditableLeft(invoice), creditableLeft(invoice) + 50, Math.round(rand() * invoice.total * 150) / 100, settledNow + 1000, 1.005]);
        const kind = rand() < 0.3 ? 'payment' : 'correction';
        const args = { invoice, notes, amount, reason: 'Bank statement', kind };
        const effect = amountReceivedEffect(args);
        const issuedNotes = notes.filter((c) => c.status === 'issued');
        const fixed = cents(issuedNotes.reduce((s, c) => s + Number(c.amount_allocated || 0) + Number(c.refunded_amount || 0), 0));
        if (effect.problem) {
          if (effect.problem.includes('already been used or refunded')) {
            // Refused exactly when the overpayment would be under what is used or refunded,
            // and the lowest amount it names is then accepted (or is already the amount).
            const lowest = Number(effect.problem.match(/below .([\d,]+\.\d\d)\./)[1].replace(/,/g, ''));
            expect(cents(amount)).toBeLessThan(cents(lowest));
            const atLowest = amountReceivedEffect({ ...args, amount: lowest, kind: 'correction' });
            expect([null, 'That is already the amount received on this invoice.']).toContain(atLowest.problem);
          }
          continue;
        }
        const done = receive(args);
        const held = cents(done.notes.filter((c) => c.status === 'issued' && c.refund_status !== 'none').reduce((s, c) => s + Number(c.refund_due), 0));
        // Everything overpaid is on a note or reported as not on one.
        expect(held + cents(effect.not_on_a_credit_note)).toBe(cents(effect.overpaid));
        expect(held).toBeGreaterThanOrEqual(fixed);
        expect(effect.not_on_a_credit_note).toBe(overpaidNotOnCredit(done.invoice, done.notes));
        expect(effect.balance_due).toBe(balanceDue(done.invoice));
        expect(done.invoice.status === 'paid').toBe(balanceDue(done.invoice) === 0);
        expect(amountPaid(done.invoice)).toBe(effect.amount_paid);
        for (const c of done.notes) {
          expect(Number(c.refund_due)).toBeLessThanOrEqual(Number(c.total));
          expect(creditAvailable(c)).toBeGreaterThanOrEqual(0);
          const want = c.status === 'cancelled' ? 'Cancelled' : creditAvailable(c) > 0 ? (c.amount_allocated > 0 ? 'Part used' : 'Available')
            : c.refund_status === 'refunded' ? 'Refunded' : c.amount_allocated > 0 ? 'Used' : 'Issued';
          expect(creditNoteStatusKind(c)).toBe(want);
        }
        invoice = done.invoice;
        notes = done.notes;
      }
    }
  });
});

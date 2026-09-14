import { describe, it, expect } from 'vitest';
import {
  lineNet, lineTax, creditTotals, creditableLeft, balanceDue, creditState, canRaiseCredit,
  linesFromInvoice, validateCredit, refundFor, creditNoteLabel, creditNoteStatusLabel,
  issuedTotal, amountPaid, taxRatesFor, MAX_LINES,
  lineCreditLeft, creditIssueDate, cancelCreditEffect, overpaidNotOnCredit,
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
  it('labels the chip from status and refund', () => {
    expect(creditNoteStatusLabel({ status: 'issued', refund_status: 'none' })).toBe('Issued');
    expect(creditNoteStatusLabel({ status: 'issued', refund_status: 'owed' })).toBe('Refund owed');
    expect(creditNoteStatusLabel({ status: 'issued', refund_status: 'refunded' })).toBe('Refunded');
    expect(creditNoteStatusLabel({ status: 'cancelled', refund_status: 'none' })).toBe('Cancelled');
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

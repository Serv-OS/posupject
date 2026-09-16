/* Credit notes: the sums and the rules, shared by the raise screen, the
 * invoice lists, the reports and the PDF. This file is identical in posupject
 * and posupcrm; currency never enters the maths, so nothing here differs (the
 * apply screen's check that a credit note and an invoice share a currency
 * only runs when both rows carry one, as posupject's do).
 *
 * THE ROUNDING RULE
 * An invoice never rounds a line. InvoiceBuilder and invoice-recurring add up
 * qty x unit_price for the subtotal and qty x unit_price x tax_rate / 100 for
 * the tax, and store the sums as they come: 3 x 33.33 at 20% is saved as a
 * total of 119.988 and only becomes £119.99 when it is shown. A credit note is
 * stored in pennies, so it does the same sums and rounds ONCE, at the end:
 *   tax_amount = the lines' tax added up, to the penny
 *   total      = the lines' net plus tax added up, to the penny
 *   subtotal   = total - tax_amount
 * Rounding each line first (as money.js lineTotals does for expenses) would
 * make a credit for a whole invoice come out more than the invoice: three
 * lines of 1 x 0.03 at 20% total 0.11 on the invoice but 0.12 line by line, and
 * the database would refuse the full credit.
 *
 * "To the penny" means rounded to 6 places first, then to 2, half up. The 6
 * places wash out the float noise the browser leaves in figures it stored
 * (1.5 x 100.01 was saved as 150.01500000000001, which is really 150.015 and
 * shows as £150.02). What is left to credit on an invoice is rounded the same
 * way, so crediting every line of an invoice always comes to exactly what is
 * left, and the invoice then reads as fully credited.
 *
 * WHY BIGINT
 * The database function issue_credit_note (in the credit notes migration) does
 * these sums in exact decimals and has the final say. Doing them here in
 * floats would disagree with it by a penny at exactly half a penny: 0.5 x
 * 2469.99 is 1234.995, which rounds to 1235.00 in the database but to 1234.99
 * in floats. The raise screen would then show one total and store another, or
 * pass a credit the database refuses. So every sum below is done on exact
 * decimals held as BigInts, and only turned back into a Number at the end.
 *
 * APPLYING CREDIT TO ANOTHER INVOICE
 * When money already taken on an invoice is more than it asks for after a
 * credit, the credit note has credit available (refund_due less what has been
 * applied less what has been refunded). That can be refunded, or applied to
 * another invoice of the customer's (allocate_credit in the credit allocations
 * migration). Applied credit is a settlement, not revenue and not cash:
 *   an invoice's balance due is total - amount_paid - amount_credited -
 *   amount_allocated, never below 0, in pennies, and amount_paid stays the
 *   cash actually received;
 *   what has SETTLED an invoice is amount_paid + amount_allocated, and that is
 *   what every refund sum compares with what the invoice asks for.
 * The functions below make the same checks, in the same order and with the
 * same words, as allocate_credit, remove_credit_allocation and the credit note
 * functions, so a screen can show a problem before the database refuses it.
 *
 * THE AMOUNT RECEIVED
 * The cash on an invoice is changed through one database function,
 * set_invoice_amount_received (the amount received migration), for both a
 * correction (Change: the total the customer has paid) and a payment (Mark
 * paid: this payment added to the cash already received, markPaymentTotal).
 * Whatever has settled the invoice beyond what it asks for is held by its
 * credit notes as refund_due, so correcting the cash moves credit to use onto
 * or off them. amountReceivedEffect does the same sums, in the same order and
 * with the same words, so the sheet can show what will happen first. Card
 * payments still go through record_invoice_payment. paid_at is the day money
 * came in, which Collected counts on: it stays while there is cash on the
 * invoice, even when a correction reopens it.
 *
 * Pure on purpose: no React, no Supabase, so it can be tested against the
 * invoice maths.
 */

export const CREDITABLE_STATUSES = ['sent', 'viewed', 'paid'];
export const REFUND_METHODS = ['Bank transfer', 'Card refund', 'Other'];
export const REASON_MIN = 3;
export const REASON_MAX = 500;
export const MAX_LINES = 100;
/** The invoices credit can be applied to (with a balance due above 0). */
export const ALLOCATABLE_STATUSES = ['sent', 'viewed'];
/** The longest note on applied credit, in characters. */
export const ALLOCATION_NOTE_MAX = 500;

// ── Exact decimals ──────────────────────────────────────────────────────────
// A decimal is { n, s }: the value n / 10^s, with n a BigInt. BigInt() calls
// rather than 10n literals keep this readable by any bundler target.
const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const TEN = BigInt(10);
const DZERO = { n: ZERO, s: 0 };
const pow10 = (k) => TEN ** BigInt(k);

// The same shapes of number the database function accepts (its c_number
// pattern): digits with an optional point and a short exponent. A blank, "abc",
// NaN or Infinity is not a number to either side.
const NUMBER_TEXT = /^\s*([+-]?)(?:(\d+)\.?(\d*)|\.(\d+))(?:[eE]([+-]?\d{1,3}))?\s*$/;

// A JS number is read through String(), which is exactly the text JSON.stringify
// sends to the database, so both sides start from the same decimal.
function toDec(v) {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    v = String(v);
  }
  if (typeof v !== 'string') return null;
  const m = v.match(NUMBER_TEXT);
  if (!m) return null;
  const [, sign, whole = '', fracA, fracB, exp = '0'] = m;
  const frac = fracA ?? fracB ?? '';
  let s = frac.length - Number(exp);
  let n = BigInt(`${sign === '-' ? '-' : ''}${whole}${frac}`);
  if (s < 0) { n *= pow10(-s); s = 0; }
  return { n, s };
}
const decOr0 = (v) => toDec(v) ?? DZERO;
const at = (a, s) => a.n * pow10(s - a.s);
const add = (a, b) => { const s = Math.max(a.s, b.s); return { n: at(a, s) + at(b, s), s }; };
const sub = (a, b) => add(a, { n: -b.n, s: b.s });
const mul = (a, b) => ({ n: a.n * b.n, s: a.s + b.s });
const cmp = (a, b) => { const s = Math.max(a.s, b.s); const x = at(a, s), y = at(b, s); return x < y ? -1 : x > y ? 1 : 0; };
const isPos = (a) => a.n > ZERO;
const max0 = (a) => (isPos(a) ? a : DZERO);
const minDec = (a, b) => (cmp(a, b) <= 0 ? a : b);
// One text per value, so 20, 20.0 and 20.00 are the same rate as a map key.
function decKey(a) {
  let { n, s } = a;
  while (s > 0 && n % TEN === ZERO) { n /= TEN; s -= 1; }
  return `${n}e${s}`;
}
// a / b to dp places, rounded down, or null when b is not above 0.
function divDown(a, b, dp) {
  if (!isPos(b)) return null;
  // (a.n / 10^a.s) / (b.n / 10^b.s) = a.n * 10^(b.s + dp) / (b.n * 10^a.s), in 10^-dp units.
  const top = a.n * pow10(b.s + dp);
  const bottom = b.n * pow10(a.s);
  return { n: top / bottom, s: dp, exact: top % bottom === ZERO };
}

// Half away from zero, which is what Postgres round(numeric, dp) does.
function roundTo(a, dp) {
  if (a.s <= dp) return { n: at(a, dp), s: dp };
  const f = pow10(a.s - dp);
  const neg = a.n < ZERO;
  const abs = neg ? -a.n : a.n;
  let q = abs / f;
  if ((abs % f) * TWO >= f) q += ONE;
  return { n: neg ? -q : q, s: dp };
}
// The rule above: 6 places to wash out float noise, then the penny.
const toPennies = (a) => roundTo(roundTo(a, 6), 2);

function toNumber(a) {
  const neg = a.n < ZERO;
  const digits = (neg ? -a.n : a.n).toString().padStart(a.s + 1, '0');
  const cut = digits.length - a.s;
  // `|| 0` so a zero never comes back as -0.
  return Number(`${neg ? '-' : ''}${digits.slice(0, cut)}.${digits.slice(cut) || '0'}`) || 0;
}

// ── Lines ───────────────────────────────────────────────────────────────────
// A missing tax rate is 0, as it is on an invoice line and in the database.
const rateDec = (line) => (line?.tax_rate == null ? DZERO : decOr0(line.tax_rate));
const netDec = (line) => mul(decOr0(line?.qty), decOr0(line?.unit_price));
// x 0.01 rather than / 100: the database multiplies too, because numeric
// division rounds to a chosen number of places and multiplication is exact.
const taxDec = (line) => mul(mul(netDec(line), rateDec(line)), { n: ONE, s: 2 });

/** qty x unit_price, NOT rounded, exactly as an invoice line. */
export const lineNet = (line) => toNumber(netDec(line));

/** qty x unit_price x tax_rate / 100, NOT rounded, exactly as an invoice line. */
export const lineTax = (line) => toNumber(taxDec(line));

function totalsDec(lines) {
  let net = DZERO, tax = DZERO;
  for (const l of lines || []) { net = add(net, netDec(l)); tax = add(tax, taxDec(l)); }
  const taxP = toPennies(tax);
  const totalP = toPennies(add(net, tax));
  return { subtotal: sub(totalP, taxP), tax: taxP, total: totalP };
}

/** { subtotal, tax_amount, total } in pennies, by the rule at the top. */
export function creditTotals(lines = []) {
  const t = totalsDec(lines);
  return { subtotal: toNumber(t.subtotal), tax_amount: toNumber(t.tax), total: toNumber(t.total) };
}

// ── The invoice ─────────────────────────────────────────────────────────────
// Credit applied to this invoice from other invoices' credit notes.
const allocatedDec = (invoice) => decOr0(invoice?.amount_allocated);

// The CASH taken on the invoice. A paid invoice with no amount_paid was paid in
// full: the invoice screens already show it that way (amount_paid ?? total),
// and without this a credit on one of those would never see that a refund is
// owed. In full means whatever credit applied to it did not settle; cash did.
// The database reads it the same way: coalesce(amount_paid, case when status
// = 'paid' then greatest(0, total - amount_allocated) else 0 end).
function paidDec(invoice) {
  if (invoice?.amount_paid != null && invoice.amount_paid !== '') return decOr0(invoice.amount_paid);
  return invoice?.status === 'paid' ? max0(sub(decOr0(invoice.total), allocatedDec(invoice))) : DZERO;
}
// What has settled the invoice: cash plus credit applied to it, in pennies.
const settledDec = (invoice) => add(toPennies(paidDec(invoice)), toPennies(allocatedDec(invoice)));
const leftDec = (invoice) => toPennies(sub(decOr0(invoice?.total), decOr0(invoice?.amount_credited)));
const balanceDec = (invoice) => max0(toPennies(sub(sub(sub(decOr0(invoice?.total), paidDec(invoice)),
  decOr0(invoice?.amount_credited)), allocatedDec(invoice))));

/**
 * The cash paid, in pennies (a paid invoice with no amount_paid counts as paid
 * in full). Credit applied from another invoice is not cash and is not in here.
 */
export const amountPaid = (invoice) => toNumber(toPennies(paidDec(invoice)));

/** What has settled the invoice: cash paid plus credit applied to it, in pennies. */
export const settledAmount = (invoice) => toNumber(settledDec(invoice));

/** What can still be credited: total less issued credit notes. Can be 0. */
export const creditableLeft = (invoice) => toNumber(leftDec(invoice));

/**
 * What the customer still owes: total less cash paid, less credit notes on it,
 * less credit applied to it from other invoices, never below 0.
 */
export const balanceDue = (invoice) => toNumber(balanceDec(invoice));

/**
 * What Mark paid records as amount_paid: the cash already taken plus the
 * balance due, so credit notes and applied credit are never counted as cash.
 * An invoice of 1,000 with 224 of credit applied records 776.
 */
export const markPaidAmount = (invoice) => toNumber(add(toPennies(paidDec(invoice)), balanceDec(invoice)));

/**
 * 'none' | 'part' | 'full'. Full exactly when nothing is left to credit, so it
 * always agrees with canRaiseCredit and with the database's own limit.
 */
export function creditState(invoice) {
  if (!isPos(decOr0(invoice?.amount_credited))) return 'none';
  return isPos(leftDec(invoice)) ? 'part' : 'full';
}

/** Sent, viewed (so overdue too) or paid, with something left to credit. */
export const canRaiseCredit = (invoice) =>
  !!invoice && CREDITABLE_STATUSES.includes(invoice.status) && isPos(leftDec(invoice));

// ── What earlier credit notes used ──────────────────────────────────────────
// creditedLines are the lines of the invoice's ISSUED credit notes (cancelled
// ones credit nothing). A line is only ever credited once in full: the net
// (qty x unit_price) credited against an invoice line, over every issued note,
// can never pass that line's own net. And at each tax rate above 0 the net
// credited can never pass the net the invoice charged at that rate, so the tax
// handed back never passes the tax charged. Without these a second credit note
// could credit the same line, and its VAT, all over again while the total
// still fitted what was left.
function usedByLine(creditedLines) {
  const map = new Map();
  for (const l of creditedLines || []) {
    if (!l?.invoice_line_id) continue;
    map.set(l.invoice_line_id, add(map.get(l.invoice_line_id) ?? DZERO, netDec(l)));
  }
  return map;
}
function netByRate(lines) {
  const map = new Map();
  for (const l of lines || []) {
    const key = decKey(rateDec(l));
    map.set(key, add(map.get(key) ?? DZERO, netDec(l)));
  }
  return map;
}
// Compared at 6 places, the same float wash as the rule at the top.
const moreThan = (a, b) => cmp(roundTo(a, 6), roundTo(b, 6)) > 0;

/** Net (before tax) still left to credit on one invoice line, never below 0. */
export function lineCreditLeft(invoiceLine, creditedLines = []) {
  if (!invoiceLine) return 0;
  const used = usedByLine(creditedLines).get(invoiceLine.id) ?? DZERO;
  return toNumber(max0(sub(netDec(invoiceLine), used)));
}

/**
 * The invoice's lines as the raise screen starts them: each line at what is
 * still left on it after earlier credit notes (every line at full value when
 * there are none), and a line credited in full is left out. A part credited
 * line keeps its unit price when what is left is a whole number of units (or
 * to 2 places, as 2 of 3 terminals), and otherwise becomes 1 at the amount
 * left, so it never reads as more than the invoice line.
 */
export const linesFromInvoice = (invoiceLines = [], creditedLines = []) => {
  const used = usedByLine(creditedLines);
  return [...(invoiceLines || [])]
    .sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0))
    .flatMap((l) => {
      const line = {
        invoice_line_id: l.id ?? null,
        name: l.name || '',
        description: l.description || '',
        qty: Number(l.qty) || 0,
        unit_price: Number(l.unit_price) || 0,
        tax_rate: Number(l.tax_rate) || 0,
      };
      const done = l.id != null ? used.get(l.id) : null;
      if (!done || !isPos(done)) return [line];
      const left = sub(netDec(l), done);
      if (!isPos(left)) return [];
      const units = divDown(left, decOr0(l.unit_price), 2);
      if (units?.exact) return [{ ...line, qty: toNumber(units) }];
      const qty = decOr0(l.qty);
      if (cmp(qty, { n: ONE, s: 0 }) >= 0) return [{ ...line, qty: 1, unit_price: toNumber(left) }];
      return [{ ...line, unit_price: toNumber(divDown(left, qty, 6) ?? DZERO) }];
    });
};

/**
 * The tax rates a credit line may carry: 0, or what the invoice charged. A
 * line copied from the invoice may only keep its own rate or drop to 0; a
 * free line (a goodwill credit) may use 0 or any rate on the invoice. An
 * invoice with no lines at all falls back to its header rate. Crediting tax
 * the invoice never charged would hand back VAT that was never paid.
 */
export function taxRatesFor({ line = {}, invoiceLines = [], invoice = null } = {}) {
  const rateOf = (l) => Number(l?.tax_rate) || 0;
  const list = invoiceLines || [];
  let rates;
  if (line?.invoice_line_id) {
    const src = list.find((l) => l.id === line.invoice_line_id);
    rates = src ? [rateOf(src)] : [];
  } else if (list.length) {
    rates = list.map(rateOf);
  } else {
    rates = [Number(invoice?.tax_rate) || 0];
  }
  return [...new Set([0, ...rates])].sort((a, b) => a - b);
}

// A number typed as a name or reason is still text to the database (->> reads it as text).
const trimmed = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');

// 'YYYY-MM-DD' plus one day, worked in UTC so no clock change can skip a day.
function nextDay(day) {
  const d = new Date(`${String(day).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * The day a new credit note is dated: today, or the invoice's own issue date
 * when that is later (an invoice made in the evening in the US carries the
 * next UTC day). A credit note is never dated before the invoice it credits.
 */
export function creditIssueDate(invoice, today) {
  const inv = invoice?.issue_date ? String(invoice.issue_date).slice(0, 10) : '';
  return inv && inv > today ? inv : today;
}

/**
 * Every problem with a credit, in plain words; [] when it can be issued. The
 * same checks, in the same order and with the same wording, as
 * issue_credit_note, which raises the first one it finds. Pass invoiceLines
 * (the invoice's saved lines) to include the "is this line on the invoice",
 * tax rate and "is anything left on this line" checks, with creditedLines (the
 * lines of the invoice's issued credit notes) so earlier credits count; without
 * invoiceLines only the rate being 0 or more is checked. Pass issueDate (and
 * today, the caller's own date) to check the date the note will carry.
 */
export function validateCredit({ invoice, lines, reason, invoiceLines, creditedLines = [], issueDate, today } = {}) {
  if (!invoice) return ['Invoice not found.'];
  const problems = [];
  if (invoice.status === 'draft') problems.push('A draft invoice cannot be credited. Edit the invoice instead.');
  else if (!CREDITABLE_STATUSES.includes(invoice.status)) problems.push('Only a sent, viewed or paid invoice can be credited.');

  // A credit lands in the period of its own date, so a stray one would change
  // a VAT quarter already filed. A day of slack for the future, as for a
  // refund date: the caller's today can be ahead of the database's in UTC.
  if (issueDate) {
    const day = String(issueDate).slice(0, 10);
    if (invoice.issue_date && day < String(invoice.issue_date).slice(0, 10)) {
      problems.push('A credit note cannot be dated before the invoice it credits.');
    } else if (today && day > nextDay(today)) {
      problems.push('A credit note cannot be dated in the future.');
    }
  }

  // Counted in characters, not UTF-16 units, as the database counts them.
  const reasonLength = [...trimmed(reason)].length;
  if (reasonLength < REASON_MIN || reasonLength > REASON_MAX) {
    problems.push(`Give a reason of ${REASON_MIN} to ${REASON_MAX} characters.`);
  }

  const list = Array.isArray(lines) ? lines : [];
  if (!list.length) { problems.push('Add at least one line to credit.'); return problems; }
  if (list.length > MAX_LINES) problems.push(`A credit note can have at most ${MAX_LINES} lines.`);

  // Running totals, so two lines of one note on the same invoice line add up.
  const lineUsed = usedByLine(creditedLines);
  const rateUsed = netByRate(creditedLines);
  const rateCharged = invoiceLines ? netByRate(invoiceLines) : new Map();
  list.forEach((l, i) => {
    const no = i + 1;
    if (!trimmed(l?.name)) problems.push(`Line ${no} needs a name.`);
    const qty = toDec(l?.qty);
    if (!qty || !isPos(qty)) problems.push(`Line ${no}: the quantity must be more than 0.`);
    const price = toDec(l?.unit_price);
    if (!price || price.n < ZERO) problems.push(`Line ${no}: the unit price must be 0 or more.`);
    const rate = l?.tax_rate == null ? DZERO : toDec(l.tax_rate);
    if (!rate || rate.n < ZERO) { problems.push(`Line ${no}: the tax rate must be 0 or more.`); return; }
    if (!invoiceLines) return;
    const src = l?.invoice_line_id ? invoiceLines.find((s) => s.id === l.invoice_line_id) : null;
    if (l?.invoice_line_id && !src) {
      problems.push(`Line ${no} is not on this invoice.`);
      return;
    }
    const allowed = taxRatesFor({ line: l, invoiceLines, invoice });
    if (!allowed.some((r) => cmp(decOr0(r), rate) === 0)) {
      problems.push(`Line ${no}: the tax rate can only be 0 or the rate on the invoice.`);
      return;
    }
    const net = qty && price ? netDec(l) : DZERO;
    if (src) {
      const used = add(lineUsed.get(src.id) ?? DZERO, net);
      lineUsed.set(src.id, used);
      if (moreThan(used, netDec(src))) { problems.push(`Line ${no}: more than is left to credit on this line.`); return; }
    }
    // An invoice with no lines only has its header rate, and the total limit.
    if (isPos(rate) && invoiceLines.length) {
      const key = decKey(rate);
      const used = add(rateUsed.get(key) ?? DZERO, net);
      rateUsed.set(key, used);
      if (moreThan(used, rateCharged.get(key) ?? DZERO)) problems.push(`Line ${no}: more than is left to credit at ${toNumber(rate)}%.`);
    }
  });

  const { total } = totalsDec(list);
  if (!isPos(total)) problems.push('The credit must be more than 0.');
  else if (cmp(total, leftDec(invoice)) > 0) problems.push('This credit is more than is left on the invoice.');
  return problems;
}

// What the invoice asks for once `credited` is taken off, in pennies, never
// below 0: the figure balanceDue and "left to credit" start from. Worked out in
// pennies first, then compared with what was paid, because the total is stored
// unrounded: a full credit of 682.63 on 682.625 left would otherwise leave half
// a penny that rounds up into a refund of 0.01 on an invoice nobody paid.
const askedAfter = (invoice, credited) => max0(toPennies(sub(decOr0(invoice?.total), credited)));
// Settled (cash plus credit applied to it) beyond that, in pennies. Can be
// below 0.
const paidBeyond = (invoice, credited) => sub(settledDec(invoice), askedAfter(invoice, credited));

/**
 * Whether issuing this credit leaves money to hand back. After the credit the
 * invoice asks for total - amount_credited - creditTotal; anything that has
 * already settled it (cash, and credit applied from another invoice) beyond
 * that is credit available on the new note, but never more than the credit
 * itself.
 */
export function refundFor({ invoice, creditTotal } = {}) {
  const credit = toPennies(decOr0(creditTotal));
  const excess = paidBeyond(invoice, add(decOr0(invoice?.amount_credited), credit));
  if (!isPos(credit) || !isPos(excess)) return { refund_status: 'none', refund_due: 0 };
  return { refund_status: 'owed', refund_due: toNumber(cmp(excess, credit) < 0 ? excess : credit) };
}

// What a note holds of the money beyond what its invoice asks for: owed back,
// applied to another invoice, or refunded. All of it is in refund_due.
const refundOnNote = (c) => (c?.status === 'issued' && ['owed', 'allocated', 'refunded'].includes(c.refund_status) ? decOr0(c.refund_due) : DZERO);

// ── What a credit note's credit has been used for ───────────────────────────
// refund_due is all the money the note hands back. Of that, amount_allocated
// has been applied to other invoices and refunded_amount refunded; the rest is
// credit available. A note refunded before refunded_amount existed had its
// whole refund_due refunded (the migration copies it across).
const noteAllocatedDec = (note) => decOr0(note?.amount_allocated);
function refundedDec(note) {
  if (note?.refunded_amount != null && note.refunded_amount !== '') return decOr0(note.refunded_amount);
  return note?.refund_status === 'refunded' ? max0(sub(decOr0(note.refund_due), noteAllocatedDec(note))) : DZERO;
}
// Only an issued note with a refund owed has any; never below 0.
function availableDec(note) {
  if (note?.status !== 'issued' || note.refund_status !== 'owed') return DZERO;
  return max0(toPennies(sub(sub(decOr0(note.refund_due), noteAllocatedDec(note)), refundedDec(note))));
}
// The refund_status a note has once its credit available is `left`.
const statusWithLeft = (note, left) => (isPos(left) ? 'owed' : isPos(refundedDec(note)) ? 'refunded' : isPos(noteAllocatedDec(note)) ? 'allocated' : 'none');

// When less of an invoice's settlement is beyond what it asks for (a credit
// note cancelled, or credit applied to it removed), what its issued notes hand
// back comes down to `allowed`. Refunds already paid and credit already applied
// cannot come down: { problem: 'refunded' } when refunds alone are more than
// allowed, { problem: 'used' } when refunds and applied credit are. Otherwise
// the credit available on the notes shrinks, oldest keeping theirs first so
// the newest lose theirs first, and refunds lists the notes that change as
// [{ id, refund_status, refund_due }]. cancel_credit_note and
// remove_credit_allocation do the same, in the same order.
function fitRefunds(notes, allowed) {
  const refunded = notes.reduce((s, c) => add(s, refundedDec(c)), DZERO);
  if (cmp(refunded, allowed) > 0) return { problem: 'refunded' };
  const fixed = notes.reduce((s, c) => add(s, noteAllocatedDec(c)), refunded);
  if (cmp(fixed, allowed) > 0) return { problem: 'used' };
  let budget = sub(allowed, fixed);
  const refunds = [];
  notes.filter((c) => c.refund_status === 'owed')
    .sort((a, b) => (Number(a.credit_number) || 0) - (Number(b.credit_number) || 0))
    .forEach((c) => {
      const held = add(noteAllocatedDec(c), refundedDec(c));
      const extra = sub(decOr0(c.refund_due), held);
      const keep = minDec(extra, max0(budget));
      budget = sub(budget, keep);
      if (cmp(keep, extra) !== 0) refunds.push({ id: c.id, refund_status: statusWithLeft(c, keep), refund_due: toNumber(add(held, keep)) });
    });
  return { problem: null, refunds };
}

/**
 * What cancelling a credit note does, by the same rules and in the same order
 * as cancel_credit_note, so the Cancel screen can say it before anyone presses
 * it and the harness can do it. notes are all the invoice's credit notes.
 *
 * Returns { problem } when the database would refuse, otherwise:
 *   amount_credited  the invoice's credit once this note is gone
 *   reopen           true when a PAID invoice now asks for more than was paid:
 *                    it goes back to sent so the rest shows as owed and the
 *                    pay link charges it
 *   balance_due      what the customer owes afterwards
 *   refunds          [{ id, refund_status, refund_due }] for the other notes
 *                    whose credit available shrinks, because with less credit
 *                    less of what settled the invoice is owed back. The newest
 *                    lose theirs first. A refund already paid, or credit
 *                    already applied to another invoice, cannot shrink, so
 *                    when those come to more than is now owed back, the
 *                    cancel is refused.
 * A note that has been refunded, or whose credit is applied to an invoice, is
 * refused too. Pass reason to check it as the database does.
 */
export function cancelCreditEffect({ invoice, notes = [], noteId, reason } = {}) {
  const note = (notes || []).find((c) => c?.id === noteId);
  if (!note) return { problem: 'Credit note not found.' };
  if (note.status === 'cancelled') return { problem: 'This credit note is already cancelled.' };
  if (note.refund_status === 'refunded' || isPos(refundedDec(note))) return { problem: 'This credit has already been refunded.' };
  if (isPos(noteAllocatedDec(note))) return { problem: 'Remove the credit applied from this note first.' };
  if (reason !== undefined) {
    const length = [...trimmed(reason)].length;
    if (length < REASON_MIN || length > REASON_MAX) return { problem: `Give a reason of ${REASON_MIN} to ${REASON_MAX} characters.` };
  }

  const others = (notes || []).filter((c) => c?.status === 'issued' && c.id !== noteId);
  const credited = others.reduce((s, c) => add(s, decOr0(c.total)), DZERO);
  const fit = fitRefunds(others, max0(paidBeyond(invoice, credited)));
  if (fit.problem === 'refunded') {
    return { problem: 'A refund has already been paid on this invoice. Without this credit it would be more than the customer overpaid, so this credit cannot be cancelled.' };
  }
  if (fit.problem === 'used') {
    return { problem: 'Credit from another credit note on this invoice has already been used on an invoice. Without this credit it would be more than the customer overpaid, so this credit cannot be cancelled.' };
  }
  const { refunds } = fit;

  const after = { ...invoice, amount_credited: toNumber(credited) };
  const balance = balanceDue(after);
  const reopen = invoice?.status === 'paid' && balance > 0;
  return { problem: null, amount_credited: after.amount_credited, reopen, balance_due: balance, refunds };
}

/**
 * Money taken on an invoice beyond what it now asks for that no credit note
 * records as a refund owed or made: a card payment that landed after a credit
 * was issued on the open pay page, or an invoice paid twice. notes are the
 * invoice's credit notes. 0 when nothing is unaccounted for.
 */
export function overpaidNotOnCredit(invoice, notes = []) {
  const excess = paidBeyond(invoice, decOr0(invoice?.amount_credited));
  const onNotes = (notes || []).reduce((s, c) => add(s, refundOnNote(c)), DZERO);
  return toNumber(max0(sub(excess, onNotes)));
}

// ── Credit notes ────────────────────────────────────────────────────────────
/** CN-1001, from a number or a credit note row. */
export const creditNoteLabel = (n) => {
  const num = n != null && typeof n === 'object' ? n.credit_number : n;
  return num == null || num === '' ? '' : `CN-${num}`;
};

/**
 * A fixed word for the kind of status a credit note has, for keying chip
 * colours and list filters (the label itself carries amounts and invoice
 * numbers): Issued (it only reduced its own invoice), Available (credit to
 * use, none of it used yet), Part used (some applied to an invoice, some
 * left), Used (all applied), Refunded (what was left refunded, whether or not
 * some was used first) or Cancelled.
 */
export const creditNoteStatusKind = (note) => {
  if (note?.status === 'cancelled') return 'Cancelled';
  if (note?.refund_status === 'owed') return isPos(noteAllocatedDec(note)) ? 'Part used' : 'Available';
  if (note?.refund_status === 'allocated') return 'Used';
  if (note?.refund_status === 'refunded') return 'Refunded';
  return 'Issued';
};

// Pennies as the database's to_char(x, 'FM999,999,999,990.00') writes them:
// 1,344.00, 0.50. Worked on the exact decimal, so no float can round it.
function moneyDigits(a) {
  const p = toPennies(a);
  const neg = p.n < ZERO;
  const digits = (neg ? -p.n : p.n).toString().padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${whole}.${digits.slice(-2)}`;
}
// £ unless the row says USD: posupcrm rows carry no currency and are pounds.
const currencySign = (currency) => (currency === 'USD' ? '$' : '£');
const moneyText = (a, currency) => `${currencySign(currency)}${moneyDigits(a)}`;

// INV-1050 from a number, 'INV-1050', an invoice row or a row holding one
// ({ invoice: { invoice_number } }, as the lists load it).
function invoiceRef(v) {
  const n = v != null && typeof v === 'object' ? (v.invoice_number ?? v.invoice?.invoice_number) : v;
  if (n == null || n === '') return null;
  return String(n).startsWith('INV-') ? String(n) : `INV-${n}`;
}
// "INV-1050", "INV-1050 and INV-1051", "INV-1050, INV-1051 and INV-1052".
function joinRefs(refs) {
  const list = [...new Set(refs.filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  if (list.length <= 1) return list[0] || '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/**
 * What a credit note's status says, in plain words:
 *   issued with nothing owed  "Used on INV-1036": it reduced its own
 *                             invoice's balance
 *   credit to use             "£224.00 to use", or when part has gone
 *                             "£100.00 used, £124.00 to use" (and
 *                             "£124.00 refunded" when a refund came first)
 *   all applied               "Used on INV-1050", every invoice it went to
 *   Refunded, Cancelled       as they were
 * options (all optional):
 *   invoiceNumber  the note's own invoice number; otherwise read from
 *                  note.invoice.invoice_number or note.invoice_number
 *   usedOn         the invoices its credit was applied to: numbers, 'INV-'
 *                  texts, invoice rows or allocation rows carrying
 *                  invoice.invoice_number (removed ones are skipped);
 *                  otherwise note.used_on
 *   money          (amount, currency) => text, to format as the screen does;
 *                  otherwise £ (or $ for a USD note) with 2 places
 * Chip colours and filters key on creditNoteStatusKind, which never changes.
 */
export function creditNoteStatusLabel(note, { invoiceNumber, usedOn, money } = {}) {
  const kind = creditNoteStatusKind(note);
  if (kind === 'Cancelled' || kind === 'Refunded') return kind;
  const fmt = (n) => (typeof money === 'function' ? money(n, note?.currency) : moneyText(decOr0(n), note?.currency));
  if (kind === 'Available' || kind === 'Part used') {
    // The figures creditUse gives, worked out here so nothing is used before it is defined.
    const used = toPennies(noteAllocatedDec(note)), refunded = toPennies(refundedDec(note));
    return [isPos(used) ? `${fmt(toNumber(used))} used` : null, isPos(refunded) ? `${fmt(toNumber(refunded))} refunded` : null,
      `${fmt(toNumber(availableDec(note)))} to use`].filter(Boolean).join(', ');
  }
  if (kind === 'Used') {
    const rows = (usedOn ?? note?.used_on ?? []).filter((r) => !(r && typeof r === 'object' && r.removed_at));
    const refs = joinRefs(rows.map(invoiceRef));
    return refs ? `Used on ${refs}` : 'Used on another invoice';
  }
  const own = invoiceRef(invoiceNumber ?? note?.invoice?.invoice_number ?? note?.invoice_number);
  return own ? `Used on ${own}` : 'Used on its invoice';
}

/**
 * Why Mark refunded would be refused, by the same checks, in the same order
 * and with the same words as mark_credit_note_refunded; null when it can be
 * marked. Pass method to check it too (the form checks the date and note).
 * A note holds one refund: its date, method and note are single fields that
 * the reports read by date, so a note that already has a refund on it (it
 * owes again only once credit applied from it is removed) is refused, and
 * what it has left can be applied to an invoice instead.
 */
export function refundProblem({ note, method } = {}) {
  if (!note) return 'Credit note not found.';
  if (note.status !== 'issued') return 'This credit note is cancelled.';
  if (note.refund_status === 'refunded') return 'This refund is already marked as refunded.';
  if (note.refund_status === 'allocated') return 'All of this credit has been used on invoices, so there is nothing left to refund.';
  if (isPos(refundedDec(note))) return 'A refund has already been marked on this credit note, and a second one cannot be recorded. Apply the credit left to an invoice instead.';
  if (note.refund_status !== 'owed' || !isPos(availableDec(note))) return 'There is no refund owed on this credit note.';
  if (method !== undefined && !REFUND_METHODS.includes(method)) return `Choose how it was refunded: ${REFUND_METHODS.slice(0, -1).join(', ')} or ${REFUND_METHODS[REFUND_METHODS.length - 1]}.`;
  return null;
}

/** Sum of the totals of the issued notes in a list; cancelled notes count for nothing. */
export const issuedTotal = (notes = []) =>
  toNumber((notes || []).filter((c) => c?.status === 'issued').reduce((s, c) => add(s, decOr0(c.total)), DZERO));

// ── Applying credit to another invoice ──────────────────────────────────────
/**
 * Credit available on a credit note: refund_due less what has been applied to
 * invoices less what has been refunded, in pennies, never below 0. Only an
 * issued note with a refund owed has any; a cancelled note has none.
 */
export const creditAvailable = (note) => toNumber(availableDec(note));

/**
 * How a note's credit has been used, in pennies: { used } applied to invoices,
 * { refunded } handed back, { left } still available. Enough for "£100 used,
 * £124 left" and "Used £100, refunded £124".
 */
export const creditUse = (note) => ({
  used: toNumber(toPennies(noteAllocatedDec(note))),
  refunded: toNumber(toPennies(refundedDec(note))),
  left: creditAvailable(note),
});

/**
 * Credit available across a customer's credit notes. Pass currency (posupject)
 * to add up only the notes in that currency; without it every note counts.
 */
export const companyCreditAvailable = (notes = [], currency) =>
  toNumber((notes || [])
    .filter((c) => currency == null || c?.currency === currency)
    .reduce((s, c) => add(s, availableDec(c)), DZERO));

/** What the apply screen starts the amount at: the credit available or the balance due, whichever is less. */
export const allocationDefault = ({ note, invoice } = {}) => toNumber(minDec(availableDec(note), balanceDec(invoice)));

/**
 * Every problem with applying `amount` of a credit note's credit to an
 * invoice, in plain words; [] when it can be applied. The same checks, in the
 * same order and with the same wording, as allocate_credit, which raises the
 * first one it finds. note is the credit note, invoice the invoice it goes to,
 * allocationNote the optional note typed on the apply screen. The note's
 * invoice_id and both currencies (posupject) are checked when present.
 */
export function allocationProblems({ note, invoice, amount, allocationNote } = {}) {
  if (!note) return ['Credit note not found.'];
  if (!invoice) return ['Invoice not found.'];
  const problems = [];
  if (note.status !== 'issued') problems.push('This credit note is cancelled.');
  else if (!isPos(availableDec(note))) problems.push('There is no credit left to use on this credit note.');
  const noteOk = !problems.length;

  if (invoice.id != null && invoice.id === note.invoice_id) problems.push('Credit cannot be applied to the invoice it was raised on.');
  else if (!ALLOCATABLE_STATUSES.includes(invoice.status)) problems.push('Credit can only be applied to a sent or viewed invoice.');
  else if (note.currency != null && invoice.currency != null && note.currency !== invoice.currency) {
    problems.push('This invoice is in a different currency from the credit note.');
  } else if (!isPos(balanceDec(invoice))) problems.push('This invoice has nothing left to pay.');
  const invoiceOk = problems.length === (noteOk ? 0 : 1);

  // The amount is only held to a side that passed above, so the list never
  // says "more than the credit left" under "no credit left".
  const amt = toDec(amount);
  if (!amt || !isPos(amt)) problems.push('The amount must be more than 0.');
  // Whole pennies, after the same 6 place wash as the rounding rule.
  else if (cmp(roundTo(amt, 6), toPennies(amt)) !== 0) problems.push('The amount can have at most 2 decimal places.');
  else if (noteOk && cmp(toPennies(amt), availableDec(note)) > 0) problems.push('This is more than the credit left on this credit note.');
  else if (invoiceOk && cmp(toPennies(amt), balanceDec(invoice)) > 0) problems.push('This is more than is left to pay on this invoice.');

  // Counted in characters, not UTF-16 units, as the database counts them.
  if ([...trimmed(allocationNote)].length > ALLOCATION_NOTE_MAX) problems.push(`Keep the note to ${ALLOCATION_NOTE_MAX} characters or fewer.`);
  return problems;
}

/**
 * What applying the credit does, by the same sums as allocate_credit. Returns
 * { problem } when the database would refuse, otherwise:
 *   amount   what is applied, in pennies
 *   note     { amount_allocated, refund_status, credit_available } afterwards:
 *            'allocated' (Used) once nothing is left, 'owed' while some is
 *   invoice  { amount_allocated, balance_due, settles, status, amount_paid }:
 *            when nothing is left to pay it settles, becomes paid, and
 *            amount_paid is set to the cash actually received (0 if none)
 */
export function allocationEffect({ note, invoice, amount, allocationNote } = {}) {
  const problems = allocationProblems({ note, invoice, amount, allocationNote });
  if (problems.length) return { problem: problems[0] };
  const amt = toPennies(toDec(amount));
  const left = sub(availableDec(note), amt);
  const noteAfter = { ...note, amount_allocated: toNumber(add(noteAllocatedDec(note), amt)) };
  const after = { ...invoice, amount_allocated: toNumber(add(allocatedDec(invoice), amt)) };
  const settles = !isPos(balanceDec(after));
  return {
    problem: null,
    amount: toNumber(amt),
    note: { amount_allocated: noteAfter.amount_allocated, refund_status: statusWithLeft(noteAfter, left), credit_available: toNumber(left) },
    invoice: {
      amount_allocated: after.amount_allocated,
      balance_due: balanceDue(after),
      settles,
      status: settles ? 'paid' : invoice.status,
      amount_paid: settles ? toNumber(paidDec(invoice)) : invoice.amount_paid ?? null,
    },
  };
}

/**
 * What removing applied credit does, by the same rules and in the same order
 * as remove_credit_allocation (owner only; the screen checks the role).
 * allocation is the credit_allocations row, note its credit note, invoice the
 * invoice it was applied to and invoiceNotes that invoice's own credit notes.
 * Returns { problem } when the database would refuse, otherwise:
 *   note     { amount_allocated, refund_status, credit_available }: the credit
 *            is available again, so a Used or Refunded note goes back to owed
 *   invoice  { amount_allocated, balance_due, reopen, status }: a PAID invoice
 *            that now has a balance reopens as sent, with amount_paid kept as
 *            the cash received and paid_at kept as the day it came in (as a
 *            cancelled credit note leaves it), so that cash stays in Collected
 *            for its own month
 *   refunds  [{ id, refund_status, refund_due }] for the invoice's own credit
 *            notes whose credit available shrinks because less has settled
 *            the invoice (as cancelCreditEffect); the removal is refused when
 *            refunds paid or credit used from those notes would be more than
 *            the customer overpaid
 * Pass reason to check it as the database does. A note that already has a
 * refund on it gets its credit back to apply again, but refundProblem refuses
 * a second refund on it.
 */
export function removeAllocationEffect({ allocation, note, invoice, invoiceNotes = [], reason } = {}) {
  if (!allocation) return { problem: 'Applied credit not found.' };
  if (allocation.removed_at) return { problem: 'This applied credit has already been removed.' };
  if (reason !== undefined) {
    const length = [...trimmed(reason)].length;
    if (length < REASON_MIN || length > REASON_MAX) return { problem: `Give a reason of ${REASON_MIN} to ${REASON_MAX} characters.` };
  }
  const amt = decOr0(allocation.amount);
  // The cash is read before the credit comes off, so a paid invoice with no
  // amount_paid keeps the cash it was taken to have.
  const cash = toNumber(paidDec(invoice));
  const after = { ...invoice, amount_paid: cash, amount_allocated: toNumber(max0(sub(allocatedDec(invoice), amt))) };
  const issued = (invoiceNotes || []).filter((c) => c?.status === 'issued');
  const fit = fitRefunds(issued, max0(paidBeyond(after, decOr0(invoice?.amount_credited))));
  if (fit.problem === 'refunded') {
    return { problem: 'A refund has already been paid on a credit note of this invoice. Without the credit applied it would be more than the customer overpaid, so the credit cannot be removed.' };
  }
  if (fit.problem === 'used') {
    return { problem: 'Credit from a credit note of this invoice has already been used on an invoice. Without the credit applied it would be more than the customer overpaid, so the credit cannot be removed.' };
  }

  const noteAfter = { ...note, amount_allocated: toNumber(max0(sub(noteAllocatedDec(note), amt))) };
  const left = max0(toPennies(sub(sub(decOr0(note?.refund_due), noteAllocatedDec(noteAfter)), refundedDec(note))));
  const balance = balanceDue(after);
  const reopen = invoice?.status === 'paid' && balance > 0;
  return {
    problem: null,
    note: {
      amount_allocated: noteAfter.amount_allocated,
      refund_status: isPos(left) ? 'owed' : note?.refund_status,
      credit_available: toNumber(left),
    },
    invoice: { amount_allocated: after.amount_allocated, balance_due: balance, reopen, status: reopen ? 'sent' : invoice?.status },
    refunds: fit.refunds,
  };
}

// ── The amount received ─────────────────────────────────────────────────────
/** The two ways set_invoice_amount_received is called: Change and Mark paid. */
export const RECEIVED_KINDS = ['correction', 'payment'];
/** The reason a payment is recorded with when none is typed. */
export const PAYMENT_REASON = 'Payment received';

/**
 * What Mark paid sends as the amount received: the cash already received on
 * the invoice (in pennies; a paid invoice with no amount_paid counts as paid
 * in full) plus this payment, exactly as typed, so a payment with more than 2
 * places is still refused rather than rounded away. null when the payment is
 * not a number.
 */
export function markPaymentTotal(invoice, payment) {
  const amt = toDec(payment);
  return amt ? toNumber(add(toPennies(paidDec(invoice)), amt)) : null;
}

/**
 * What setting an invoice's amount received does, by the same rules, in the
 * same order and with the same words as set_invoice_amount_received, so the
 * sheet can say it before anyone saves and the harness can do it.
 *   invoice               the invoice (its amount_paid, amount_credited and
 *                         amount_allocated columns are read, as balanceDue does)
 *   notes                 its credit notes (cancelled ones are skipped)
 *   allocationsFromNotes  optional: the credit_allocations rows applied FROM
 *                         those notes; the active ones are summed per note
 *                         (as the database does) instead of each note's
 *                         amount_allocated
 *   amount                the TOTAL cash received afterwards (for Mark paid,
 *                         markPaymentTotal(invoice, payment))
 *   reason                checked only when passed; a blank one on a payment
 *                         is "Payment received"
 *   kind                  'correction' (Change, the default) or 'payment'
 *   expectedFrom          optional: the amount received the screen worked
 *                         from (p_expected_from); refused when the invoice no
 *                         longer has it
 * A payment is refused on an invoice that is paid or has nothing left to pay:
 * that is Change's job.
 * Returns { problem } when the database would refuse, otherwise:
 *   from_amount, amount_paid  the cash before and after, in pennies
 *   status                'paid' once cash plus credit applied covers what the
 *                         invoice asks for; a paid invoice that no longer is
 *                         goes back to 'sent'; sent and viewed stay as they are
 *   paid_at               the day money came in, which Collected counts on:
 *                         'keep' (an invoice that stays paid, or one with cash
 *                         on it that already has a date, reopened or not),
 *                         'now' (its first cash, or it becomes paid, with no
 *                         date yet) or 'clear' (left with no cash and unpaid)
 *   balance_due, overpaid what is left to pay, and settled beyond what it asks
 *   credit_moved          [{ id, credit_number, refund_due, refund_status,
 *                         credit_available }] for each note that changes, in
 *                         the order the database changes them (newest first)
 *   not_on_a_credit_note  overpaid with no credit note to hold it
 *   reason                the reason as it will be stored
 */
export function amountReceivedEffect({ invoice, notes = [], allocationsFromNotes, amount, reason, kind = 'correction', expectedFrom } = {}) {
  const k = kind ?? 'correction';
  if (!RECEIVED_KINDS.includes(k)) return { problem: 'Choose correction or payment.' };
  if (!invoice) return { problem: 'Invoice not found.' };
  if (!CREDITABLE_STATUSES.includes(invoice.status)) {
    return { problem: 'The amount received can only be changed on a sent, viewed or paid invoice.' };
  }
  const payment = k === 'payment';
  const what = payment ? 'The payment' : 'The amount received';

  const applied = allocatedDec(invoice);
  const from = toPennies(paidDec(invoice));
  // A card payment or a colleague's change landed after the screen read it.
  if (expectedFrom != null) {
    const seen = toDec(expectedFrom);
    if (!seen || cmp(toPennies(seen), from) !== 0) {
      return { problem: 'The amount received on this invoice changed while this was open. Check the figures and save again.' };
    }
  }
  const asked = askedAfter(invoice, decOr0(invoice.amount_credited));
  if (payment) {
    const name = invoiceRef(invoice) || 'This invoice';
    if (invoice.status === 'paid') return { problem: `${name} has already been paid. Use Change to correct the amount received.` };
    if (cmp(add(from, toPennies(applied)), asked) >= 0) return { problem: `${name} has nothing left to pay. Use Change to correct the amount received.` };
  }
  const amt = toDec(amount);
  if (!amt || (!payment && amt.n < ZERO)) return { problem: payment ? 'The payment must be more than 0.' : 'The amount received must be 0 or more.' };
  // Whole pennies, after the same 6 place wash as the rounding rule.
  if (cmp(roundTo(amt, 6), toPennies(amt)) !== 0) return { problem: `${what} can have at most 2 decimal places.` };
  const to = toPennies(amt);
  if (payment && cmp(to, from) <= 0) return { problem: 'The payment must be more than 0.' };
  if (!payment && cmp(to, from) === 0) return { problem: 'That is already the amount received on this invoice.' };

  let why = reason === undefined ? undefined : trimmed(reason);
  if (payment && (why === undefined || why === '')) why = PAYMENT_REASON;
  if (why !== undefined) {
    const length = [...why].length;
    if (length < REASON_MIN || length > REASON_MAX) return { problem: `Give a reason of ${REASON_MIN} to ${REASON_MAX} characters.` };
  }

  const settled = add(to, toPennies(applied));
  const target = max0(sub(settled, asked));

  const issued = (notes || []).filter((c) => c?.status === 'issued');
  const rows = Array.isArray(allocationsFromNotes) ? allocationsFromNotes.filter((a) => a && !a.removed_at) : null;
  const usedOf = (c) => (rows ? rows.filter((a) => a.credit_note_id === c.id).reduce((s, a) => add(s, decOr0(a.amount)), DZERO) : noteAllocatedDec(c));
  const refundedOf = (c) => decOr0(c.refunded_amount);
  const held = issued.reduce((s, c) => add(s, refundOnNote(c)), DZERO);
  const fixed = issued.reduce((s, c) => add(add(s, refundedOf(c)), usedOf(c)), DZERO);
  if (cmp(target, fixed) < 0) {
    const lowest = sub(add(asked, fixed), toPennies(applied));
    return {
      problem: `${moneyText(fixed, invoice.currency)} of the credit from this invoice has already been used or refunded, so the amount received cannot go below ${moneyText(lowest, invoice.currency)}.`,
    };
  }

  const wasPaid = invoice.status === 'paid';
  const paid = cmp(settled, asked) >= 0;
  const status = paid ? 'paid' : wasPaid ? 'sent' : invoice.status;
  // The day money came in, as the database sets it: as it was while the
  // invoice stays paid; now if it has no date yet once there is cash or it
  // becomes paid; cleared when it is left with no cash and unpaid.
  const dated = invoice.paid_at != null && invoice.paid_at !== '' && invoice.paid_at !== false;
  const paidAt = paid && wasPaid ? 'keep'
    : paid || isPos(to) ? (dated ? 'keep' : 'now')
      : dated ? 'clear' : 'keep';
  const newest = (a, b) => (Number(b.credit_number) || 0) - (Number(a.credit_number) || 0);
  const moved = [];
  let more = DZERO;
  if (cmp(target, held) > 0) {
    // More overpaid: added newest first, each note up to its total.
    more = sub(target, held);
    for (const c of issued.filter((x) => ['none', 'owed', 'allocated'].includes(x.refund_status)).sort(newest)) {
      if (!isPos(more)) break;
      const step = minDec(more, sub(decOr0(c.total), decOr0(c.refund_due)));
      if (!isPos(step)) continue;
      const due = add(decOr0(c.refund_due), step);
      moved.push({ id: c.id, credit_number: c.credit_number, refund_due: toNumber(due), refund_status: 'owed',
        credit_available: toNumber(max0(toPennies(sub(sub(due, usedOf(c)), refundedOf(c))))) });
      more = sub(more, step);
    }
  } else if (cmp(target, held) < 0) {
    // Less overpaid: off the credit still to use, newest first.
    let less = sub(held, target);
    for (const c of issued.filter((x) => x.refund_status === 'owed').sort(newest)) {
      if (!isPos(less)) break;
      const used = usedOf(c), refunded = refundedOf(c);
      const step = minDec(less, max0(sub(sub(decOr0(c.refund_due), used), refunded)));
      if (!isPos(step)) continue;
      const due = sub(decOr0(c.refund_due), step);
      const left = sub(sub(due, used), refunded);
      const st = isPos(left) ? 'owed' : isPos(refunded) ? 'refunded' : isPos(used) ? 'allocated' : 'none';
      moved.push({ id: c.id, credit_number: c.credit_number, refund_due: toNumber(due), refund_status: st,
        credit_available: toNumber(max0(toPennies(left))) });
      less = sub(less, step);
    }
  }

  return {
    problem: null,
    kind: k,
    reason: why,
    from_amount: toNumber(from),
    amount_paid: toNumber(to),
    status,
    paid_at: paidAt,
    balance_due: toNumber(max0(sub(asked, settled))),
    overpaid: toNumber(target),
    credit_moved: moved,
    not_on_a_credit_note: toNumber(max0(more)),
  };
}

/**
 * What to do about money paid beyond what an invoice asks for that no credit
 * note holds (overpaidNotOnCredit on the invoice screen, not_on_a_credit_note
 * from set_invoice_amount_received on the amount received sheet), as the
 * sentence that follows "Overpaid £X." null when nothing is overpaid.
 *   invoice    the invoice as it is, or will be once saved (its amount_paid,
 *              total, amount_credited and amount_allocated are read)
 *   overpaid   what no credit note holds
 *   canCredit  whether a credit note can still be raised on it
 * When no more is overpaid than the credit applied TO the invoice, the customer
 * paid without using that credit. A credit note would take VAT off a sale that
 * was never reduced, and the note the credit came from would still read as
 * used, so the way out is an owner removing the credit applied, which puts it
 * back on that note to use. Otherwise a credit note is raised to use or refund
 * it, or when none can be, it is refunded.
 */
export function overpaidAdvice({ invoice, overpaid, canCredit } = {}) {
  const over = toPennies(decOr0(overpaid));
  if (!isPos(over)) return null;
  const applied = toPennies(allocatedDec(invoice));
  if (isPos(applied) && cmp(over, applied) <= 0) {
    const inFull = cmp(toPennies(paidDec(invoice)), leftDec(invoice)) >= 0;
    return `${inFull ? 'The customer paid in full without using the credit applied.' : 'The customer paid more than was left to pay after the credit applied.'} An owner can remove the credit applied so it goes back on the credit note.`;
  }
  return canCredit
    ? 'Raise a credit note to use or refund it.'
    : 'More was paid than this invoice asks for and no credit note holds it as credit. Refund it to the customer.';
}

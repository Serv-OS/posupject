/* How a quote's lines are ordered and described to the customer.
 *
 * Hardware and setup first, then software, then card processing. The customer
 * pays the one-off lines on acceptance; the software lines are billed by a
 * schedule that starts when their account goes live, plus whatever delay the
 * quote promised. Pure, so the wording and the order can be tested.
 */
import { round2 } from './money.js';

export const CATEGORY_ORDER = ['hardware', 'services', 'saas', 'payments'];
export const SECTION = {
  hardware: { title: 'Hardware & setup', note: 'due on acceptance' },
  services: { title: 'Services', note: 'due on acceptance' },
  saas: { title: 'Software', note: null },   // note comes from saasStartText
  payments: { title: 'Card processing', note: 'charged per transaction once live' },
};
const rank = (c) => { const i = CATEGORY_ORDER.indexOf(c || 'hardware'); return i === -1 ? CATEGORY_ORDER.length : i; };

/** Stable: category order first, then the order the lines already had. */
export const sortQuoteLines = (items = []) =>
  items.map((it, i) => [it, i]).sort((a, b) => rank(a[0].category) - rank(b[0].category) || (Number(a[0].sort ?? a[1]) - Number(b[0].sort ?? b[1])) || a[1] - b[1]).map(([it]) => it);

/** [{ category, title, note, items }] in display order, empty categories left out. */
export const groupQuoteLines = (items = []) => {
  const sorted = sortQuoteLines(items);
  return CATEGORY_ORDER.map(category => ({ category, ...SECTION[category], items: sorted.filter(it => (it.category || 'hardware') === category) }))
    .filter(g => g.items.length);
};

/** When software billing starts, in the customer's words. */
export const saasStartText = (days) => {
  const d = Number(days) || 0;
  if (d <= 0) return 'from the day your account goes live';
  return `starting ${d} day${d === 1 ? '' : 's'} after your account goes live`;
};

/** The caption under one line: what it is and when it is billed. */
export const lineCaption = (it, days) => {
  if (it.billing_type === 'monthly') return `billed monthly, ${saasStartText(days)}`;
  if (it.billing_type === 'annual') return `billed annually, ${saasStartText(days)}`;
  if (it.billing_type === 'usage') return 'billed on use';
  return null;
};

/** Software per month, ex tax: monthly lines as they are, annual lines spread. */
export const softwareMonthly = (items = []) =>
  items.filter(it => it.category === 'saas').reduce((s, it) => {
    const lt = Number(it.line_total || 0);
    return s + (it.billing_type === 'monthly' ? lt : it.billing_type === 'annual' ? lt / 12 : 0);
  }, 0);

/** The lines as the customer may see them.
 *
 * A payments line is charged per transaction at the rate card, and the price
 * typed on it in the builder is our own yearly margin estimate (the builder
 * labels it "internal margin"). So its qty, unit price, discount and total
 * are dropped before the line reaches the page; the amount column says "per
 * transaction" instead. Every other line is returned as it is. The public
 * quote function does the same server side, so the figure never leaves the
 * database either way. */
export const customerLines = (items = []) =>
  (items || []).map(it => it.category === 'payments'
    ? { ...it, qty: null, unit_price: null, discount: null, line_total: null }
    : it);

/** What the customer pays for software, for their page and nothing else.
 *
 * Monthly lines stay monthly and annual lines stay yearly: the two are never
 * folded into one number, because a figure that reads "per month" must be
 * exactly what is charged each month. Tax is per line from tax_rate. Payments
 * lines never count (they are charged per transaction, see the rates table)
 * and hardware and services are one off. Each sum is rounded once at the end,
 * the way QuoteBuilder and the invoices do it.
 *
 * quotes.recurring_arr is NOT used here: it carries our card margin estimate,
 * which is why two quotes for the same software showed different yearly
 * totals. The customer must never see that figure. */
export const customerRecurring = (items = []) => {
  let monthlyEx = 0, monthlyTax = 0, annualEx = 0, annualTax = 0, hasMonthly = false, hasAnnual = false;
  for (const it of items || []) {
    if (it.category !== 'saas') continue;
    const lt = Number(it.line_total || 0);
    const tax = lt * (Number(it.tax_rate) || 0) / 100;
    if (it.billing_type === 'monthly') { hasMonthly = true; monthlyEx += lt; monthlyTax += tax; }
    else if (it.billing_type === 'annual') { hasAnnual = true; annualEx += lt; annualTax += tax; }
  }
  monthlyEx = round2(monthlyEx); monthlyTax = round2(monthlyTax);
  annualEx = round2(annualEx); annualTax = round2(annualTax);
  return {
    monthlyEx, monthlyTax, monthlyInc: round2(monthlyEx + monthlyTax),
    annualEx, annualTax, annualInc: round2(annualEx + annualTax),
    hasMonthly, hasAnnual,
  };
};

/* How a quote's lines are ordered and described to the customer.
 *
 * Hardware and setup first, then software, then card processing. The customer
 * pays the one-off lines on acceptance; the software lines are billed by a
 * schedule that starts when their account goes live, plus whatever delay the
 * quote promised. Pure, so the wording and the order can be tested.
 */
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

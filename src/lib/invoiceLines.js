/* What counts as a line on an invoice, and what the invoice therefore totals.
 *
 * Only a line with an item name is written to the database. The totals used to
 * be added up from every line ON SCREEN, including ones the save was about to
 * throw away, so a line with a price and an empty name vanished without a word
 * and left the invoice disagreeing with itself: INV-1119 was stored at £321.60
 * with no lines at all, so the list said £321.60 and the invoice said £0.00.
 *
 * So the totals are built from the same list the save writes, and a priced
 * line with no name stops the save instead of being dropped.
 */

export const hasName = (l) => String(l?.name || '').trim().length > 0;

/** Quantity times unit price, treating blanks as zero. Ex tax. */
export const lineValue = (l) => (Number(l?.qty) || 0) * (Number(l?.unit_price) || 0);

/** The lines that will actually be saved. */
export const savableLines = (lines) => (lines || []).filter(hasName);

/** Priced lines with no item name, with their position, for the message. */
export const namelessWithValue = (lines) =>
  (lines || []).map((l, i) => ({ line: l, index: i })).filter(({ line }) => !hasName(line) && lineValue(line) !== 0);

/** Subtotal, tax and total from the savable lines only. Tax is per line. */
export function invoiceTotals(lines) {
  const kept = savableLines(lines);
  const subtotal = kept.reduce((s, l) => s + lineValue(l), 0);
  const taxAmount = kept.reduce((s, l) => s + lineValue(l) * (Number(l.tax_rate) || 0) / 100, 0);
  return { subtotal, taxAmount, total: subtotal + taxAmount, kept };
}

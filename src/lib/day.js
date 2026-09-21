/* Calendar dates, kept as calendar dates.
 *
 * An install date, a go-live, a due date or a quote expiry is a DAY, not an
 * instant: "30 September 2026" is the same day in Huddersfield and in Los
 * Angeles. Postgres stores those columns as `date` and sends them as
 * '2026-09-30'.
 *
 * `new Date('2026-09-30')` does NOT mean that. The ISO short form is parsed as
 * UTC midnight, so anywhere behind UTC it renders as the day before: in Los
 * Angeles an install booked for the 30th showed as 29 Sep on the record, on the
 * board and on the customer's quote, while the edit box still read 30. Every
 * hour of the working day in the US is wrong; the UK only sees it in summer
 * evenings, which is why it hid for so long.
 *
 * So: parse a day at LOCAL midnight and compare days against local midnight
 * today. A full timestamp (anything longer than 'YYYY-MM-DD') is an instant and
 * is left alone.
 */

const DMY = { day: 'numeric', month: 'short', year: '2-digit' };
const pad = (n) => String(n).padStart(2, '0');

/** '2026-09-30' -> local midnight on the 30th. Timestamps and Dates pass through. */
export function parseDay(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const s = String(value).trim();
  if (!s) return null;
  const d = new Date(s.length <= 10 ? `${s}T00:00:00` : s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Formatted day, or `empty` when there is nothing to show. */
export function fmtDay(value, opts = DMY, locale = 'en-GB', empty = '') {
  const d = parseDay(value);
  return d ? d.toLocaleDateString(locale, opts) : empty;
}

/** Local midnight today, the only fair thing to compare a day against. */
export function today() {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

/** 'YYYY-MM-DD' for a day, in local time. Never toISOString(): that is UTC. */
export function toDayISO(value = new Date()) {
  const d = parseDay(value);
  return d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : '';
}

/** Whole days from today: negative is in the past, 0 is today. */
export function daysFromToday(value) {
  const d = parseDay(value);
  if (!d) return null;
  const at = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((at - today()) / 86400000);
}

/** Strictly before today. Today itself is never overdue. */
export function isPastDay(value) {
  const n = daysFromToday(value);
  return n !== null && n < 0;
}

export { DMY };

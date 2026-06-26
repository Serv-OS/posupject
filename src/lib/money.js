// Single source of truth for GBP money formatting + VAT/total maths.
//
// Money is stored as NUMERIC pounds across this app (invoices, quotes, products,
// and the new Finance/Expenses module), so this module works in pounds and rounds
// half-up to 2 decimal places. This is a deliberate, signed-off deviation from the
// expenses brief's "integer pence minor units" — matching the existing money model
// keeps the new tables join/report-compatible with invoices & products. The
// floating-point risk is contained here, in one pure, unit-tested module.
//
// Everything below is pure (no I/O) so it can be exhaustively tested — see money.test.js.

// Round to `dp` decimal places, half-up, guarding against binary-float drift
// (e.g. 1.005 must round to 1.01, not 1.00).
export function round(n, dp = 2) {
  const f = 10 ** dp;
  return Math.round((Number(n) + Number.EPSILON) * f) / f;
}
export const round2 = (n) => round(n, 2);

// GBP formatters (en-GB). gbp0 = whole pounds, gbp2 = always 2dp.
export const gbp = (n, dp = 2) =>
  '£' + (Number(n) || 0).toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp });
export const gbp0 = (n) => '£' + (Number(n) || 0).toLocaleString('en-GB', { maximumFractionDigits: 0 });
export const gbp2 = (n) => gbp(n, 2);
export const pct = (n, dp = 2) => (n == null || n === '' ? '—' : `${Number(n).toFixed(dp)}%`);

// Net of a single line: qty × unit_price × (1 − discount%). Rounded to 2dp.
export function lineNet({ qty = 1, unit_price = 0, discount = 0 } = {}) {
  const net = (Number(qty) || 0) * (Number(unit_price) || 0) * (1 - (Number(discount) || 0) / 100);
  return round2(net);
}

// VAT on a net amount at a percentage rate. Rounded to 2dp.
export function computeVat(net, rate = 0) {
  return round2((Number(net) || 0) * (Number(rate) || 0) / 100);
}

// { net, vat, gross } for one line at its tax_rate/vat_rate.
export function lineTotals(line = {}) {
  const net = lineNet(line);
  const vat = computeVat(net, line.tax_rate ?? line.vat_rate ?? 0);
  return { net, vat, gross: round2(net + vat) };
}

// Sum a set of lines into { net, vat, gross }. VAT is summed per-line then rounded,
// matching how invoices/quotes total today (per-line tax, summed).
export function computeTotals(lines = []) {
  let net = 0, vat = 0;
  for (const l of lines) { const t = lineTotals(l); net += t.net; vat += t.vat; }
  net = round2(net); vat = round2(vat);
  return { net, vat, gross: round2(net + vat) };
}

// VAT contained in a VAT-INCLUSIVE (gross) amount at `rate`% = gross × rate/(100+rate).
// At the 20% standard rate this is the 1/6 fraction HMRC uses for reclaimable VAT on
// mileage fuel (fuel element × 1/6). Rounded to 2dp.
export function vatFractionOfGross(gross, rate = 20) {
  const g = Number(gross) || 0;
  const r = Number(rate) || 0;
  if (100 + r === 0) return 0;
  return round2(g * r / (100 + r));
}

/* Which catalogue price belongs on a document.
 *
 * A product carries a pound price and a dollar price, and they are different
 * prices, not conversions: items sell for more in the US. A document in a
 * currency the product is not priced in gets NOTHING, not the other
 * currency's number, and the screen says so. Pure, so it can be tested.
 */
import { fmtMoney, currencySymbol } from './money';

const COL = { GBP: 'default_price', USD: 'default_price_usd' };
const COST = { GBP: 'cost_price', USD: 'cost_price_usd' };
const ccyOf = (c) => (c === 'USD' ? 'USD' : 'GBP');
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

/** The selling price in a currency, or null when the product is not priced in it. */
export const priceFor = (p, ccy) => num(p?.[COL[ccyOf(ccy)]]);
/** The cost price in a currency, or null. */
export const costFor = (p, ccy) => num(p?.[COST[ccyOf(ccy)]]);
/** True when the product can go on a document of this currency without a typed price. */
export const isPricedIn = (p, ccy) => priceFor(p, ccy) !== null;
/** What a picker shows next to the name: the price in the document's money, or that there is none. */
export const listPrice = (p, ccy) => {
  const v = priceFor(p, ccy);
  return v === null ? `no ${currencySymbol(ccyOf(ccy))} price yet` : fmtMoney(v, ccyOf(ccy));
};
/** The unit price a new line starts with: the real price, or 0 to be typed, never a guess. */
export const unitPriceFor = (p, ccy) => priceFor(p, ccy) ?? 0;
/** Margin in one currency, or null when either side is missing. Never mixes currencies. */
export const marginFor = (p, ccy) => {
  const sell = priceFor(p, ccy), cost = costFor(p, ccy);
  if (sell === null || cost === null || sell <= 0) return null;
  return { amount: sell - cost, pct: Math.round(((sell - cost) / sell) * 100) };
};

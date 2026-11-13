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

/* SKUs and bundles (migration 123).
 *
 * A product has a UK SKU (sku) and a US SKU (sku_us); one is never copied into
 * the other. A bundle ("Kiosk - Counter mounted") has its own price and is made
 * of parts that differ by market, so a pound document lists the UK parts and a
 * dollar document the US ones.
 */
const SKU = { GBP: 'sku', USD: 'sku_us' };
/** The SKU for a market, or null. */
export const skuFor = (p, ccy) => (p?.[SKU[ccyOf(ccy)]] || '').trim() || null;

/**
 * A bundle's parts for one market, in order, each joined to its product. A row
 * loaded with its part embedded (component) still resolves when the part is not
 * in the active list, so a switched off part is never silently left out.
 */
export const bundleParts = (bundleId, parts, products, ccy) => {
  const byId = new Map((products || []).map(p => [p.id, p]));
  return (parts || [])
    .filter(r => r.bundle_id === bundleId && r.region === ccyOf(ccy))
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
    .map(r => ({ qty: Math.max(1, Number(r.qty) || 1), product: byId.get(r.component_id) || r.component || null }))
    .filter(x => x.product);
};

/** What the quote and invoice builders load: every bundle row with its part's name and prices. */
export const BUNDLE_SELECT = 'bundle_id, component_id, region, qty, sort, component:products!component_id(id, name, default_price, default_price_usd, track_inventory)';

/** "Includes: 1 x Sunmi 22 Inch Kiosk, 2 x Counter bracket", or '' when there are no parts. */
export const includesText = (list) =>
  list.length ? 'Includes: ' + list.map(x => `${x.qty} x ${x.product.name}`).join(', ') : '';

/**
 * What a new quote or invoice line says under its name: the product's own
 * description, then for a bundle the parts for that document's market.
 */
export const lineDescriptionFor = (p, parts, products, ccy) => {
  const own = (p?.description || '').trim();
  if (!p?.is_bundle) return own;
  const inc = includesText(bundleParts(p.id, parts, products, ccy));
  return [own, inc].filter(Boolean).join('\n');
};

/** The parts' list prices added up, as a guide next to the bundle price. Null when any part has no price in that money. */
export const partsTotalFor = (list, ccy) => {
  if (!list.length) return null;
  let sum = 0;
  for (const x of list) { const v = priceFor(x.product, ccy); if (v === null) return null; sum += v * x.qty; }
  return Math.round(sum * 100) / 100;
};

/**
 * A bundle's cost in one market: its parts' cost prices added up (qty x cost).
 * total is null when there are no parts or any part has no cost in that money;
 * missing names those parts, so the screen can say why.
 */
export const partsCostFor = (list, ccy) => {
  if (!list.length) return { total: null, missing: [] };
  const missing = list.filter(x => costFor(x.product, ccy) === null).map(x => x.product.name);
  if (missing.length) return { total: null, missing };
  return { total: Math.round(list.reduce((s, x) => s + costFor(x.product, ccy) * x.qty, 0) * 100) / 100, missing };
};

/**
 * How many of a bundle can be built from stock: for every stock tracked part,
 * units in stock / qty needed, rounded down; the lowest wins. Parts that are not
 * stock tracked never hold a bundle back. Null when no part is tracked.
 * inStock maps product id to units in stock.
 */
export const bundleBuildable = (list, inStock) => {
  const tracked = list.filter(x => x.product.track_inventory);
  if (!tracked.length) return null;
  return Math.min(...tracked.map(x => Math.floor((Number(inStock?.[x.product.id]) || 0) / x.qty)));
};

/**
 * Stock Out for a bundle: which scanned units cover which part. units are the
 * scanned in stock units ({ serial, product_id }). Each tracked part needs qty
 * units of its product; anything else scanned is extra.
 */
export const bundleScan = (list, units) => {
  const left = [...(units || [])];
  const parts = list.filter(x => x.product.track_inventory).map(x => {
    const got = [];
    for (let i = 0; i < left.length && got.length < x.qty;) {
      if (left[i].product_id === x.product.id) got.push(left.splice(i, 1)[0].serial); else i++;
    }
    return { name: x.product.name, need: x.qty, got };
  });
  return { parts, extra: left.map(u => u.serial), complete: parts.every(p => p.got.length === p.need) && !left.length };
};

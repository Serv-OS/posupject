import { describe, it, expect } from 'vitest';
import { priceFor, costFor, isPricedIn, listPrice, unitPriceFor, marginFor, skuFor, bundleParts, includesText, lineDescriptionFor, partsTotalFor, partsCostFor } from './catalogue.js';

// Priced in both. The dollar price is deliberately NOT 1.27 x the pound one:
// items sell for more in the US, and the point of the column is that nothing
// derives one from the other.
const both = { name: 'ServOS Growth', default_price: 149, cost_price: 40, default_price_usd: 199, cost_price_usd: 60 };
const gbpOnly = { name: 'Card reader', default_price: 149, cost_price: 90 };

describe('priceFor / isPricedIn', () => {
  it('returns each currency its own price', () => {
    expect(priceFor(both, 'GBP')).toBe(149);
    expect(priceFor(both, 'USD')).toBe(199);
  });
  it('never falls back to the other currency', () => {
    expect(priceFor(gbpOnly, 'USD')).toBeNull();
    expect(isPricedIn(gbpOnly, 'USD')).toBe(false);
    expect(isPricedIn(gbpOnly, 'GBP')).toBe(true);
  });
  it('treats anything that is not USD as pounds, matching the app', () => {
    expect(priceFor(both, undefined)).toBe(149);
    expect(priceFor(both, 'EUR')).toBe(149);
  });
  it('reads an empty string as unpriced, not as zero', () => {
    expect(priceFor({ default_price_usd: '' }, 'USD')).toBeNull();
  });
  // A US-only product has a null pound price (migration 111). It must read as
  // unpriced for the UK, while a real £0 stays a price.
  it('treats a null pound price as unpriced, and a real zero as a price', () => {
    expect(isPricedIn({ default_price: null, default_price_usd: 549 }, 'GBP')).toBe(false);
    expect(listPrice({ default_price: null, default_price_usd: 549 }, 'GBP')).toBe('no £ price yet');
    expect(isPricedIn({ default_price: 0 }, 'GBP')).toBe(true);
  });
});

describe('listPrice / unitPriceFor', () => {
  it('shows the price in the document currency', () => {
    expect(listPrice(both, 'USD')).toBe('$199.00');
    expect(listPrice(both, 'GBP')).toBe('£149.00');
  });
  it('says plainly when there is no price in that currency', () => {
    expect(listPrice(gbpOnly, 'USD')).toBe('no $ price yet');
  });
  it('starts an unpriced line at zero to be typed, never at the other currency', () => {
    expect(unitPriceFor(gbpOnly, 'USD')).toBe(0);
    expect(unitPriceFor(both, 'USD')).toBe(199);
  });
});

describe('marginFor', () => {
  it('works inside one currency only', () => {
    expect(marginFor(both, 'GBP')).toEqual({ amount: 109, pct: 73 });
    expect(marginFor(both, 'USD')).toEqual({ amount: 139, pct: 70 });
  });
  it('is null when a side is missing, rather than borrowing the pound cost', () => {
    expect(marginFor(gbpOnly, 'USD')).toBeNull();
    expect(costFor(gbpOnly, 'USD')).toBeNull();
  });
});


describe('skuFor', () => {
  const p = { sku: 'UK-1', sku_us: 'US-9' };
  it('gives each market its own SKU', () => {
    expect(skuFor(p, 'GBP')).toBe('UK-1');
    expect(skuFor(p, 'USD')).toBe('US-9');
  });
  it('never copies the UK SKU into the US', () => {
    expect(skuFor({ sku: 'UK-1' }, 'USD')).toBeNull();
    expect(skuFor({ sku: '  ' }, 'GBP')).toBeNull();
  });
});

describe('bundles', () => {
  const kiosk = { id: 'k', name: 'Sunmi 22 Inch Kiosk', default_price: 676, default_price_usd: 899 };
  const ukMount = { id: 'u', name: 'UK counter bracket', default_price: 40 };
  const usMount = { id: 's', name: 'US counter bracket', default_price_usd: 55 };
  const bundle = { id: 'b', name: 'Kiosk - Counter mounted', description: 'Ready to bolt down.', is_bundle: true };
  const products = [kiosk, ukMount, usMount, bundle];
  const parts = [
    { bundle_id: 'b', component_id: 'u', region: 'GBP', qty: 2, sort: 1 },
    { bundle_id: 'b', component_id: 'k', region: 'GBP', qty: 1, sort: 0 },
    { bundle_id: 'b', component_id: 'k', region: 'USD', qty: 1, sort: 0 },
    { bundle_id: 'b', component_id: 's', region: 'USD', qty: 1, sort: 1 },
    { bundle_id: 'other', component_id: 'k', region: 'GBP', qty: 5, sort: 0 },
  ];
  it('resolves a part from the embedded row when it is not in the active list', () => {
    const off = [{ bundle_id: 'b', component_id: 'gone', region: 'GBP', qty: 1, sort: 0, component: { id: 'gone', name: 'Old stand' } }];
    expect(includesText(bundleParts('b', off, products, 'GBP'))).toBe('Includes: 1 x Old stand');
    expect(bundleParts('b', [{ bundle_id: 'b', component_id: 'gone', region: 'GBP' }], products, 'GBP')).toEqual([]);
  });
  it('lists the parts for the document market only, in order', () => {
    expect(bundleParts('b', parts, products, 'GBP').map(x => [x.product.id, x.qty])).toEqual([['k', 1], ['u', 2]]);
    expect(bundleParts('b', parts, products, 'USD').map(x => x.product.id)).toEqual(['k', 's']);
  });
  it('writes the line description with the parts under the product text', () => {
    expect(lineDescriptionFor(bundle, parts, products, 'GBP')).toBe('Ready to bolt down.\nIncludes: 1 x Sunmi 22 Inch Kiosk, 2 x UK counter bracket');
    expect(lineDescriptionFor(bundle, parts, products, 'USD')).toBe('Ready to bolt down.\nIncludes: 1 x Sunmi 22 Inch Kiosk, 1 x US counter bracket');
  });
  it('leaves a plain product description alone', () => {
    expect(lineDescriptionFor(kiosk, parts, products, 'GBP')).toBe('');
    expect(lineDescriptionFor({ ...kiosk, description: 'x' }, parts, products, 'USD')).toBe('x');
  });
  it('adds a bundle with no parts for a market without an Includes line', () => {
    expect(lineDescriptionFor({ ...bundle, id: 'none' }, parts, products, 'GBP')).toBe('Ready to bolt down.');
    expect(includesText([])).toBe('');
  });
  it('totals the parts as a guide, or null when a part has no price in that money', () => {
    expect(partsTotalFor(bundleParts('b', parts, products, 'GBP'), 'GBP')).toBe(756);
    expect(partsTotalFor(bundleParts('b', parts, products, 'USD'), 'USD')).toBe(954);
    expect(partsTotalFor([{ qty: 1, product: ukMount }], 'USD')).toBeNull();
    expect(partsTotalFor([], 'GBP')).toBeNull();
  });
});

describe('partsCostFor', () => {
  const a = { name: 'Kiosk', cost_price: 500, cost_price_usd: 610 };
  const b = { name: 'Bracket', cost_price: 12.5 };
  it('adds the parts cost prices in that money, qty included', () => {
    expect(partsCostFor([{ qty: 1, product: a }, { qty: 2, product: b }], 'GBP')).toEqual({ total: 525, missing: [] });
  });
  it('gives no cost, and names the part, when a part has no cost in that money', () => {
    expect(partsCostFor([{ qty: 1, product: a }, { qty: 1, product: b }], 'USD')).toEqual({ total: null, missing: ['Bracket'] });
  });
  it('gives no cost for a bundle with no parts', () => {
    expect(partsCostFor([], 'GBP')).toEqual({ total: null, missing: [] });
  });
});

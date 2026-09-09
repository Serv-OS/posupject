import { describe, it, expect } from 'vitest';
import { priceFor, costFor, isPricedIn, listPrice, unitPriceFor, marginFor } from './catalogue.js';

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

import { describe, it, expect } from 'vitest';
import { stagesProblem, netByRate, stageLines, orderSummary, STAGE_PRESETS } from './invoiceStages.js';
import { invoiceTotals } from './invoiceLines.js';

const line = (o = {}) => ({ name: 'Item', description: '', qty: 1, unit_price: 0, tax_rate: 20, ...o });

// INV-1012 as stored: four free Sunmi items and four priced ones, £5,265 net.
const inv1012 = [
  line({ name: 'Sunmi Cloud Printer', qty: 2 }),
  line({ name: 'Sunmi D3 Pro' }),
  line({ name: 'Sunmi Customer Facing Display' }),
  line({ name: 'Sunmi KDS - Screens', qty: 3 }),
  line({ name: 'Unifi UMR - 4G Backup', unit_price: 225 }),
  line({ name: 'Unifi UX7 Router', unit_price: 249 }),
  line({ name: 'TV Menu Stick', qty: 6, unit_price: 149 }),
  line({ name: '21.5 Inch Kiosk - With Counter Stand', qty: 3, unit_price: 1299 }),
];

describe('stagesProblem', () => {
  it('accepts every preset', () => {
    for (const p of STAGE_PRESETS) expect(stagesProblem(p.stages)).toBe('');
  });
  it('needs two stages, names, positive percentages and 100% in all', () => {
    expect(stagesProblem([{ label: 'All', percent: 100 }])).toMatch(/two stages/);
    expect(stagesProblem([{ label: '', percent: 50 }, { label: 'B', percent: 50 }])).toMatch(/name/);
    expect(stagesProblem([{ label: 'A', percent: 0 }, { label: 'B', percent: 100 }])).toMatch(/above 0/);
    expect(stagesProblem([{ label: 'A', percent: 50 }, { label: 'B', percent: 40 }])).toMatch(/90%/);
    expect(stagesProblem([{ label: 'A', percent: 33.33 }, { label: 'B', percent: 33.33 }, { label: 'C', percent: 33.34 }])).toBe('');
  });
});

describe('stageLines on INV-1012', () => {
  const stages = STAGE_PRESETS[1].stages; // 50 / 30 / 20
  const out = stageLines(inv1012, stages);

  it('makes one line per stage, named for the customer', () => {
    expect(out).toHaveLength(3);
    expect(out.map(s => s.length)).toEqual([1, 1, 1]);
    expect(out[0][0].name).toBe('Stage 1 of 3: Deposit (50%)');
    expect(out[2][0].name).toBe('Stage 3 of 3: Go live (20%)');
  });

  it('charges the right share of £5,265 and keeps 20% VAT', () => {
    expect(out.map(s => s[0].unit_price)).toEqual([2632.5, 1579.5, 1053]);
    expect(out.every(s => s[0].tax_rate === 20)).toBe(true);
  });

  it('adds back up to the original invoice, VAT included', () => {
    const totals = out.map(s => invoiceTotals(s).total);
    expect(Math.round(totals.reduce((a, b) => a + b, 0) * 100) / 100).toBe(6318);
  });

  it('lists the full order, free kit included, in the description', () => {
    expect(out[0][0].description).toContain('50% of 5265.00 before tax.');
    expect(out[0][0].description).toContain('2 x Sunmi Cloud Printer');
    expect(out[0][0].description).toContain('3 x 21.5 Inch Kiosk');
  });
});

describe('pennies', () => {
  it('the last stage takes the remainder so nothing is lost', () => {
    const out = stageLines([line({ unit_price: 100 })], [
      { label: 'A', percent: 33.33 }, { label: 'B', percent: 33.33 }, { label: 'C', percent: 33.34 },
    ]);
    const amounts = out.map(s => s[0].unit_price);
    expect(amounts).toEqual([33.33, 33.33, 33.34]);
    const odd = stageLines([line({ unit_price: 0.05 })], [{ label: 'A', percent: 50 }, { label: 'B', percent: 50 }]);
    expect(odd[0][0].unit_price + odd[1][0].unit_price).toBeCloseTo(0.05, 10);
  });
});

describe('mixed VAT rates', () => {
  const mixed = [line({ name: 'Kit', unit_price: 1000, tax_rate: 20 }), line({ name: 'Training', unit_price: 200, tax_rate: 0 })];
  it('keeps each rate on its own line so VAT stays right', () => {
    expect(netByRate(mixed)).toEqual([{ rate: 20, net: 1000 }, { rate: 0, net: 200 }]);
    const out = stageLines(mixed, STAGE_PRESETS[0].stages);
    expect(out[0].map(l => [l.unit_price, l.tax_rate])).toEqual([[500, 20], [100, 0]]);
    expect(out[0][0].name).toBe('Stage 1 of 2: Deposit (50%) at 20% VAT');
    const tax = out.reduce((s, st) => s + invoiceTotals(st).taxAmount, 0);
    expect(tax).toBe(200);
  });
});

describe('orderSummary', () => {
  it('skips lines with no name, as the save does', () => {
    expect(orderSummary([line({ name: 'A', qty: 2 }), line({ name: ' ' })])).toBe('2 x A');
  });
});

/* The value model behind every deal report. If these rules drift, close-rate
 * and revenue numbers change meaning silently — so they are pinned here.
 *
 *   node --test src/lib/dealValue.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oneOffValue, recurringValue, totalValue } from './dealValue.js';

test('a passed-in one-time deal: only the headline value is set', () => {
  const d = { value: 4500 };
  assert.equal(oneOffValue(d), 4500);
  assert.equal(recurringValue(d), 0);
  assert.equal(totalValue(d), 4500);
});

test('a structured deal: hardware + services beat the headline', () => {
  const d = { value: 9999, hardware_value: 3000, services_value: 1200 };
  assert.equal(oneOffValue(d), 4200, 'headline must not be double-counted');
  assert.equal(totalValue(d), 4200);
});

test('a recurring deal: the headline does not leak into one-off', () => {
  // The headline usually restates the ARR on these — counting it as one-off
  // would double the deal.
  const d = { value: 12000, saas_arr: 9000, payments_arr: 3000 };
  assert.equal(recurringValue(d), 12000);
  assert.equal(oneOffValue(d), 0);
  assert.equal(totalValue(d), 12000);
});

test('a mixed deal: broken-out one-off plus ARR', () => {
  const d = { value: 0, hardware_value: 2500, services_value: 500, saas_arr: 6000 };
  assert.equal(oneOffValue(d), 3000);
  assert.equal(recurringValue(d), 6000);
  assert.equal(totalValue(d), 9000);
});

test('empty and null fields never produce NaN', () => {
  for (const d of [{}, { value: null }, { hardware_value: null, saas_arr: null }]) {
    assert.equal(Number.isFinite(totalValue(d)), true);
    assert.equal(totalValue(d), 0);
  }
});

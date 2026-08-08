/* node --test src/lib/trading.test.mjs
 *
 * The trap this file exists for: average transaction across several sites is
 * total revenue over total transactions, never the average of the averages.
 * Get it wrong and a group with one restaurant and one coffee kiosk reports an
 * average transaction more than double the truth.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  transactionsFrom, blendedAvgTransaction, rollUp, effectiveDealTrading,
  estimateAccuracy, pipelineTotals, DEFAULT_STAGE_WEIGHTS,
} from './trading.js';

test('transactions come from turnover and average transaction', () => {
  assert.equal(transactionsFrom(45000, 45), 1000);
  assert.equal(transactionsFrom(20000, 4), 5000);
  assert.equal(transactionsFrom(10000, 7.5), 1333);      // rounded
});

test('transactions are null when the inputs cannot support them', () => {
  assert.equal(transactionsFrom(45000, 0), null);
  assert.equal(transactionsFrom(45000, null), null);
  assert.equal(transactionsFrom(null, 45), null);
  assert.equal(transactionsFrom(45000, -5), null);
  assert.equal(transactionsFrom('', ''), null);
});

test('THE TRAP: blended average is not the average of averages', () => {
  const sites = [
    { monthlyRevenue: 45000, avgTransaction: 45 },   // restaurant, 1,000 txns
    { monthlyRevenue: 20000, avgTransaction: 4 },    // kiosk,      5,000 txns
  ];
  const naive = (45 + 4) / 2;                        // 24.50 — wrong
  const blended = blendedAvgTransaction(sites);      // 65000 / 6000 = 10.83
  assert.ok(Math.abs(blended - 65000 / 6000) < 1e-9);
  assert.ok(blended < naive / 2, `blended ${blended} should be far below the naive ${naive}`);
});

test('blended average matches the database view for the same inputs', () => {
  // Verified against deal_trading in Postgres: 10.8333333333333333
  const b = blendedAvgTransaction([
    { monthlyRevenue: 45000, avgTransaction: 45 },
    { monthlyRevenue: 20000, avgTransaction: 4 },
  ]);
  assert.equal(b.toFixed(4), '10.8333');
});

test('roll-up totals turnover, transactions and the year', () => {
  const r = rollUp([
    { monthlyRevenue: 45000, avgTransaction: 45 },
    { monthlyRevenue: 20000, avgTransaction: 4 },
  ]);
  assert.equal(r.siteCount, 2);
  assert.equal(r.monthlyRevenue, 65000);
  assert.equal(r.transactions, 6000);
  assert.equal(r.annualRevenue, 780000);
});

test('a site with no average transaction still counts towards turnover', () => {
  const r = rollUp([
    { monthlyRevenue: 45000, avgTransaction: 45 },
    { monthlyRevenue: 30000, avgTransaction: null },
  ]);
  assert.equal(r.monthlyRevenue, 75000, 'turnover must include it');
  assert.equal(r.transactions, 1000, 'but it cannot contribute transactions');
  // Blended ATV is computed only from sites we can actually place.
  assert.equal(r.avgTransaction, 45);
});

test('no sites means nulls, not zeroes', () => {
  const r = rollUp([]);
  assert.equal(r.monthlyRevenue, null);
  assert.equal(r.avgTransaction, null);
  assert.equal(r.siteCount, 0);
});

test('a deal override beats the roll-up', () => {
  const sites = [{ monthlyRevenue: 45000, avgTransaction: 45 }];
  const plain = effectiveDealTrading({}, sites);
  assert.equal(plain.monthlyRevenue, 45000);
  assert.equal(plain.isOverride, false);

  const over = effectiveDealTrading({ est_monthly_revenue: 100000, est_avg_transaction: 25 }, sites);
  assert.equal(over.monthlyRevenue, 100000);
  assert.equal(over.avgTransaction, 25);
  assert.equal(over.transactions, 4000);
  assert.equal(over.isOverride, true);
  assert.equal(over.siteCount, 1, 'the sites are still reported');
});

test('overriding only one field leaves the other rolling up', () => {
  const sites = [{ monthlyRevenue: 45000, avgTransaction: 45 }];
  const r = effectiveDealTrading({ est_monthly_revenue: 90000 }, sites);
  assert.equal(r.monthlyRevenue, 90000, 'override');
  assert.equal(r.avgTransaction, 45, 'rolled up');
  assert.equal(r.transactions, 2000);
});

test('a deal with no sites and no override is empty, not zero', () => {
  const r = effectiveDealTrading({}, []);
  assert.equal(r.monthlyRevenue, null);
  assert.equal(r.transactions, null);
});

test('estimate accuracy shows over and under statement', () => {
  assert.equal(estimateAccuracy(40000, 44000), 0.1);      // doing 10% better
  assert.equal(estimateAccuracy(40000, 30000), -0.25);    // over-stated by a quarter
  assert.equal(estimateAccuracy(0, 30000), null);
  assert.equal(estimateAccuracy(null, 30000), null);
});

test('pipeline separates best case, likely case and won', () => {
  const deals = [
    { stage: 'qualified',     est_monthly_revenue: 10000, est_monthly_transactions: 1000 },
    { stage: 'proposal_sent', est_monthly_revenue: 20000, est_monthly_transactions: 2000 },
    { stage: 'closed_won',    est_monthly_revenue: 50000, est_monthly_transactions: 5000 },
    { stage: 'closed_lost',   est_monthly_revenue: 99000, est_monthly_transactions: 9900 },
  ];
  const t = pipelineTotals(deals, DEFAULT_STAGE_WEIGHTS);
  assert.equal(t.openCount, 2);
  assert.equal(t.openRevenue, 30000, 'raw open pipeline');
  assert.equal(t.weightedRevenue, 10000 * 0.25 + 20000 * 0.70);   // 16,500
  assert.equal(t.wonRevenue, 50000);
  assert.equal(t.wonTransactions, 5000);
  assert.equal(t.openTransactions, 3000);
});

test('lost deals never count anywhere', () => {
  const t = pipelineTotals([{ stage: 'closed_lost', est_monthly_revenue: 99000 }]);
  assert.equal(t.openRevenue, 0);
  assert.equal(t.wonRevenue, 0);
  assert.equal(t.weightedRevenue, 0);
});

test('an unknown stage contributes nothing to the weighted figure', () => {
  const t = pipelineTotals([{ stage: 'some_new_stage', est_monthly_revenue: 10000 }]);
  assert.equal(t.openRevenue, 10000, 'still in the raw pipeline');
  assert.equal(t.weightedRevenue, 0, 'but carries no probability');
});

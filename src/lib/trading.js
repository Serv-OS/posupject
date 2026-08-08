/* Venue trading figures — what the CUSTOMER turns over.
 *
 * Not to be confused with the deal's revenue fields (hardware_value, saas_arr,
 * payments_arr), which are what WE earn. These are the numbers a rep gathers in
 * discovery: expected monthly turnover and expected average transaction.
 *
 * The database owns the real derivation (see migration 078 and the deal_trading
 * view). This is the same arithmetic for the browser, so a rep sees the
 * transaction count update as they type rather than after a save.
 */

const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

/** Transactions a month, from turnover and average transaction. */
export function transactionsFrom(monthlyRevenue, avgTransaction) {
  const rev = num(monthlyRevenue);
  const atv = num(avgTransaction);
  if (rev === null || atv === null || atv <= 0) return null;
  return Math.round(rev / atv);
}

/**
 * Average transaction across several sites.
 *
 * NOT the average of their averages: a 45-cover restaurant and a coffee kiosk
 * would then weigh the same, and a group of one restaurant (£45) plus one kiosk
 * (£4) would read as £24.50 when the real blended figure is £10.83. It is total
 * revenue divided by total transactions.
 */
export function blendedAvgTransaction(sites) {
  let rev = 0;
  let txns = 0;
  for (const s of sites || []) {
    const r = num(s?.monthlyRevenue);
    const t = transactionsFrom(s?.monthlyRevenue, s?.avgTransaction);
    if (r === null || t === null || t <= 0) continue;   // can't place a site with no ATV
    rev += r;
    txns += t;
  }
  if (txns <= 0) return null;
  return rev / txns;
}

/** Totals for a set of sites: turnover, transactions and the blended average. */
export function rollUp(sites) {
  const list = (sites || []).filter((s) => num(s?.monthlyRevenue) !== null);
  const monthlyRevenue = list.reduce((a, s) => a + num(s.monthlyRevenue), 0);
  const transactions = list.reduce((a, s) => a + (transactionsFrom(s.monthlyRevenue, s.avgTransaction) || 0), 0);
  return {
    siteCount: list.length,
    monthlyRevenue: list.length ? monthlyRevenue : null,
    transactions: transactions || null,
    avgTransaction: blendedAvgTransaction(list),
    annualRevenue: list.length ? monthlyRevenue * 12 : null,
  };
}

/** The deal-level override beats the roll-up when either field is filled in. */
export function effectiveDealTrading(deal, sites) {
  const roll = rollUp(sites);
  const oRev = num(deal?.est_monthly_revenue);
  const oAtv = num(deal?.est_avg_transaction);
  const isOverride = oRev !== null || oAtv !== null;
  const monthlyRevenue = oRev !== null ? oRev : roll.monthlyRevenue;
  const avgTransaction = oAtv !== null ? oAtv : roll.avgTransaction;
  return {
    ...roll,
    isOverride,
    monthlyRevenue,
    avgTransaction,
    transactions: transactionsFrom(monthlyRevenue, avgTransaction),
    annualRevenue: monthlyRevenue === null ? null : monthlyRevenue * 12,
  };
}

/** How far off the pitch was, once the venue is actually trading. */
export function estimateAccuracy(estimated, actual) {
  const e = num(estimated);
  const a = num(actual);
  if (e === null || a === null || e <= 0) return null;
  return (a - e) / e;          // +0.10 = doing 10% better than they said
}

export const DEFAULT_STAGE_WEIGHTS = {
  new_lead: 0.05, contacted: 0.10, qualified: 0.25, demo_booked: 0.40,
  demo_done: 0.55, proposal_sent: 0.70, negotiation: 0.85,
  closed_won: 1, closed_lost: 0,
};

/** Pipeline view of a set of deals: best case, likely case, and already won. */
export function pipelineTotals(deals, weights = DEFAULT_STAGE_WEIGHTS) {
  const out = {
    openCount: 0, wonCount: 0,
    openRevenue: 0, weightedRevenue: 0, wonRevenue: 0,
    openTransactions: 0, wonTransactions: 0,
  };
  for (const d of deals || []) {
    const rev = num(d?.est_monthly_revenue) || 0;
    const txn = num(d?.est_monthly_transactions) || 0;
    if (d?.stage === 'closed_won') {
      out.wonCount += 1; out.wonRevenue += rev; out.wonTransactions += txn;
    } else if (d?.stage !== 'closed_lost') {
      const p = num(weights?.[d?.stage]);
      out.openCount += 1;
      out.openRevenue += rev;
      out.openTransactions += txn;
      out.weightedRevenue += rev * (p === null ? 0 : p);
    }
  }
  return out;
}

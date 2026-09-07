/* Payments ARR, derived rather than guessed.
 *
 * A processing account already models, per card type: the customer's monthly
 * volume and transaction count, the rate WE charge them, and the rate WE pay
 * (the buy rate). Our revenue on that account is therefore
 *
 *     margin = our cost to them  -  our buy cost        (per month)
 *     payments ARR = margin x 12                        (per year)
 *
 * That is the same margin PaymentsPanel already shows as "We earn / mo". Until
 * now the deal's payments_arr was typed in by hand, so the pipeline carried a
 * rep's estimate while the real figure sat one screen away on the rate card.
 *
 * Only PRICED rows count: a row with no "our rate" is volume we have not
 * quoted yet, and counting it would invent revenue.
 */
export function paymentsArrFromRates(rates = []) {
  let ourCost = 0, buyCost = 0, priced = 0;
  for (const r of rates || []) {
    const our = r?.our_rate_pct;
    if (our === null || our === undefined || our === '') continue;   // unpriced
    const vol = Number(r.monthly_volume || 0);
    const txns = Number(r.monthly_txns || 0);
    ourCost += vol * (Number(our) || 0) / 100 + txns * (Number(r.our_txn_fee) || 0) / 100;
    buyCost += vol * (Number(r.buy_rate_pct) || 0) / 100 + txns * (Number(r.buy_txn_fee) || 0) / 100;
    priced += 1;
  }
  const marginMonthly = ourCost - buyCost;
  return { priced, marginMonthly, arr: marginMonthly * 12 };
}

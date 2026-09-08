/* What card processing COSTS us, per region.
 *
 * These numbers used to be constants in PaymentsPanel, so changing a buy rate
 * meant a deploy and there was no way to hold a second set for the US. They now
 * live in processing_cost_templates, effective-dated, one template per region.
 *
 * Everything downstream already reads a rate card's buy figures, so once a rate
 * card is seeded from a template the margin, the customer's saving and the
 * deal's payments ARR all follow with no further wiring.
 *
 * Degrading: if the table is missing, empty, or unreadable, every caller falls
 * back to the values the app has always used. That keeps the app working before
 * the migration lands and if a region has no template yet.
 *
 * The Supabase client is passed in rather than imported so this stays pure and
 * testable outside a browser.
 */

/** The rates the app hardcoded before templates existed. UK figures. */
export const FALLBACK_ROWS = {
  cp_vm_credit:  { buy_rate_pct: 0.65, buy_txn_fee: 6,  split_pct: 15 },
  cp_vm_debit:   { buy_rate_pct: 0.55, buy_txn_fee: 6,  split_pct: 82 },
  cp_amex:       { buy_rate_pct: 2.00, buy_txn_fee: 10, split_pct: 3 },
  cnp_vm_credit: { buy_rate_pct: 0.65, buy_txn_fee: 6,  split_pct: 35 },
  cnp_vm_debit:  { buy_rate_pct: 0.55, buy_txn_fee: 6,  split_pct: 60 },
  cnp_amex:      { buy_rate_pct: 2.00, buy_txn_fee: 10, split_pct: 5 },
};

/** 'GB' → 'UK'. Anything we do not trade in falls back to UK. */
export const regionForCountry = (country) => (String(country || '').toUpperCase() === 'US' ? 'US' : 'UK');

/**
 * The costs in force for a region today.
 * @returns {{ rows: object, source: 'template'|'fallback', effectiveFrom: string|null, id: string|null }}
 */
export async function loadCostTemplate(client, regionCode = 'UK', today = new Date()) {
  const miss = { rows: FALLBACK_ROWS, source: 'fallback', effectiveFrom: null, id: null };
  try {
    const { data, error } = await client
      .from('processing_cost_templates')
      .select('id, region_code, effective_from, rows')
      .eq('region_code', regionCode)
      .lte('effective_from', today.toISOString().slice(0, 10))
      .order('effective_from', { ascending: false })
      .limit(1);
    if (error) return miss;
    const row = (data || [])[0];
    if (!row || !row.rows || !Object.keys(row.rows).length) return miss;
    return { rows: row.rows, source: 'template', effectiveFrom: row.effective_from, id: row.id };
  } catch {
    return miss;
  }
}

/**
 * The cost for one rate-matrix row, e.g. 'cp_vm_debit'.
 * `category` carries the old constants so a key the template does not mention
 * still resolves rather than silently costing nothing.
 */
export function costFor(template, key, category = null) {
  const row = template?.rows?.[key] || FALLBACK_ROWS[key] || {};
  const n = (v, alt) => (v === null || v === undefined || v === '' ? alt : Number(v));
  return {
    buy: n(row.buy_rate_pct, category?.buy ?? null),
    buyTxn: n(row.buy_txn_fee, category?.buyTxn ?? null),
    split: n(row.split_pct, category?.split ?? null),
  };
}

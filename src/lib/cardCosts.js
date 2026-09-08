/* What card processing COSTS us, per region.
 *
 * Our acquirer charges us INTERCHANGE plus a markup of their own. At the time
 * of writing that markup is 0.10% + 5p on every transaction, whatever the card.
 * So the buy rate for a card type is:
 *
 *     buy %   = interchange %      + markup %
 *     buy fee = interchange fixed  + markup fixed
 *
 * They are stored apart because they change for different reasons: interchange
 * moves when a scheme or a regulator changes it, per card type and country;
 * the markup moves only when we renegotiate. Keeping them separate also means
 * the quote screen can show a rep exactly where a cost came from.
 *
 * Fixed amounts are in the region's MINOR unit: pence in the UK, cents in the
 * US. The rest of the app already works in pence for per-transaction fees.
 *
 * Degrading: with no template for a region every caller gets nulls rather than
 * a guess. A missing cost must read as missing, never as free, or we would
 * quote margin we are not making.
 */

// No Supabase import on purpose: the caller passes its client in, which keeps
// this module pure and testable outside a browser.
export const DEFAULT_TZ_REGION = 'UK';

/** 'GB' → 'UK'. Anything we do not trade in falls back to UK. */
export const regionForCountry = (country) => (String(country || '').toUpperCase() === 'US' ? 'US' : 'UK');

/** What our acquirer adds on top of interchange, if the template does not say. */
export const DEFAULT_MARKUP = { rate_pct: 0.10, txn_minor: 5 };

/**
 * The costs in force for a region today.
 * @returns {{ rows: object, markup: object, source: 'template'|'none', effectiveFrom: string|null, id: string|null }}
 */
export async function loadCostTemplate(client, regionCode = 'UK', today = new Date()) {
  const none = { rows: {}, markup: DEFAULT_MARKUP, source: 'none', effectiveFrom: null, id: null };
  try {
    const { data, error } = await client
      .from('processing_cost_templates')
      .select('id, region_code, effective_from, rows, markup')
      .eq('region_code', regionCode)
      .lte('effective_from', today.toISOString().slice(0, 10))
      .order('effective_from', { ascending: false })
      .limit(1);
    if (error) return none;
    const row = (data || [])[0];
    if (!row || !row.rows || !Object.keys(row.rows).length) return none;
    return { rows: row.rows, markup: row.markup || DEFAULT_MARKUP, source: 'template', effectiveFrom: row.effective_from, id: row.id };
  } catch {
    return none;
  }
}

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

/**
 * The cost for one rate-matrix row, e.g. 'cp_vm_debit'.
 * Returns nulls when the region has no interchange set for that card type:
 * an unknown cost must never read as a free one.
 */
export function costFor(template, key) {
  const row = template?.rows?.[key];
  const markup = template?.markup || DEFAULT_MARKUP;
  if (!row) return { buy: null, buyTxn: null, split: null, ic: null, icTxn: null, markup };
  const ic = num(row.ic_rate_pct);
  const icTxn = num(row.ic_txn_minor);
  return {
    ic,
    icTxn,
    markup,
    buy: ic === null ? null : round2(ic + Number(markup.rate_pct || 0)),
    buyTxn: icTxn === null ? null : round2(icTxn + Number(markup.txn_minor || 0)),
    split: num(row.split_pct),
  };
}

/** Money maths deserves rounding you can predict. */
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** Human sentence for where a buy rate came from, for the rep on the quote. */
export function costExplain(template, key, symbol = 'p') {
  const c = costFor(template, key);
  if (c.ic === null) return 'No interchange set for this card type';
  return `${c.ic}% + ${c.icTxn}${symbol} interchange, plus ${c.markup.rate_pct}% + ${c.markup.txn_minor}${symbol}`;
}

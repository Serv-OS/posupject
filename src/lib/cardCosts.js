/* What card processing COSTS us, per region.
 *
 * A card costs us three things, not two:
 *
 *     buy %   = interchange %     + scheme %     + markup %
 *     buy fee = interchange fixed + scheme fixed + markup fixed
 *
 * INTERCHANGE goes to the card issuer. SCHEME FEES (assessments, authorisation
 * and clearing fees) go to Visa and Mastercard. MARKUP is our acquirer's own
 * cut, currently 0.10% + 5p.
 *
 * The scheme layer is separate because it is a pass-through we do not control
 * and because it is easy to forget: quoting "interchange plus 0.10% and 5p"
 * sounds complete, and it is not. On US credit the scheme layer is about
 * 0.14% + 2c, which is roughly 6% of the margin on a $45 ticket. In the UK it
 * is far smaller, nearer 0.03% + 0.8p card present, because Visa and
 * Mastercard price Europe differently.
 *
 * Whether scheme fees sit inside a given acquirer's markup or on top of it is
 * a CONTRACT question, not a research one. Under IC++ they are passed through
 * at cost and belong here; under IC+ the markup absorbs them and these fields
 * should be left empty. Set them to nothing and the maths is exactly what it
 * was before this layer existed.
 *
 * All three are stored apart because they change for different reasons:
 * interchange moves when a scheme or a regulator changes it, per card type and
 * country; scheme fees move on the networks' own schedules; the markup moves
 * only when we renegotiate. Keeping them separate also means the quote screen
 * can show a rep exactly where a cost came from.
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
  if (!row) return { buy: null, buyTxn: null, split: null, ic: null, icTxn: null, scheme: null, schemeTxn: null, markup, offered: true };
  const ic = num(row.ic_rate_pct);
  const icTxn = num(row.ic_txn_minor);
  // An unset scheme fee means "we are not charged one separately", which is a
  // real answer under IC+ pricing, so it adds nothing rather than voiding the
  // buy rate. An unset INTERCHANGE is different: that is genuinely unknown,
  // and the row stays null so it cannot read as free.
  const scheme = num(row.scheme_rate_pct);
  const schemeTxn = num(row.scheme_txn_minor);
  // Some card types we simply do not sell in a region. UK Amex is the usual
  // case: the merchant holds their own agreement with American Express, so
  // there is nothing for us to buy and nothing to quote. That is a different
  // answer from "we have not looked it up yet", and the rate card should not
  // nag for a number that will never exist.
  if (row.not_offered) return { buy: null, buyTxn: null, split: num(row.split_pct), ic: null, icTxn: null, scheme: null, schemeTxn: null, markup, offered: false };
  return {
    offered: true,
    ic,
    icTxn,
    scheme,
    schemeTxn,
    markup,
    buy: ic === null ? null : round2(ic + Number(scheme || 0) + Number(markup.rate_pct || 0)),
    buyTxn: icTxn === null ? null : round2(icTxn + Number(schemeTxn || 0) + Number(markup.txn_minor || 0)),
    split: num(row.split_pct),
  };
}

/** Money maths deserves rounding you can predict. */
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** Human sentence for where a buy rate came from, for the rep on the quote. */
export function costExplain(template, key, symbol = 'p') {
  const c = costFor(template, key);
  if (c.offered === false) return 'We do not sell this card type here — the merchant holds it direct';
  if (c.ic === null) return 'No interchange set for this card type';
  const parts = [`${c.ic}% + ${c.icTxn}${symbol} interchange`];
  if (c.scheme != null || c.schemeTxn != null) parts.push(`${c.scheme ?? 0}% + ${c.schemeTxn ?? 0}${symbol} scheme fees`);
  parts.push(`${c.markup.rate_pct}% + ${c.markup.txn_minor}${symbol} acquirer`);
  return parts.join(', plus ');
}

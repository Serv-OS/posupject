/* Reading a merchant's processing statement into a rate card.
 *
 * A statement does not have six rows. Toast, Square and most US processors
 * print FOUR: Visa/Mastercard/Discover swiped, the same keyed, then American
 * Express swiped and keyed. Debit and credit sit in ONE bucket, because the
 * merchant is charged one rate for both.
 *
 * That is not a formatting quirk, it is the incumbent's business model. On a
 * real Toast statement (MOZZ Provo, August 2026) the merchant pays 2.49% + 15c
 * on every Visa/Mastercard transaction. At their $40.95 average ticket that is
 * $1.17 whether the card is debit or credit, while debit costs the processor
 * about 54c and credit about $1.15. Nearly all the margin is on debit, and it
 * is only there because the price is not split.
 *
 * So we take the statement in its own shape. Our COST model still needs debit
 * apart from credit, because they cost us very different amounts, but that
 * split is our problem and not something to ask a customer for.
 *
 * Pure on purpose: no React, no Supabase, so the maths can be tested against a
 * real statement.
 */

export const STATEMENT_LINES = [
  { key: 'cp_vm', label: 'Visa / Mastercard / Discover', sub: 'Swiped, dipped, tapped', channel: 'cp', amex: false },
  { key: 'cnp_vm', label: 'Visa / Mastercard / Discover', sub: 'Keyed, online', channel: 'cnp', amex: false },
  { key: 'cp_amex', label: 'American Express', sub: 'Swiped, dipped, tapped', channel: 'cp', amex: true },
  { key: 'cnp_amex', label: 'American Express', sub: 'Keyed, online', channel: 'cnp', amex: true },
];
export const blankStatement = () => Object.fromEntries(STATEMENT_LINES.map(l => [l.key, { rate: '', fee: '', txns: '', volume: '' }]));

/** What the four statement lines add up to: their real cost, and their real effective rate. */
export function statementTotals(st) {
  let vol = 0, txns = 0, cost = 0;
  for (const l of STATEMENT_LINES) {
    const r = st[l.key] || {};
    const v = Number(r.volume || 0), n = Number(r.txns || 0);
    vol += v; txns += n;
    cost += v * (Number(r.rate) || 0) / 100 + n * (Number(r.fee) || 0) / 100;
  }
  return { vol, txns, cost, eff: vol > 0 ? cost / vol * 100 : 0, avg: txns > 0 ? vol / txns : 0 };
}

/**
 * Turn four statement lines into the six-row rate card.
 * The Visa/Mastercard rate is written to BOTH the credit and debit rows because
 * that is genuinely what the customer pays on each. Volume is split by the
 * debit share, which is the one number the statement cannot tell us.
 */
export function statementToRates(st, debitSharePct) {
  const d = Math.min(100, Math.max(0, Number(debitSharePct) || 0)) / 100;
  const t = statementTotals(st);
  const volOf = (k) => Number(st[k]?.volume || 0);
  const chTotal = { cp: volOf('cp_vm') + volOf('cp_amex'), cnp: volOf('cnp_vm') + volOf('cnp_amex') };
  const pct = (part, whole) => (whole > 0 ? round2(part / whole * 100) : 0);
  const out = {};
  for (const ch of ['cp', 'cnp']) {
    const vm = st[`${ch}_vm`] || {}, ax = st[`${ch}_amex`] || {};
    const vmVol = volOf(`${ch}_vm`), axVol = volOf(`${ch}_amex`);
    const vmShare = pct(vmVol, chTotal[ch]);
    out[`${ch}_vm_debit`] = { current_rate_pct: vm.rate ?? '', current_txn_fee: vm.fee ?? '', split: String(round2(vmShare * d)) };
    out[`${ch}_vm_credit`] = { current_rate_pct: vm.rate ?? '', current_txn_fee: vm.fee ?? '', split: String(round2(vmShare * (1 - d))) };
    out[`${ch}_amex`] = { current_rate_pct: ax.rate ?? '', current_txn_fee: ax.fee ?? '', split: String(pct(axVol, chTotal[ch])) };
  }
  return { rows: out, cp_volume: chTotal.cp, cnp_volume: chTotal.cnp, avg_txn_size: t.avg ? round2(t.avg) : '' };
}

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;


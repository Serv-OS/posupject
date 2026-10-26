/* Billing one invoice in stages: 50% deposit, 30% on install, 20% at go live.
 *
 * Peter asked for it on INV-1012 (Next Flavour Kitchens, £6,318). The invoice
 * becomes stage 1 and every later stage is a new draft invoice, so each stage
 * has its own number, its own pay link and its own place in the totals.
 *
 * Each stage is ONE line per VAT rate: "Stage 1 of 3: Deposit (50%)". Lines at
 * different rates are kept apart so the VAT still comes out right; a rate with
 * nothing to charge (free kit) gets no line. Pennies are rounded per stage and
 * the last stage takes whatever is left, so the stages add up to the original
 * net to the penny.
 */
import { round2 } from './money';
import { savableLines, lineValue } from './invoiceLines';

export const MAX_STAGES = 10;

export const STAGE_PRESETS = [
  { name: '50 / 50', stages: [{ label: 'Deposit', percent: 50 }, { label: 'Balance', percent: 50 }] },
  { name: '50 / 30 / 20', stages: [{ label: 'Deposit', percent: 50 }, { label: 'Installation', percent: 30 }, { label: 'Go live', percent: 20 }] },
  { name: '30 / 40 / 30', stages: [{ label: 'Deposit', percent: 30 }, { label: 'Installation', percent: 40 }, { label: 'Go live', percent: 30 }] },
];

/** Why these stages cannot be used, or '' when they can. */
export function stagesProblem(stages) {
  const list = stages || [];
  if (list.length < 2) return 'Add at least two stages.';
  if (list.length > MAX_STAGES) return `No more than ${MAX_STAGES} stages.`;
  if (list.some(s => !String(s.label || '').trim())) return 'Give every stage a name.';
  if (list.some(s => !(Number(s.percent) > 0))) return 'Every stage needs a percentage above 0.';
  const sum = round2(list.reduce((a, s) => a + Number(s.percent), 0));
  if (sum !== 100) return `The stages add up to ${sum}%. They must add up to 100%.`;
  return '';
}

/** Net value per VAT rate, in the order the rates first appear. Free lines drop out. */
export function netByRate(lines) {
  const out = new Map();
  for (const l of savableLines(lines)) {
    const rate = Number(l.tax_rate) || 0;
    out.set(rate, (out.get(rate) || 0) + lineValue(l));
  }
  return [...out].map(([rate, net]) => ({ rate, net: round2(net) })).filter(g => g.net !== 0);
}

/** A short list of what was ordered, for the stage line's description. */
export function orderSummary(lines) {
  return savableLines(lines).map(l => `${Number(l.qty) || 1} x ${String(l.name).trim()}`).join(', ');
}

/**
 * The lines for every stage: [[stage 1 lines], [stage 2 lines], ...].
 * fmt formats an amount in the invoice's currency for the description.
 */
export function stageLines(lines, stages, fmt = (v) => round2(v).toFixed(2)) {
  const groups = netByRate(lines);
  const n = stages.length;
  const many = groups.length > 1;
  const summary = orderSummary(lines);
  const given = groups.map(() => 0);
  return stages.map((s, i) => {
    const pct = Number(s.percent);
    const last = i === n - 1;
    return groups.map((g, gi) => {
      const amount = last ? round2(g.net - given[gi]) : round2(g.net * pct / 100);
      given[gi] = round2(given[gi] + amount);
      const name = `Stage ${i + 1} of ${n}: ${String(s.label).trim()} (${pct}%)${many ? ` at ${g.rate}% VAT` : ''}`;
      const description = [`${pct}% of ${fmt(g.net)} before tax.`, summary && `Full order: ${summary}.`].filter(Boolean).join(' ');
      return { name, description, qty: 1, unit_price: amount, tax_rate: g.rate };
    });
  });
}

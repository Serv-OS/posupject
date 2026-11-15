/* The deal pipeline for selling POS (Peter, 15 Nov 2026; migration 126).
 *
 * Lead work (new, contacted, qualified) happens on the Leads board; a deal
 * starts at Discovery. The card statement is its own step because the payments
 * saving is often why a venue switches. After Won, onboarding takes over
 * (payments checks, hardware and menu build, training, go-live).
 *
 * The one list every screen uses. Won and Lost keep their keys
 * (closed_won / closed_lost): quotes, onboarding and reports key on them.
 */
export const DEAL_STAGES = [
  { key: 'discovery',     label: 'Discovery',            color: '#3b82f6', probability: 0.10, hint: 'Sites, current system, pain points, decision maker, contract end date' },
  { key: 'statement',     label: 'Statement & Savings',  color: '#8b5cf6', probability: 0.25, hint: 'Card statement in, savings worked out' },
  { key: 'demo',          label: 'Demo',                 color: '#E8743C', probability: 0.45, hint: 'Booked and done; the date is on the deal' },
  { key: 'proposal_sent', label: 'Proposal Sent',        color: '#C75A29', probability: 0.65, hint: 'Quote with software, hardware and card rates' },
  { key: 'negotiation',   label: 'Negotiation',          color: '#eab308', probability: 0.85, hint: 'Pricing, terms, start date' },
  { key: 'closed_won',    label: 'Won',                  color: '#10b981', probability: 1, hint: 'Quote signed and deposit paid' },
  { key: 'closed_lost',   label: 'Lost',                 color: '#ef4444', probability: 0, hint: 'Say why' },
];

export const DEAL_STAGE_KEYS = DEAL_STAGES.map(s => s.key);
export const FIRST_DEAL_STAGE = 'discovery';
export const OPEN_DEAL_STAGES = DEAL_STAGE_KEYS.filter(k => k !== 'closed_won' && k !== 'closed_lost');

// Stage history written before 15 Nov uses the old keys; they still read as words.
const OLD = {
  new_lead: 'New Lead', contacted: 'Contacted', qualified: 'Qualified',
  demo_booked: 'Demo Booked', demo_done: 'Demo Done',
};
const LABEL = Object.fromEntries(DEAL_STAGES.map(s => [s.key, s.label]));
export const stageLabel = (k) => LABEL[k] || OLD[k] || (k ? String(k).replace(/_/g, ' ') : '');

export const DEFAULT_STAGE_WEIGHTS = Object.fromEntries(DEAL_STAGES.map(s => [s.key, s.probability]));

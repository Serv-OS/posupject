// In-memory Supabase for the design harness. Any query chain works; rows come from TABLES.
import {
  allocationEffect, amountPaid, amountReceivedEffect, cancelCreditEffect, creditAvailable, creditTotals, creditUse, issuedTotal, refundFor,
  refundProblem, removeAllocationEffect, validateCredit,
} from '../lib/creditNotes.js';
const d = (n) => { const x = new Date(); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
const ts = (n, h = 0) => { const x = new Date(); x.setDate(x.getDate() + n); x.setHours(x.getHours() - h); return x.toISOString(); };
const ME = 'u-peter';
export const MEMBERS = [{ id: 'u-peter', display_name: 'Peter', email: 'peter@posup.co.uk', role: 'owner' }, { id: 'u-sarah', display_name: 'Sarah', email: 'sarah@posup.co.uk', role: 'editor' }, { id: 'u-james', display_name: 'James', email: 'james@posup.co.uk', role: 'editor' }];
const COMPANIES = [{ id: 'c1', name: 'Coffee Boy — Barnsley', country: 'GB' }, { id: 'c2', name: 'Lightspeed POS UK Ltd', country: 'GB' }, { id: 'c3', name: 'Mozz Pizza', country: null }, { id: 'c4', name: 'Container Coffee Shops LTD', country: 'GB' }];
const LOCATIONS = [{ id: 'l1', name: 'Verde — Macclesfield', company_id: 'c2', status: 'live', phone: '01625 442 118', email: 'verde@example.com', address: '14 Mill Street', city: 'Macclesfield', postcode: 'SK11 6NN', venue_type: 'restaurant', covers: 80, go_live_date: '2026-03-14', owner_id: ME, created_at: ts(-200) }, { id: 'l2', name: 'Mozz — Provo', company_id: 'c3', status: 'live', country: 'US', venue_type: 'restaurant', covers: 60, owner_id: ME, created_at: ts(-30) }];
const LEADS = [{ id: 'lead1', name: 'Cafe Brigante - Leeds Center', stage: 'deal', deal_id: 'd1', source: 'website', priority: 'medium', venue_type: 'cafe', current_pos: 'Lightspeed', owner_id: ME, company_id: 'c1', location_id: 'l1', created_at: ts(-90) }];
const DEALS = [
  { id: 'd1', name: 'Coffee Boy — Barnsley Train Station', company_id: 'c1', stage: 'proposal_sent', owner_id: ME, hardware_value: 3200, services_value: 850, saas_arr: 1788, payments_arr: 0, expected_close_date: d(12), created_at: ts(-40), updated_at: ts(-3) },
  // A dollar deal, so the harness can prove nothing adds it to the pound ones.
  { id: 'dus1', name: 'Mozz Pizza — Provo', company_id: 'c3', currency: 'USD', stage: 'proposal_sent', owner_id: ME, hardware_value: 1774, services_value: 0, saas_arr: 3588, payments_arr: 0, expected_close_date: d(20), created_at: ts(-10), updated_at: ts(-1) },
  { id: 'd2', name: 'Verde — second site', company_id: 'c2', stage: 'negotiation', owner_id: 'u-sarah', hardware_value: 5400, services_value: 1200, saas_arr: 3576, payments_arr: 4100, expected_close_date: d(5), created_at: ts(-60), updated_at: ts(-1) },
  { id: 'd3', name: 'Hare and Hounds — till refresh', company_id: 'c2', stage: 'qualified', owner_id: ME, hardware_value: 1800, saas_arr: 1788, expected_close_date: d(-6), created_at: ts(-90), updated_at: ts(-35) },
  { id: 'd4', name: 'Cafe Brigante — Leeds', company_id: 'c1', stage: 'demo_booked', value: 2400, expected_close_date: null, created_at: ts(-20), updated_at: ts(-20) },
  { id: 'd5', name: 'Evuna — closed', company_id: 'c2', stage: 'closed_won', owner_id: ME, hardware_value: 4000, saas_arr: 1788, closed_at: ts(-2), created_at: ts(-70), updated_at: ts(-10) },
  // A won US deal, so Sales and Quota have to show pounds and dollars side by side.
  { id: 'd7', name: 'Mozz Pizza — Orem (won)', company_id: 'c3', currency: 'USD', stage: 'closed_won', owner_id: ME, hardware_value: 4000, saas_arr: 1788, closed_at: ts(-1), created_at: ts(-70), updated_at: ts(-10) },
  // An open US deal, so Reporting has to show pounds and dollars side by side.
  { id: 'd6', name: 'Mozz Pizza — Provo', company_id: 'c3', stage: 'negotiation', currency: 'USD', owner_id: ME, hardware_value: 1774, services_value: 0, saas_arr: 4188, payments_arr: 13750, expected_close_date: d(20), created_at: ts(-12), updated_at: ts(-2) },
];
const PROJECTS = [{ id: 'p1', name: 'Adyen Onboarding', status: 'active', subject_type: 'deal', subject_id: 'd1', owner_id: ME, due_date: d(9), created_at: ts(-6), updated_at: ts(0), phases: ['Account setup', 'Go live'] }, { id: 'p2', name: 'Verde refit', status: 'active', subject_type: 'location', subject_id: 'l1', owner_id: ME, due_date: d(20), created_at: ts(-3), updated_at: ts(0), phases: [] }];
const TASKS = [
  { id: 't1', title: 'Create Adyen company account', status: 'done', priority: 'P2', project_id: 'p1', phase: 'Account setup', owner_id: ME, due_date: d(-4), completed_at: ts(-4), created_at: ts(-6), updated_at: ts(-4), sort_order: 0 },
  { id: 't2', title: 'Upload KYC documents', status: 'done', priority: 'P2', project_id: 'p1', phase: 'Account setup', owner_id: 'u-sarah', due_date: d(-2), completed_at: ts(-1), created_at: ts(-6), updated_at: ts(-1), sort_order: 1 },
  { id: 't3', title: 'Unable to add sub account', status: 'in_progress', priority: 'P1', project_id: 'p1', phase: 'Account setup', owner_id: ME, due_date: d(0), description: 'Cannot add sub account — the button is missing from my account. Likely a permissions scope on the parent.', created_by: 'u-sarah', created_at: ts(-5), updated_at: ts(0, 1), sort_order: 2 },
  { id: 't4', title: 'Get access to live account', status: 'blocked', priority: 'P1', project_id: 'p1', phase: 'Go live', owner_id: ME, due_date: d(-2), blocked_reason: 'Adyen support ticket', created_at: ts(-5), updated_at: ts(0, 3), sort_order: 3 },
  { id: 't5', title: 'First live transaction test', status: 'todo', priority: 'P2', project_id: 'p1', phase: 'Go live', owner_id: 'u-sarah', due_date: d(9), depends_on_id: 't4', created_at: ts(-5), updated_at: ts(-5), sort_order: 4 },
  { id: 't6', title: 'Cool Guys — menu build', status: 'in_progress', priority: 'P2', project_id: 'p2', owner_id: 'u-james', due_date: d(3), created_at: ts(-2), updated_at: ts(0), sort_order: 0 },
  { id: 't7', title: 'Book install — Leeds', status: 'todo', priority: 'P2', project_id: 'p2', owner_id: ME, due_date: d(0), created_at: ts(-2), updated_at: ts(-1), sort_order: 1 },
  { id: 't8', title: 'Chase signed reseller agreement', status: 'todo', priority: 'P1', project_id: 'p2', owner_id: ME, due_date: d(-5), created_at: ts(-9), updated_at: ts(-2), sort_order: 2 },
  { id: 's1', title: 'Check parent verification', status: 'done', project_id: 'p1', parent_task_id: 't3', owner_id: ME, completed_at: ts(-1), created_at: ts(-2), updated_at: ts(-1), sort_order: 0 },
  { id: 's3', title: 'Raise Adyen support ticket', status: 'todo', project_id: 'p1', parent_task_id: 't3', owner_id: ME, created_at: ts(-2), updated_at: ts(-2), sort_order: 2 },
];
const W = (o) => ({ type: 'task', source_table: 'tasks', blocked_reason: null, created_by: ME, link: {}, ...o });
const WORK = [
  W({ type: 'ticket', source_table: 'tickets', source_id: 'k1', title: 'Card machine offline at lunch', subtitle: 'Verde — Macclesfield · 2.4 mi away', owner_id: ME, status: 'in_progress', priority: 'P1', due_at: new Date(Date.now() - 40 * 60e3).toISOString(), updated_at: ts(0) }),
  W({ type: 'onboarding', source_table: 'onboardings', source_id: 'o1', title: 'Fourelephants — hardware not shipped', subtitle: 'Stage 4 of 9', owner_id: ME, status: 'blocked', priority: 'P2', due_at: d(-11) + 'T00:00:00Z', updated_at: ts(-2) }),
  W({ type: 'approval', source_table: 'expenses', source_id: 'e1', title: 'Bill — Lightspeed POS UK Ltd', subtitle: '£2,480', owner_id: null, created_by: 'u-james', status: 'todo', priority: 'P2', due_at: d(0) + 'T09:00:00Z', updated_at: ts(0, 2) }),
  W({ source_id: 't3', title: 'Unable to add sub account', subtitle: 'Evuna — Northern Quarter · timer running', owner_id: ME, status: 'in_progress', priority: 'P1', due_at: d(0) + 'T00:00:00Z', updated_at: ts(0) }),
  W({ source_id: 't7', title: 'Book install — Leeds', subtitle: 'Cafe Brigante', owner_id: ME, status: 'todo', priority: 'P2', due_at: d(0) + 'T00:00:00Z', updated_at: ts(-1) }),
];
const TICKETS = [
  { id: 'k1', ticket_number: 1042, customer_email: 'dan@verde.example', channel: 'email', contact_id: 'ct1', subject: 'Card machine offline', priority: 'P1', stage: 'in_progress', location_id: 'l1', company_id: 'c2', sla_due_at: new Date(Date.now() - 40 * 60e3).toISOString(), first_response_due_at: new Date(Date.now() - 40 * 60e3).toISOString(), created_at: ts(0, 3) },
];
const ONBOARDINGS = [{ id: 'o2', name: 'LS FFA Onboarding', stage: 'quote_sent', location_id: 'l1', company_id: 'c2', created_at: ts(-4) }];
const CONTACTS = [{ id: 'ct1', first_name: 'Dan', last_name: 'Marsh', job_title: 'General manager', phone: '07700 900123', email: 'dan@verde.example' }];
const ASSOC = [{ from_type: 'location', from_id: 'l1', to_type: 'contact', to_id: 'ct1' }];
const NOTIFS = [
  { id: 'n1', type: 'mention', title: 'Sarah on FranPOS reseller agreement', body: '“@peter legal came back — needs your signature today”', entity_type: 'task', link_id: 't8', read_at: null, created_at: ts(0, 3), recipient_id: ME },
  { id: 'n2', type: 'reply', title: '#1039 — customer replied', body: 'Thanks, the terminal is back up now.', entity_type: 'ticket', link_id: 'k1', read_at: null, created_at: ts(0, 4), recipient_id: ME },
  { id: 'n3', type: 'assignment', title: 'You were assigned “Book install — Leeds”', body: null, entity_type: 'task', link_id: 't7', read_at: ts(-1), created_at: ts(-1), recipient_id: ME },
  { id: 'n4', type: 'system', title: 'Weekly digest is ready', body: null, entity_type: null, link_id: null, read_at: ts(-2), created_at: ts(-2), recipient_id: ME },
];
const BILLS = [
  { id: 'b1', bill_number: 4821, supplier_id: 's1', supplier: { name: 'Lightspeed POS UK Ltd' }, total: 2480, amount_paid: 0, status: 'to_pay', due_date: d(-4), supplier_ref: 'INV-4821', cost_context: 'ongoing', created_at: ts(-20) },
  { id: 'b2', bill_number: 4822, supplier_id: 's2', supplier: { name: 'Adyen N.V.' }, total: 612.4, amount_paid: 0, status: 'to_pay', due_date: d(9), cost_context: 'ongoing', recurring_id: 'r1', created_at: ts(-10) },
  // A dollar bill: the list must total it apart from the pound ones and label it in its own money.
  { id: 'bus1', bill_number: 4830, supplier_id: 's2', supplier: { name: 'Adyen N.V.' }, total: 1320.5, amount_paid: 0, status: 'to_pay', currency: 'USD', due_date: d(6), cost_context: 'ongoing', created_at: ts(-3) },
  { id: 'b3', bill_number: 4823, supplier_id: 's3', supplier: { name: 'Sumup Payments Ltd' }, total: 149, amount_paid: 0, status: 'draft', due_date: null, cost_context: 'deal', created_at: ts(-1) },
];
const QUOTES = [{ id: 'q1', quote_number: 118, deal_id: 'd1', status: 'draft', saas_start_days: 30, company_id: 'c2', contact_id: 'ct1', location_id: 'l1', currency: 'GBP', valid_until: d(30), payment_terms: 'deposit', deposit_percent: 25, terms: 'Payment 14 days from invoice.', notes: '', public_token: 'abc123', tax_rate: 20, processing_account_id: 'pa1' },
  // A DIFFERENT company on the SAME card: the Coffee Boy case, six sites across three companies.
  { id: 'q2', quote_number: 119, status: 'sent', company_id: 'c4', location_id: null, currency: 'GBP', valid_until: d(21), payment_terms: 'deposit', deposit_percent: 25, terms: '', notes: '', public_token: 'def456', tax_rate: 20, processing_account_id: 'pa1' }];
const QLINES = [
  { id: 'ql1', quote_id: 'q1', name: 'Lightspeed terminal', category: 'hardware', billing_type: 'one_off', qty: 2, unit_price: 390, discount: 0, tax_rate: 20, sort: 0 },
  { id: 'ql2', quote_id: 'q1', name: 'Card reader', category: 'hardware', billing_type: 'one_off', qty: 1, unit_price: 149, discount: 0, tax_rate: 20, sort: 1 },
  { id: 'ql3', quote_id: 'q1', name: 'Install & training', category: 'services', billing_type: 'one_off', qty: 4, unit_price: 60, discount: 10, tax_rate: 20, sort: 2 },
  { id: 'ql4', quote_id: 'q1', name: 'ServOS Growth', category: 'saas', billing_type: 'monthly', qty: 1, unit_price: 149, discount: 0, tax_rate: 20, line_total: 149, sort: 3 },
];
const PRODUCTS = [{ id: 'pr1', name: 'Lightspeed terminal', category: 'hardware', billing_type: 'one_off', default_price: 390, default_price_usd: 549, cost_price: 260, cost_price_usd: 340, active: true }, { id: 'pr2', name: 'Card reader', category: 'hardware', billing_type: 'one_off', default_price: 149, active: true }, { id: 'pr3', name: 'ServOS Growth', category: 'saas', billing_type: 'monthly', default_price: 149, default_price_usd: 199, active: true }, { id: 'pr4', name: 'Kiosk stand (US only)', category: 'hardware', billing_type: 'one_off', default_price: null, default_price_usd: 899, cost_price_usd: 610, active: true }];
const SERIALS = [{ id: 'sn1', serial: 'LS-88213', location_id: 'l1', product: { name: 'Lightspeed terminal' }, status: 'deployed' }, { id: 'sn2', serial: 'LS-88214', location_id: 'l1', product: { name: 'Lightspeed terminal' }, status: 'deployed' }, { id: 'sn3', serial: 'CR-1120', location_id: 'l1', product: { name: 'Card reader' }, status: 'deployed' }];
const ACTIVITIES = [
  { id: 'c1', type: 'call', direction: 'outbound', actor_id: ME, occurred_at: ts(0, 2), channel_metadata: { to: '+447700900123', duration_seconds: 182 }, contact_id: 'ct1', subject_type: 'contact', subject_id: 'ct1' },
  { id: 'c2', type: 'call', direction: 'inbound', actor_id: ME, occurred_at: ts(0, 5), channel_metadata: { from_number: '+441625442118', duration_seconds: 0 } },{ id: 'a1', type: 'note', is_internal: true, subject: 'Cannot add sub account button is missing from my account', body: 'Cannot add sub account button is missing from my account', actor_id: ME, occurred_at: ts(0, 0.05), subject_type: 'task', subject_id: 't3', created_at: ts(0, 0.05) }];
const TIME = [{ id: 'te1', profile_id: ME, subject_type: 'task', subject_id: 't3', started_at: ts(0, 1), ended_at: null, duration_seconds: 1440 }];
const STAGE_HISTORY = [
  { id: 'sh1', object_type: 'deal', object_id: 'd1', to_stage: 'proposal_sent', changed_at: ts(-3), changed_by: ME },
  { id: 'sh2', object_type: 'deal', object_id: 'd3', to_stage: 'qualified', changed_at: ts(-35), changed_by: ME },
];
const PROC_ACCOUNTS = [
  { id: 'pa1', label: 'Coffee Boy rate card', company_id: 'c1', location_id: 'l1', region_code: 'UK', status: 'live' },
  { id: 'pa2', label: 'Mozz Provo rate card', company_id: 'c3', location_id: 'l2', region_code: 'US', status: 'prospect' },
];
// £100k/mo at 1.20% against a 0.90% buy, plus 8,000 txns at 5p vs 3p.
// margin = (1200 + 400) - (900 + 240) = £460/mo -> £5,520 a year.
const PROC_RATES = [
  { id: 'pr1', account_id: 'pa1', category: 'cp_vm_debit', monthly_volume: 100000, monthly_txns: 8000, current_rate_pct: 1.6, our_rate_pct: 1.2, buy_rate_pct: 0.3, our_txn_fee: 8, buy_txn_fee: 3, volume_split_pct: 82 },
  // A US card, so every screen has to prove it renders dollars not pounds.
  { id: 'pr2', account_id: 'pa2', category: 'cp_vm_debit', monthly_volume: 60000, monthly_txns: 1700, current_rate_pct: 2.49, our_rate_pct: 1.4, buy_rate_pct: 0.60, our_txn_fee: 25, buy_txn_fee: 22.3, volume_split_pct: 55 },
  { id: 'pr3', account_id: 'pa2', category: 'cp_vm_credit', monthly_volume: 38000, monthly_txns: 1100, current_rate_pct: 2.49, our_rate_pct: 2.55, buy_rate_pct: 2.39, our_txn_fee: 12, buy_txn_fee: 9, volume_split_pct: 35 },
];
const WEIGHTS = [{ stage: 'qualified', probability: 0.25 }, { stage: 'demo_booked', probability: 0.4 }, { stage: 'proposal_sent', probability: 0.7 }, { stage: 'negotiation', probability: 0.85 }];
const COST_TEMPLATES = [
  { id: 'ct-uk', region_code: 'UK', effective_from: '2026-01-01', markup: { rate_pct: 0.10, txn_minor: 3 },
    note: 'UK interchange is percentage-only, IFR-capped, nothing per transaction. Our 0.10% + 5p is all-in above it (IC+).',
    rows: { cp_vm_credit: { ic_rate_pct: 0.30, ic_txn_minor: 0, split_pct: 15 },
            cp_vm_debit: { ic_rate_pct: 0.20, ic_txn_minor: 0, split_pct: 82 },
            cp_amex: { ic_rate_pct: 1.80, ic_txn_minor: 0, split_pct: 3 },
            cnp_vm_credit: { ic_rate_pct: 0.30, ic_txn_minor: 0, split_pct: 35 },
            cnp_vm_debit: { ic_rate_pct: 0.20, ic_txn_minor: 0, split_pct: 60 },
            cnp_amex: { ic_rate_pct: 1.80, ic_txn_minor: 0, split_pct: 5 } } },
  { id: 'ct-us', region_code: 'US', effective_from: '2026-01-01', markup: { rate_pct: 0.10, txn_minor: 5 },
    note: 'US interchange carries a per-transaction element (Durbin 21c + 1c on regulated debit).',
    rows: { cp_vm_credit: { ic_rate_pct: 2.29, ic_txn_minor: 4, split_pct: 35 },
            cp_vm_debit: { ic_rate_pct: 0.50, ic_txn_minor: 17.3, split_pct: 55 },
            cp_amex: { ic_rate_pct: 2.50, ic_txn_minor: 10, split_pct: 10 },
            cnp_vm_credit: { ic_rate_pct: 2.53, ic_txn_minor: 4, split_pct: 45 },
            cnp_vm_debit: { ic_rate_pct: 0.68, ic_txn_minor: 19.2, split_pct: 45 },
            cnp_amex: { ic_rate_pct: 2.80, ic_txn_minor: 10, split_pct: 10 } } },
];

// Harness only: a long email ticket, so the scroll, Reply all and note edit fixes can be seen.
// The latest email copies Kate and the ops inbox, and copies our own mailbox in capitals.
const TICKET_THREAD = [
  { id: 'e1', type: 'email', direction: 'inbound', subject: 'Card machine offline', body: 'Hi, our terminal went offline this morning. The card machine keeps dropping its connection during service and staff are taking cash instead. The card machine keeps dropping its connection during service and staff are taking cash instead.', subject_type: 'ticket', subject_id: 'k1', contact_id: 'ct1', is_internal: false, occurred_at: ts(0, 30), created_at: ts(0, 30), channel_metadata: { from: 'Dan Marsh <dan@verde.example>', gmail_message_id: 'gm-e1' } },
  { id: 'e2', type: 'email', direction: 'outbound', subject: 'Re: Card machine offline', body: 'Thanks Dan, we are looking into it now. The card machine keeps dropping its connection during service and staff are taking cash instead. The card machine keeps dropping its connection during service and staff are taking cash instead.', subject_type: 'ticket', subject_id: 'k1', actor_id: ME, is_internal: false, occurred_at: ts(0, 29), created_at: ts(0, 29), channel_metadata: { from: 'support@serv-os.app', to: 'dan@verde.example', gmail_message_id: 'gm-e2' } },
  { id: 'n1', type: 'note', body: 'Checked the terminal logs, it loses Wi-Fi every 20 minutes.', subject_type: 'ticket', subject_id: 'k1', actor_id: 'u-sarah', is_internal: true, occurred_at: ts(0, 28), created_at: ts(0, 28), channel_metadata: {} },
  { id: 'e3', type: 'email', direction: 'inbound', subject: 'Card machine offline', body: 'It happened again at lunch. The card machine keeps dropping its connection during service and staff are taking cash instead. The card machine keeps dropping its connection during service and staff are taking cash instead.', subject_type: 'ticket', subject_id: 'k1', contact_id: 'ct1', is_internal: false, occurred_at: ts(0, 26), created_at: ts(0, 26), channel_metadata: { from: 'Dan Marsh <dan@verde.example>', gmail_message_id: 'gm-e3' } },
  { id: 'e4', type: 'email', direction: 'outbound', subject: 'Re: Card machine offline', body: 'Could you try the ethernet cable in the box? The card machine keeps dropping its connection during service and staff are taking cash instead. The card machine keeps dropping its connection during service and staff are taking cash instead.', subject_type: 'ticket', subject_id: 'k1', actor_id: ME, is_internal: false, occurred_at: ts(0, 25), created_at: ts(0, 25), channel_metadata: { from: 'support@serv-os.app', to: 'dan@verde.example', gmail_message_id: 'gm-e4' } },
  { id: 'e5', type: 'email', direction: 'inbound', subject: 'Card machine offline', body: 'Ethernet is in, still dropping. The card machine keeps dropping its connection during service and staff are taking cash instead. The card machine keeps dropping its connection during service and staff are taking cash instead.', subject_type: 'ticket', subject_id: 'k1', contact_id: 'ct1', is_internal: false, occurred_at: ts(0, 20), created_at: ts(0, 20), channel_metadata: { from: 'Dan Marsh <dan@verde.example>', gmail_message_id: 'gm-e5' } },
  { id: 'e6', type: 'email', direction: 'outbound', subject: 'Re: Card machine offline', body: 'We will send a replacement unit. The card machine keeps dropping its connection during service and staff are taking cash instead. The card machine keeps dropping its connection during service and staff are taking cash instead.', subject_type: 'ticket', subject_id: 'k1', actor_id: ME, is_internal: false, occurred_at: ts(0, 19), created_at: ts(0, 19), channel_metadata: { from: 'support@serv-os.app', to: 'dan@verde.example', gmail_message_id: 'gm-e6' } },
  { id: 'n2', type: 'note', body: 'Chased Adyen, waiting on a replacment terminal.', subject_type: 'ticket', subject_id: 'k1', actor_id: 'u-peter', is_internal: true, occurred_at: ts(0, 18), created_at: ts(0, 18), channel_metadata: {} },
  { id: 'e7', type: 'email', direction: 'inbound', subject: 'Card machine offline', body: 'Any update on the replacement? The card machine keeps dropping its connection during service and staff are taking cash instead. The card machine keeps dropping its connection during service and staff are taking cash instead.', subject_type: 'ticket', subject_id: 'k1', contact_id: 'ct1', is_internal: false, occurred_at: ts(0, 10), created_at: ts(0, 10), channel_metadata: { from: 'Dan Marsh <dan@verde.example>', gmail_message_id: 'gm-e7' } },
  { id: 'e8', type: 'email', direction: 'outbound', subject: 'Re: Card machine offline', body: 'It ships today, tracking to follow. The card machine keeps dropping its connection during service and staff are taking cash instead. The card machine keeps dropping its connection during service and staff are taking cash instead.', subject_type: 'ticket', subject_id: 'k1', actor_id: ME, is_internal: false, occurred_at: ts(0, 9), created_at: ts(0, 9), channel_metadata: { from: 'support@serv-os.app', to: 'dan@verde.example', gmail_message_id: 'gm-e8' } },
  { id: 'e9', type: 'email', direction: 'inbound', subject: 'Card machine offline', body: 'Copying Kate who runs the floor and our ops inbox. The card machine keeps dropping its connection during service and staff are taking cash instead. The card machine keeps dropping its connection during service and staff are taking cash instead.', subject_type: 'ticket', subject_id: 'k1', contact_id: 'ct1', is_internal: false, occurred_at: ts(0, 2), created_at: ts(0, 2), channel_metadata: { from: 'Dan Marsh <dan@verde.example>', gmail_message_id: 'gm-e9', to: 'support@serv-os.app, ops@verde.example', cc: 'Kate Lowe <kate@verde.example>, SUPPORT@SERV-OS.APP' } },
  { id: 'n3', type: 'note', body: 'Tracking number sent to Dan.', subject_type: 'ticket', subject_id: 'k1', actor_id: 'u-peter', is_internal: true, occurred_at: ts(0, 0.2), created_at: ts(0, 0.2), channel_metadata: {} },
];
ACTIVITIES.push(...TICKET_THREAD);

// Harness only (#packcard): a submitted UK Organisation onboarding pack on the
// o2 onboarding, written the way the onboarding-form function writes one. The
// bank numbers, date of birth, home address and passport page are NOT in
// answers: answers only carry _held (built as heldFrom would build it) and
// _meta, and the values sit in the owner only onboarding_form_secure row.
const PACK_ID = 'rq1';
const PACK_PASSPORT = `${PACK_ID}/id_passport-a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d.jpg`;
const PACK_REQUESTS = [{
  id: PACK_ID, onboarding_id: 'o2', location_id: 'l1', company_id: 'c2', contact_id: 'ct1', token: 'harness-pack-card',
  sent_to: 'dan@verde.example', sent_at: ts(-6), opened_at: ts(-5), submitted_at: ts(-1, 2), created_at: ts(-6), created_by: ME, updated_at: ts(-1, 2),
  answers: {
    company: { entity_type: 'Organisation', legal_name: 'Verde Restaurants Ltd', address: '2 Chestergate\nMacclesfield\nSK11 6BA', company_number: '09876543', contact_name: 'Dan Marsh' },
    vat: { registered: 'Yes', number: 'GB220430231' },
    bank: { holder_same: 'Yes' },
    representative: { is_contact: 'No', name: 'Kate Lowe', phone: '+447700900456', email: 'kate@verde.example', home_same: 'No', id_type: 'Passport' },
    trading: { trading_name: 'Verde', same_address: 'No', trading_address: '14 Mill Street\nMacclesfield\nSK11 6NN' },
    receipt: { logo: { name: 'Verde logo.png', path: `onboarding/${PACK_ID}/0b7c-Verde_logo.png`, size: 184000, mime: 'image/png' }, footer: 'Thanks for eating with us. Find us at @verdemacc' },
    menu: { files: [{ name: 'Verde autumn menu.pdf', path: `onboarding/${PACK_ID}/4f1a-Verde_autumn_menu.pdf`, size: 1850000, mime: 'application/pdf' }], notes: 'Brunch runs until 3pm at weekends.' },
    users: { pos_users: 'Dan Marsh, 1234, Manager\nKate Lowe, 5678, Manager\nSam Reed, 2468, Staff', bo_users: 'dan@verde.example\nkate@verde.example' },
    discounts: { list: 'Staff 50%\nFriends and family 20%' },
    tables: { notes: 'Terrace tables T1 to T6 are outside.' },
    drinks_printing: { wanted: 'Yes', areas: 'Bar\n- Everything' },
    food_printing: { multiple: 'No' },
    current_pos: { system: 'Lightspeed K Series' },
    site_readiness: { network_by_us: 'No', internet: true, ethernet: true, wifi_coverage: true, power: true },
    network: { wifi_name: 'VerdeStaff', wifi_password: 'basilandlime26' },
    signoff: { full_name: 'Kate Lowe', position: 'Director', agreed: true },
    _held: { 'bank.sort_code': true, 'bank.account_number': { hint: '6819' }, 'representative.dob': true, 'representative.home_address': true, 'representative.id_passport': true },
    _meta: { v: 2, region: 'UK', saved_at: ts(-1, 3), terms_version: 2 },
  },
}];
const PACK_SECURE = [{
  request_id: PACK_ID,
  secure_values: { 'bank.sort_code': '309634', 'bank.account_number': '31926819', 'representative.dob': '1985-07-14', 'representative.home_address': '9 Hollin Lane\nSutton\nMacclesfield SK11 0HR' },
  files: { 'representative.id_passport': { path: PACK_PASSPORT, name: 'Passport photo page.jpg', size: 412000, mime: 'image/jpeg' } },
  updated_at: ts(-1, 2), purged_at: null, purged_by: null,
}];
// A second submitted pack on a second onboarding (#packcard has a switcher),
// so a detail shown on one card can be checked never to carry over to the next.
const PACK2_ID = 'rq2';
ONBOARDINGS.push({ id: 'o3', name: 'Hare and Hounds onboarding', stage: 'kickoff', location_id: 'l1', company_id: 'c2', created_at: ts(-2) });
PACK_REQUESTS.push({
  id: PACK2_ID, onboarding_id: 'o3', location_id: 'l1', company_id: 'c2', token: 'harness-pack-card-2',
  sent_to: 'kate@hare.example', sent_at: ts(-3), opened_at: ts(-3), submitted_at: ts(-1), created_at: ts(-3), created_by: ME, updated_at: ts(-1),
  answers: {
    company: { entity_type: 'Organisation', legal_name: 'Hare and Hounds Ltd', address: '1 Market Place\nMacclesfield\nSK10 1EX', company_number: '07654321', contact_name: 'Kate Lowe' },
    vat: { registered: 'No' },
    bank: { holder_same: 'Yes' },
    representative: { is_contact: 'Yes', phone: '+447700900789', email: 'kate@hare.example', home_same: 'Yes', id_type: 'Driving licence' },
    trading: { trading_name: 'Hare and Hounds', same_address: 'Yes' },
    signoff: { full_name: 'Kate Lowe', position: 'Owner', agreed: true },
    _held: { 'bank.sort_code': true, 'bank.account_number': { hint: '4455' }, 'representative.dob': true, 'representative.id_front': { doc: 'Driving licence' }, 'representative.id_back': { doc: 'Driving licence' } },
    _meta: { v: 2, region: 'UK', saved_at: ts(-1), terms_version: 2 },
  },
});
PACK_SECURE.push({
  request_id: PACK2_ID,
  secure_values: { 'bank.sort_code': '112233', 'bank.account_number': '99884455', 'representative.dob': '1979-02-03' },
  files: {
    'representative.id_front': { path: `${PACK2_ID}/id_front-1a2b3c4d.jpg`, name: 'Photo ID front.jpg', size: 1000, mime: 'image/jpeg', doc: 'Driving licence' },
    'representative.id_back': { path: `${PACK2_ID}/id_back-5e6f7a8b.jpg`, name: 'Photo ID back.jpg', size: 1000, mime: 'image/jpeg', doc: 'Driving licence' },
  },
  updated_at: ts(-1), purged_at: null, purged_by: null,
});

// Harness only (#creditnote, #invoice-credits, #invoice-paid): credit notes.
// INV-1045 is a sent invoice with three lines at mixed tax (20%, 5% and 0%),
// its totals stored unrounded the way InvoiceBuilder saves them, one issued
// credit note (CN-1001) and one cancelled (CN-1002). INV-1046 is paid in full
// with no credit yet, so a credit raised on it owes a refund and Mark refunded
// can be tried. The joined names (company, location, invoice) are on the rows
// because this stub ignores joins in select().
const INV_PARTIES = { company_id: 'c2', location_id: 'l1', contact_id: 'ct1', company: { name: COMPANIES.find((c) => c.id === 'c2').name }, location: { name: LOCATIONS.find((l) => l.id === 'l1').name } };
const INVOICES = [
  { id: 'inv1045', invoice_number: 1045, status: 'sent', ...INV_PARTIES, currency: 'GBP', tax_rate: 20,
    issue_date: d(-20), due_date: d(-6), email_to: 'dan@verde.example', po_number: 'PO-7731', public_token: 'harness-inv-1045',
    subtotal: 991.5, tax_amount: 159.125, total: 1150.625, amount_paid: null, amount_credited: 468, amount_allocated: 0,
    terms: 'Payment within 14 days.', notes: null, sent_at: ts(-20), viewed_at: ts(-19), paid_at: null, created_by: ME, created_at: ts(-20), updated_at: ts(-3) },
  { id: 'inv1046', invoice_number: 1046, status: 'paid', ...INV_PARTIES, currency: 'GBP', tax_rate: 20,
    issue_date: d(-12), due_date: d(2), email_to: 'dan@verde.example', po_number: null, public_token: 'harness-inv-1046',
    subtotal: 298, tax_amount: 59.6, total: 357.6, amount_paid: 357.6, amount_credited: 0, amount_allocated: 0,
    terms: null, notes: null, sent_at: ts(-12), viewed_at: ts(-11), paid_at: ts(-10), created_by: ME, created_at: ts(-12), updated_at: ts(-10) },
];
const INVOICE_LINES = [
  { id: 'il1', invoice_id: 'inv1045', name: 'Lightspeed terminal', description: 'Countertop, with stand', qty: 2, unit_price: 390, tax_rate: 20, sort: 0 },
  { id: 'il2', invoice_id: 'inv1045', name: 'Printed table menus', description: null, qty: 50, unit_price: 1.25, tax_rate: 5, sort: 1 },
  { id: 'il3', invoice_id: 'inv1045', name: 'Card processing set up', description: 'Zero rated', qty: 1, unit_price: 149, tax_rate: 0, sort: 2 },
  { id: 'il4', invoice_id: 'inv1046', name: 'Card reader', description: null, qty: 2, unit_price: 149, tax_rate: 20, sort: 0 },
];
const CN_COMMON = { amount_allocated: 0, refunded_amount: 0, refunded_at: null, refund_method: null, refund_note: null, sent_at: null, cancelled_at: null, cancelled_by: null, cancel_reason: null, created_by: ME };
const CREDIT_NOTES = [
  { id: 'cn1001', credit_number: 1001, invoice_id: 'inv1045', ...INV_PARTIES, invoice: { invoice_number: 1045 }, status: 'issued', issue_date: d(-3),
    reason: 'One terminal came back unused.', subtotal: 390, tax_amount: 78, total: 468, currency: 'GBP', refund_status: 'none', refund_due: 0,
    public_token: 'harness-cn-1001', ...CN_COMMON, email_to: 'dan@verde.example', sent_at: ts(-3), created_at: ts(-3), updated_at: ts(-3) },
  { id: 'cn1002', credit_number: 1002, invoice_id: 'inv1045', ...INV_PARTIES, invoice: { invoice_number: 1045 }, status: 'cancelled', issue_date: d(-2),
    reason: 'Goodwill for the late install.', subtotal: 50, tax_amount: 10, total: 60, currency: 'GBP', refund_status: 'none', refund_due: 0,
    public_token: 'harness-cn-1002', ...CN_COMMON, email_to: null, created_at: ts(-2), updated_at: ts(-1),
    cancelled_at: ts(-1), cancelled_by: ME, cancel_reason: 'Raised against the wrong invoice.' },
];
const CREDIT_NOTE_LINES = [
  { id: 'cnl1', credit_note_id: 'cn1001', invoice_line_id: 'il1', name: 'Lightspeed terminal', description: 'Countertop, with stand', qty: 1, unit_price: 390, tax_rate: 20, sort: 0 },
  { id: 'cnl2', credit_note_id: 'cn1002', invoice_line_id: null, name: 'Goodwill credit', description: null, qty: 1, unit_price: 50, tax_rate: 20, sort: 0 },
];
// Harness only (#allocate, #invoice-allocated): credit applied to another
// invoice, with Peter's own figures. Coffee Boy (c1) paid INV-1047's £1,000 in
// full, then CN-1003 took £224 off it, so CN-1003 has £224 of credit
// available. INV-1050 is Coffee Boy's next £1,000 invoice, not paid yet:
// #allocate opens the apply screen on CN-1003, where INV-1050 is that
// customer's one unpaid invoice and the amount starts at £224. Container
// Coffee Shops (c4) is the same story already done, so #invoice-allocated
// opens INV-1049 on its "Credit applied CN-1004" row and £776.00 balance
// without applying anything first; CN-1004 on INV-1048 reads Used.
const partiesOf = (companyId, email) => ({
  company_id: companyId, location_id: null, contact_id: null, email_to: email,
  company: { name: COMPANIES.find((c) => c.id === companyId).name }, location: null,
});
const COFFEE_BOY = partiesOf('c1', 'accounts@coffeeboy.example');
const CONTAINER = partiesOf('c4', 'finance@containercoffee.example');
// Two self order kiosks at 20% and a zero rated set up: 840 + 160 = 1,000.
const THOUSAND = { currency: 'GBP', tax_rate: 20, subtotal: 840, tax_amount: 160, total: 1000, po_number: null, terms: null, notes: null, created_by: ME };
INVOICES.push(
  { id: 'inv1047', invoice_number: 1047, status: 'paid', ...COFFEE_BOY, ...THOUSAND, amount_paid: 1000, amount_credited: 224, amount_allocated: 0,
    issue_date: d(-30), due_date: d(-16), public_token: 'harness-inv-1047', sent_at: ts(-30), viewed_at: ts(-29), paid_at: ts(-25), created_at: ts(-30), updated_at: ts(-4) },
  { id: 'inv1048', invoice_number: 1048, status: 'paid', ...CONTAINER, ...THOUSAND, amount_paid: 1000, amount_credited: 224, amount_allocated: 0,
    issue_date: d(-28), due_date: d(-14), public_token: 'harness-inv-1048', sent_at: ts(-28), viewed_at: ts(-27), paid_at: ts(-24), created_at: ts(-28), updated_at: ts(-3) },
  { id: 'inv1049', invoice_number: 1049, status: 'viewed', ...CONTAINER, ...THOUSAND, amount_paid: null, amount_credited: 0, amount_allocated: 224,
    issue_date: d(-6), due_date: d(8), public_token: 'harness-inv-1049', sent_at: ts(-6), viewed_at: ts(-5), paid_at: null, created_at: ts(-6), updated_at: ts(-1) },
  { id: 'inv1050', invoice_number: 1050, status: 'sent', ...COFFEE_BOY, ...THOUSAND, amount_paid: null, amount_credited: 0, amount_allocated: 0,
    issue_date: d(-2), due_date: d(12), public_token: 'harness-inv-1050', sent_at: ts(-2), viewed_at: null, paid_at: null, created_at: ts(-2), updated_at: ts(-2) },
);
['inv1047', 'inv1048', 'inv1049', 'inv1050'].forEach((id) => INVOICE_LINES.push(
  { id: `${id}-l1`, invoice_id: id, name: 'Self order kiosk', description: 'Screen, stand and card reader', qty: 2, unit_price: 400, tax_rate: 20, sort: 0 },
  { id: `${id}-l2`, invoice_id: id, name: 'Card processing set up', description: 'Zero rated', qty: 1, unit_price: 40, tax_rate: 0, sort: 1 },
));
// £192 off the kiosks (£160 plus £32 VAT) and a £32 goodwill credit: £224.
const KIOSK_CREDIT = { status: 'issued', currency: 'GBP', reason: 'A kiosk stand came back unused, and goodwill for the late install.', subtotal: 192, tax_amount: 32, total: 224, refund_due: 224, ...CN_COMMON };
CREDIT_NOTES.push(
  { id: 'cn1003', credit_number: 1003, invoice_id: 'inv1047', ...COFFEE_BOY, invoice: { invoice_number: 1047 }, ...KIOSK_CREDIT, issue_date: d(-4),
    refund_status: 'owed', public_token: 'harness-cn-1003', sent_at: ts(-4), created_at: ts(-4), updated_at: ts(-4) },
  { id: 'cn1004', credit_number: 1004, invoice_id: 'inv1048', ...CONTAINER, invoice: { invoice_number: 1048 }, ...KIOSK_CREDIT, issue_date: d(-3),
    refund_status: 'allocated', amount_allocated: 224, public_token: 'harness-cn-1004', sent_at: ts(-3), created_at: ts(-3), updated_at: ts(-1) },
);
[['cn1003', 'inv1047'], ['cn1004', 'inv1048']].forEach(([id, invId]) => CREDIT_NOTE_LINES.push(
  { id: `${id}-l1`, credit_note_id: id, invoice_line_id: `${invId}-l1`, name: 'Self order kiosk', description: 'Stand returned', qty: 1, unit_price: 160, tax_rate: 20, sort: 0 },
  { id: `${id}-l2`, credit_note_id: id, invoice_line_id: null, name: 'Goodwill credit', description: 'Late install', qty: 1, unit_price: 32, tax_rate: 0, sort: 1 },
));
const CREDIT_ALLOCATIONS = [
  { id: 'alloc1', credit_note_id: 'cn1004', invoice_id: 'inv1049', amount: 224, allocated_on: d(-1), note: 'They paid £224 less against this invoice.',
    created_by: ME, created_at: ts(-1), removed_at: null, removed_by: null, remove_reason: null },
];
// Harness only (#received, #creditnotes-list): the INV-1036 case from 14 Sep
// 2026, on Coffee Boy (c1). £1,344 total with the VAT built in by mistake,
// CN-1005 took the £224 off, then Mark paid recorded the £1,120 left although
// the customer had sent £1,344. So it reads paid with £1,120 received and
// CN-1005 "Used on INV-1036", with no credit to use. #received opens Change on
// it: £1,344 puts £224 to use on CN-1005, which can go on INV-1050 (Coffee
// Boy's next £1,000 invoice), and after that £1,120 again is refused.
INVOICES.push(
  { id: 'inv1036', invoice_number: 1036, status: 'paid', ...COFFEE_BOY, currency: 'GBP', tax_rate: 20, subtotal: 1120, tax_amount: 224, total: 1344,
    po_number: null, terms: null, notes: null, created_by: ME, amount_paid: 1120, amount_credited: 224, amount_allocated: 0,
    issue_date: d(-9), due_date: d(5), public_token: 'harness-inv-1036', sent_at: ts(-9), viewed_at: ts(-8), paid_at: ts(0, 2), created_at: ts(-9), updated_at: ts(0, 2) },
);
INVOICE_LINES.push(
  { id: 'inv1036-l1', invoice_id: 'inv1036', name: 'Kiosk install and training', description: 'Priced with the VAT already in it', qty: 1, unit_price: 1120, tax_rate: 20, sort: 0 },
);
CREDIT_NOTES.push(
  { id: 'cn1005', credit_number: 1005, invoice_id: 'inv1036', ...COFFEE_BOY, invoice: { invoice_number: 1036 }, ...CN_COMMON, status: 'issued', issue_date: d(0),
    reason: 'VAT was added to a price that already included it.', subtotal: 186.67, tax_amount: 37.33, total: 224, currency: 'GBP', refund_status: 'none', refund_due: 0,
    public_token: 'harness-cn-1005', created_at: ts(0, 2), updated_at: ts(0, 2) },
);
CREDIT_NOTE_LINES.push(
  { id: 'cn1005-l1', credit_note_id: 'cn1005', invoice_line_id: 'inv1036-l1', name: 'Kiosk install and training', description: 'VAT charged twice', qty: 1, unit_price: 186.67, tax_rate: 20, sort: 0 },
);
// Every change to an amount received, written by set_invoice_amount_received
// below. None yet: INV-1036 was marked paid before there was a history.
const PAYMENT_ADJUSTMENTS = [];
const SUPPORT_SETTINGS = [{ id: 1, business_name: 'ServOS', business_address: '1 Harness Street, Manchester M1 1AA', business_email: 'accounts@serv-os.app', business_phone: '0161 000 0000', logo_url: null, quote_accent: '#15C26A', invoice_terms: 'Payment within 14 days of the invoice date.' }];

export const TABLES = { gmail_connections_safe: [{ email: 'support@serv-os.app' }], user_integrations: [{ profile_id: ME, provider: 'google', email: 'peter@posup.co.uk' }], ticket_email_threads: [], processing_cost_templates: COST_TEMPLATES, monthly_volumes: [], deal_stage_weights: WEIGHTS, deal_trading: [
  // Dollar rows, so the Volume tab has to show pounds and dollars side by side.
  { deal_id: 'd7', name: 'Mozz Pizza — Orem (won)', stage: 'closed_won', owner_id: ME, company_id: 'c3', currency: 'USD', closed_at: ts(-1), site_count: 1, est_monthly_revenue: 98000, est_avg_transaction: 41, est_monthly_transactions: 2400, actual_monthly_revenue: 0, probability: 1, weighted_monthly_revenue: 98000, is_won: true, is_closed: true },
  { deal_id: 'd6', name: 'Mozz Pizza — Provo', stage: 'negotiation', owner_id: ME, company_id: 'c3', currency: 'USD', site_count: 1, est_monthly_revenue: 131554, est_avg_transaction: 44, est_monthly_transactions: 3004, probability: 0.85, weighted_monthly_revenue: 111821, is_won: false, is_closed: false },
    // Venue turnover per deal, one in each region: the Volume tab must never add these two.
    { deal_id: 'd1', name: 'Coffee Boy — Barnsley Train Station', company_id: 'c1', stage: 'proposal_sent', site_count: 1, est_monthly_revenue: 42000, est_monthly_transactions: 5000, est_avg_transaction: 8.4 },
    { deal_id: 'dus1', name: 'Mozz Pizza — Provo', company_id: 'c3', stage: 'proposal_sent', site_count: 1, est_monthly_revenue: 131554, est_monthly_transactions: 3004, est_avg_transaction: 43.79 },
  ], location_modules: [], modules: [], feature_requests: [], profiles: MEMBERS, companies: COMPANIES, locations: LOCATIONS, deals: DEALS, crm_projects: PROJECTS, tasks: TASKS, work_items: WORK, tickets: TICKETS, onboardings: ONBOARDINGS, contacts: CONTACTS, associations: ASSOC, notifications: NOTIFS, bills: BILLS, quotes: QUOTES, quote_line_items: QLINES, products: PRODUCTS, inv_serials: SERIALS, crm_activities: ACTIVITIES, time_entries: TIME, expenses: [
    { id: 'ex1', expense_date: d(-2), description: 'Provo site visit, taxis', merchant: 'Uber', amount: 84.2, net: 84.2, vat_amount: 0, total: 84.2, currency: 'USD', status: 'submitted', company_id: 'c3', location_id: 'l2', created_by: ME, created_at: ts(-2) },
    { id: 'ex2', expense_date: d(-5), description: 'Train to Macclesfield', merchant: 'Northern', amount: 32.5, net: 32.5, vat_amount: 0, total: 32.5, currency: 'GBP', status: 'submitted', company_id: 'c2', location_id: 'l1', created_by: ME, created_at: ts(-5) },
  ], bill_schedules: [], recurring_bills: [], suppliers: [{ id: 's1', name: 'Lightspeed POS UK Ltd' }, { id: 's2', name: 'Adyen N.V.' }, { id: 's3', name: 'Sumup Payments Ltd' }], expense_categories: [{ id: 'ec1', label: 'Software', active: true, sort: 1 }], attachments: [], processing_accounts: PROC_ACCOUNTS, processing_rates: PROC_RATES, leads: LEADS, stage_history: STAGE_HISTORY,
  onboarding_form_requests: PACK_REQUESTS, onboarding_form_secure: PACK_SECURE,
  invoices: INVOICES, invoice_line_items: INVOICE_LINES, credit_notes: CREDIT_NOTES, credit_note_lines: CREDIT_NOTE_LINES, support_settings: SUPPORT_SETTINGS,
  credit_allocations: CREDIT_ALLOCATIONS, invoice_payment_adjustments: PAYMENT_ADJUSTMENTS };
export const MEMBERS_LIST = MEMBERS;

// Harness only: delete() really removes rows from these tables, so saving an
// invoice (which deletes and re-inserts its lines) does not leave the old lines
// behind. Every other table keeps delete() as a no-op, as it always was.
const DELETES = new Set(['invoices', 'invoice_line_items', 'credit_notes', 'credit_note_lines']);

function makeQuery(table) {
  let rows = (TABLES[table] || []).slice(); let head = false; let single = false; let patch = null; let inserted = null; let removing = false;
  // Harness only: an update changes the rows the filters matched and an insert
  // adds rows, the way the database would, so note edits and new notes show up.
  const res = () => {
    if (inserted) { (TABLES[table] = TABLES[table] || []).push(...inserted); rows = inserted; inserted = null; }
    if (removing) {
      const all = TABLES[table] || [];
      for (const r of rows) { const i = all.indexOf(r); if (i >= 0) all.splice(i, 1); }
      removing = false;
    }
    if (patch) {
      rows.forEach((r) => { const textChanged = table === 'crm_activities' && 'body' in patch && patch.body !== r.body; Object.assign(r, patch); if (textChanged) r.edited_at = new Date().toISOString(); });
      patch = null;
    }
    return { data: single ? (rows[0] ?? null) : head ? null : rows, error: null, count: rows.length };
  };
  const filt = (fn) => { rows = rows.filter(fn); return proxy; };
  const api = {
    select: (_c, o) => { if (o?.head) head = true; return proxy; },
    eq: (k, v) => filt(r => r[k] === v), neq: (k, v) => filt(r => r[k] !== v), in: (k, a) => filt(r => a.includes(r[k])),
    is: (k, v) => filt(r => (v === null ? r[k] == null : r[k] === v)), not: () => proxy, or: () => proxy, gte: () => proxy, lte: () => proxy, gt: () => proxy, lt: () => proxy, ilike: () => proxy, like: () => proxy, contains: () => proxy, textSearch: () => proxy,
    order: () => proxy, limit: (n) => { rows = rows.slice(0, n); return proxy; }, range: () => proxy,
    single: () => { single = true; return proxy; }, maybeSingle: () => { single = true; return proxy; },
    insert: (v) => { const now = new Date().toISOString(); inserted = (Array.isArray(v) ? v : [v]).map((r) => ({ id: `stub-${Math.random().toString(36).slice(2, 9)}`, created_at: now, occurred_at: now, ...r })); return proxy; },
    update: (v) => { patch = v; return proxy; }, upsert: (v, o) => { const keys = String(o?.onConflict || 'id').split(',').map((k) => k.trim()); const all = (TABLES[table] = TABLES[table] || []); const now = new Date().toISOString(); inserted = (Array.isArray(v) ? v : [v]).map((r) => { const i = all.findIndex((x) => keys.every((k) => x[k] === r[k])); if (i >= 0) all.splice(i, 1); return { id: `stub-${Math.random().toString(36).slice(2, 9)}`, created_at: now, ...r }; }); return proxy; }, delete: () => { removing = DELETES.has(table); return proxy; },
    then: (r, j) => Promise.resolve(res()).then(r, j), catch: (j) => Promise.resolve(res()).catch(j), finally: (f) => Promise.resolve(res()).finally(f),
  };
  const proxy = new Proxy(api, { get: (t, k) => (k in t ? t[k] : () => proxy) });
  return proxy;
}
// Harness only: storage in memory, one list of object paths per bucket, and a
// log of every call so a check can see what the card signed and removed. The
// secure bucket holds the seeded passport page plus a stray upload that was
// never saved, which "Delete ID and bank details" has to sweep up as well.
export const BUCKETS = { 'onboarding-secure': [PACK_PASSPORT, `${PACK_ID}/id_front-9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f.png`, `${PACK2_ID}/id_front-1a2b3c4d.jpg`, `${PACK2_ID}/id_back-5e6f7a8b.jpg`] };
export const STORAGE_CALLS = [];
// A stand in picture for a signed ID link, so View opens something readable.
// Made in this page, so the tab the card opened may be pointed at it.
const sampleIdUrl = (path) => URL.createObjectURL(new Blob([
  `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420"><rect width="640" height="420" fill="#eef1f4"/><rect x="24" y="24" width="592" height="372" rx="18" fill="#fff" stroke="#9aa4ad"/><rect x="56" y="80" width="150" height="190" rx="8" fill="#cfd6dc"/><text x="240" y="120" font-family="sans-serif" font-size="30" fill="#0f1211">Sample ID</text><text x="240" y="160" font-family="sans-serif" font-size="18" fill="#5e665e">Design harness only</text><text x="56" y="340" font-family="monospace" font-size="14" fill="#5e665e">${path}</text></svg>`,
], { type: 'image/svg+xml' }));
const bucketApi = (bucket) => {
  const log = (...a) => { STORAGE_CALLS.push([bucket, ...a]); };
  return {
    upload: (path) => { log('upload', path); return Promise.resolve({ error: null }); },
    createSignedUrl: (path, seconds) => {
      log('createSignedUrl', path, seconds);
      if (bucket !== 'onboarding-secure') return Promise.resolve({ data: { signedUrl: '#' }, error: null });
      if (!(BUCKETS[bucket] || []).includes(path)) return Promise.resolve({ data: null, error: { message: 'Object not found' } });
      return Promise.resolve({ data: { signedUrl: sampleIdUrl(path) }, error: null });
    },
    // Objects straight inside the folder, shaped like storage-api's listing.
    list: (prefix = '', opts = {}) => {
      log('list', prefix, opts);
      const dir = prefix ? `${prefix.replace(/\/+$/, '')}/` : '';
      const data = (BUCKETS[bucket] || []).filter((p) => p.startsWith(dir) && !p.slice(dir.length).includes('/'))
        .map((p) => ({ id: `obj-${p}`, name: p.slice(dir.length), metadata: { size: 1000, mimetype: 'image/jpeg' } }));
      return Promise.resolve({ data, error: null });
    },
    remove: (paths = []) => {
      log('remove', paths);
      BUCKETS[bucket] = (BUCKETS[bucket] || []).filter((p) => !paths.includes(p));
      return Promise.resolve({ data: paths.map((name) => ({ name })), error: null });
    },
    getPublicUrl: () => ({ data: { publicUrl: '#' } }),
  };
};

// Harness only: the credit note and applied credit database functions, in
// memory. They run the rules from src/lib/creditNotes.js, which carries the
// SQL's sums and its messages word for word, so the raise screen, Mark
// refunded, Cancel, the apply screen and Remove behave as they will live.
// Every other rpc answers as it always did.
const creditFail = (message) => ({ data: null, error: { message } });
const syncCredited = (invoiceId) => {
  const inv = TABLES.invoices.find((i) => i.id === invoiceId);
  if (!inv) return;
  inv.amount_credited = issuedTotal(TABLES.credit_notes.filter((c) => c.invoice_id === invoiceId));
  inv.updated_at = new Date().toISOString();
};
function creditRpc(name, args = {}) {
  const now = new Date().toISOString();
  if (name === 'issue_credit_note') {
    const inv = TABLES.invoices.find((i) => i.id === args.p_invoice_id);
    if (!inv) return creditFail('Invoice not found.');
    const invoiceLines = TABLES.invoice_line_items.filter((l) => l.invoice_id === inv.id);
    const issuedIds = TABLES.credit_notes.filter((c) => c.invoice_id === inv.id && c.status === 'issued').map((c) => c.id);
    const creditedLines = TABLES.credit_note_lines.filter((l) => issuedIds.includes(l.credit_note_id));
    const lines = Array.isArray(args.p_lines) ? args.p_lines : [];
    // today is the database's own date, UTC.
    const problems = validateCredit({ invoice: inv, lines, reason: args.p_reason, invoiceLines, creditedLines, issueDate: args.p_issue_date, today: now.slice(0, 10) });
    if (problems.length) return creditFail(problems[0]);
    const totals = creditTotals(lines);
    const number = Math.max(1000, ...TABLES.credit_notes.map((c) => c.credit_number)) + 1;
    const note = {
      id: `cn${number}`, credit_number: number, invoice_id: inv.id,
      company_id: inv.company_id, location_id: inv.location_id, contact_id: inv.contact_id,
      company: inv.company, location: inv.location, invoice: { invoice_number: inv.invoice_number },
      status: 'issued', issue_date: args.p_issue_date || now.slice(0, 10), reason: String(args.p_reason).trim(),
      ...totals, currency: inv.currency || 'GBP', ...refundFor({ invoice: inv, creditTotal: totals.total }),
      public_token: `harness-cn-${number}`, ...CN_COMMON, email_to: inv.email_to, created_at: now, updated_at: now,
    };
    TABLES.credit_notes.push(note);
    lines.forEach((l, i) => TABLES.credit_note_lines.push({
      id: `cnl${number}-${i}`, credit_note_id: note.id, invoice_line_id: l.invoice_line_id || null,
      name: String(l.name).trim(), description: String(l.description || '').trim() || null,
      qty: Number(l.qty), unit_price: Number(l.unit_price), tax_rate: Number(l.tax_rate) || 0, sort: i,
    }));
    syncCredited(inv.id);
    return { data: { ...note }, error: null };
  }
  if (name === 'allocate_credit') {
    // The same checks, sums and settling as allocate_credit (allocationEffect).
    const cn = TABLES.credit_notes.find((c) => c.id === args.p_credit_note_id);
    const inv = TABLES.invoices.find((i) => i.id === args.p_invoice_id);
    const effect = allocationEffect({ note: cn, invoice: inv, amount: args.p_amount, allocationNote: args.p_note });
    if (effect.problem) return creditFail(effect.problem);
    const text = String(args.p_note ?? '').trim();
    const row = {
      id: `alloc${TABLES.credit_allocations.length + 1}-${Math.random().toString(36).slice(2, 7)}`, credit_note_id: cn.id, invoice_id: inv.id, amount: effect.amount, allocated_on: now.slice(0, 10),
      note: text || null, created_by: ME, created_at: now, removed_at: null, removed_by: null, remove_reason: null,
    };
    TABLES.credit_allocations.push(row);
    Object.assign(cn, { amount_allocated: effect.note.amount_allocated, refund_status: effect.note.refund_status, updated_at: now });
    // Settled once nothing is left to pay, with amount_paid written out as the cash.
    Object.assign(inv, { amount_allocated: effect.invoice.amount_allocated, updated_at: now,
      ...(effect.invoice.settles ? { status: 'paid', paid_at: now, amount_paid: effect.invoice.amount_paid } : {}) });
    return { data: { ...row }, error: null };
  }
  if (name === 'remove_credit_allocation') {
    // The same refusals, restored credit and reopening as remove_credit_allocation.
    const row = TABLES.credit_allocations.find((a) => a.id === args.p_allocation_id);
    if (!row) return creditFail('Applied credit not found.');
    const cn = TABLES.credit_notes.find((c) => c.id === row.credit_note_id);
    const inv = TABLES.invoices.find((i) => i.id === row.invoice_id);
    const invoiceNotes = TABLES.credit_notes.filter((c) => c.invoice_id === row.invoice_id);
    const effect = removeAllocationEffect({ allocation: row, note: cn, invoice: inv, invoiceNotes, reason: args.p_reason ?? '' });
    if (effect.problem) return creditFail(effect.problem);
    // The cash, read while the credit is still on the invoice, as the database
    // reads it. A reopened invoice keeps its paid_at, the day that cash came in.
    const cash = amountPaid(inv);
    Object.assign(row, { removed_at: now, removed_by: ME, remove_reason: String(args.p_reason).trim() });
    Object.assign(cn, { amount_allocated: effect.note.amount_allocated, refund_status: effect.note.refund_status, updated_at: now });
    effect.refunds.forEach((r) => Object.assign(invoiceNotes.find((c) => c.id === r.id), { refund_status: r.refund_status, refund_due: r.refund_due, updated_at: now }));
    Object.assign(inv, { amount_allocated: effect.invoice.amount_allocated, updated_at: now,
      ...(effect.invoice.reopen ? { status: 'sent', amount_paid: cash } : {}) });
    return { data: { ...row }, error: null };
  }
  if (name === 'set_invoice_amount_received') {
    // The same checks, messages, status, paid_at and credit note moves as
    // set_invoice_amount_received (amountReceivedEffect), with its history row.
    // p_expected_from is checked the same way: a sheet working from an amount
    // received that has since changed is refused.
    const inv = TABLES.invoices.find((i) => i.id === args.p_invoice_id);
    if (!inv) return creditFail('Invoice not found.');
    const notes = TABLES.credit_notes.filter((c) => c.invoice_id === inv.id);
    const allocationsFromNotes = TABLES.credit_allocations.filter((a) => notes.some((c) => c.id === a.credit_note_id));
    const effect = amountReceivedEffect({ invoice: inv, notes, allocationsFromNotes, amount: args.p_amount, reason: args.p_reason ?? '', kind: args.p_kind ?? 'correction', expectedFrom: args.p_expected_from });
    if (effect.problem) return creditFail(effect.problem);
    Object.assign(inv, { amount_paid: effect.amount_paid, status: effect.status, updated_at: now,
      ...(effect.paid_at === 'now' ? { paid_at: now } : effect.paid_at === 'clear' ? { paid_at: null } : {}) });
    effect.credit_moved.forEach((mv) => Object.assign(notes.find((c) => c.id === mv.id), { refund_due: mv.refund_due, refund_status: mv.refund_status, updated_at: now }));
    TABLES.invoice_payment_adjustments.push({
      id: `adj${TABLES.invoice_payment_adjustments.length + 1}`, invoice_id: inv.id, from_amount: effect.from_amount, to_amount: effect.amount_paid,
      reason: effect.reason, kind: effect.kind, created_by: ME, created_at: now,
    });
    return {
      data: {
        status: effect.status, amount_paid: effect.amount_paid, balance_due: effect.balance_due, overpaid: effect.overpaid,
        credit_moved: effect.credit_moved.map(({ credit_number, refund_due, refund_status }) => ({ credit_number, refund_due, refund_status })),
        not_on_a_credit_note: effect.not_on_a_credit_note,
      },
      error: null,
    };
  }
  const note = TABLES.credit_notes.find((c) => c.id === args.p_id);
  if (name === 'cancel_credit_note') {
    if (!note) return creditFail('Credit note not found.');
    // The same refusals, refund changes and reopening as the database.
    const inv = TABLES.invoices.find((i) => i.id === note.invoice_id);
    const notes = TABLES.credit_notes.filter((c) => c.invoice_id === note.invoice_id);
    const effect = cancelCreditEffect({ invoice: inv, notes, noteId: note.id, reason: args.p_reason ?? '' });
    if (effect.problem) return creditFail(effect.problem);
    const why = String(args.p_reason || '').trim();
    Object.assign(note, { status: 'cancelled', cancelled_at: now, cancelled_by: ME, cancel_reason: why, refund_status: 'none', refund_due: 0, updated_at: now });
    effect.refunds.forEach((r) => Object.assign(notes.find((c) => c.id === r.id), { refund_status: r.refund_status, refund_due: r.refund_due, updated_at: now }));
    syncCredited(note.invoice_id);
    if (inv && effect.reopen) inv.status = 'sent';
    return { data: { ...note }, error: null };
  }
  if (name === 'mark_credit_note_refunded') {
    // The same refusals, in the same order, as mark_credit_note_refunded: one
    // refund per note, and only the credit still available is refunded (what
    // was applied stays applied).
    const problem = refundProblem({ note, method: args.p_method ?? null });
    if (problem) return creditFail(problem);
    const left = creditAvailable(note);
    const text = String(args.p_note || '').trim();
    if ([...text].length > 500) return creditFail('Keep the refund note to 500 characters or fewer.');
    // Noon UTC on the chosen day, as the database stores it.
    const refunded = Math.round((creditUse(note).refunded + left) * 100) / 100;
    Object.assign(note, { refund_status: 'refunded', refunded_amount: refunded, refunded_at: `${args.p_refunded_on || now.slice(0, 10)}T12:00:00.000Z`, refund_method: args.p_method, refund_note: text || null, updated_at: now });
    return { data: { ...note }, error: null };
  }
  return { data: null, error: null };
}

const chan = { on() { return chan; }, subscribe() { return chan; }, unsubscribe() {} };
export const supabase = {
  from: makeQuery,
  rpc: (name, args) => Promise.resolve(creditRpc(name, args)),
  channel: () => chan, removeChannel: () => {}, removeAllChannels: () => {},
  auth: { getSession: () => Promise.resolve({ data: { session: { user: { id: ME } } } }), getUser: () => Promise.resolve({ data: { user: { id: ME } } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
  storage: { from: bucketApi },
  functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
};
export const APP_URL = 'http://localhost:5198';

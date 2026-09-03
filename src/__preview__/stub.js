// In-memory Supabase for the design harness. Any query chain works; rows come from TABLES.
const d = (n) => { const x = new Date(); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
const ts = (n, h = 0) => { const x = new Date(); x.setDate(x.getDate() + n); x.setHours(x.getHours() - h); return x.toISOString(); };
const ME = 'u-peter';
export const MEMBERS = [{ id: 'u-peter', display_name: 'Peter', email: 'peter@posup.co.uk', role: 'owner' }, { id: 'u-sarah', display_name: 'Sarah', email: 'sarah@posup.co.uk', role: 'editor' }, { id: 'u-james', display_name: 'James', email: 'james@posup.co.uk', role: 'editor' }];
const COMPANIES = [{ id: 'c1', name: 'Coffee Boy — Barnsley', country: 'GB' }, { id: 'c2', name: 'Lightspeed POS UK Ltd', country: 'GB' }];
const LOCATIONS = [{ id: 'l1', name: 'Verde — Macclesfield', company_id: 'c2', status: 'live', phone: '01625 442 118', email: 'verde@example.com', address: '14 Mill Street', city: 'Macclesfield', postcode: 'SK11 6NN', venue_type: 'restaurant', covers: 80, go_live_date: '2026-03-14', owner_id: ME, created_at: ts(-200) }];
const DEALS = [{ id: 'd1', name: 'Coffee Boy — Barnsley Train Station', company_id: 'c1', stage: 'proposal' }];
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
  { id: 'k1', ticket_number: 1042, subject: 'Card machine offline', priority: 'P1', stage: 'in_progress', location_id: 'l1', company_id: 'c2', sla_due_at: new Date(Date.now() - 40 * 60e3).toISOString(), first_response_due_at: new Date(Date.now() - 40 * 60e3).toISOString(), created_at: ts(0, 3) },
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
  { id: 'b3', bill_number: 4823, supplier_id: 's3', supplier: { name: 'Sumup Payments Ltd' }, total: 149, amount_paid: 0, status: 'draft', due_date: null, cost_context: 'deal', created_at: ts(-1) },
];
const QUOTES = [{ id: 'q1', quote_number: 118, status: 'draft', company_id: 'c2', contact_id: 'ct1', location_id: 'l1', currency: 'GBP', valid_until: d(30), payment_terms: 'deposit', deposit_percent: 25, terms: 'Payment 14 days from invoice.', notes: '', public_token: 'abc123', tax_rate: 20 }];
const QLINES = [
  { id: 'ql1', quote_id: 'q1', name: 'Lightspeed terminal', category: 'hardware', billing_type: 'one_off', qty: 2, unit_price: 390, discount: 0, tax_rate: 20, sort: 0 },
  { id: 'ql2', quote_id: 'q1', name: 'Card reader', category: 'hardware', billing_type: 'one_off', qty: 1, unit_price: 149, discount: 0, tax_rate: 20, sort: 1 },
  { id: 'ql3', quote_id: 'q1', name: 'Install & training', category: 'services', billing_type: 'one_off', qty: 4, unit_price: 60, discount: 10, tax_rate: 20, sort: 2 },
];
const PRODUCTS = [{ id: 'pr1', name: 'Lightspeed terminal', category: 'hardware', billing_type: 'one_off', default_price: 390, active: true }, { id: 'pr2', name: 'Card reader', category: 'hardware', billing_type: 'one_off', default_price: 149, active: true }, { id: 'pr3', name: 'ServOS Growth', category: 'saas', billing_type: 'monthly', default_price: 149, active: true }];
const SERIALS = [{ id: 'sn1', serial: 'LS-88213', location_id: 'l1', product: { name: 'Lightspeed terminal' }, status: 'deployed' }, { id: 'sn2', serial: 'LS-88214', location_id: 'l1', product: { name: 'Lightspeed terminal' }, status: 'deployed' }, { id: 'sn3', serial: 'CR-1120', location_id: 'l1', product: { name: 'Card reader' }, status: 'deployed' }];
const ACTIVITIES = [{ id: 'a1', type: 'note', subject: 'Cannot add sub account button is missing from my account', body: 'Cannot add sub account button is missing from my account', actor_id: ME, occurred_at: ts(0, 0.05), subject_type: 'task', subject_id: 't3', created_at: ts(0, 0.05) }];
const TIME = [{ id: 'te1', profile_id: ME, subject_type: 'task', subject_id: 't3', started_at: ts(0, 1), ended_at: null, duration_seconds: 1440 }];
export const TABLES = { profiles: MEMBERS, companies: COMPANIES, locations: LOCATIONS, deals: DEALS, crm_projects: PROJECTS, tasks: TASKS, work_items: WORK, tickets: TICKETS, onboardings: ONBOARDINGS, contacts: CONTACTS, associations: ASSOC, notifications: NOTIFS, bills: BILLS, quotes: QUOTES, quote_line_items: QLINES, products: PRODUCTS, inv_serials: SERIALS, crm_activities: ACTIVITIES, time_entries: TIME, expenses: [], bill_schedules: [], recurring_bills: [], suppliers: [{ id: 's1', name: 'Lightspeed POS UK Ltd' }, { id: 's2', name: 'Adyen N.V.' }, { id: 's3', name: 'Sumup Payments Ltd' }], expense_categories: [{ id: 'ec1', label: 'Software', active: true, sort: 1 }], attachments: [], processing_accounts: [], processing_rates: [], leads: [], stage_history: [] };
export const MEMBERS_LIST = MEMBERS;

function makeQuery(table) {
  let rows = (TABLES[table] || []).slice(); let head = false; let single = false;
  const res = () => ({ data: single ? (rows[0] ?? null) : head ? null : rows, error: null, count: rows.length });
  const filt = (fn) => { rows = rows.filter(fn); return proxy; };
  const api = {
    select: (_c, o) => { if (o?.head) head = true; return proxy; },
    eq: (k, v) => filt(r => r[k] === v), neq: (k, v) => filt(r => r[k] !== v), in: (k, a) => filt(r => a.includes(r[k])),
    is: (k, v) => filt(r => (v === null ? r[k] == null : r[k] === v)), not: () => proxy, or: () => proxy, gte: () => proxy, lte: () => proxy, gt: () => proxy, lt: () => proxy, ilike: () => proxy, like: () => proxy, contains: () => proxy, textSearch: () => proxy,
    order: () => proxy, limit: (n) => { rows = rows.slice(0, n); return proxy; }, range: () => proxy,
    single: () => { single = true; return proxy; }, maybeSingle: () => { single = true; return proxy; },
    insert: () => proxy, update: () => proxy, upsert: () => proxy, delete: () => proxy,
    then: (r, j) => Promise.resolve(res()).then(r, j), catch: (j) => Promise.resolve(res()).catch(j), finally: (f) => Promise.resolve(res()).finally(f),
  };
  const proxy = new Proxy(api, { get: (t, k) => (k in t ? t[k] : () => proxy) });
  return proxy;
}
const chan = { on() { return chan; }, subscribe() { return chan; }, unsubscribe() {} };
export const supabase = {
  from: makeQuery,
  rpc: () => Promise.resolve({ data: null, error: null }),
  channel: () => chan, removeChannel: () => {}, removeAllChannels: () => {},
  auth: { getSession: () => Promise.resolve({ data: { session: { user: { id: ME } } } }), getUser: () => Promise.resolve({ data: { user: { id: ME } } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
  storage: { from: () => ({ upload: () => Promise.resolve({ error: null }), createSignedUrl: () => Promise.resolve({ data: { signedUrl: '#' }, error: null }), remove: () => Promise.resolve({ error: null }), getPublicUrl: () => ({ data: { publicUrl: '#' } }) }) },
  functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
};
export const APP_URL = 'http://localhost:5198';

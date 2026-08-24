/* The onboarding pack we send a new customer once their onboarding starts.
 *
 * One definition, used by three surfaces: the public page the customer fills in,
 * the card that shows the answers on the onboarding, and the summary written to
 * the location. Keeping it in one place is why the three can never drift.
 *
 * Three groups, because they are three different jobs for the customer:
 *   Account config   what we build the till from
 *   Install info     what the engineer needs to be true before travelling
 *   Things to do     jobs for the customer to complete before install day
 *
 * Field kinds:
 *   text | textarea | choice | file | confirm | terms
 * `terms` renders read-only clauses (the sign-off declaration) and is never
 * an answer in its own right — the tick that follows it is.
 * `confirm` is a single tick the customer must give: used for the install
 * checks, where "not answered" and "no" are the same problem for the engineer.
 * `showIf(answers_for_this_section)` hides a field until it is relevant, so
 * nobody is asked for a VAT number they already said they do not have.
 * `sensitive` marks a value to mask in our UI (the WiFi password).
 */

// `short` is what the tabs use. The full titles are honest but too long for a
// phone: three of them overflowed a 375px screen and clipped the last tab clean
// off, which hid a whole third of the form.
export const GROUPS = [
  { key: 'account', title: 'Account config', short: 'Account', blurb: 'What we build your till from.' },
  { key: 'install', title: 'Install information', short: 'Install', blurb: 'What has to be true on site before our engineer travels.' },
  { key: 'todo', title: 'Things to do', short: 'To do', blurb: 'A couple of jobs for you before install day.' },
  { key: 'signoff', title: 'Sign off', short: 'Sign off', blurb: 'Who is confirming this, and what you are confirming.' },
];

export const SECTIONS = [
  // ── Account config ────────────────────────────────────────────────────────
  {
    key: 'company', group: 'account', title: 'Company details',
    hint: 'The legal entity we contract with and invoice.',
    fields: [
      { key: 'legal_name', label: 'Legal entity name', type: 'text', required: true },
      { key: 'contact_name', label: 'Company contact full name', type: 'text', required: true },
      { key: 'address', label: 'Full address', type: 'textarea', required: true },
    ],
  },
  {
    key: 'trading', group: 'account', title: 'Trading details',
    hint: 'What the public sees. Often different from the legal entity.',
    fields: [
      { key: 'trading_name', label: 'Trading name', type: 'text', required: true },
      { key: 'same_address', label: 'Is the trading address the same as your company address?', type: 'choice', options: ['Yes', 'No'], required: true },
      { key: 'trading_address', label: 'Trading address', type: 'textarea', required: true, showIf: (a) => a.same_address === 'No' },
    ],
  },
  {
    key: 'vat', group: 'account', title: 'VAT',
    fields: [
      { key: 'registered', label: 'Are you VAT registered?', type: 'choice', options: ['Yes', 'No'], required: true },
      { key: 'number', label: 'VAT number', type: 'text', required: true, showIf: (a) => a.registered === 'Yes' },
    ],
  },
  {
    key: 'receipt', group: 'account', title: 'Receipt details',
    hint: 'What prints on your customer receipts.',
    fields: [
      { key: 'logo', label: 'Logo', type: 'file', required: true, hint: 'A PNG or JPG. Square or landscape both work.' },
      { key: 'footer', label: 'Footer message', type: 'textarea', hint: 'Printed at the bottom of every receipt, e.g. a thank you and your socials.' },
    ],
  },
  {
    key: 'menu', group: 'account', title: 'Menu',
    fields: [
      { key: 'files', label: 'Full food and drink menu', type: 'file', multiple: true, required: true,
        hint: 'Include every modifier and option. A spreadsheet is ideal, but a PDF or clear photos are fine.' },
      { key: 'notes', label: 'Anything we should know about the menu', type: 'textarea' },
    ],
  },
  {
    key: 'users', group: 'account', title: 'Users',
    fields: [
      { key: 'pos_users', label: 'POS users', type: 'textarea', required: true,
        hint: 'One per line: name, 4 digit PIN, and Manager or Staff.\ne.g. Jane Smith, 1234, Manager' },
      { key: 'bo_users', label: 'Back office users', type: 'textarea', required: true,
        hint: 'Email addresses to invite, one per line. These people get reporting and admin access.' },
    ],
  },
  {
    key: 'discounts', group: 'account', title: 'Discounts',
    fields: [
      { key: 'list', label: 'Discounts to add to the POS', type: 'textarea',
        hint: 'One per line with the amount, e.g. Staff 50%, Friends and family 20%, Manager comp 100%.' },
    ],
  },
  {
    key: 'tables', group: 'account', title: 'Table plan',
    fields: [
      { key: 'files', label: 'Table plan(s)', type: 'file', multiple: true,
        hint: 'A layout we can copy into the system. A drawing, PDF or photo is fine, as long as table names and numbers are readable.' },
      { key: 'notes', label: 'Notes on the layout', type: 'textarea', hint: 'e.g. separate areas, outside tables, a bar with no table service.' },
    ],
  },
  {
    key: 'drinks_printing', group: 'account', title: 'Production printing: drinks',
    hint: 'Where drink orders print when staff send them.',
    fields: [
      { key: 'wanted', label: 'Do you want production tickets for drinks?', type: 'choice', options: ['Yes', 'No'], required: true },
      { key: 'areas', label: 'Your drinks production areas, and what prints at each', type: 'textarea', required: true, showIf: (a) => a.wanted === 'Yes',
        hint: 'Name each area and the product categories that print there. For example:\n\nHot Drinks Production\n- Tea\n- Coffee\n\nBar\n- Everything else that is not above' },
    ],
  },
  {
    key: 'food_printing', group: 'account', title: 'Production printing: food',
    fields: [
      { key: 'multiple', label: 'Do you have multiple production centres? (e.g. starters, mains, desserts)', type: 'choice',
        options: ['Yes', 'No', 'Not sure'], required: true },
      { key: 'detail', label: 'How should food printing work?', type: 'textarea', required: true, showIf: (a) => a.multiple !== 'No',
        hint: 'If you know: list which product categories go to each production centre. If you are not sure, just describe how the kitchen works and we will design it with you.' },
    ],
  },
  {
    key: 'current_pos', group: 'account', title: 'Current POS system',
    fields: [
      { key: 'system', label: 'What is your current POS system?', type: 'text', required: true,
        hint: 'If you do not have one, just say "none".' },
    ],
  },
  {
    key: 'anything_else', group: 'account', title: 'Anything else',
    fields: [
      { key: 'notes', label: 'Anything else your installer and configuration team should know', type: 'textarea',
        hint: 'Anything at all you can think of that would help us set this up the way you work.' },
    ],
  },

  // ── Install information ───────────────────────────────────────────────────
  {
    key: 'site_readiness', group: 'install', title: 'Site readiness',
    hint: 'Our engineer travels on the strength of these. If any are not true yet, leave it unticked and tell us in the notes rather than guessing.',
    fields: [
      { key: 'internet', label: 'I confirm we have an active internet connection', type: 'confirm', required: true },
      { key: 'ethernet', label: 'I confirm network (ethernet) cables are run to every location a printer will go', type: 'confirm', required: true },
      { key: 'wifi_coverage', label: 'I confirm we have full WiFi coverage of the building', type: 'confirm', required: true },
      { key: 'hardware', label: 'I confirm I have my Lightspeed hardware', type: 'confirm', required: true },
      { key: 'power', label: 'I confirm there is sufficient power where the POS and devices will be located', type: 'confirm', required: true },
      { key: 'notes', label: 'Anything not ticked above, or anything we should know about the site', type: 'textarea' },
    ],
  },
  {
    key: 'network', group: 'install', title: 'Network details',
    hint: 'Needed to get your tills and printers talking on the day.',
    fields: [
      { key: 'wifi_name', label: 'WiFi name (SSID)', type: 'text', required: true },
      { key: 'wifi_password', label: 'WiFi password', type: 'text', required: true, sensitive: true,
        hint: 'Held against your venue record and only visible to our team.' },
    ],
  },

  // ── Things to do ──────────────────────────────────────────────────────────
  {
    key: 'ipads', group: 'todo', title: 'Your iPads',
    hint: 'Both of these need doing before install day. They take a few minutes and save hours on site.',
    fields: [
      { key: 'unboxed', type: 'confirm', required: true,
        label: 'Unboxed the iPads, powered them on, and signed each one into an Apple ID',
        hint: 'To check it is working, download any free app from the App Store. If that works, the Apple ID is active.' },
      { key: 'updated', type: 'confirm', required: true,
        label: 'Updated every iPad to the latest iOS' },
    ],
  },

  // ── Sign off ──────────────────────────────────────────────────────────────
  {
    key: 'signoff', group: 'signoff', title: 'Sign off',
    hint: 'The last step. Everything above gets built from this, and our engineer travels on the strength of it.',
    fields: [
      { key: 'full_name', label: 'Full name of the person signing off', type: 'text', required: true },
      { key: 'position', label: 'Position in the business', type: 'text', required: true,
        hint: 'e.g. Owner, Director, General Manager.' },
      {
        key: 'terms', type: 'terms', label: 'What you are confirming',
        clauses: [
          'The information in this pack is true, complete and accurate to the best of my knowledge.',
          'I am authorised to give this information and to accept these terms on behalf of the business named above.',
          'The site readiness confirmations are accurate, and I will tell you straight away if any of them stop being true before the install date.',
          'I understand that if information is missing or wrong, or the site is not ready as confirmed, the installation may not be able to go ahead on the day.',
          'I understand that an installation that has to be rearranged for those reasons may be rechargeable to us, including the engineer visit.',
          'I have completed, or will complete before install day, the jobs listed under Things to do.',
          'I understand that significant changes to the menu, users or printing setup after this pack is submitted may delay the build and may be chargeable.',
          'I have the right to share the details given here, including staff names, PINs and network details, and I am happy for them to be used to set up and support the system.',
        ],
      },
      { key: 'agreed', type: 'confirm', required: true,
        label: 'I confirm the above on behalf of the business',
        hint: 'Your name, position and the date and time are recorded with this pack.' },
    ],
  },
];

/** Sections belonging to a group, in order. */
export function sectionsIn(groupKey) {
  return SECTIONS.filter((s) => s.group === groupKey);
}

/** Fields visible for the answers given (showIf resolved). */
export function visibleFields(section, answers = {}) {
  const a = answers[section.key] || {};
  return section.fields.filter((f) => !f.showIf || f.showIf(a));
}

const isEmpty = (f, v) => {
  if (f.type === 'terms') return true;            // display only, never an answer
  if (f.type === 'file') return !(Array.isArray(v) ? v.length : v);
  if (f.type === 'confirm') return v !== true;
  return !String(v ?? '').trim();
};

/** Every required question still unanswered, as [{section, field}]. */
export function missingRequired(answers = {}) {
  const out = [];
  for (const s of SECTIONS) {
    const a = answers[s.key] || {};
    for (const f of visibleFields(s, answers)) {
      if (f.required && isEmpty(f, a[f.key])) out.push({ section: s.title, field: f.label });
    }
  }
  return out;
}

/** Plain-text summary, for the activity feed and the location record. */
export function summarize(answers = {}) {
  const out = [];
  for (const g of GROUPS) {
    const blocks = [];
    for (const s of sectionsIn(g.key)) {
      const a = answers[s.key] || {};
      const rows = visibleFields(s, answers).map((f) => {
        const v = a[f.key];
        if (isEmpty(f, v)) return null;
        if (f.type === 'file') {
          const names = (Array.isArray(v) ? v : [v]).map((x) => x?.name).filter(Boolean);
          return names.length ? `${f.label}: ${names.join(', ')}` : null;
        }
        if (f.type === 'terms') return null;
        if (f.type === 'confirm') return `[confirmed] ${f.label}`;
        // The WiFi password is not repeated into the activity feed; it lives on
        // the request record where it can be shown deliberately.
        if (f.sensitive) return `${f.label}: (held on the venue record)`;
        return `${f.label}: ${String(v).trim()}`;
      }).filter(Boolean);
      if (rows.length) blocks.push(`${s.title}\n${rows.map((r) => `  ${r}`).join('\n')}`);
    }
    if (blocks.length) out.push(`══ ${g.title.toUpperCase()} ══\n\n${blocks.join('\n\n')}`);
  }
  return out.join('\n\n');
}

/** Every uploaded file across the pack, flattened for attaching to the location. */
export function allFiles(answers = {}) {
  const out = [];
  for (const s of SECTIONS) {
    const a = answers[s.key] || {};
    for (const f of s.fields) {
      if (f.type !== 'file') continue;
      const v = a[f.key];
      for (const file of (Array.isArray(v) ? v : v ? [v] : [])) {
        if (file?.path) out.push({ ...file, section: s.title, label: f.label });
      }
    }
  }
  return out;
}

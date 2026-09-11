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
 *   text | textarea | choice | file | confirm | terms | digits | email | tel | dob
 * `terms` renders read-only clauses (the sign-off declaration) and is never
 * an answer in its own right — the tick that follows it is.
 * `confirm` is a single tick the customer must give: used for the install
 * checks, where "not answered" and "no" are the same problem for the engineer.
 * `digits` is a number typed on a numeric keypad (sort code, account number,
 * EIN). It is stored as bare digits and shown through `format`.
 * `tel` is stored as E.164, `email` trimmed and lowercased, `dob` as YYYY-MM-DD.
 *
 * Who is filling it in changes the questions. `ctx` (see formContext) carries
 * the region (UK or US, decided by us from the venue, never asked) and whether
 * the legal entity is an Individual (a sole trader). Anything that reads
 * differently for them is worked out from ctx:
 *   title, label, hint, options   stay plain strings written for a UK company,
 *                                 with the ctx version beside them as titleFor,
 *                                 labelFor, hintFor and optionsFor. Both, so a
 *                                 screen not yet reading through titleOf and
 *                                 labelOf still prints sensible text instead of
 *                                 an empty heading. Always read through the
 *                                 *Of helpers, which also accept a plain prop
 *                                 that is itself a function of ctx.
 *   showIf(sectionAnswers, ctx)   hides a field until it is relevant, so nobody
 *                                 is asked for a VAT number they already said
 *                                 they do not have. One argument versions still
 *                                 work, they just ignore ctx.
 *   requiredIf(ctx)               required for some customers only (the EIN).
 *   normalize(value, ctx)         fixes the format when leaving the box. We
 *                                 tidy, we never reject for style.
 *   validate(value, ctx)          {error} stops the pack being sent, {warning}
 *                                 only nudges. Always run on the normalised value.
 *   echo(ctx)                     the answer a "same as" question would reuse,
 *                                 shown under it so Yes is an informed tap.
 *   suggest(ctx)                  tap to fill chips, shown while the box is empty.
 *   format(value, ctx), maxDigits display and expected length for digits
 *                                 fields. The page never cuts a typed or pasted
 *                                 number to maxDigits: too many digits is an
 *                                 error the customer sees, not a shorter number.
 * `sensitive` marks a value to mask in our UI (the WiFi password).
 * `secure` marks bank numbers, date of birth, home address and ID images. They
 * never sit in onboarding_form_requests.answers, which every logged in user can
 * read: the onboarding-form function moves them into onboarding_form_secure
 * (owner only) and the private onboarding-secure bucket, and answers keep only
 * `_held`, which says a value is there (plus the last 4 digits of the account
 * number). The key lists are mirrored in supabase/functions/_shared/onboardingSecure.ts
 * and a test keeps the two equal.
 */

import { toE164 } from './phoneFormat';

// ── Small helpers ───────────────────────────────────────────────────────────

const str = (v) => String(v ?? '').trim();
const digitsOnly = (v) => String(v ?? '').replace(/\D/g, '');
// Optional chaining on purpose: a caller still using one argument showIf, or a
// resolver called without ctx, must read as a UK company rather than throw.
const isUS = (ctx) => ctx?.region === 'US';
const isInd = (ctx) => !!ctx?.individual;
const company = (ctx) => ctx?.all?.company || {};

// ── Validators and formats (pure, exported for the tests and the page) ──────

/** Companies House numbers are 8 characters. People drop the leading zeros
 *  ("1234567") and the zeros after a prefix ("SC12345"), so we put them back. */
export function normCompanyNumber(v) {
  const s = String(v ?? '').toUpperCase().replace(/[\s.-]/g, '');
  if (/^\d{1,7}$/.test(s)) return s.padStart(8, '0');
  const m = /^([A-Z]{2})(\d{1,5})$/.exec(s);
  return m ? m[1] + m[2].padStart(6, '0') : s;
}
/** NONE is a real answer: a partnership or club is not on Companies House. */
export const validCompanyNumber = (v) => /^(\d{8}|[A-Z]{2}\d{6}|R0\d{6}|IP\d{5}R|NONE)$/.test(String(v ?? ''));

/** A bare 9 or 12 digit VAT number is a UK one missing its GB. */
export function normVat(v) {
  const s = String(v ?? '').toUpperCase().replace(/[\s.-]/g, '');
  if (/^(\d{9}|\d{12})$/.test(s) || /^(GD|HA)\d{3}$/.test(s)) return 'GB' + s;
  return s;
}
/** Standard, branch traders, government departments and health authorities.
 *  Northern Ireland (XI) numbers come in the same four forms as GB ones. */
export const validVat = (v) => /^(GB|XI)(\d{9}|\d{12}|GD\d{3}|HA\d{3})$/.test(String(v ?? ''));

export const normSortCode = (v) => digitsOnly(v);
export const validSortCode = (v) => /^\d{6}$/.test(String(v ?? ''));
/** 12-34-56. Too many digits are shown as typed, never cut to six, so a pasted
 *  sort code and account number can be seen for what it is next to its error. */
export function formatSortCode(v) {
  const d = digitsOnly(v);
  return d.length > 6 ? d : (d.match(/.{1,2}/g) || []).join('-');
}

/** Older UK accounts have 6 or 7 digits. Banks pad them to 8 with leading
 *  zeros, and payment providers only accept the padded form. */
export function normUkAccount(v) {
  const d = digitsOnly(v);
  return d.length === 6 || d.length === 7 ? d.padStart(8, '0') : d;
}
export const validUkAccount = (v) => /^\d{8}$/.test(String(v ?? ''));
export const validUsAccount = (v) => /^\d{4,17}$/.test(String(v ?? ''));

/** US routing numbers carry their own checksum, so a single mistyped digit is
 *  caught here instead of as a failed payout weeks later. All zeros passes the
 *  sum but is never a real bank. */
export function validAba(v) {
  const s = String(v ?? '');
  if (!/^\d{9}$/.test(s) || /^0+$/.test(s)) return false;
  const d = s.split('').map(Number);
  return (3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8])) % 10 === 0;
}

export const normEin = (v) => digitsOnly(v);
export const validEin = (v) => /^\d{9}$/.test(String(v ?? '')) && !/^0+$/.test(String(v));
export function formatEin(v) {
  const d = digitsOnly(v);
  return d.length > 2 && d.length <= 9 ? `${d.slice(0, 2)}-${d.slice(2)}` : d;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const ymdParts = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(s));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12) return null;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const last = mo === 2 && leap ? 29 : DAYS_IN_MONTH[mo - 1];
  return d >= 1 && d <= last ? [y, mo, d] : null;
};
const todayParts = (today) => {
  if (typeof today === 'string') return ymdParts(today);
  const t = today instanceof Date && !Number.isNaN(today.getTime()) ? today : new Date();
  return [t.getFullYear(), t.getMonth() + 1, t.getDate()];
};

/** What is wrong with a date of birth: 'date' (not a real date, before 1900,
 *  or in the future), 'age' (under 18), or null when it is fine. Two reasons
 *  because the customer needs to be told which. A 29 February birthday turns
 *  18 on 1 March in a non leap year, which is the UK rule. */
export function dobProblem(ymd, today = new Date()) {
  const b = ymdParts(ymd);
  const t = todayParts(today);
  if (!b || !t || b[0] < 1900) return 'date';
  const [y, m, d] = b;
  const [ty, tm, td] = t;
  if (y > ty || (y === ty && (m > tm || (m === tm && d > td)))) return 'date';
  const age = ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
  return age < 18 ? 'age' : null;
}
/** A real date, 1900 or later, and 18 or over on `today`. */
export const validDob = (ymd, today = new Date()) => dobProblem(ymd, today) === null;
/** The order of the three date boxes: how people in each country write a date. */
export const dobOrder = (ctx) => (isUS(ctx) ? ['month', 'day', 'year'] : ['day', 'month', 'year']);
/** 21/04/1990 in the UK, 04/21/1990 in the US. */
export function formatDob(ymd, ctx) {
  const p = ymdParts(ymd);
  if (!p) return str(ymd);
  const [y, m, d] = [String(p[0]), String(p[1]).padStart(2, '0'), String(p[2]).padStart(2, '0')];
  return isUS(ctx) ? `${m}/${d}/${y}` : `${d}/${m}/${y}`;
}

// A postcode or ZIP ends a line of an address, or the part before a comma. A
// country after it is fine. Looking for one anywhere in the text read "A2 3rd"
// in "Suite A2 3rd Floor" as a postcode, and the house number in
// "Unit 5, 12345 Main St" as a ZIP, so a missing one was never flagged.
const UK_COUNTRY_TAIL = /[\s,.]*(?:\b(?:uk|u\.k\.|united kingdom|great britain|gb|england|scotland|wales|northern ireland))?[\s,.]*$/i;
const US_COUNTRY_TAIL = /[\s,.]*(?:\b(?:usa|u\.s\.a\.|us|u\.s\.|united states(?: of america)?))?[\s,.]*$/i;
const addressLines = (text) => String(text ?? '').split(/\r?\n/);

/** A line of the text ends with something shaped like a UK postcode, or has
 *  one just before a comma ("SW1A 2AA, London"). */
export const hasUkPostcode = (text) => addressLines(text).some((line) =>
  /(?:^|[\s,])(?:GIR\s?0AA|[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})(?:\s*,|$)/i.test(line.replace(UK_COUNTRY_TAIL, '')));

/** A line of the text ends with a 5 digit ZIP (or ZIP+4), with something
 *  before it on that line or an earlier one, so "12345 Main St" (a house
 *  number) and a lone number on its own are not taken for one. */
export const hasUsZip = (text) => addressLines(text).some((line, i, lines) => {
  const m = /(?:^|[\s,])\d{5}(?:-\d{4})?$/.exec(line.replace(US_COUNTRY_TAIL, ''));
  return !!m && (m.index > 0 || lines.slice(0, i).some((x) => x.trim()));
});

export const validEmail = (v) => /^[^\s@]+@([^\s@.]+\.)+[^\s@.]{2,}$/.test(String(v ?? ''));

/** Plausible E.164: US numbers need a real area code and exchange, UK numbers
 *  9 or 10 digits after the 44, anything else 8 to 15 digits in all. */
export function validPhone(v) {
  const s = String(v ?? '');
  if (s.startsWith('+1')) return /^\+1[2-9]\d{2}[2-9]\d{6}$/.test(s);
  if (s.startsWith('+44')) return /^\+44[1-9]\d{8,9}$/.test(s);
  return /^\+[2-9]\d{6,14}$/.test(s);
}
const phoneCountry = (ctx) => (isUS(ctx) ? 'US' : 'GB');

// Shared field rules. A missing postcode or ZIP is a warning, never an error:
// plenty of real addresses are typed on several lines, and we would rather
// have the address with a nudge than a customer stuck.
const addressWarning = (v, ctx) => {
  if (isUS(ctx)) return hasUsZip(v) ? null : { warning: 'Add the ZIP code if it is missing.' };
  return hasUkPostcode(v) ? null : { warning: 'Add the postcode if it is missing.' };
};
const COMPANY_WORDS = /\b(ltd|limited|llp|plc|inc|incorporated|llc|corp|corporation)\b/i;
const chips = (values) => {
  const seen = new Set();
  return values.map(str).filter((v) => {
    const k = v.toLowerCase();
    if (!v || seen.has(k)) return false;
    seen.add(k);
    return true;
  }).map((v) => ({ label: v, value: v }));
};
const venueAddressChip = (ctx) => (str(ctx?.venueAddress) ? [{ label: 'Use the venue address', value: str(ctx.venueAddress) }] : []);
// "Driving licence" in the UK, "driver's license" in the US, for ID labels.
const idDocName = (ctx) => {
  const t = str(ctx?.all?.representative?.id_type);
  if (t === 'Driving licence') return isUS(ctx) ? "driver's license" : 'driving licence';
  if (t === 'National ID card') return 'ID card';
  return 'photo ID';
};
const colour = (ctx) => (isUS(ctx) ? 'color' : 'colour');

// `short` is what the tabs use. The full titles are honest but too long for a
// phone: three of them overflowed a 375px screen and clipped the last tab clean
// off, which hid a whole third of the form.
export const GROUPS = [
  { key: 'account', title: 'Account config', short: 'Account', blurb: 'What we build your till and card payments from.' },
  { key: 'install', title: 'Install information', short: 'Install', blurb: 'What has to be true on site before our engineer travels.' },
  { key: 'todo', title: 'Things to do', short: 'To do', blurb: 'A couple of jobs for you before install day.' },
  { key: 'signoff', title: 'Sign off', short: 'Sign off', blurb: 'Who is confirming this, and what you are confirming.' },
];

export const TERMS_VERSION = 2;

const ORG_COMPANY_HINT = 'The legal entity we contract with, invoice, and set your card payments up for.';
const UK_ORG_NAME_HINT = 'Exactly as on Companies House, including Ltd or Limited. Not your trading name, that comes later.';
const UK_ORG_ADDRESS_HINT = "Your registered office, exactly as on Companies House, including the postcode. It is often your accountant's address, not the venue.";
const ORG_REP_HINT = 'The person legally responsible for the business, usually a director or owner. Payment providers have to check who they are.';
const UK_ENTITY_HINT = 'Organisation: a limited company, LLP, partnership, charity or club. Individual: a sole trader, trading in your own name.';
const idHint = (ctx, which, doc = idDocName(ctx)) =>
  `${which} The real ${doc}, in ${colour(ctx)}, all four corners in shot, no glare. JPG, PNG or PDF, up to 10MB.`;

export const SECTIONS = [
  // ── Account config ────────────────────────────────────────────────────────
  {
    key: 'company', group: 'account', title: 'Company details',
    titleFor: (ctx) => (isInd(ctx) ? 'Business details' : 'Company details'),
    hint: ORG_COMPANY_HINT,
    hintFor: (ctx) => (isInd(ctx) ? 'As a sole trader, the legal entity is you, so these are your own details.' : ORG_COMPANY_HINT),
    fields: [
      { key: 'entity_type', label: 'Legal entity', type: 'choice', required: true,
        options: ['Organisation', 'Individual'],
        optionsFor: (ctx) => [
          { value: 'Organisation', label: isUS(ctx) ? 'Organization' : 'Organisation' },
          { value: 'Individual', label: 'Individual' },
        ],
        hint: UK_ENTITY_HINT,
        hintFor: (ctx) => (isUS(ctx)
          ? 'Organization: an LLC, corporation, partnership or nonprofit. Individual: a sole proprietor, trading in your own name.'
          : UK_ENTITY_HINT) },
      { key: 'legal_name', label: 'Legal entity name', type: 'text', required: true,
        labelFor: (ctx) => (isInd(ctx) ? 'Your full legal name' : 'Legal entity name'),
        hint: UK_ORG_NAME_HINT,
        hintFor: (ctx) => (isInd(ctx) ? 'Exactly as on your photo ID, including middle names.'
          : isUS(ctx) ? 'Exactly as registered with your state, including LLC or Inc.' : UK_ORG_NAME_HINT),
        validate: (v, ctx) => {
          const s = str(v);
          if (s.length < 2 || s.length > 160) return { error: 'The name should be between 2 and 160 characters.' };
          // The commonest wrong turn: a limited company owner picking Individual
          // because they are one person. A nudge, since a person can be called Lincoln.
          if (isInd(ctx) && COMPANY_WORDS.test(s)) {
            return { warning: `A sole trader's legal name is their own name. If this is a company, choose ${isUS(ctx) ? 'Organization' : 'Organisation'}.` };
          }
          return null;
        } },
      { key: 'address', label: 'Company registered address', type: 'textarea', required: true,
        labelFor: (ctx) => (isInd(ctx) ? 'Your business address' : isUS(ctx) ? 'Registered business address' : 'Company registered address'),
        hint: UK_ORG_ADDRESS_HINT,
        hintFor: (ctx) => (isUS(ctx) ? 'Include the state and ZIP code.'
          : isInd(ctx) ? 'The address HMRC has for your business, including the postcode.' : UK_ORG_ADDRESS_HINT),
        validate: addressWarning,
        suggest: venueAddressChip },
      { key: 'company_number', label: 'Company number', type: 'text', required: true,
        showIf: (a, ctx) => !isUS(ctx) && !isInd(ctx),
        hint: 'Your 8 character Companies House number, e.g. 01234567 or SC123456. Not on Companies House, for example a partnership? Type NONE.',
        normalize: (v) => normCompanyNumber(v),
        validate: (v) => (validCompanyNumber(normCompanyNumber(v)) ? null
          : { error: 'Company numbers are 8 characters, like 01234567 or SC123456.' }) },
      // A sole proprietor often trades on their SSN and has no EIN, so it is
      // optional for them. We never ask for an SSN at all.
      { key: 'ein', label: 'EIN (Employer Identification Number)', type: 'digits', required: true,
        requiredIf: (ctx) => !isInd(ctx),
        showIf: (a, ctx) => isUS(ctx),
        labelFor: (ctx) => (isInd(ctx) ? 'EIN, if your business has one' : 'EIN (Employer Identification Number)'),
        hint: 'The 9 digit number on your IRS EIN letter, e.g. 12-3456789. Never enter a Social Security number here.',
        maxDigits: 9, normalize: (v) => normEin(v), format: (v) => formatEin(v),
        validate: (v) => (validEin(normEin(v)) ? null : { error: 'An EIN is 9 digits, like 12-3456789.' }) },
      { key: 'contact_name', label: 'Main contact full name', type: 'text', required: true,
        hint: 'Who we speak to day to day about your set up and install. It can be the same person as the legal representative.',
        suggest: (ctx) => (isInd(ctx) && str(company(ctx).legal_name)
          ? [{ label: "That's me", value: str(company(ctx).legal_name) }] : []) },
    ],
  },
  {
    key: 'vat', group: 'account', title: 'VAT',
    // The US has no VAT (our team sets sales tax from the venue address), so
    // the whole section drops away for a US venue. A stored answer is kept.
    fields: [
      { key: 'registered', label: 'Are you VAT registered?', type: 'choice', options: ['Yes', 'No'], required: true,
        showIf: (a, ctx) => !isUS(ctx) },
      { key: 'number', label: 'VAT number', type: 'text', required: true,
        showIf: (a, ctx) => !isUS(ctx) && a.registered === 'Yes',
        normalize: (v) => normVat(v),
        validate: (v) => (validVat(normVat(v)) ? null : { error: 'UK VAT numbers look like GB123456789.' }) },
    ],
  },
  {
    key: 'bank', group: 'account', title: 'Bank account',
    hint: 'The business account for your card payments and billing. Held securely. Only our account owner can see it.',
    fields: [
      { key: 'sort_code', label: 'Sort code', type: 'digits', required: true, secure: true,
        showIf: (a, ctx) => !isUS(ctx),
        maxDigits: 6, normalize: (v) => normSortCode(v), format: (v) => formatSortCode(v),
        validate: (v) => (validSortCode(normSortCode(v)) ? null : { error: 'A sort code is 6 digits, like 12-34-56.' }) },
      { key: 'routing_number', label: 'Routing number (ABA)', type: 'digits', required: true, secure: true,
        showIf: (a, ctx) => isUS(ctx),
        maxDigits: 9, normalize: (v) => digitsOnly(v),
        validate: (v) => (validAba(digitsOnly(v)) ? null : { error: 'Check the 9 digit routing number.' }) },
      { key: 'account_number', label: 'Account number', type: 'digits', required: true, secure: true,
        maxDigits: (ctx) => (isUS(ctx) ? 17 : 8),
        normalize: (v, ctx) => (isUS(ctx) ? digitsOnly(v) : normUkAccount(v)),
        validate: (v, ctx) => {
          if (isUS(ctx)) return validUsAccount(digitsOnly(v)) ? null : { error: 'Check the account number.' };
          return validUkAccount(normUkAccount(v)) ? null : { error: 'A UK account number is 8 digits.' };
        } },
      { key: 'account_type', label: 'Account type', type: 'choice', options: ['Checking', 'Savings'], required: true,
        showIf: (a, ctx) => isUS(ctx) },
      { key: 'holder_same', label: 'Is this account in the name of the legal entity?', type: 'choice', options: ['Yes', 'No'], required: true,
        labelFor: (ctx) => (isInd(ctx) ? 'Is this account in your name?' : 'Is this account in the name of the legal entity?'),
        echo: (ctx) => str(company(ctx).legal_name) || 'the name given above' },
      { key: 'holder_name', label: 'Name on the account', type: 'text', required: true,
        showIf: (a) => a.holder_same === 'No',
        hint: 'Exactly as the bank shows it.' },
    ],
  },
  {
    key: 'representative', group: 'account', title: 'Company representative details',
    titleFor: (ctx) => (isInd(ctx) ? 'Your details' : 'Company representative details'),
    hint: ORG_REP_HINT,
    hintFor: (ctx) => (isInd(ctx) ? 'As a sole trader, you are the legal representative.' : ORG_REP_HINT),
    fields: [
      // Asked only once there is a main contact to point at; a sole trader is
      // their own representative, so neither question applies to them.
      { key: 'is_contact', label: 'Is the main contact the legal representative?', type: 'choice', options: ['Yes', 'No'], required: true,
        showIf: (a, ctx) => !isInd(ctx) && !!str(company(ctx).contact_name),
        echo: (ctx) => str(company(ctx).contact_name) },
      { key: 'name', label: 'Legal representative full name', type: 'text', required: true,
        showIf: (a, ctx) => !isInd(ctx) && (a.is_contact === 'No' || !str(company(ctx).contact_name)),
        hint: 'Exactly as on their photo ID.' },
      { key: 'phone', label: 'Legal representative contact number', type: 'tel', required: true,
        labelFor: (ctx) => (isInd(ctx) ? 'Your mobile number' : 'Legal representative contact number'),
        // Kept as typed when it cannot be read, so the customer sees their own
        // input with the error rather than an emptied box.
        normalize: (v, ctx) => toE164(v, phoneCountry(ctx)) || str(v),
        validate: (v, ctx) => (validPhone(toE164(v, phoneCountry(ctx))) ? null : { error: 'Check the phone number.' }) },
      { key: 'email', label: 'Legal representative email', type: 'email', required: true,
        labelFor: (ctx) => (isInd(ctx) ? 'Your email' : 'Legal representative email'),
        normalize: (v) => str(v).toLowerCase(),
        validate: (v) => (validEmail(str(v)) ? null : { error: 'Check the email address.' }),
        suggest: (ctx) => (validEmail(str(ctx?.sentTo)) ? chips([str(ctx.sentTo).toLowerCase()]) : []) },
      { key: 'dob', label: 'Legal representative date of birth', type: 'dob', required: true, secure: true,
        labelFor: (ctx) => (isInd(ctx) ? 'Your date of birth' : 'Legal representative date of birth'),
        validate: (v, ctx) => {
          const p = dobProblem(v);
          if (p === 'date') return { error: 'Check the date.' };
          if (p === 'age') return { error: isInd(ctx) ? 'You must be 18 or over.' : 'They must be 18 or over.' };
          return null;
        } },
      { key: 'home_same', label: 'Does the legal representative live at the company registered address?', type: 'choice', options: ['Yes', 'No'], required: true,
        labelFor: (ctx) => (isInd(ctx) ? 'Do you live at your business address?' : 'Does the legal representative live at the company registered address?'),
        echo: (ctx) => str(company(ctx).address) },
      { key: 'home_address', label: 'Legal representative home address', type: 'textarea', required: true, secure: true,
        showIf: (a) => a.home_same === 'No',
        labelFor: (ctx) => (isInd(ctx) ? 'Your home address' : 'Legal representative home address'),
        // 5 to 500 matches the server check, so an address the page accepts is
        // never silently refused when it is saved.
        validate: (v, ctx) => {
          const s = str(v);
          if (s.length < 5 || s.length > 500) return { error: 'Check the address.' };
          return addressWarning(s, ctx);
        } },
      { key: 'id_type', label: 'Legal representative photo ID', type: 'choice', required: true,
        labelFor: (ctx) => (isInd(ctx) ? 'Your photo ID' : 'Legal representative photo ID'),
        options: ['Passport', 'Driving licence', 'National ID card'],
        optionsFor: (ctx) => [
          { value: 'Passport', label: 'Passport' },
          { value: 'Driving licence', label: isUS(ctx) ? "Driver's license" : 'Driving licence' },
          { value: 'National ID card', label: isUS(ctx) ? 'State ID card' : 'National ID card' },
        ],
        hint: 'A passport is best: it is one photo instead of two.' },
      // Separate keys for the passport page and the card faces, so a file sent
      // as a licence front can never be relabelled as a passport by switching
      // type. A licence and an ID card share the face keys, so each face is
      // held with the type it was uploaded as (see heldEntryOf).
      { key: 'id_passport', label: 'Passport photo page', type: 'file', required: true, secure: true,
        showIf: (a) => a.id_type === 'Passport',
        hint: idHint(null, 'The page with the photo.', 'passport'),
        hintFor: (ctx) => idHint(ctx, 'The page with the photo.', 'passport') },
      { key: 'id_front', label: 'Front of the photo ID', type: 'file', required: true, secure: true,
        showIf: (a) => !!str(a.id_type) && a.id_type !== 'Passport',
        labelFor: (ctx) => `Front of the ${idDocName(ctx)}`,
        hint: idHint(null, 'The side with the photo.'),
        hintFor: (ctx) => idHint(ctx, 'The side with the photo.') },
      { key: 'id_back', label: 'Back of the photo ID', type: 'file', required: true, secure: true,
        showIf: (a) => !!str(a.id_type) && a.id_type !== 'Passport',
        labelFor: (ctx) => `Back of the ${idDocName(ctx)}`,
        hint: idHint(null, 'The other side.'),
        hintFor: (ctx) => idHint(ctx, 'The other side.') },
    ],
  },
  {
    key: 'trading', group: 'account', title: 'Trading details',
    hint: 'What the public sees. Often different from the legal entity.',
    fields: [
      { key: 'trading_name', label: 'Trading name', type: 'text', required: true,
        suggest: (ctx) => chips([ctx?.venue, company(ctx).legal_name]) },
      { key: 'same_address', label: 'Is the trading address the same as your company registered address?', type: 'choice', options: ['Yes', 'No'], required: true,
        labelFor: (ctx) => (isInd(ctx) ? 'Is the trading address the same as your business address?'
          : 'Is the trading address the same as your company registered address?'),
        echo: (ctx) => str(company(ctx).address) },
      { key: 'trading_address', label: 'Trading address', type: 'textarea', required: true, showIf: (a) => a.same_address === 'No',
        suggest: venueAddressChip },
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
      // The password lives on the onboarding pack (onboarding_form_requests),
      // not the venue record, which the old wording claimed.
      { key: 'wifi_password', label: 'WiFi password', type: 'text', required: true, sensitive: true,
        hint: 'Held on your onboarding pack and only visible to our team.' },
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
      // A chip, never a prefill: the name typed or tapped here is the signature.
      { key: 'full_name', label: 'Full name of the person signing off', type: 'text', required: true,
        suggest: (ctx) => chips([representativeName(ctx?.all || {})]) },
      { key: 'position', label: 'Position in the business', type: 'text', required: true,
        hint: 'e.g. Owner, Director, General Manager.' },
      {
        key: 'terms', type: 'terms', label: 'What you are confirming',
        // Adding or rewording a clause means bumping TERMS_VERSION, which is
        // stamped on the pack when it is sent, so we can tell what was agreed.
        clauses: [
          'The information in this pack is true, complete and accurate to the best of my knowledge.',
          'I am authorised to give this information and to accept these terms on behalf of the business named above.',
          'The site readiness confirmations are accurate, and I will tell you straight away if any of them stop being true before the install date.',
          'I understand that if information is missing or wrong, or the site is not ready as confirmed, the installation may not be able to go ahead on the day.',
          'I understand that an installation that has to be rearranged for those reasons may be rechargeable to us, including the engineer visit.',
          'I have completed, or will complete before install day, the jobs listed under Things to do.',
          'I understand that significant changes to the menu, users or printing setup after this pack is submitted may delay the build and may be chargeable.',
          'I have the right to share the details given here, including staff names, PINs and network details, and I am happy for them to be used to set up and support the system.',
          'I agree that the bank and identity details given here can be used to set up and check our payments and billing accounts, and shared with our payment providers for that reason.',
        ],
      },
      { key: 'agreed', type: 'confirm', required: true,
        label: 'I confirm the above on behalf of the business',
        hint: 'Your name, position and the date and time are recorded with this pack.' },
    ],
  },
];

// ── Context and resolvers ───────────────────────────────────────────────────

/** Everything a question needs to know about who is answering it.
 *  env comes from the page's load (region, venue, venue_address, sent_to, held)
 *  or the card. Old packs have no _meta, and they were shown the UK form, so
 *  that is what they read as. Camel and snake case both accepted, because load
 *  returns snake case. */
export function formContext(answers = {}, env = {}) {
  const all = answers || {};
  const e = env || {};
  const region = String(e.region || all._meta?.region || 'UK').toUpperCase() === 'US' ? 'US' : 'UK';
  return {
    all,
    region,
    individual: all.company?.entity_type === 'Individual',
    venue: str(e.venue),
    venueAddress: str(e.venueAddress ?? e.venue_address),
    sentTo: str(e.sentTo ?? e.sent_to),
    held: e.held || all._held || {},
  };
}

// A prop's ctx version wins, then a prop that is itself a function, then the
// plain value.
const resolve = (obj, prop, ctx) => {
  const fn = obj?.[`${prop}For`];
  if (typeof fn === 'function') return fn(ctx);
  const v = obj?.[prop];
  return typeof v === 'function' ? v(ctx) : v;
};

export const titleOf = (section, ctx = formContext()) => resolve(section, 'title', ctx) || '';
export const sectionHintOf = (section, ctx = formContext()) => resolve(section, 'hint', ctx) || '';
export const labelOf = (field, ctx = formContext()) => resolve(field, 'label', ctx) || '';
export const hintOf = (field, ctx = formContext()) => resolve(field, 'hint', ctx) || '';
/** Options as [{value, label}], whether written as strings or objects. */
export function optionsOf(field, ctx = formContext()) {
  return (resolve(field, 'options', ctx) || []).map((o) => (o && typeof o === 'object'
    ? { value: o.value, label: o.label ?? String(o.value) }
    : { value: o, label: String(o) }));
}
/** The label a stored choice is shown with. Unknown values print as stored. */
export function optionLabel(field, value, ctx = formContext()) {
  const hit = optionsOf(field, ctx).find((o) => o.value === value);
  return hit ? hit.label : String(value ?? '');
}
export const echoOf = (field, ctx = formContext()) => (typeof field?.echo === 'function' ? str(field.echo(ctx)) : '');
export const suggestOf = (field, ctx = formContext()) => (typeof field?.suggest === 'function' ? field.suggest(ctx) || [] : []);
export const maxDigitsOf = (field, ctx = formContext()) => resolve(field, 'maxDigits', ctx) || null;
/** How a stored value is displayed, e.g. a sort code as 12-34-56. */
export const formatOf = (field, value, ctx = formContext()) =>
  (typeof field?.format === 'function' ? field.format(value, ctx) : String(value ?? ''));

// ── Visibility, answers and progress ────────────────────────────────────────

/** Sections belonging to a group, in order. */
export function sectionsIn(groupKey) {
  return SECTIONS.filter((s) => s.group === groupKey);
}

/** Fields visible for the answers given (showIf resolved). */
export function visibleFields(section, answers = {}, ctx = formContext(answers)) {
  const a = (answers || {})[section.key] || {};
  return section.fields.filter((f) => !f.showIf || f.showIf(a, ctx));
}

/** Sections in a group with at least one question to show. A US venue has no
 *  VAT questions, so it gets no empty VAT card either. */
export function visibleSections(groupKey, answers = {}, ctx = formContext(answers)) {
  return sectionsIn(groupKey).filter((s) => visibleFields(s, answers, ctx).length > 0);
}

export function isRequired(field, ctx = formContext()) {
  return typeof field.requiredIf === 'function' ? !!field.requiredIf(ctx) : !!field.required;
}

export function isEmpty(f, v) {
  if (f.type === 'terms') return true;            // display only, never an answer
  if (f.type === 'file') return !(Array.isArray(v) ? v.length : v);
  if (f.type === 'confirm') return v !== true;
  return !String(v ?? '').trim();
}

/** {error}, {warning} or null for a value, checked in its normalised form so a
 *  sort code typed as 12 34 56 is not an error. Empty is not an issue here:
 *  that is missingRequired's job. */
export function fieldIssue(field, value, ctx = formContext()) {
  if (isEmpty(field, value) || typeof field.validate !== 'function') return null;
  const v = typeof field.normalize === 'function' ? field.normalize(value, ctx) : value;
  return field.validate(v, ctx) || null;
}

const heldKey = (sectionKey, fieldKey) => `${sectionKey}.${fieldKey}`;

/** The _held entry for a secure question, or null when nothing usable is held.
 *  A card face is saved with {doc}, the ID type it was uploaded as. Switching
 *  from a driving licence to an ID card uses the same two questions, so the
 *  licence photos must stop counting, or the pack would go in saying ID card
 *  with licence images and fail the payment provider's check. */
export function heldEntryOf(section, field, ctx = formContext()) {
  const entry = ctx?.held?.[heldKey(section.key, field.key)];
  if (!entry) return null;
  if (entry && typeof entry === 'object' && typeof entry.doc === 'string' && entry.doc) {
    return entry.doc === str((ctx?.all?.[section.key] || {}).id_type) ? entry : null;
  }
  return entry;
}
const isHeld = (s, f, ctx) => !!heldEntryOf(s, f, ctx);

// Where a question stands: 'done', 'missing' or 'invalid'. A secure answer
// already held on the server is done even though the page no longer has it,
// unless the customer has started typing a replacement, which must be valid,
// or it is a card face held for a different ID type.
function standing(s, f, a, ctx) {
  const v = a[f.key];
  if (isEmpty(f, v)) return f.secure && isHeld(s, f, ctx) ? 'done' : 'missing';
  return fieldIssue(f, v, ctx)?.error ? 'invalid' : 'done';
}

/** Every question stopping the pack being sent, as
 *  [{sectionKey, section, fieldKey, field, reason}]. `section` and `field` are
 *  the titles the customer sees. A required question left empty is 'missing';
 *  any shown answer with an error is 'invalid', optional ones included, so a
 *  junk EIN cannot slip through just because an EIN was optional. */
export function missingRequired(answers = {}, ctx = formContext(answers)) {
  const all = answers || {};
  const out = [];
  for (const s of SECTIONS) {
    const a = all[s.key] || {};
    for (const f of visibleFields(s, all, ctx)) {
      if (f.type === 'terms') continue;
      const st = standing(s, f, a, ctx);
      if (st === 'done' || (st === 'missing' && !isRequired(f, ctx))) continue;
      out.push({ sectionKey: s.key, section: titleOf(s, ctx), fieldKey: f.key, field: labelOf(f, ctx), reason: st });
    }
  }
  return out;
}

/** {required, done} over the required questions showing right now, so a
 *  question hidden by an earlier answer neither counts nor sticks the bar. */
export function progress(answers = {}, ctx = formContext(answers)) {
  const all = answers || {};
  let required = 0;
  let done = 0;
  for (const s of SECTIONS) {
    const a = all[s.key] || {};
    for (const f of visibleFields(s, all, ctx)) {
      if (f.type === 'terms' || !isRequired(f, ctx)) continue;
      required += 1;
      if (standing(s, f, a, ctx) === 'done') done += 1;
    }
  }
  return { required, done };
}

/** Plain-text summary, for the activity feed and the location record. */
export function summarize(answers = {}, ctx = formContext(answers)) {
  const all = answers || {};
  const out = [];
  for (const g of GROUPS) {
    const blocks = [];
    for (const s of sectionsIn(g.key)) {
      const a = all[s.key] || {};
      const rows = visibleFields(s, all, ctx).map((f) => {
        const v = a[f.key];
        const label = labelOf(f, ctx);
        if (f.type === 'terms') return null;
        // Decided before the value is looked at, so no secure value, file name
        // or path can reach the activity feed, which every logged in user reads.
        if (f.secure) return isHeld(s, f, ctx) || !isEmpty(f, v) ? `${label}: provided, held securely` : null;
        if (isEmpty(f, v)) return null;
        if (f.type === 'file') {
          const names = (Array.isArray(v) ? v : [v]).map((x) => x?.name).filter(Boolean);
          return names.length ? `${label}: ${names.join(', ')}` : null;
        }
        if (f.type === 'confirm') return `[confirmed] ${label}`;
        // The WiFi password is not repeated into the activity feed; it stays on
        // the onboarding pack where it can be shown deliberately.
        if (f.sensitive) return `${label}: hidden, on the onboarding pack`;
        if (f.type === 'choice') return `${label}: ${optionLabel(f, v, ctx)}`;
        return `${label}: ${typeof f.format === 'function' ? f.format(v, ctx) : String(v).trim()}`;
      }).filter(Boolean);
      if (rows.length) blocks.push(`${titleOf(s, ctx)}\n${rows.map((r) => `  ${r}`).join('\n')}`);
    }
    if (blocks.length) out.push(`══ ${g.title.toUpperCase()} ══\n\n${blocks.join('\n\n')}`);
  }
  return out.join('\n\n');
}

/** Every uploaded file across the pack, flattened for attaching to the location.
 *  Only files for questions showing now (a menu from a hidden question is not
 *  part of the pack) and never a secure one: ID stays on the pack. */
export function allFiles(answers = {}, ctx = formContext(answers)) {
  const all = answers || {};
  const out = [];
  for (const s of SECTIONS) {
    const a = all[s.key] || {};
    for (const f of visibleFields(s, all, ctx)) {
      if (f.type !== 'file' || f.secure) continue;
      const v = a[f.key];
      for (const file of (Array.isArray(v) ? v : v ? [v] : [])) {
        if (file?.path) out.push({ ...file, section: titleOf(s, ctx), label: labelOf(f, ctx) });
      }
    }
  }
  return out;
}

// ── Secure keys ─────────────────────────────────────────────────────────────

const secureKeys = (files) => SECTIONS.flatMap((s) => s.fields
  .filter((f) => f.secure && (f.type === 'file') === files)
  .map((f) => heldKey(s.key, f.key)));

/** 'section.field' keys whose values are held in onboarding_form_secure. */
export const SECURE_VALUE_KEYS = secureKeys(false);
/** 'section.field' keys whose files are held in the onboarding-secure bucket. */
export const SECURE_FILE_KEYS = secureKeys(true);
export const isSecureKey = (key) => SECURE_VALUE_KEYS.includes(key) || SECURE_FILE_KEYS.includes(key);

// ── Reused answers ──────────────────────────────────────────────────────────
// Copied answers are never written into other keys. These work them out, so
// the page, the card and the summary all agree on one name.

/** Who the legal representative is. Mirrors the visibility of the questions,
 *  so a stale answer to a hidden question is never used. */
export function representativeName(answers = {}) {
  const all = answers || {};
  const co = all.company || {};
  const rep = all.representative || {};
  if (co.entity_type === 'Individual') return str(co.legal_name);
  const contact = str(co.contact_name);
  if (contact && rep.is_contact === 'Yes') return contact;
  if (!contact || rep.is_contact === 'No') return str(rep.name);
  return '';
}

/** The name on the bank account: the legal entity, or the name given instead. */
export function accountHolder(answers = {}) {
  const all = answers || {};
  const bank = all.bank || {};
  if (bank.holder_same === 'Yes') return str(all.company?.legal_name);
  if (bank.holder_same === 'No') return str(bank.holder_name);
  return '';
}

/** UK or US questions, decided by us and never asked. The venue's country
 *  first, then the company's, and nothing at all is the UK. Same rule as
 *  ReportingDashboard and migration 109, and mirrored in onboardingSecure.ts. */
export function regionFor(locationCountry, companyCountry) {
  const isUsCountry = (c) => ['US', 'USA'].includes(str(c).toUpperCase());
  if (str(locationCountry)) return isUsCountry(locationCountry) ? 'US' : 'UK';
  return isUsCountry(companyCountry) ? 'US' : 'UK';
}

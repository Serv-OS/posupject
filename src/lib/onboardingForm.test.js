import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as F from './onboardingForm.js';
import { toE164 } from './phoneFormat.js';
// The server's copy of the secure rules. It has no imports precisely so this
// test can load it and prove the two never drift.
import * as S from '../../supabase/functions/_shared/onboardingSecure.ts';

const {
  GROUPS, SECTIONS, sectionsIn, visibleFields, visibleSections, formContext,
  titleOf, sectionHintOf, labelOf, hintOf, optionsOf, optionLabel, echoOf, suggestOf, formatOf, maxDigitsOf,
  isRequired, isEmpty, fieldIssue, missingRequired, progress, summarize, allFiles,
  SECURE_VALUE_KEYS, SECURE_FILE_KEYS, isSecureKey, representativeName, accountHolder, regionFor, TERMS_VERSION,
} = F;

const section = (key) => SECTIONS.find((s) => s.key === key);
const field = (sectionKey, fieldKey) => section(sectionKey).fields.find((f) => f.key === fieldKey);
const visibleKeys = (answers, ctx = formContext(answers)) =>
  SECTIONS.flatMap((s) => visibleFields(s, answers, ctx).map((f) => `${s.key}.${f.key}`));
const keysIn = (keys, sectionKey) => keys.filter((k) => k.startsWith(`${sectionKey}.`)).map((k) => k.split('.')[1]);
const missingKeys = (list) => list.map((m) => `${m.sectionKey}.${m.fieldKey}`);

// Every section and field as it was before v2, with its group and type. A saved
// answer is only readable while its key, and the kind of thing stored under it,
// stay put.
const BEFORE = {
  company: ['account', { legal_name: 'text', contact_name: 'text', address: 'textarea' }],
  trading: ['account', { trading_name: 'text', same_address: 'choice', trading_address: 'textarea' }],
  vat: ['account', { registered: 'choice', number: 'text' }],
  receipt: ['account', { logo: 'file', footer: 'textarea' }],
  menu: ['account', { files: 'file', notes: 'textarea' }],
  users: ['account', { pos_users: 'textarea', bo_users: 'textarea' }],
  discounts: ['account', { list: 'textarea' }],
  tables: ['account', { files: 'file', notes: 'textarea' }],
  drinks_printing: ['account', { wanted: 'choice', areas: 'textarea' }],
  food_printing: ['account', { multiple: 'choice', detail: 'textarea' }],
  current_pos: ['account', { system: 'text' }],
  anything_else: ['account', { notes: 'textarea' }],
  site_readiness: ['install', { internet: 'confirm', ethernet: 'confirm', wifi_coverage: 'confirm', hardware: 'confirm', power: 'confirm', notes: 'textarea' }],
  network: ['install', { wifi_name: 'text', wifi_password: 'text' }],
  ipads: ['todo', { unboxed: 'confirm', updated: 'confirm' }],
  signoff: ['signoff', { full_name: 'text', position: 'text', terms: 'terms', agreed: 'confirm' }],
};
// The showIf rules as they were, copied from the old definition.
const OLD_SHOW_IF = {
  'trading.trading_address': (a) => a.same_address === 'No',
  'vat.number': (a) => a.registered === 'Yes',
  'drinks_printing.areas': (a) => a.wanted === 'Yes',
  'food_printing.detail': (a) => a.multiple !== 'No',
};
const oldVisible = (answers) => Object.entries(BEFORE).flatMap(([sk, [, fields]]) =>
  Object.keys(fields).filter((fk) => {
    const rule = OLD_SHOW_IF[`${sk}.${fk}`];
    return !rule || rule(answers[sk] || {});
  }).map((fk) => `${sk}.${fk}`));

// A pack filled in and submitted before this change: no entity_type, no _meta,
// no bank or representative answers.
const OLD_PACK = {
  company: { legal_name: 'Mozz Pizza Ltd', contact_name: 'Jane Smith', address: '12 Market Street\nManchester\nM1 1AE' },
  trading: { trading_name: 'Mozz', same_address: 'No', trading_address: '5 Deansgate, Manchester M3 2BW' },
  vat: { registered: 'Yes', number: 'GB220430231' },
  receipt: { logo: { name: 'logo.png', path: 'onboarding/r1/logo.png', size: 1000, mime: 'image/png' }, footer: 'Thanks for visiting' },
  menu: { files: [{ name: 'menu.pdf', path: 'onboarding/r1/menu.pdf', size: 2000, mime: 'application/pdf' }], notes: 'Gluten free bases' },
  users: { pos_users: 'Jane Smith, 1234, Manager', bo_users: 'jane@mozz.co.uk' },
  discounts: { list: 'Staff 50%' },
  tables: { files: [], notes: '' },
  drinks_printing: { wanted: 'Yes', areas: 'Bar\n- Everything' },
  food_printing: { multiple: 'Yes', detail: 'The pizza oven gets everything' },
  current_pos: { system: 'none' },
  site_readiness: { internet: true, ethernet: true, wifi_coverage: true, hardware: true, power: true },
  network: { wifi_name: 'MozzGuest', wifi_password: 'pepperoni123' },
  ipads: { unboxed: true, updated: true },
  signoff: { full_name: 'Jane Smith', position: 'Director', agreed: true },
};

// A v2 pack with every secure answer typed in, and stale answers to questions
// that are now hidden (a licence front, from before they switched to passport).
const SECRET_PACK = {
  company: { entity_type: 'Organisation', legal_name: 'Mozz Pizza Ltd', contact_name: 'Jane Smith', address: '12 Market Street, Manchester M1 1AE', company_number: '00445790' },
  vat: { registered: 'No' },
  bank: { sort_code: '309634', account_number: '31926819', holder_same: 'Yes' },
  representative: {
    is_contact: 'Yes', phone: '+447700900123', email: 'jane@mozz.co.uk', dob: '1985-07-14',
    home_same: 'No', home_address: '9 Hidden Lane, Salford M5 4WT', id_type: 'Passport',
    id_passport: { name: 'Jane Smith passport.jpg', path: 'req-1/id_passport-a1b2c3d4.jpg', size: 1000, mime: 'image/jpeg' },
    id_front: { name: 'Jane licence front.jpg', path: 'req-1/id_front-e5f6a7b8.jpg', size: 1000, mime: 'image/jpeg' },
  },
  trading: { trading_name: 'Mozz', same_address: 'Yes' },
  receipt: { logo: { name: 'logo.png', path: 'onboarding/req-1/logo.png', size: 1000, mime: 'image/png' } },
  menu: { files: [{ name: 'menu.pdf', path: 'onboarding/req-1/menu.pdf', size: 2000, mime: 'application/pdf' }] },
  network: { wifi_name: 'MozzGuest', wifi_password: 'pepperoni123' },
};

describe('definition shape', () => {
  it('keeps every section and field key that existed before, in the same group and type', () => {
    for (const [sectionKey, [group, fields]] of Object.entries(BEFORE)) {
      const s = section(sectionKey);
      expect(s, sectionKey).toBeTruthy();
      expect(s.group).toBe(group);
      for (const [fieldKey, type] of Object.entries(fields)) {
        expect(field(sectionKey, fieldKey)?.type, `${sectionKey}.${fieldKey}`).toBe(type);
      }
    }
    expect(GROUPS.map((g) => g.key)).toEqual(['account', 'install', 'todo', 'signoff']);
  });

  it('orders the Account group company, VAT, bank, representative, trading, then as before', () => {
    expect(sectionsIn('account').map((s) => s.key)).toEqual([
      'company', 'vat', 'bank', 'representative', 'trading',
      'receipt', 'menu', 'users', 'discounts', 'tables', 'drinks_printing', 'food_printing', 'current_pos', 'anything_else',
    ]);
    expect(GROUPS[0].blurb).toBe('What we build your till and card payments from.');
    expect(section('company').fields.map((f) => f.key)).toEqual(['entity_type', 'legal_name', 'address', 'company_number', 'ein', 'contact_name']);
  });

  it('keeps plain string titles, labels, hints and options, so a screen not yet on the resolvers still reads', () => {
    for (const s of SECTIONS) {
      expect(typeof s.title, s.key).toBe('string');
      if ('hint' in s) expect(typeof s.hint, s.key).toBe('string');
      for (const f of s.fields) {
        const where = `${s.key}.${f.key}`;
        expect(typeof f.label, where).toBe('string');
        if ('hint' in f) expect(typeof f.hint, where).toBe('string');
        if ('options' in f) expect(f.options.every((o) => typeof o === 'string'), where).toBe(true);
      }
    }
  });

  it('never uses an em or en dash in anything the customer or our team reads', () => {
    const texts = [];
    const junk = ['x', 'Acme Ltd', '123', '1990-13-01', `${new Date().getFullYear() - 5}-01-01`, 'no postcode here'];
    for (const region of ['UK', 'US']) {
      for (const entity_type of ['Organisation', 'Individual']) {
        for (const id_type of ['Passport', 'Driving licence', 'National ID card']) {
          const answers = { company: { entity_type }, representative: { id_type } };
          const ctx = formContext(answers, { region, venue: 'Mozz', venueAddress: '1 High St', sentTo: 'a@b.co' });
          GROUPS.forEach((g) => texts.push(g.title, g.short, g.blurb));
          for (const s of SECTIONS) {
            texts.push(titleOf(s, ctx), sectionHintOf(s, ctx));
            for (const f of s.fields) {
              texts.push(labelOf(f, ctx), hintOf(f, ctx), echoOf(f, ctx), ...(f.clauses || []));
              optionsOf(f, ctx).forEach((o) => texts.push(o.label));
              suggestOf(f, ctx).forEach((c) => texts.push(c.label));
              if (f.validate) junk.forEach((v) => { const r = f.validate(v, ctx); if (r) texts.push(r.error || r.warning); });
            }
          }
        }
      }
    }
    const offenders = texts.filter((t) => /[\u2013\u2014]/.test(t || ''));
    expect(offenders).toEqual([]);
  });

  it('adds the ninth sign-off clause and bumps the terms version', () => {
    expect(TERMS_VERSION).toBe(2);
    const clauses = field('signoff', 'terms').clauses;
    expect(clauses).toHaveLength(9);
    expect(clauses[8]).toBe('I agree that the bank and identity details given here can be used to set up and check our payments and billing accounts, and shared with our payment providers for that reason.');
  });
});

describe('formContext', () => {
  it('reads a pack with no _meta and no entity type as a UK Organisation', () => {
    const ctx = formContext({});
    expect(ctx).toMatchObject({ region: 'UK', individual: false, venue: '', venueAddress: '', sentTo: '', held: {} });
    expect(formContext(null).region).toBe('UK');
  });

  it('takes the region from env first, then the stamp on the pack', () => {
    expect(formContext({ _meta: { region: 'US' } }).region).toBe('US');
    expect(formContext({ _meta: { region: 'US' } }, { region: 'UK' }).region).toBe('UK');
    expect(formContext({}, { region: 'us' }).region).toBe('US');
    expect(formContext({}, { region: 'Mars' }).region).toBe('UK');
  });

  it('accepts load\'s snake case, and held from env or the pack', () => {
    const ctx = formContext({ _held: { 'representative.dob': true } }, { venue_address: '1 High St', sent_to: 'a@b.co' });
    expect(ctx.venueAddress).toBe('1 High St');
    expect(ctx.sentTo).toBe('a@b.co');
    expect(ctx.held).toEqual({ 'representative.dob': true });
    expect(formContext({ _held: { x: true } }, { held: { y: true } }).held).toEqual({ y: true });
    expect(formContext({ company: { entity_type: 'Individual' } }).individual).toBe(true);
  });
});

describe('visibility matrix', () => {
  const packFor = (entity_type) => ({
    company: { entity_type, legal_name: 'Acme Kitchens Ltd', contact_name: 'Jane Smith', address: '1 High Street, Leeds LS1 1AA' },
    vat: { registered: 'Yes', number: 'GB220430231' },
    bank: { holder_same: 'No' },
    representative: { is_contact: 'No', home_same: 'No', id_type: 'Driving licence' },
    trading: { same_address: 'No' },
  });

  const ORG_REP = ['is_contact', 'name', 'phone', 'email', 'dob', 'home_same', 'home_address', 'id_type', 'id_front', 'id_back'];
  const IND_REP = ['phone', 'email', 'dob', 'home_same', 'home_address', 'id_type', 'id_front', 'id_back'];
  const UK_BANK = ['sort_code', 'account_number', 'holder_same', 'holder_name'];
  const US_BANK = ['routing_number', 'account_number', 'account_type', 'holder_same', 'holder_name'];
  const MATRIX = [
    ['UK', 'Organisation', ['entity_type', 'legal_name', 'address', 'company_number', 'contact_name'], ['registered', 'number'], UK_BANK, ORG_REP],
    ['UK', 'Individual', ['entity_type', 'legal_name', 'address', 'contact_name'], ['registered', 'number'], UK_BANK, IND_REP],
    ['US', 'Organisation', ['entity_type', 'legal_name', 'address', 'ein', 'contact_name'], [], US_BANK, ORG_REP],
    ['US', 'Individual', ['entity_type', 'legal_name', 'address', 'ein', 'contact_name'], [], US_BANK, IND_REP],
  ];

  it.each(MATRIX)('%s %s', (region, entity, company, vat, bank, rep) => {
    const answers = packFor(entity);
    const keys = visibleKeys(answers, formContext(answers, { region }));
    expect(keysIn(keys, 'company')).toEqual(company);
    expect(keysIn(keys, 'vat')).toEqual(vat);
    expect(keysIn(keys, 'bank')).toEqual(bank);
    expect(keysIn(keys, 'representative')).toEqual(rep);
    expect(keysIn(keys, 'trading')).toEqual(['trading_name', 'same_address', 'trading_address']);
  });

  it('drops the VAT card for a US venue and keeps it for the UK', () => {
    const answers = packFor('Organisation');
    expect(visibleSections('account', answers, formContext(answers, { region: 'US' })).map((s) => s.key)).not.toContain('vat');
    expect(visibleSections('account', answers, formContext(answers, { region: 'UK' })).map((s) => s.key)).toContain('vat');
  });

  it('asks for an EIN from a US Organization, and only offers it to a sole proprietor', () => {
    const ein = field('company', 'ein');
    expect(isRequired(ein, formContext({ company: { entity_type: 'Organisation' } }, { region: 'US' }))).toBe(true);
    expect(isRequired(ein, formContext({ company: { entity_type: 'Individual' } }, { region: 'US' }))).toBe(false);
    const us = formContext({ company: { entity_type: 'Individual' } }, { region: 'US' });
    expect(missingKeys(missingRequired({ company: { entity_type: 'Individual' } }, us))).not.toContain('company.ein');
    // Optional, but junk is still stopped.
    const junk = { company: { entity_type: 'Individual', ein: '12345' } };
    expect(missingRequired(junk, formContext(junk, { region: 'US' })).find((m) => m.fieldKey === 'ein')?.reason).toBe('invalid');
  });

  it('asks whether the main contact is the representative only once there is a main contact', () => {
    const rep = (company, representative) => keysIn(visibleKeys({ company, representative }), 'representative');
    expect(rep({ contact_name: '' }, {})).toEqual(expect.arrayContaining(['name']));
    expect(rep({ contact_name: '' }, {})).not.toContain('is_contact');
    expect(rep({ contact_name: 'Jane' }, {})).toContain('is_contact');
    expect(rep({ contact_name: 'Jane' }, {})).not.toContain('name');
    expect(rep({ contact_name: 'Jane' }, { is_contact: 'Yes' })).not.toContain('name');
    expect(rep({ contact_name: 'Jane' }, { is_contact: 'No' })).toContain('name');
  });

  it('asks for one passport page, or a front and back for a card, and nothing before a choice', () => {
    const ids = (representative) => keysIn(visibleKeys({ representative }), 'representative').filter((k) => k.startsWith('id_') && k !== 'id_type');
    expect(ids({})).toEqual([]);
    expect(ids({ id_type: 'Passport' })).toEqual(['id_passport']);
    expect(ids({ id_type: 'Driving licence' })).toEqual(['id_front', 'id_back']);
    expect(ids({ id_type: 'National ID card' })).toEqual(['id_front', 'id_back']);
  });

  it('words things for the customer in front of it', () => {
    const ukInd = formContext({ company: { entity_type: 'Individual' }, representative: { id_type: 'Driving licence' } });
    const usOrg = formContext({ representative: { id_type: 'Driving licence' } }, { region: 'US' });
    expect(titleOf(section('company'), ukInd)).toBe('Business details');
    expect(titleOf(section('representative'), ukInd)).toBe('Your details');
    expect(titleOf(section('representative'), usOrg)).toBe('Company representative details');
    expect(labelOf(field('company', 'legal_name'), ukInd)).toBe('Your full legal name');
    expect(labelOf(field('company', 'address'), usOrg)).toBe('Registered business address');
    expect(labelOf(field('representative', 'id_front'), ukInd)).toBe('Front of the driving licence');
    expect(labelOf(field('representative', 'id_back'), usOrg)).toBe("Back of the driver's license");
    expect(labelOf(field('representative', 'id_front'), formContext({ representative: { id_type: 'National ID card' } }))).toBe('Front of the ID card');
    expect(optionsOf(field('company', 'entity_type'), usOrg)).toEqual([{ value: 'Organisation', label: 'Organization' }, { value: 'Individual', label: 'Individual' }]);
    expect(optionsOf(field('representative', 'id_type'), usOrg).map((o) => o.label)).toEqual(['Passport', "Driver's license", 'State ID card']);
    expect(optionsOf(field('trading', 'same_address'))).toEqual([{ value: 'Yes', label: 'Yes' }, { value: 'No', label: 'No' }]);
    expect(optionLabel(field('company', 'entity_type'), 'Organisation', usOrg)).toBe('Organization');
    expect(optionLabel(field('company', 'entity_type'), 'Something old', usOrg)).toBe('Something old');
    expect(F.dobOrder(usOrg)).toEqual(['month', 'day', 'year']);
    expect(F.dobOrder(ukInd)).toEqual(['day', 'month', 'year']);
    expect(maxDigitsOf(field('bank', 'account_number'), usOrg)).toBe(17);
    expect(maxDigitsOf(field('bank', 'account_number'), ukInd)).toBe(8);
  });

  it('still accepts a plain prop that is itself a function of ctx, and one argument showIf', () => {
    const custom = { key: 'x', type: 'text', label: (ctx) => `in ${ctx.region}`, options: () => ['A'] };
    expect(labelOf(custom, formContext({}, { region: 'US' }))).toBe('in US');
    expect(optionsOf(custom)).toEqual([{ value: 'A', label: 'A' }]);
    // The old card and page call visibleFields with no ctx at all.
    expect(visibleFields(section('trading'), { trading: { same_address: 'No' } }).map((f) => f.key)).toContain('trading_address');
    expect(field('vat', 'number').showIf({ registered: 'Yes' })).toBe(true);
  });
});

describe('a pack answered before this change', () => {
  const variants = [
    OLD_PACK,
    { ...OLD_PACK, trading: { ...OLD_PACK.trading, same_address: 'Yes' }, vat: { registered: 'No' } },
    { ...OLD_PACK, drinks_printing: { wanted: 'No' }, food_printing: { multiple: 'No' } },
    {},
  ];

  it.each(variants.map((v, i) => [i, v]))('shows exactly the old questions it showed before (variant %i)', (i, answers) => {
    const oldKeys = new Set(oldVisible(answers));
    const allOld = new Set(Object.entries(BEFORE).flatMap(([sk, [, fs]]) => Object.keys(fs).map((fk) => `${sk}.${fk}`)));
    const nowOld = visibleKeys(answers).filter((k) => allOld.has(k));
    expect(new Set(nowOld)).toEqual(oldKeys);
  });

  it('reads as a UK Organisation with the titles it had', () => {
    const ctx = formContext(OLD_PACK);
    expect(ctx.region).toBe('UK');
    expect(ctx.individual).toBe(false);
    expect(titleOf(section('company'), ctx)).toBe('Company details');
    expect(labelOf(field('company', 'legal_name'), ctx)).toBe('Legal entity name');
  });

  it('has no old answer that now counts as missing or wrong', () => {
    const owed = missingRequired(OLD_PACK);
    expect(owed.every((m) => m.reason === 'missing')).toBe(true);
    expect([...new Set(owed.map((m) => m.sectionKey))].sort()).toEqual(['bank', 'company', 'representative']);
    expect(missingKeys(owed).filter((k) => k.startsWith('company.'))).toEqual(['company.entity_type', 'company.company_number']);
  });

  it('summarises its answers the way it always did, WiFi password hidden', () => {
    const text = summarize(OLD_PACK);
    expect(text).toContain('Company details\n  Legal entity name: Mozz Pizza Ltd');
    expect(text).toContain('Trading name: Mozz');
    expect(text).toContain('VAT number: GB220430231');
    expect(text).toContain('Logo: logo.png');
    expect(text).toContain('Full food and drink menu: menu.pdf');
    expect(text).toContain('[confirmed] I confirm we have an active internet connection');
    expect(text).toContain('WiFi password: hidden, on the onboarding pack');
    expect(text).not.toContain('pepperoni123');
    expect(text).not.toContain('held securely');
    expect(text).not.toContain('Bank account');
  });
});

describe('summarize', () => {
  it('never prints a secure value, file name or path', () => {
    const text = summarize(SECRET_PACK);
    for (const secret of ['309634', '30-96-34', '31926819', '1985-07-14', '14/07/1985', '9 Hidden Lane', 'M5 4WT',
      'passport.jpg', 'licence front', 'req-1/', 'id_passport-', 'id_front-']) {
      expect(text, secret).not.toContain(secret);
    }
    expect(text).toContain('Sort code: provided, held securely');
    expect(text).toContain('Account number: provided, held securely');
    expect(text).toContain('Legal representative date of birth: provided, held securely');
    expect(text).toContain('Legal representative home address: provided, held securely');
    expect(text).toContain('Passport photo page: provided, held securely');
    // The licence front is hidden now that they chose a passport.
    expect(text).not.toContain('Front of the');
    expect(text).not.toContain('pepperoni123');
  });

  it('prints held secure answers the page no longer has, and nothing for ones never given', () => {
    const answers = { bank: { holder_same: 'Yes' }, _held: { 'bank.account_number': { hint: '6819' }, 'representative.dob': true } };
    const text = summarize(answers);
    expect(text).toContain('Account number: provided, held securely');
    expect(text).toContain('Legal representative date of birth: provided, held securely');
    expect(text).not.toContain('6819');
    expect(text).not.toContain('Sort code');
  });

  it('prints choices by label and digits in their display format', () => {
    const answers = { company: { entity_type: 'Organisation', ein: '123456789' }, bank: { account_type: 'Checking', routing_number: '021000021' } };
    const text = summarize(answers, formContext(answers, { region: 'US' }));
    expect(text).toContain('Legal entity: Organization');
    expect(text).toContain('EIN (Employer Identification Number): 12-3456789');
    expect(text).toContain('Account type: Checking');
    expect(text).toContain('Routing number (ABA): provided, held securely');
    expect(text).not.toContain('021000021');
    expect(summarize({ company: { entity_type: 'Organisation' } })).toContain('Legal entity: Organisation');
  });
});

describe('allFiles', () => {
  it('returns visible, non-secure files only, so ID never becomes a venue attachment', () => {
    const files = allFiles(SECRET_PACK);
    expect(files.map((f) => f.path).sort()).toEqual(['onboarding/req-1/logo.png', 'onboarding/req-1/menu.pdf']);
    expect(files.find((f) => f.path.endsWith('logo.png'))).toMatchObject({ section: 'Receipt details', label: 'Logo', name: 'logo.png' });
    // Every file returned belongs to a question showing now. (No non-secure
    // file question is conditional today, so the hidden ones here are the ID.)
    const visibleFileLabels = SECTIONS.flatMap((s) => visibleFields(s, SECRET_PACK).filter((f) => f.type === 'file' && !f.secure).map((f) => f.label));
    expect(files.every((f) => visibleFileLabels.includes(f.label))).toBe(true);
    const licence = { ...SECRET_PACK, representative: { ...SECRET_PACK.representative, id_type: 'Driving licence' } };
    expect(allFiles(licence).some((f) => f.path.startsWith('req-1/'))).toBe(false);
  });
});

describe('progress and missingRequired', () => {
  it('ignores a question hidden by an earlier answer, even one answered before it was hidden', () => {
    const shared = { trading: { same_address: 'Yes' } };
    const separate = { trading: { same_address: 'No' } };
    expect(progress(separate).required).toBe(progress(shared).required + 1);
    const stale = { trading: { same_address: 'Yes', trading_address: '5 Deansgate' } };
    expect(progress(stale)).toEqual(progress(shared));
    expect(missingKeys(missingRequired(shared))).not.toContain('trading.trading_address');
  });

  it('counts only valid answers as done', () => {
    const base = progress({ vat: { registered: 'Yes' } });
    expect(progress({ vat: { registered: 'Yes', number: '123' } }).done).toBe(base.done);
    expect(progress({ vat: { registered: 'Yes', number: '220 4302 31' } }).done).toBe(base.done + 1);
    const p = progress({});
    expect(p.done).toBe(0);
    expect(p.required).toBe(missingRequired({}).length);
  });

  it('counts a secure answer held on the server as answered', () => {
    const pack = { representative: { home_same: 'No', id_type: 'Passport' } };
    const secureOwed = (list) => missingKeys(list).filter(isSecureKey).sort();
    expect(secureOwed(missingRequired(pack))).toEqual([
      'bank.account_number', 'bank.sort_code', 'representative.dob', 'representative.home_address', 'representative.id_passport',
    ]);
    const held = {
      'bank.sort_code': true, 'bank.account_number': { hint: '6819' }, 'representative.dob': true,
      'representative.home_address': true, 'representative.id_passport': true,
    };
    expect(secureOwed(missingRequired(pack, formContext(pack, { held })))).toEqual([]);
    expect(secureOwed(missingRequired({ ...pack, _held: held }))).toEqual([]);
    const withHeld = progress(pack, formContext(pack, { held }));
    expect(withHeld.done - progress(pack).done).toBe(5);
    // A replacement being typed over a held value still has to be right.
    const typing = { ...pack, bank: { sort_code: '1234' } };
    expect(missingRequired(typing, formContext(typing, { held })).find((m) => m.fieldKey === 'sort_code'))
      .toEqual({ sectionKey: 'bank', section: 'Bank account', fieldKey: 'sort_code', field: 'Sort code', reason: 'invalid' });
  });

  it('does not count a card face held for a different ID type', () => {
    const held = { 'representative.id_front': { doc: 'Driving licence' }, 'representative.id_back': { doc: 'Driving licence' } };
    const licence = { representative: { id_type: 'Driving licence' } };
    const card = { representative: { id_type: 'National ID card' } };
    const faces = (list) => missingKeys(list).filter((k) => /id_(front|back)$/.test(k));
    expect(faces(missingRequired(licence, formContext(licence, { held })))).toEqual([]);
    expect(faces(missingRequired(card, formContext(card, { held })))).toEqual(['representative.id_front', 'representative.id_back']);
    expect(progress(card, formContext(card, { held })).done).toBe(progress(card).done);
    expect(F.heldEntryOf(section('representative'), field('representative', 'id_front'), formContext(card, { held }))).toBeNull();
    expect(F.heldEntryOf(section('representative'), field('representative', 'id_front'), formContext(licence, { held }))).toEqual({ doc: 'Driving licence' });
    // The summary does not call licence images an ID card.
    expect(summarize(card, formContext(card, { held }))).not.toContain('Front of the ID card');
    expect(summarize(licence, formContext(licence, { held }))).toContain('Front of the driving licence: provided, held securely');
    // A face held before the type was recorded still counts.
    const legacyHeld = { ...card, _held: { 'representative.id_front': true, 'representative.id_back': true } };
    expect(faces(missingRequired(legacyHeld))).toEqual([]);
  });

  it('gives the titles the customer sees, keyed by section key', () => {
    const answers = { company: { entity_type: 'Individual' } };
    const m = missingRequired(answers).find((x) => x.fieldKey === 'legal_name');
    expect(m).toEqual({ sectionKey: 'company', section: 'Business details', fieldKey: 'legal_name', field: 'Your full legal name', reason: 'missing' });
  });
});

describe('fieldIssue', () => {
  const uk = formContext({});
  const us = formContext({}, { region: 'US' });
  const ind = formContext({ company: { entity_type: 'Individual' } });

  it('checks the tidied value, so format is fixed rather than refused', () => {
    expect(fieldIssue(field('company', 'company_number'), '445790', uk)).toBeNull();
    expect(fieldIssue(field('company', 'company_number'), '123456789', uk)).toEqual({ error: 'Company numbers are 8 characters, like 01234567 or SC123456.' });
    expect(fieldIssue(field('vat', 'number'), 'gb 220 4302 31', uk)).toBeNull();
    expect(fieldIssue(field('vat', 'number'), 'FR12345678901', uk)).toEqual({ error: 'UK VAT numbers look like GB123456789.' });
    expect(fieldIssue(field('bank', 'sort_code'), '30 96 34', uk)).toBeNull();
    expect(fieldIssue(field('bank', 'sort_code'), '3096', uk)).toEqual({ error: 'A sort code is 6 digits, like 12-34-56.' });
    expect(fieldIssue(field('bank', 'account_number'), '1234567', uk)).toBeNull();
    expect(fieldIssue(field('bank', 'account_number'), '12345', uk)).toEqual({ error: 'A UK account number is 8 digits.' });
    expect(fieldIssue(field('bank', 'account_number'), '12345', us)).toBeNull();
    expect(fieldIssue(field('bank', 'account_number'), '123', us)).toEqual({ error: 'Check the account number.' });
    expect(fieldIssue(field('bank', 'routing_number'), '021000022', us)).toEqual({ error: 'Check the 9 digit routing number.' });
    expect(fieldIssue(field('company', 'ein'), '12-3456789', us)).toBeNull();
  });

  it('flags too many digits instead of keeping the first few', () => {
    // A sort code and account number pasted into one box, or a doubled tap.
    expect(fieldIssue(field('bank', 'account_number'), '30963431926819', uk)).toEqual({ error: 'A UK account number is 8 digits.' });
    expect(fieldIssue(field('bank', 'sort_code'), '30963431', uk)).toEqual({ error: 'A sort code is 6 digits, like 12-34-56.' });
    expect(fieldIssue(field('bank', 'account_number'), '021000021123456789012', us)).toEqual({ error: 'Check the account number.' });
    expect(fieldIssue(field('bank', 'routing_number'), '0210000210', us)).toEqual({ error: 'Check the 9 digit routing number.' });
    expect(fieldIssue(field('company', 'ein'), '1234567890', us)?.error).toBeTruthy();
    // Shown as typed next to that error, never cut to a valid looking number.
    expect(formatOf(field('bank', 'sort_code'), '30963431')).toBe('30963431');
    expect(formatOf(field('company', 'ein'), '1234567890')).toBe('1234567890');
    expect(formatOf(field('company', 'ein'), '123456789')).toBe('12-3456789');
  });

  it('warns a sole trader whose legal name looks like a company, without blocking', () => {
    expect(fieldIssue(field('company', 'legal_name'), 'Mozz Pizza Ltd', ind)).toEqual({ warning: "A sole trader's legal name is their own name. If this is a company, choose Organisation." });
    expect(fieldIssue(field('company', 'legal_name'), 'Mozz Pizza Ltd', uk)).toBeNull();
    expect(fieldIssue(field('company', 'legal_name'), 'Jane Lincoln', ind)).toBeNull();
    expect(fieldIssue(field('company', 'legal_name'), 'J', uk)?.error).toBeTruthy();
    expect(fieldIssue(field('company', 'legal_name'), '', uk)).toBeNull();
  });

  it('nudges for a missing postcode or ZIP', () => {
    expect(fieldIssue(field('company', 'address'), '12 Market Street, Manchester', uk)).toEqual({ warning: 'Add the postcode if it is missing.' });
    expect(fieldIssue(field('company', 'address'), '12 Market Street, Manchester M1 1AE', uk)).toBeNull();
    expect(fieldIssue(field('company', 'address'), '350 Fifth Avenue, New York, NY', us)).toEqual({ warning: 'Add the ZIP code if it is missing.' });
    expect(fieldIssue(field('representative', 'home_address'), 'abc', uk)).toEqual({ error: 'Check the address.' });
  });

  it('tidies phone numbers to E.164 for the venue\'s country', () => {
    const phone = field('representative', 'phone');
    expect(phone.normalize('07700 900123', uk)).toBe('+447700900123');
    expect(phone.normalize('(415) 555-0123', us)).toBe('+14155550123');
    expect(phone.normalize('not a number', uk)).toBe('not a number');
    expect(fieldIssue(phone, '07700 900123', uk)).toBeNull();
    expect(fieldIssue(phone, '415.555.0123', us)).toBeNull();
    expect(fieldIssue(phone, '12345', uk)).toEqual({ error: 'Check the phone number.' });
    expect(fieldIssue(phone, '555-0123', us)).toEqual({ error: 'Check the phone number.' });
    expect(field('representative', 'email').normalize('  Jane@Mozz.CO.UK ')).toBe('jane@mozz.co.uk');
    expect(fieldIssue(field('representative', 'email'), 'jane@mozz', uk)).toEqual({ error: 'Check the email address.' });
  });

  it('tells the customer whether a date of birth is wrong or too young', () => {
    const dob = field('representative', 'dob');
    const young = `${new Date().getFullYear() - 5}-01-01`;
    expect(fieldIssue(dob, '1985-07-14', uk)).toBeNull();
    expect(fieldIssue(dob, '1985-02-30', uk)).toEqual({ error: 'Check the date.' });
    expect(fieldIssue(dob, young, uk)).toEqual({ error: 'They must be 18 or over.' });
    expect(fieldIssue(dob, young, ind)).toEqual({ error: 'You must be 18 or over.' });
  });

  it('is not the place for missing answers', () => {
    expect(isEmpty(field('bank', 'sort_code'), '')).toBe(true);
    expect(isEmpty(field('receipt', 'logo'), [])).toBe(true);
    expect(isEmpty(field('site_readiness', 'internet'), false)).toBe(true);
    expect(isEmpty(field('signoff', 'terms'), 'anything')).toBe(true);
    expect(fieldIssue(field('bank', 'sort_code'), '', uk)).toBeNull();
  });
});

describe('validators', () => {
  it('company numbers: zero padding, prefixes and NONE', () => {
    // Tesco PLC is 00445790; NatWest Group plc (Scotland) is SC045551.
    expect(F.normCompanyNumber('445790')).toBe('00445790');
    expect(F.normCompanyNumber('sc 45551')).toBe('SC045551');
    expect(F.normCompanyNumber('OC1234')).toBe('OC001234');
    expect(F.normCompanyNumber(' none ')).toBe('NONE');
    for (const ok of ['00445790', 'SC045551', 'NI123456', 'R0123456', 'IP12345R', 'NONE']) expect(F.validCompanyNumber(ok), ok).toBe(true);
    for (const bad of ['445790', '123456789', 'SC1234567', 'N/A', '']) expect(F.validCompanyNumber(bad), bad).toBe(false);
    expect(F.normCompanyNumber('123456789')).toBe('123456789');
  });

  it('VAT numbers: standard, 12 digit, government, health and Northern Ireland', () => {
    // Tesco's UK VAT number is GB 220 4302 31.
    expect(F.normVat('220 4302 31')).toBe('GB220430231');
    expect(F.normVat('gb220430231')).toBe('GB220430231');
    expect(F.normVat('220430231000')).toBe('GB220430231000');
    expect(F.normVat('GD001')).toBe('GBGD001');
    // Northern Ireland numbers come in the same four forms as GB ones.
    for (const ok of ['GB220430231', 'GB220430231000', 'GBGD001', 'GBHA599', 'XI220430231', 'XI123456789012', 'XIGD001', 'XIHA599']) {
      expect(F.validVat(ok), ok).toBe(true);
    }
    for (const bad of ['GB22043023', '220430231', 'FR12345678901', 'GBGD01', 'XI12345678', 'XIGD01', 'XI1234567890123']) expect(F.validVat(bad), bad).toBe(false);
    expect(fieldIssue(field('vat', 'number'), 'xi 123456789012', formContext({}))).toBeNull();
  });

  it('sort codes and UK account numbers, with a 7 digit account padded to 8', () => {
    expect(F.normSortCode('30-96-34')).toBe('309634');
    expect(F.validSortCode('309634')).toBe(true);
    expect(F.validSortCode('30963')).toBe(false);
    expect(F.formatSortCode('309634')).toBe('30-96-34');
    expect(F.formatSortCode('3096')).toBe('30-96');
    expect(formatOf(field('bank', 'sort_code'), '309634')).toBe('30-96-34');
    expect(F.normUkAccount('1234567')).toBe('01234567');
    expect(F.normUkAccount('123456')).toBe('00123456');
    expect(F.normUkAccount('12345')).toBe('12345');
    expect(F.validUkAccount('01234567')).toBe(true);
    expect(F.validUkAccount('1234567')).toBe(false);
    expect(F.validUsAccount('1234')).toBe(true);
    expect(F.validUsAccount('12345678901234567')).toBe(true);
    expect(F.validUsAccount('123')).toBe(false);
    expect(F.validUsAccount('123456789012345678')).toBe(false);
  });

  it('ABA routing numbers pass only with a valid checksum, in both copies', () => {
    const real = [
      '021000021', // JPMorgan Chase, New York
      '011000015', // Federal Reserve Bank of Boston
      '121000358', // Bank of America, California
      '322271627', // JPMorgan Chase, California
      '026009593', // Bank of America, New York
    ];
    const wrong = ['021000022', '121000359', '000000000', '02100002', '0210000210', '02100002a'];
    for (const n of real) {
      expect(F.validAba(n), n).toBe(true);
      expect(S.validAba(n), n).toBe(true);
    }
    for (const n of wrong) {
      expect(F.validAba(n), n).toBe(false);
      expect(S.validAba(n), n).toBe(false);
    }
  });

  it('EINs are 9 digits, not all zeros, shown as 12-3456789', () => {
    expect(F.normEin('12-3456789')).toBe('123456789');
    expect(F.validEin('123456789')).toBe(true);
    expect(F.validEin('000000000')).toBe(false);
    expect(F.validEin('12345678')).toBe(false);
    expect(F.formatEin('123456789')).toBe('12-3456789');
    expect(F.formatEin('12')).toBe('12');
  });

  it('dates of birth: real dates, 1900 on, and 18 on the 18th birthday itself', () => {
    const today = '2026-09-11';
    expect(F.validDob('2008-09-11', today)).toBe(true);    // 18 today
    expect(F.dobProblem('2008-09-12', today)).toBe('age'); // 18 tomorrow
    expect(F.validDob('2008-09-10', today)).toBe(true);
    expect(F.validDob('2008-09-11', new Date(2026, 8, 11))).toBe(true);
    expect(F.validDob('2008-09-11', new Date(2026, 8, 10))).toBe(false);
    expect(F.validDob('1900-01-01', today)).toBe(true);
    expect(F.dobProblem('1899-12-31', today)).toBe('date');
    expect(F.dobProblem('2001-02-29', today)).toBe('date');
    expect(F.validDob('2000-02-29', today)).toBe(true);
    expect(F.dobProblem('1990-13-01', today)).toBe('date');
    expect(F.dobProblem('2027-01-01', today)).toBe('date');
    expect(F.dobProblem('14/07/1985', today)).toBe('date');
    // A leap day birthday turns 18 on 1 March in a non leap year.
    expect(F.dobProblem('2008-02-29', '2026-02-28')).toBe('age');
    expect(F.validDob('2008-02-29', '2026-03-01')).toBe(true);
    expect(F.formatDob('1985-07-14', formContext({}))).toBe('14/07/1985');
    expect(F.formatDob('1985-07-14', formContext({}, { region: 'US' }))).toBe('07/14/1985');
  });

  it('postcodes and ZIP codes', () => {
    for (const ok of ['10 Downing Street, London SW1A 2AA', 'Manchester\nM1 1AE', 'sw1a2aa', 'EC1A 1BB', 'Leeds LS1 1AA', 'GIR 0AA']) {
      expect(F.hasUkPostcode(ok), ok).toBe(true);
    }
    for (const bad of ['10 Downing Street, London', '12 Market Street', '']) expect(F.hasUkPostcode(bad), bad).toBe(false);
    for (const ok of ['1600 Pennsylvania Avenue NW, Washington, DC 20500', '350 Fifth Avenue\nNew York, NY 10118-0110', '1 Main St\n94043']) {
      expect(F.hasUsZip(ok), ok).toBe(true);
    }
    for (const bad of ['350 Fifth Avenue, New York, NY', '12345 Main St, Springfield, IL', '']) expect(F.hasUsZip(bad), bad).toBe(false);
  });

  it('postcodes and ZIP codes are read where an address puts them, not anywhere in the text', () => {
    // A unit number or house number mid address is not a postcode or ZIP.
    for (const bad of ['Suite A2 3rd Floor, Leeds', 'Flat B3 2nd floor\nLeeds']) expect(F.hasUkPostcode(bad), bad).toBe(false);
    for (const ok of ['SW1A 2AA, London', '12 Market Street, Manchester M1 1AE, United Kingdom', 'Leeds LS1 1AA.', 'Belfast BT1 5GS\nUK']) {
      expect(F.hasUkPostcode(ok), ok).toBe(true);
    }
    for (const bad of ['Unit 5, 12345 Main St, Austin, TX', 'Suite 200\n12345 Main St\nAustin, TX', '12345']) {
      expect(F.hasUsZip(bad), bad).toBe(false);
    }
    for (const ok of ['500 Main St Suite 200 78701', 'Austin, TX 78701, USA', '120 N University Ave\nProvo, UT 84601-1234\nUnited States']) {
      expect(F.hasUsZip(ok), ok).toBe(true);
    }
    const us = formContext({}, { region: 'US' });
    expect(fieldIssue(field('company', 'address'), 'Unit 5, 12345 Main St, Austin, TX', us)).toEqual({ warning: 'Add the ZIP code if it is missing.' });
    expect(fieldIssue(field('company', 'address'), '500 Main St Suite 200 78701', us)).toBeNull();
    expect(fieldIssue(field('company', 'address'), 'Suite A2 3rd Floor, Leeds', formContext({}))).toEqual({ warning: 'Add the postcode if it is missing.' });
  });

  it('emails and phone numbers', () => {
    expect(F.validEmail('jane@mozz.co.uk')).toBe(true);
    for (const bad of ['jane@mozz', 'jane mozz@x.com', '@x.com', 'jane@.com', '']) expect(F.validEmail(bad), bad).toBe(false);
    expect(F.validPhone('+447700900123')).toBe(true);
    expect(F.validPhone('+14155550123')).toBe(true);
    expect(F.validPhone('+353861234567')).toBe(true);
    expect(F.validPhone('+15550123')).toBe(false);
    expect(F.validPhone('+4412345')).toBe(false);
    expect(F.validPhone(null)).toBe(false);
  });

  it('toE164 moved to phoneFormat.js unchanged', () => {
    expect(toE164('07576 123456')).toBe('+447576123456');
    expect(toE164('+44 (0)7576 123456')).toBe('+447576123456');
    expect(toE164('(713) 555-0123')).toBe('+17135550123');
    expect(toE164('7135550123', 'US')).toBe('+17135550123');
    expect(toE164('')).toBeNull();
  });
});

describe('reused answers', () => {
  it('works out the legal representative without copying answers', () => {
    expect(representativeName({ company: { entity_type: 'Individual', legal_name: 'Jane Smith', contact_name: 'Bob' }, representative: { name: 'Stale' } })).toBe('Jane Smith');
    expect(representativeName({ company: { contact_name: 'Jane Smith' }, representative: { is_contact: 'Yes', name: 'Stale' } })).toBe('Jane Smith');
    expect(representativeName({ company: { contact_name: 'Jane Smith' }, representative: { is_contact: 'No', name: 'Raj Patel' } })).toBe('Raj Patel');
    expect(representativeName({ company: { contact_name: '' }, representative: { name: 'Raj Patel' } })).toBe('Raj Patel');
    expect(representativeName({ company: { contact_name: 'Jane Smith' }, representative: { name: 'Stale' } })).toBe('');
    expect(representativeName({})).toBe('');
  });

  it('works out the account holder', () => {
    expect(accountHolder({ company: { legal_name: 'Mozz Pizza Ltd' }, bank: { holder_same: 'Yes', holder_name: 'Stale' } })).toBe('Mozz Pizza Ltd');
    expect(accountHolder({ company: { legal_name: 'Mozz Pizza Ltd' }, bank: { holder_same: 'No', holder_name: 'Mozz Holdings Ltd' } })).toBe('Mozz Holdings Ltd');
    expect(accountHolder({ bank: {} })).toBe('');
  });

  it('shows the answer a same as question reuses', () => {
    const answers = { company: { legal_name: 'Mozz Pizza Ltd', contact_name: 'Jane Smith', address: '12 Market Street, Manchester M1 1AE' } };
    const ctx = formContext(answers);
    expect(echoOf(field('bank', 'holder_same'), ctx)).toBe('Mozz Pizza Ltd');
    expect(echoOf(field('bank', 'holder_same'), formContext({}))).toBe('the name given above');
    expect(echoOf(field('representative', 'is_contact'), ctx)).toBe('Jane Smith');
    expect(echoOf(field('representative', 'home_same'), ctx)).toBe('12 Market Street, Manchester M1 1AE');
    expect(echoOf(field('trading', 'same_address'), ctx)).toBe('12 Market Street, Manchester M1 1AE');
    expect(labelOf(field('trading', 'same_address'), formContext({ company: { entity_type: 'Individual' } })))
      .toBe('Is the trading address the same as your business address?');
  });

  it('offers tap to fill chips from what we already hold', () => {
    const ind = { company: { entity_type: 'Individual', legal_name: 'Jane Smith' } };
    expect(suggestOf(field('company', 'contact_name'), formContext(ind))).toEqual([{ label: "That's me", value: 'Jane Smith' }]);
    expect(suggestOf(field('company', 'contact_name'), formContext({ company: { legal_name: 'Mozz Pizza Ltd' } }))).toEqual([]);
    expect(suggestOf(field('company', 'address'), formContext({}, { venue_address: '5 Deansgate, Manchester M3 2BW' })))
      .toEqual([{ label: 'Use the venue address', value: '5 Deansgate, Manchester M3 2BW' }]);
    expect(suggestOf(field('company', 'address'), formContext({}))).toEqual([]);
    expect(suggestOf(field('trading', 'trading_name'), formContext({ company: { legal_name: 'Mozz Pizza Ltd' } }, { venue: 'Mozz' })).map((c) => c.value))
      .toEqual(['Mozz', 'Mozz Pizza Ltd']);
    expect(suggestOf(field('trading', 'trading_name'), formContext({ company: { legal_name: 'mozz' } }, { venue: 'Mozz' }))).toHaveLength(1);
    expect(suggestOf(field('representative', 'email'), formContext({}, { sent_to: 'Jane@Mozz.co.uk' }))).toEqual([{ label: 'jane@mozz.co.uk', value: 'jane@mozz.co.uk' }]);
    expect(suggestOf(field('representative', 'email'), formContext({}, { sent_to: 'link only' }))).toEqual([]);
    expect(suggestOf(field('signoff', 'full_name'), formContext(ind)).map((c) => c.value)).toEqual(['Jane Smith']);
  });
});

describe('the server copy agrees with the definition', () => {
  it('has the same secure key lists', () => {
    expect(SECURE_VALUE_KEYS).toEqual([...S.SECURE_VALUE_KEYS]);
    expect(SECURE_FILE_KEYS).toEqual([...S.SECURE_FILE_KEYS]);
    expect(SECURE_VALUE_KEYS).toEqual(['bank.sort_code', 'bank.routing_number', 'bank.account_number', 'representative.dob', 'representative.home_address']);
    expect(SECURE_FILE_KEYS).toEqual(['representative.id_passport', 'representative.id_front', 'representative.id_back']);
    // Business contact details and public identifiers are deliberately not secure.
    for (const k of ['representative.name', 'representative.phone', 'representative.email', 'company.company_number', 'company.ein', 'vat.number']) {
      expect(isSecureKey(k), k).toBe(false);
    }
    expect(S.isSecureKey('representative.dob')).toBe(true);
    expect(SECTIONS.flatMap((s) => s.fields.filter((f) => f.secure && f.multiple))).toEqual([]);
  });

  it('agrees on which secure keys are showing, across the whole matrix', () => {
    let checked = 0;
    for (const region of ['UK', 'US']) {
      for (const entity_type of [undefined, 'Organisation', 'Individual']) {
        for (const contact_name of ['', 'Jane Smith']) {
          for (const is_contact of [undefined, 'Yes', 'No']) {
            for (const home_same of [undefined, 'Yes', 'No']) {
              for (const id_type of [undefined, '', 'Passport', 'Driving licence', 'National ID card']) {
                const answers = { company: { entity_type, contact_name }, representative: { is_contact, home_same, id_type } };
                const fromDefinition = visibleKeys(answers, formContext(answers, { region })).filter(isSecureKey).sort();
                expect([...S.secureVisible(answers, region)].sort(), JSON.stringify({ region, answers })).toEqual(fromDefinition);
                // And through the stamp on the pack, as the card reads it.
                const stamped = { ...answers, _meta: { v: 2, region } };
                expect([...S.secureVisible(stamped, region)].sort()).toEqual(visibleKeys(stamped).filter(isSecureKey).sort());
                checked += 1;
              }
            }
          }
        }
      }
    }
    expect(checked).toBe(540);
    expect([...S.secureVisible(null, 'UK')].sort()).toEqual(['bank.account_number', 'bank.sort_code', 'representative.dob']);
  });

  it('picks the same region from the venue and company countries', () => {
    const cases = [
      ['US', null, 'US'], ['USA', 'GB', 'US'], ['us', '', 'US'], ['GB', 'US', 'UK'], ['CA', 'US', 'UK'],
      ['', 'US', 'US'], [null, 'usa', 'US'], [undefined, 'GB', 'UK'], [null, null, 'UK'], ['', '', 'UK'], [' ', 'US', 'US'],
    ];
    for (const [loc, co, want] of cases) {
      expect(regionFor(loc, co), `${loc}/${co}`).toBe(want);
      expect(S.regionFor(loc, co), `${loc}/${co}`).toBe(want);
    }
  });

  it('accepts on the server exactly what the page lets through', () => {
    const NOW = new Date();
    const cases = [
      ['bank', 'sort_code', 'UK', ['309634', '30-96-34', '30963', '']],
      ['bank', 'routing_number', 'US', ['021000021', '021000022', '02100002']],
      ['bank', 'account_number', 'UK', ['31926819', '1234567', '12345', '123456789']],
      ['bank', 'account_number', 'US', ['1234', '12345678901234567', '123', '123456789012345678']],
      ['representative', 'dob', 'UK', ['1985-07-14', '1985-02-30', `${NOW.getFullYear() - 5}-01-01`, '1899-01-01']],
      ['representative', 'home_address', 'UK', ['9 Hidden Lane, Salford M5 4WT', 'No postcode at all', 'abc', 'x'.repeat(501)]],
      ['representative', 'home_address', 'US', ['12 Elm St, Austin, TX 78701', 'abcd']],
    ];
    for (const [sk, fk, region, values] of cases) {
      const f = field(sk, fk);
      const ctx = formContext({}, { region });
      for (const raw of values) {
        // The page only ever sends the normalised form.
        const v = f.normalize ? f.normalize(raw, ctx) : raw;
        const pageOk = !isEmpty(f, v) && !fieldIssue(f, v, ctx)?.error;
        expect(S.serverValid(`${sk}.${fk}`, v, region, NOW), `${sk}.${fk} ${region} ${raw}`).toBe(pageOk);
      }
    }
    // A key for the other region is never stored.
    expect(S.serverValid('bank.sort_code', '309634', 'US')).toBe(false);
    expect(S.serverValid('bank.routing_number', '021000021', 'UK')).toBe(false);
    expect(S.serverValid('representative.id_passport', 'x', 'UK')).toBe(false);
    expect(S.serverValid('bank.sort_code', 309634, 'UK')).toBe(false);
  });

  it('gives the server one day of grace on an 18th birthday, for time zones ahead of UTC', () => {
    const noonUtc = new Date('2026-09-11T12:00:00Z');
    expect(S.serverValid('representative.dob', '2008-09-11', 'UK', noonUtc)).toBe(true);
    expect(S.serverValid('representative.dob', '2008-09-12', 'UK', noonUtc)).toBe(true);
    expect(S.serverValid('representative.dob', '2008-09-13', 'UK', noonUtc)).toBe(false);
    expect(S.serverValid('representative.dob', '2008-02-30', 'UK', noonUtc)).toBe(false);
  });

  it('stamps the terms version the definition shows', () => {
    expect(S.TERMS_VERSION).toBe(TERMS_VERSION);
  });

  it('builds _held from the secure row in a shape the page and the card count as answered', () => {
    const values = { 'bank.sort_code': '309634', 'bank.account_number': '31926819', 'representative.dob': '1985-07-14', 'representative.home_address': '  ', 'company.legal_name': 'Not secure' };
    const files = { 'representative.id_passport': { path: 'req-1/id_passport-a1b2c3d4.jpg' }, 'representative.id_front': {} };
    const held = S.heldFrom(values, files);
    // Blank values, files with no path and keys that are not secure are left out,
    // and the order follows the key lists so two builds compare equal as JSON.
    expect(held).toEqual({ 'bank.sort_code': true, 'bank.account_number': { hint: '6819' }, 'representative.dob': true, 'representative.id_passport': true });
    expect(Object.keys(held)).toEqual(['bank.sort_code', 'bank.account_number', 'representative.dob', 'representative.id_passport']);
    expect(JSON.stringify(S.heldFrom({ ...values }, { ...files }))).toBe(JSON.stringify(held));
    expect(S.heldFrom(null, undefined)).toEqual({});
    // Read back through _held on the pack, as the card reads it, and through
    // env.held, as the page reads load's response.
    const pack = { representative: { home_same: 'Yes', id_type: 'Passport' } };
    const secureOwed = (list) => missingKeys(list).filter(isSecureKey);
    expect(secureOwed(missingRequired({ ...pack, _held: held }))).toEqual([]);
    expect(secureOwed(missingRequired(pack, formContext(pack, { held })))).toEqual([]);
  });

  it('hints only the last 4 digits of a long enough account number', () => {
    expect(S.hintFor('bank.account_number', '31926819')).toBe('6819');
    expect(S.hintFor('bank.account_number', '1234')).toBeNull();
    expect(S.hintFor('bank.sort_code', '309634')).toBeNull();
    expect(S.hintFor('representative.dob', '1985-07-14')).toBeNull();
    expect(S.heldEntry('bank.account_number', '31926819')).toEqual({ hint: '6819' });
    expect(S.heldEntry('representative.dob', '1985-07-14')).toBe(true);
  });

  it('only accepts a secure file inside its own request and field', () => {
    const rid = '3f1c0a52-9a55-4c1e-b7e1-0c7d8f6f2a10';
    const id = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
    const path = S.securePath(rid, 'representative.id_passport', 'image/jpeg', id);
    expect(path).toBe(`${rid}/id_passport-${id}.jpg`);
    const file = { path, name: 'Passport photo page.jpg', size: 245000, mime: 'image/jpeg' };
    expect(S.secureFileValid('representative.id_passport', file, rid)).toBe(true);
    expect(S.secureFileValid('representative.id_front', file, rid)).toBe(false);
    expect(S.secureFileValid('representative.id_passport', file, 'another-request')).toBe(false);
    expect(S.secureFileValid('representative.id_passport', { ...file, path: `onboarding/${rid}/id_passport-${id}.jpg` }, rid)).toBe(false);
    expect(S.secureFileValid('representative.id_passport', { ...file, path: `${rid}/id_passport-../../x.jpg` }, rid)).toBe(false);
    expect(S.secureFileValid('representative.id_passport', { ...file, size: S.MAX_SECURE_BYTES + 1 }, rid)).toBe(false);
    expect(S.secureFileValid('representative.id_passport', { ...file, mime: 'image/heic' }, rid)).toBe(false);
    expect(S.secureFileValid('representative.id_passport', [file], rid)).toBe(false);
    expect(S.securePath(rid, 'bank.sort_code', 'image/jpeg', id)).toBeNull();
    expect(S.securePath(rid, 'representative.id_front', 'text/html', id)).toBeNull();
    expect(S.secureFileName('representative.id_passport', 'image/jpeg')).toBe('Passport photo page.jpg');
    expect(S.secureFileName('representative.id_back', 'application/pdf')).toBe('Photo ID back.pdf');
    expect(S.SECURE_BUCKET).toBe('onboarding-secure');
    expect([...S.SECURE_MIME]).toEqual(['image/jpeg', 'image/png', 'application/pdf']);
    expect(S.MAX_SECURE_BYTES).toBe(10485760);
  });

  it('withholds the whole note when the summary mentions a held value, in the forms people write them', () => {
    const secrets = ['309634', '31926819', '1985-07-14', 'req-1/id_passport-a1b2.jpg', '12', '9 Hidden Lane\nSalford M5 4WT'];
    for (const text of ['Sort code 30-96-34', 'sort 30 96 34', 'account 31926819', 'born 14/07/1985', 'born 07/14/1985',
      'born 14.07.1985', 'file req-1/id_passport-a1b2.jpg', 'Home: 9 HIDDEN LANE Salford M5 4WT']) {
      expect(S.mentionsSecret(text, secrets), text).toBe(true);
      expect(S.noteBody(text, secrets), text).toBe(S.NOTE_WITHHELD);
    }
    // Never blanked where it sits: "[held securely] Elm St" next to the card's
    // copy of the address would give the 4 digit account number away.
    expect(S.noteBody('Your business address: 4417 Elm St, Provo, UT 84601', ['4417'])).toBe('Summary withheld. See the onboarding pack.');
    const clean = summarize(SECRET_PACK);
    expect(S.mentionsSecret(clean, ['309634', '31926819', '1985-07-14', '9 Hidden Lane, Salford M5 4WT', 'req-1/id_passport-a1b2c3d4.jpg'])).toBe(false);
    expect(S.noteBody(clean, ['309634'])).toBe(clean);
    expect(S.mentionsSecret('PIN 12', ['12'])).toBe(false);
    expect(S.NOTE_WITHHELD).not.toMatch(/[–—]/);
  });

  it('records the ID type a card face was uploaded as, and agrees with the definition about it', () => {
    const card = { representative: { id_type: 'National ID card' } };
    const licence = { representative: { id_type: 'Driving licence' } };
    const face = { path: 'req-1/id_front-a1b2c3d4.jpg', doc: 'Driving licence' };
    expect(S.idFileFits('representative.id_front', face, licence)).toBe(true);
    expect(S.idFileFits('representative.id_front', face, card)).toBe(false);
    expect(S.idFileFits('representative.id_front', { path: face.path }, card)).toBe(true);
    expect(S.idFileFits('representative.id_passport', face, card)).toBe(true);
    const held = S.heldFrom({}, {
      'representative.id_front': { path: 'req-1/id_front-a.jpg', doc: 'National ID card' },
      'representative.id_passport': { path: 'req-1/id_passport-b.jpg', doc: 'ignored' },
    });
    expect(held).toEqual({ 'representative.id_passport': true, 'representative.id_front': { doc: 'National ID card' } });
    expect(missingKeys(missingRequired({ ...card, _held: held })).filter((k) => k === 'representative.id_front')).toEqual([]);
    expect(missingKeys(missingRequired({ ...licence, _held: held }))).toContain('representative.id_front');
    expect([...S.ID_CARD_KEYS]).toEqual(['representative.id_front', 'representative.id_back']);
  });

  it('refuses section and field keys every object already has, and our own underscore keys', () => {
    for (const s of SECTIONS) {
      expect(S.validPackKey(s.key), s.key).toBe(true);
      for (const f of s.fields) expect(S.validPackKey(f.key), `${s.key}.${f.key}`).toBe(true);
    }
    for (const bad of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf', '__proto__', '_held', '_meta',
      'a.b', '', 'x'.repeat(65), 5, null, undefined]) {
      expect(S.validPackKey(bad), String(bad)).toBe(false);
    }
  });
});

describe('migration 114', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/114_onboarding_secure.sql', import.meta.url), 'utf8');

  it('lets only an owner change a role, since every owner only rule trusts the role', () => {
    expect(sql).toMatch(/create trigger profiles_guard_role\s+before update on public\.profiles/);
    expect(sql).toMatch(/new\.role is distinct from old\.role/);
    expect(sql).toMatch(/current_user in \('authenticated', 'anon'\)/);
    expect(sql).toMatch(/public\.current_user_role\(\) is distinct from 'owner'/);
  });

  it('refuses to delete a request while its ID images are still in the bucket', () => {
    expect(sql).toMatch(/create trigger onb_form_req_keep_id\s+before delete on public\.onboarding_form_requests/);
    expect(sql).toMatch(/o\.bucket_id = 'onboarding-secure'\s+and o\.name like old\.id::text \|\| '\/%'/);
    expect(sql).toMatch(/Delete ID and bank details/);
  });
});

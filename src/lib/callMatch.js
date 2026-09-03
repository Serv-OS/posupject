// Working out who a call was with.
//
// Three separate things were breaking this, and only one of them was obvious.
//
// 1. The contacts query asked for a `mobile` column that does not exist on any
//    of the four CRMs. PostgREST rejects the whole request, the code did
//    `data || []`, and so the contacts list was ALWAYS empty. Every call showed
//    a bare number, including the ones correctly linked to a contact. A silent
//    swallow turned a typo into "the call log does not know anyone".
//
// 2. Calls logged before contact-linking never got a contact_id, so even with
//    contacts loaded there was nothing to look up. 24 of 27 unlinked calls on
//    posupcrm have a contact sitting there matching on number.
//
// 3. The number is not stored under one key. Twilio paths have written
//    `from_number`, `to_number` and plain `to` over time, so anything reading
//    only one or two of them misses whole sets of calls.
//
// Matching is on the last 10 digits, which makes +447432203290, 447432203290
// and 07432203290 the same number without needing a phone library. Ten digits
// is enough to be safe for UK mobiles and US numbers alike; shorter strings are
// refused rather than guessed at, because a 4-digit extension would otherwise
// match half the address book.

export const digits10 = (s) => String(s || '').replace(/\D/g, '').slice(-10);

/** Do two numbers refer to the same line, whatever format each is stored in? */
export const samePhone = (a, b) => {
  const x = digits10(a);
  return x.length === 10 && x === digits10(b);
};

/** The other party's number on a call activity, whichever key it was written to.
 *  Named callPartyNumber, NOT callNumber: lib/phone.js already exports a
 *  callNumber() that PLACES a call, and two functions with one name in the same
 *  area is how a click-to-call button quietly stops dialling. */
export function callPartyNumber(activity) {
  const md = activity?.channel_metadata || {};
  const inbound = activity?.direction === 'inbound';
  const from = md.from_number || md.from;
  const to = md.to_number || md.to;
  // On an inbound call the other party is the caller; on an outbound one it is
  // whoever we rang. Fall back either way rather than showing nothing.
  return (inbound ? (from || to) : (to || from)) || null;
}

/** Every contact holding this number. Usually none or one — but shared lines
 *  exist, and pretending otherwise is how a call gets pinned on the wrong
 *  person. On this data 7415602105 belongs to both "Vicky CB - Castleford" and
 *  "Staff CB - Castleford": one shop phone, two people who answer it. */
export function contactsForNumber(number, contacts = []) {
  const n = digits10(number);
  if (n.length !== 10) return [];
  return contacts.filter(c => samePhone(c.phone, number));
}

/** A contact whose only "name" is the number itself, or nothing at all. These
 *  get created automatically from an unknown caller, and there are piles of
 *  them: 7527879566 is in the book three times, named +447527879566 each time.
 *  They are not competing identities, so they must not make a real name
 *  ambiguous — otherwise one junk row hides the person you actually know. */
export function isPlaceholderContact(c) {
  const name = [c?.first_name, c?.last_name].filter(Boolean).join(' ').trim();
  if (!name) return true;
  return digits10(name).length >= 10 && samePhone(name, c?.phone);
}

/** Display name for a contact, or null if it has none worth showing. */
export function contactName(c) {
  const name = [c?.first_name, c?.last_name].filter(Boolean).join(' ').trim();
  return name || c?.email || null;
}

/** The contact a call belongs to: the explicit link first, else by number —
 *  but ONLY when the number points at exactly one person.
 *
 *  Where several contacts share a line this returns null on purpose, and the
 *  caller shows the number. Taking the first match would be picking a name out
 *  of a hat and printing it as fact, which is worse than the bare number this
 *  was meant to replace. */
export function contactForCall(activity, contacts = []) {
  if (activity?.contact_id) {
    const linked = contacts.find(c => c.id === activity.contact_id);
    if (linked) return linked;   // a human said so; that beats any guess
  }
  const all = contactsForNumber(callPartyNumber(activity), contacts);
  // Placeholders never outvote a real name.
  const real = all.filter(c => !isPlaceholderContact(c));
  if (real.length === 1) return real[0];
  // Several rows, one person entered twice: the same name either way, so the
  // choice cannot be wrong. Genuinely different people stay unresolved.
  if (real.length > 1) {
    const names = new Set(real.map(c => contactName(c)));
    if (names.size === 1) return real[0];
    return null;
  }
  return null;
}

/** True when the number is in the book more than once, so the UI can say
 *  "shared line" rather than silently showing a number it could explain. */
export function isSharedLine(activity, contacts = []) {
  if (activity?.contact_id) return false;
  const real = contactsForNumber(callPartyNumber(activity), contacts).filter(c => !isPlaceholderContact(c));
  return new Set(real.map(c => contactName(c))).size > 1;
}

/** What to show as the party on a call row: their name, or the number. */
export function callPartyLabel(activity, contacts = []) {
  const c = contactForCall(activity, contacts);
  if (c) {
    const name = [c.first_name, c.last_name].filter(Boolean).join(' ').trim();
    if (name) return name;
    if (c.email) return c.email;
  }
  return callPartyNumber(activity) || 'Unknown number';
}

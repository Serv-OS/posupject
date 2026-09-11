/* Who a reply goes to.
 *
 * Replies used to go to one person: the newest sender in the Inbox, the first
 * sender on a ticket. Everyone CC'd on the thread fell off, and there was no
 * Reply all. This works out To and Cc for Reply and Reply all from the headers
 * of the message being answered, and never puts our own mailbox on either line.
 *
 * Pure, so the rules can be tested. Addresses are lowercased and de-duplicated.
 */

/** A plausible single address. Deliberately loose: the mail server is the real judge. */
export const isValidEmail = (e) => /^[^\s@<>(),;:"\\]+@[^\s@<>(),;:"\\]+\.[^\s@<>(),;:"\\]+$/.test(String(e || ''));

/** Header values must never carry a line break: that is how headers get injected. */
export const stripCrlf = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();

// Split on commas and semicolons that are not inside quotes or angle brackets,
// so "Smith, Jo" <jo@x.com> stays one part.
function addressTokens(header) {
  const text = stripCrlf(Array.isArray(header) ? header.join(', ') : header);
  if (!text) return [];
  const parts = [];
  let cur = '', quoted = false, angle = 0;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (ch === '<' && !quoted) angle++;
    else if (ch === '>' && !quoted && angle) angle--;
    if ((ch === ',' || ch === ';') && !quoted && !angle) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

const emailOf = (part) => {
  const m = part.match(/<([^<>]+)>/);
  return (m ? m[1] : part).trim().replace(/^mailto:/i, '').toLowerCase();
};

/**
 * Parse a To/Cc/From header (or a list typed by a person) into [{ name, email }].
 * Parts that are not addresses are left out here; use invalidAddresses to find them.
 */
export function parseAddressList(header) {
  const out = [], seen = new Set();
  for (const p of addressTokens(header)) {
    const email = emailOf(p);
    if (!isValidEmail(email) || seen.has(email)) continue;
    seen.add(email);
    const m = p.match(/<([^<>]+)>/);
    out.push({ name: m ? p.slice(0, m.index).trim().replace(/^"|"$/g, '').trim() : '', email });
  }
  return out;
}

/**
 * Every typed part that is not an address. A list with any of these is refused
 * as a whole: "kate@venue.com, dan@venue" used to send to Kate and quietly
 * leave Dan off. Mirrors invalidAddresses in supabase/functions/_shared/addresses.ts.
 */
export const invalidAddresses = (header) => addressTokens(header).filter((p) => !isValidEmail(emailOf(p)));

/**
 * To and Cc for a reply to `message` ({ from, replyTo, to, cc } header strings).
 * `own` is our own address(es): the support mailbox, or the person's own Gmail.
 *
 * Reply:     To = whoever sent it (Reply-To wins over From).
 * Reply all: To = the sender, Cc = everyone else it went to or was copied to.
 * If WE sent the message being answered, the people we sent it to stay on To.
 */
/**
 * The mailbox an address delivers to, for spotting our own: lower case, with
 * any +tag dropped, so support+billing@ is still the support mailbox.
 */
export const mailboxKey = (email) => String(email || '').trim().toLowerCase().replace(/\+[^@]*@/, '@');

export function buildReply(message = {}, own = [], mode = 'reply') {
  const ownKeys = new Set((Array.isArray(own) ? own : [own]).filter(Boolean).map(mailboxKey));
  const ownSet = { has: (email) => ownKeys.has(mailboxKey(email)) };
  const notOwn = (a) => !ownSet.has(a.email);
  const from = parseAddressList(message.from);
  const to = parseAddressList(message.to);
  const cc = parseAddressList(message.cc);
  const weSentIt = from.some((a) => ownSet.has(a.email));

  let toList, ccList = [];
  if (weSentIt) {
    toList = to.filter(notOwn);
    if (mode === 'all') ccList = cc;
  } else {
    const replyTo = parseAddressList(message.replyTo || message.reply_to);
    toList = (replyTo.length ? replyTo : from).filter(notOwn);
    if (mode === 'all') ccList = [...to, ...cc];
  }
  const taken = new Set(toList.map((a) => a.email));
  ccList = ccList.filter((a) => notOwn(a) && !taken.has(a.email) && taken.add(a.email));
  return { to: toList, cc: ccList };
}

/** True when Reply all would reach more people than Reply, so the choice is worth showing. */
export const hasOtherRecipients = (message, own) => buildReply(message, own, 'all').cc.length > 0;

/** Bare addresses for a header line: "a@x.com, b@y.com". Names are left out on purpose. */
export const headerList = (list) => (list || []).map((a) => (typeof a === 'string' ? a : a.email)).filter(isValidEmail).join(', ');

/* Rules behind the live conversation screens: the ticket thread, task notes and
 * the Inbox reply box.
 *
 * The ticket thread reloads every 25 s and on every realtime event. It used to
 * swap in an identical copy of the list each time, and the scroll effect threw
 * the reader back to the latest reply on every swap. These helpers keep what is
 * on screen when nothing changed, decide when new rows may move the view, and
 * work out who a reply really goes to. Pure, so the rules can be tested.
 */
import { buildReply, invalidAddresses, parseAddressList } from './replyRecipients';

export const MAX_RECIPIENTS = 20; // gmail-send and gmail-personal refuse more than this
// A new row this close in time to the newest one on screen is new to the reader
// even when its own timestamp sorts it just above that row (an email's Date header).
const NEW_ROW_WINDOW_MS = 15 * 60 * 1000;

/** Deep equality for JSON-shaped values (rows, jsonb columns). */
export function sameValue(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || !sameValue(a[k], b[k])) return false;
  return true;
}

// Everything on an activity the thread shows. Rows are changed after insert
// (note edits, recipients saved onto older emails) and there is no updated_at,
// so the fields themselves are compared.
const ROW_FIELDS = ['id', 'occurred_at', 'type', 'direction', 'actor_id', 'is_internal', 'subject', 'body', 'edited_at'];
export function sameActivity(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  for (const f of ROW_FIELDS) if ((a[f] ?? null) !== (b[f] ?? null)) return false;
  return sameValue(a.channel_metadata ?? null, b.channel_metadata ?? null);
}

/** True when a refresh brought back exactly what is already on screen. */
export function sameActivities(prev, next) {
  if (prev === next) return true;
  if (!Array.isArray(prev) || !Array.isArray(next) || prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) if (!sameActivity(prev[i], next[i])) return false;
  return true;
}

/**
 * Rows a refresh added at the bottom of the thread. `prevIds` is the Set of ids
 * that were on screen before and `prevNewestAt` the newest occurred_at among
 * them. A new last row brings every new row with it. Otherwise only new rows
 * dated within a few minutes of that newest one count: an email whose Date
 * header is a little older than the note above it is still news, while an
 * edit, a deleted row or a call logged for last week never counts.
 */
export function arrivedAtBottom(prevIds, rows, prevNewestAt = null) {
  if (!prevIds || !rows?.length) return [];
  const fresh = rows.filter((r) => !prevIds.has(r.id));
  if (!fresh.length || !prevIds.has(rows[rows.length - 1].id)) return fresh;
  const floor = Date.parse(prevNewestAt) - NEW_ROW_WINDOW_MS;
  return Number.isFinite(floor) ? fresh.filter((r) => Date.parse(r.occurred_at) >= floor) : [];
}

/** The newest occurred_at in a list of rows, or null. */
export function newestAt(rows) {
  let best = null, bestMs = -Infinity;
  for (const r of rows || []) {
    const ms = Date.parse(r?.occurred_at);
    if (Number.isFinite(ms) && ms > bestMs) { bestMs = ms; best = r.occurred_at; }
  }
  return best;
}

/**
 * What new rows at the bottom do to the view. 'follow' scrolls to the latest,
 * 'count' leaves the reader where they are and counts them on the Latest pill.
 * Our own message always follows: you just sent it and expect to see it.
 */
export function followNewRows({ fresh = [], nearBottom, myId, editing = false }) {
  if (!fresh.length) return 'stay';
  if (myId && fresh.some((r) => r.actor_id === myId)) return 'follow';
  return nearBottom && !editing ? 'follow' : 'count';
}

/** User ids mentioned in a body as @[Name](id), each once. */
export function mentionIds(text) {
  const ids = new Set();
  const re = /@\[[^\]]+\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) ids.add(m[1]);
  return [...ids];
}

/** Mentions in the edited text that were not in the original, so nobody is notified twice. */
export function addedMentions(before, after) {
  const had = new Set(mentionIds(before));
  return mentionIds(after).filter((id) => !had.has(id));
}

/**
 * The latest email in a thread (oldest first), either direction: the message a
 * reply answers. Our automatic "we got your message" reply is skipped. It is
 * saved straight after the customer's email and only ever goes to the sender,
 * so answering it dropped everyone they had copied in and hid Reply all.
 */
export function latestEmail(rows) {
  for (let i = (rows?.length || 0) - 1; i >= 0; i--) {
    const r = rows[i];
    if (r?.type === 'email' && !r.channel_metadata?.auto_reply) return r;
  }
  return null;
}

/**
 * True for an email captured before To and Cc were stored: its recipients can
 * be read back from Gmail once (gmail-send action 'recipients').
 */
export function needsRecipientLookup(activity) {
  const md = activity?.channel_metadata;
  return !!activity && activity.type === 'email' && !!md && !!md.gmail_message_id && !('to' in md);
}

/**
 * The From / To / Cc / Reply-To headers of a ticket email, from what is stored
 * on the row plus anything read back from Gmail. An outbound row without a
 * From was still sent by us, so it answers as our own message.
 */
export function emailHeadersOf(activity, fetched, ownMailbox) {
  if (!activity) return null;
  const md = activity.channel_metadata || {};
  const src = fetched ? { ...md, from: fetched.from || md.from, to: fetched.to, cc: fetched.cc, reply_to: fetched.reply_to } : md;
  return {
    from: src.from || (activity.direction === 'outbound' ? ownMailbox || '' : ''),
    to: src.to || '',
    cc: src.cc || '',
    reply_to: src.reply_to || '',
  };
}

/**
 * Default To and Cc for a reply. Falls back to `fallback` (the customer's
 * address, or the other party) when the message gives nobody to answer, e.g. a
 * ticket with no email yet.
 */
export function replyDefaults(headers, own = [], fallback = '', mode = 'reply') {
  const r = headers ? buildReply(headers, own, mode) : { to: [], cc: [] };
  if (r.to.length) return r;
  const ownSet = new Set((Array.isArray(own) ? own : [own]).filter(Boolean).map((x) => String(x).trim().toLowerCase()));
  const to = parseAddressList(fallback).filter((a) => !ownSet.has(a.email));
  const taken = new Set(to.map((a) => a.email));
  return { to, cc: r.cc.filter((a) => !taken.has(a.email)) };
}

/**
 * To and Cc exactly as they will be sent: the chips plus any valid address
 * still typed in the box, nobody twice. `problem` is set, and nothing should be
 * sent, while any typed part is not an address (even next to good ones, so
 * nobody is quietly left off), nobody is on To, or there are too many.
 */
export function recipientsToSend({ to = [], toPending = '', cc = [], ccPending = '' } = {}) {
  for (const p of [toPending, ccPending]) {
    const bad = invalidAddresses(p);
    if (bad.length) return { to: [], cc: [], problem: `"${bad.join(', ')}" is not an email address. Fix it or remove it before sending.` };
  }
  const taken = new Set();
  const merge = (list, pending) => {
    const out = [];
    for (const a of [...(list || []), ...parseAddressList(pending)]) {
      const email = String(a?.email || '').trim().toLowerCase();
      if (!email || taken.has(email)) continue;
      taken.add(email);
      out.push({ name: a.name || '', email });
    }
    return out;
  };
  const toList = merge(to, toPending);
  const ccList = merge(cc, ccPending);
  if (!toList.length) return { to: toList, cc: ccList, problem: 'Add at least one email address to send this to.' };
  if (toList.length + ccList.length > MAX_RECIPIENTS) return { to: toList, cc: ccList, problem: `Too many people: ${MAX_RECIPIENTS} at most.` };
  return { to: toList, cc: ccList, problem: null };
}

/** An address header for display: "Kate <kate@x.com>, ops@x.com". */
export function formatAddresses(header) {
  const list = parseAddressList(header);
  if (!list.length) return typeof header === 'string' ? header.trim() : '';
  return list.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', ');
}

/** Cmd+Enter (Mac) or Ctrl+Enter: send or save. Ignored mid IME composition. */
export function isSendShortcut(e) {
  if (!e || e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return false;
  return !(e.nativeEvent?.isComposing || e.isComposing || e.keyCode === 229);
}

/** The shortcut as this device writes it. */
export function sendShortcutLabel() {
  const p = typeof navigator === 'undefined' ? '' : (navigator.platform || navigator.userAgent || '');
  return /Mac|iPhone|iPad|iPod/i.test(p) ? '⌘+Enter' : 'Ctrl+Enter';
}

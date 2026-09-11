import { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, Check, FileText, Lock, Paperclip, X } from 'lucide-react';
import {
  GROUPS, SECTIONS, formContext, visibleFields, visibleSections, titleOf, sectionHintOf, labelOf, hintOf,
  optionsOf, echoOf, suggestOf, formatOf, dobOrder, isRequired, isEmpty, fieldIssue,
  missingRequired, progress, summarize, allFiles, isSecureKey, heldEntryOf,
} from '../lib/onboardingForm';
// The server's own limits for ID files, so the page refuses exactly what the
// function and the bucket would. The file has no imports, which is what lets
// the browser bundle (and the tests) load it.
import { SECURE_MIME, MAX_SECURE_BYTES } from '../../supabase/functions/_shared/onboardingSecure.ts';
import BookingInvite from './BookingInvite.jsx';

// The customer's onboarding pack. No login: the token in the URL is the way in.
//
// Shape of the thing: one tab per group, and everything in that group on a
// single scrolling page. An earlier version put all fifteen sections across the
// top as chips, which turned the first thing you see into a wall of navigation.
// A few tabs is the whole map, and scrolling beats hunting.
//
// Written for someone filling this in on a phone between services, so it really
// does save as they go: a changed answer goes to the onboarding-form function a
// moment after they stop typing, when they leave a box, and as the tab hides
// (iOS can reload a tab after using the camera). Files upload the moment they
// are picked, so a 20MB menu is never stuck behind the send button.
//
// Bank numbers, date of birth, home address and ID are write-only from here. A
// value is sent only once it passes the definition's checks, and as soon as the
// server says it is held the page forgets it and shows "Saved securely". It is
// never fetched back, and never goes in the summary or the submit.

const FN_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/onboarding-form`;

const SAVE_AFTER_TYPING_MS = 1500;
// Then every 30 seconds for as long as it keeps failing: the page promises to
// keep trying, and a venue's signal can be gone for a whole service.
const RETRY_MS = [5000, 15000, 30000];
// The function refuses more files than this on one question, and longer text.
// Stopping here is kinder than a save that fails for a reason nobody can see.
const MAX_FILES = 20;
const MAX_CHARS = 5000;
// Digits boxes keep every digit typed or pasted, up to this. Cutting to the
// expected length (8 for an account number) turned a pasted sort code and
// account number into a valid looking wrong number that saved with no error.
const MAX_DIGITS = 34;
const SECURE_ACCEPT = SECURE_MIME.join(',');
// A request that neither answers nor fails (a phone in a cellar can sit on a
// dead connection for minutes) would leave the page on "Saving…" and Send on
// "Sending…" for good. Past this it counts as a dropped connection, which is
// retried like any other.
const REQUEST_TIMEOUT_MS = 20000;

// The two sections that collect bank and ID details. An onboarding-form function
// older than v2 has no secure storage and no save, and would put bank details in
// the answers every logged in user can read, so these never render against it.
const SECURE_SECTIONS = new Set(['bank', 'representative']);

const GROUP_OF = Object.fromEntries(SECTIONS.map((s) => [s.key, s.group]));
const keyOf = (sectionKey, fieldKey) => `${sectionKey}.${fieldKey}`;
const fieldAt = (key) => {
  const [sk, fk] = key.split('.');
  return SECTIONS.find((s) => s.key === sk)?.fields.find((f) => f.key === fk);
};
const str = (v) => String(v ?? '').trim();
const digitsOf = (v) => String(v ?? '').replace(/\D/g, '');

// Autofill fills in whoever is holding the phone. For a sole trader that is the
// legal representative, so it saves typing. For a company it would drop the
// office manager's details in as the director's, so it is off.
const PERSONAL_AUTOFILL = {
  'representative.phone': 'tel',
  'representative.email': 'email',
  'representative.home_address': 'street-address',
};
function autofillFor(key, ctx) {
  if (PERSONAL_AUTOFILL[key]) return ctx.individual ? PERSONAL_AUTOFILL[key] : 'off';
  if (key === 'representative.name') return 'off';
  return undefined;
}
// Phone keyboards capitalise and correct as you type. Right for names, wrong
// for a company number, and a capitalised first letter breaks a WiFi password.
const CAPITALS = new Set(['company.company_number', 'vat.number']);
const NAMES = new Set(['company.legal_name', 'company.contact_name', 'representative.name', 'bank.holder_name', 'trading.trading_name', 'signoff.full_name']);
const LITERAL = new Set(['network.wifi_name', 'network.wifi_password', 'users.bo_users']);
function keyboardFor(key, type) {
  if (type === 'email' || LITERAL.has(key)) return { autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false };
  if (type === 'tel') return { autoCorrect: 'off', spellCheck: false };
  if (CAPITALS.has(key)) return { autoCapitalize: 'characters', autoCorrect: 'off', spellCheck: false };
  if (NAMES.has(key)) return { autoCapitalize: 'words', autoCorrect: 'off', spellCheck: false };
  return {};
}

// Some Android pickers hand over a file with no type. The extension is enough to
// tell a JPG, PNG or PDF, and anything else is refused before asking to upload.
const EXT_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf' };
const mimeOf = (file) => file.type || EXT_MIME[String(file.name || '').split('.').pop().toLowerCase()] || '';

// A dropped connection, a timeout or a server hiccup is worth trying again. A
// refusal will be refused again, so that waits for the customer's next change.
const retryable = (e) => !e.status || e.status >= 500 || e.status === 408 || e.status === 429;

const post = async (payload, { plain = false, keepalive = false } = {}) => {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS) : null;
  try {
    const res = await fetch(FN_URL, {
      method: 'POST',
      keepalive,
      signal: ctl?.signal,
      // Saves go as text/plain: a simple request needs no CORS preflight, which is
      // one round trip fewer on a weak signal and nothing to be cut off as the tab
      // hides. The function parses the body as JSON whatever the header says.
      headers: { 'Content-Type': plain ? 'text/plain' : 'application/json' },
      body: JSON.stringify(payload),
    });
    const d = await res.json().catch(() => null);
    // Cut off while the answer was arriving: whether it saved is unknown, so
    // it is not taken as a success.
    if (ctl?.signal.aborted) throw new Error('timeout');
    if (!res.ok) {
      const e = new Error(d?.error || 'Something went wrong.');
      e.status = res.status;
      throw e;
    }
    return d || {};
  } catch (err) {
    if (err?.status) throw err;
    // No status, so every caller treats it as a dropped connection and retries.
    throw new Error(ctl?.signal.aborted
      ? 'No answer from our server. Check your signal and try again.'
      : 'Could not reach our server. Check your signal and try again.');
  } finally {
    clearTimeout(timer);
  }
};

// For an onboarding-form function older than v2, which takes the whole pack on
// submit. Bank and ID questions are not shown against it; this makes sure
// nothing secure could ride along anyway.
const withoutSecure = (answers) => Object.fromEntries(Object.entries(answers).map(([sk, sec]) => [
  sk, Object.fromEntries(Object.entries(sec || {}).filter(([fk]) => !isSecureKey(keyOf(sk, fk)))),
]));

const clock = (iso, region) => {
  const d = new Date(iso || Date.now());
  if (Number.isNaN(d.getTime())) return '';
  return region === 'US'
    ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
};

const EMPTY_ENV = { v: 0, venue: '', venue_address: '', region: 'UK', sent_to: '', prefill_name: '' };

export default function OnboardingPack({ token }) {
  const [state, setState] = useState({ loading: true, error: '', submitted: false });
  const [env, setEnv] = useState(EMPTY_ENV);
  const [answers, setAnswers] = useState({});
  const [held, setHeld] = useState({});
  const [tab, setTab] = useState(0);
  const [touched, setTouched] = useState({});        // key: left the box at least once
  const [editing, setEditing] = useState({});        // held secure key reopened with Change
  const [dobStarted, setDobStarted] = useState({});  // key: some of the date typed
  const [resetGen, setResetGen] = useState({});      // key: bumped to clear a date's boxes
  const [heldWarnings, setHeldWarnings] = useState({}); // key: the nudge a saved answer had
  const [focusKey, setFocusKey] = useState(null);
  const [uploading, setUploading] = useState({});
  const [fileNotes, setFileNotes] = useState({});    // key: {error} or {warning}
  const [refused, setRefused] = useState({});        // key: the server would not keep this answer
  const [padNotes, setPadNotes] = useState({});      // key: zeros added to a bank number, to check
  const [thumbs, setThumbs] = useState({});          // key: {url, pdf}
  const [saveStatus, setSaveStatus] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [sendError, setSendError] = useState('');
  const [showMissing, setShowMissing] = useState(false);

  // The save queue works from refs, not state: saves fire from timers and from
  // page hide events long after the render that scheduled them, and must always
  // see the latest answers.
  const answersRef = useRef({});
  const heldRef = useRef({});
  const envRef = useRef(EMPTY_ENV);
  const submittedRef = useRef(false);
  const focusRef = useRef(null);
  const dirty = useRef(new Set());         // keys changed and not yet saved
  const runSent = useRef(new Map());       // key: the value the running save sent
  const hideSent = useRef(new Map());      // key: the value the save sent as the tab hid sent
  const inflight = useRef(null);
  const again = useRef(false);
  const hideSave = useRef(null);
  const debounce = useRef(null);
  const retry = useRef({ n: 0, timer: null });
  const thumbsRef = useRef({});
  const heldAt = useRef('');               // saved_at of the response whose held list is showing
  const uploads = useRef(new Set());       // uploads still running, as promises
  const removedPaths = useRef({});         // key: paths taken off a several file question
  const padPending = useRef(new Set());    // bank numbers padded on leaving, not saved until checked

  const ctxFor = (a = answersRef.current, h = heldRef.current, e = envRef.current) => formContext(a, {
    region: e.region, venue: e.venue, venue_address: e.venue_address, sent_to: e.sent_to, held: h,
  });
  const isV2 = () => envRef.current.v >= 2;

  // ── Saving ────────────────────────────────────────────────────────────────

  const toSubmitted = () => {
    submittedRef.current = true;
    clearTimeout(debounce.current);
    clearTimeout(retry.current.timer);
    dirty.current.clear();
    setState((s) => ({ ...s, submitted: true }));
    window.scrollTo(0, 0);
  };

  const scheduleSave = () => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => pump(), SAVE_AFTER_TYPING_MS);
  };

  const dropKey = (key) => (m) => {
    if (!m[key]) return m;
    const o = { ...m };
    delete o[key];
    return o;
  };

  // when: 'soon' after typing stops, 'now', or 'hold' (marked changed, but
  // nothing is saved from here).
  const setValue = (sectionKey, fieldKey, value, when = 'soon') => {
    const key = keyOf(sectionKey, fieldKey);
    const prev = answersRef.current;
    const next = { ...prev, [sectionKey]: { ...(prev[sectionKey] || {}), [fieldKey]: value } };
    answersRef.current = next;
    setAnswers(next);
    dirty.current.add(key);
    // A new answer is not the one that was padded or refused.
    padPending.current.delete(key);
    setPadNotes(dropKey(key));
    setRefused(dropKey(key));
    setSendError('');
    if (when === 'now') pump(); else if (when !== 'hold') scheduleSave();
  };

  // Once the server holds a secure answer the page lets go of it, but only if
  // it is still exactly what was sent: a digit typed since is a new answer.
  const forget = (entries) => {
    let next = answersRef.current;
    const c = ctxFor();
    const gone = [];
    const warnings = {};
    for (const [sk, fk, sentRaw] of entries) {
      if (next[sk]?.[fk] !== sentRaw) continue;
      // Back in the box before the answer came: clearing it now would empty
      // it under the customer's fingers (and remount the date boxes, losing
      // focus). It goes again when they leave, and is let go of then.
      if (focusRef.current === keyOf(sk, fk)) { dirty.current.add(keyOf(sk, fk)); continue; }
      // A home address with no postcode is saved (a nudge never blocks), and
      // the box folds away at once, so the nudge is kept to show under it.
      // Only the words of the nudge, never the value.
      const f = fieldAt(keyOf(sk, fk));
      warnings[keyOf(sk, fk)] = (f && f.type !== 'file' && fieldIssue(f, sentRaw, c)?.warning) || '';
      const sec = { ...next[sk] };
      delete sec[fk];
      next = { ...next, [sk]: sec };
      gone.push(keyOf(sk, fk));
    }
    if (!gone.length) return;
    setHeldWarnings((w) => ({ ...w, ...warnings }));
    answersRef.current = next;
    setAnswers(next);
    const without = (m) => {
      const o = { ...m };
      gone.forEach((k) => delete o[k]);
      return o;
    };
    setEditing(without);
    setTouched(without);
    setDobStarted(without);
    setPadNotes(without);
    setRefused(without);
    setResetGen((g) => {
      const o = { ...g };
      gone.forEach((k) => { o[k] = (o[k] || 0) + 1; });
      return o;
    });
  };

  // The patch for some changed keys: {section: {field: value or null}}, plus
  // what was sent, so the response can be matched back to the page.
  const buildPatch = (keys) => {
    const a = answersRef.current;
    const c = ctxFor(a);
    const patch = {};
    const sent = [];
    const drop = [];
    for (const key of keys) {
      const f = fieldAt(key);
      const [sk, fk] = key.split('.');
      if (!f || f.type === 'terms') { drop.push(key); continue; }
      const raw = a[sk]?.[fk];
      let value;
      if (f.secure && f.type === 'file') {
        if (!raw?.path) { drop.push(key); continue; }
        value = { path: raw.path, name: raw.name, size: raw.size, mime: raw.mime };
      } else if (f.secure) {
        // Still in the box: a 7 digit account number passes on its own and
        // would be saved one digit early. It goes when they leave the box, and
        // not as the tab hides either, because switching to the banking app to
        // read the last digit is exactly when that happens. A number we just
        // padded with zeros waits the same way, until they have looked at it.
        if (focusRef.current === key || padPending.current.has(key)) continue;
        // An empty box after Change keeps the saved answer, and a value that
        // fails the checks never leaves the page.
        if (isEmpty(f, raw) || fieldIssue(f, raw, c)?.error) { drop.push(key); continue; }
        value = typeof f.normalize === 'function' ? f.normalize(raw, c) : str(raw);
      } else if (f.type === 'confirm') {
        value = raw === true;
      } else if (f.type === 'file' && f.multiple) {
        // The files this page has and the ones it took away, never the whole
        // list: a menu page added from another phone is kept, not overwritten.
        value = {
          add: Array.isArray(raw) ? raw : raw ? [raw] : [],
          remove: [...(removedPaths.current[key] || [])],
        };
      } else {
        value = isEmpty(f, raw) ? null : raw;
      }
      patch[sk] = patch[sk] || {};
      patch[sk][fk] = value;
      sent.push([sk, fk, raw]);
    }
    return { patch, sent, drop };
  };

  // The function saves the rest of a patch but lists the secure answers it
  // would not keep: an ID file it cannot find in storage, or a bank number for
  // the other country's questions (the venue changed since the page loaded).
  // None of them is held, even when _held still lists an earlier answer for the
  // same question, so they must never fold away as "Saved securely".
  const refuse = (entries) => {
    let next = answersRef.current;
    const values = [];
    for (const [sk, fk, sentRaw] of entries) {
      const key = keyOf(sk, fk);
      if (fieldAt(key)?.type !== 'file') { values.push(key); continue; }
      // The upload is not held, so its preview goes. Taken off the page
      // without a save, because a null would delete a file saved earlier.
      if (next[sk]?.[fk] === sentRaw) {
        const sec = { ...next[sk] };
        delete sec[fk];
        next = { ...next, [sk]: sec };
      }
      const t = thumbsRef.current[key];
      if (t) {
        URL.revokeObjectURL(t.url);
        const rest = { ...thumbsRef.current };
        delete rest[key];
        thumbsRef.current = rest;
        setThumbs(rest);
      }
      noteFile(key, { error: 'That file did not save. Please try again.' });
    }
    if (next !== answersRef.current) {
      answersRef.current = next;
      setAnswers(next);
    }
    // A typed answer stays in its box, so the customer can see it and fix it.
    if (values.length) {
      setTouched((t) => ({ ...t, ...Object.fromEntries(values.map((k) => [k, true])) }));
      setRefused((r) => ({ ...r, ...Object.fromEntries(values.map((k) => [k, true])) }));
    }
  };

  const afterSave = (d, sent) => {
    // Two responses can land out of order (a save sent as the tab hid and the
    // one after it). The held list from an older one is not put back over a
    // newer one, or a detail just saved could show as an empty box again.
    if (d?.held && typeof d.held === 'object' && !(d.saved_at && heldAt.current && d.saved_at < heldAt.current)) {
      if (d.saved_at) heldAt.current = d.saved_at;
      heldRef.current = d.held;
      setHeld(d.held);
    }
    const rejected = new Set(Array.isArray(d?.rejected) ? d.rejected : []);
    const nowHeld = sent.filter(([sk, fk]) => isSecureKey(keyOf(sk, fk))
      && !rejected.has(keyOf(sk, fk)) && heldRef.current[keyOf(sk, fk)]);
    if (nowHeld.length) forget(nowHeld);
    const notKept = sent.filter(([sk, fk]) => rejected.has(keyOf(sk, fk)));
    if (notKept.length) refuse(notKept);
    // Belt and braces for the order saves land in: an ordinary answer that is
    // no longer what this save sent, and not already waiting to go, goes again,
    // so whatever the server applied last, the page's answer is the one kept.
    let resend = false;
    for (const [sk, fk, sentRaw] of sent) {
      const key = keyOf(sk, fk);
      if (isSecureKey(key) || dirty.current.has(key) || answersRef.current[sk]?.[fk] === sentRaw) continue;
      dirty.current.add(key);
      resend = true;
    }
    if (resend) scheduleSave();
    setSaveStatus({ kind: 'saved', at: d?.saved_at || new Date().toISOString() });
  };

  const runSave = async () => {
    const { patch, sent, drop } = buildPatch([...dirty.current]);
    drop.forEach((k) => dirty.current.delete(k));
    if (!sent.length) return true;
    const keys = sent.map(([sk, fk]) => keyOf(sk, fk));
    keys.forEach((k) => dirty.current.delete(k));
    sent.forEach(([sk, fk, raw]) => runSent.current.set(keyOf(sk, fk), raw));
    setSaveStatus((s) => ({ ...s, kind: 'saving' }));
    try {
      const d = await post({ token, action: 'save', patch }, { plain: true });
      retry.current.n = 0;
      afterSave(d, sent);
      return true;
    } catch (e) {
      keys.forEach((k) => dirty.current.add(k));
      if (e.status === 409) { toSubmitted(); return false; }
      if (retryable(e)) {
        const wait = RETRY_MS[Math.min(retry.current.n, RETRY_MS.length - 1)];
        retry.current.n += 1;
        clearTimeout(retry.current.timer);
        retry.current.timer = setTimeout(() => pump(), wait);
        setSaveStatus({ kind: 'offline' });
      } else {
        setSaveStatus({ kind: 'refused', message: e.message });
      }
      return false;
    } finally {
      keys.forEach((k) => runSent.current.delete(k));
    }
  };

  // One save at a time. A change made while one is running is picked up by a
  // second pass as soon as it finishes, so nothing waits for the next keystroke.
  const pump = () => {
    clearTimeout(debounce.current);
    if (!isV2() || submittedRef.current) return Promise.resolve(true);
    if (inflight.current) { again.current = true; return inflight.current; }
    const run = (async () => {
      // A save sent as the tab hid goes first, so the two never race on the
      // server and put an older answer back over a newer one.
      if (hideSave.current) await hideSave.current;
      if (submittedRef.current) return false;
      let ok = true;
      do {
        again.current = false;
        ok = await runSave();
      } while (ok && again.current && dirty.current.size && !submittedRef.current);
      return ok;
    })();
    inflight.current = run.finally(() => {
      inflight.current = null;
      // Asked for in the gap between the last pass and here: go again.
      if (again.current && dirty.current.size && !submittedRef.current) {
        again.current = false;
        setTimeout(() => pump(), 0);
      }
    });
    return inflight.current;
  };

  // The tab is going: another app, the camera, the lock button. An ordinary
  // request can be cut off mid flight, so this one goes with keepalive, and
  // repeats what the running save was carrying in case that one dies. It can
  // not wait for that save, so it only ever repeats the same value: an answer
  // changed since the running save sent it stays waiting, because two saves
  // with different values for one question could land in either order.
  const saveOnHide = () => {
    if (!isV2() || submittedRef.current) return;
    clearTimeout(debounce.current);
    const a = answersRef.current;
    const same = (key, raw) => { const [sk, fk] = key.split('.'); return a[sk]?.[fk] === raw; };
    const keys = new Set(dirty.current);
    for (const [key, raw] of runSent.current) {
      if (same(key, raw)) keys.add(key); else keys.delete(key);
    }
    // visibilitychange and pagehide both fire as a tab closes: the second
    // does not send what the first is already carrying, or anything it
    // carries in a different form.
    for (const key of hideSent.current.keys()) keys.delete(key);
    const { patch, sent, drop } = buildPatch([...keys]);
    drop.forEach((k) => dirty.current.delete(k));
    if (!sent.length) return;
    const sentKeys = sent.map(([sk, fk]) => keyOf(sk, fk));
    sentKeys.forEach((k) => dirty.current.delete(k));
    sent.forEach(([sk, fk, raw]) => hideSent.current.set(keyOf(sk, fk), raw));
    const p = post({ token, action: 'save', patch }, { plain: true, keepalive: true })
      .then((d) => { afterSave(d, sent); return true; })
      .catch((e) => {
        sentKeys.forEach((k) => dirty.current.add(k));
        if (e.status === 409) toSubmitted();
        return false;
      })
      .finally(() => {
        sentKeys.forEach((k) => hideSent.current.delete(k));
        if (hideSave.current === p) hideSave.current = null;
        // Anything left waiting behind it goes now the page is back.
        if (dirty.current.size && document.visibilityState === 'visible') pump();
      });
    hideSave.current = p;
  };

  // Send means done: everything outstanding goes now, typing or not, and a
  // padded bank number is taken as checked.
  const flush = async () => {
    clearTimeout(debounce.current);
    clearTimeout(retry.current.timer);
    focusRef.current = null;
    padPending.current.clear();
    if (hideSave.current) await hideSave.current;
    if (inflight.current) await inflight.current;
    // A save can leave something to send again (see afterSave), so a few passes.
    for (let i = 0; i < 3 && dirty.current.size; i += 1) {
      if (!(await pump())) return false;
    }
    return dirty.current.size === 0;
  };

  // Every upload still going, started from any question.
  const track = (p) => {
    uploads.current.add(p);
    p.finally(() => uploads.current.delete(p)).catch(() => {});
    return p;
  };
  const waitForUploads = async () => {
    while (uploads.current.size) await Promise.allSettled([...uploads.current]);
  };

  // ── Boxes ─────────────────────────────────────────────────────────────────

  const enter = (sk, f) => {
    const key = keyOf(sk, f.key);
    focusRef.current = key;
    setFocusKey(key);
    setEditing((e) => (e[key] === 'focus' ? { ...e, [key]: true } : e));
  };

  // Leaving a box: tidy the format (we fix, we never reject for style), show
  // any problem from now on, and save.
  const leave = (sk, f, e) => {
    // Chrome blurs the box when the whole page loses focus, and focus is still
    // on it inside the page. That is someone switching apps mid answer, not
    // leaving the question, so nothing is tidied or saved as finished.
    if (e?.target && document.activeElement === e.target) return;
    const key = keyOf(sk, f.key);
    if (focusRef.current === key) focusRef.current = null;
    setFocusKey((k) => (k === key ? null : k));
    setTouched((t) => (t[key] ? t : { ...t, [key]: true }));
    const raw = answersRef.current[sk]?.[f.key];
    if (typeof f.normalize === 'function' && !isEmpty(f, raw)) {
      const tidy = f.normalize(raw, ctxFor());
      if (tidy !== raw) {
        // Padding a 6 or 7 digit UK account number with zeros changes the
        // number itself. Saved and folded away straight off, a missed last
        // digit would be held as a valid wrong account, with the digits the
        // customer typed as its "ending". So the box stays open with a note,
        // and it saves the next time they leave it, or when they press Send.
        if (f.secure && digitsOf(tidy) !== digitsOf(raw)) {
          setValue(sk, f.key, tidy, 'hold');
          padPending.current.add(key);
          const added = digitsOf(tidy).length - digitsOf(raw).length;
          setPadNotes((n) => ({
            ...n,
            [key]: `We added ${added === 1 ? 'a 0' : '0'.repeat(Math.max(added, 1))} at the start to make ${digitsOf(tidy).length} digits. Check this matches your bank.`,
          }));
          if (dirty.current.size) pump();
          return;
        }
        setValue(sk, f.key, tidy, 'now');
        return;
      }
    }
    // Left the padded number as it was shown: checked, so it can go.
    padPending.current.delete(key);
    // Change opened an empty box and nothing went in: fold back to the saved answer.
    if (f.secure && isEmpty(f, raw) && !(f.type === 'dob' && dobStarted[key])) {
      setEditing((e) => (e[key] ? { ...e, [key]: false } : e));
    }
    if (dirty.current.size) pump();
  };

  const pick = (sk, f, value) => {
    setTouched((t) => ({ ...t, [keyOf(sk, f.key)]: true }));
    setValue(sk, f.key, value, 'now');
  };

  // ── Files ─────────────────────────────────────────────────────────────────

  const noteFile = (key, n) => setFileNotes((m) => ({ ...m, [key]: n }));

  const uploadFiles = async (sk, f, fileList) => {
    const key = keyOf(sk, f.key);
    const current = answersRef.current[sk]?.[f.key];
    const had = Array.isArray(current) ? current : current ? [current] : [];
    let files = Array.from(fileList || []);
    if (!files.length) return;
    files = f.multiple ? files.slice(0, Math.max(0, MAX_FILES - had.length)) : files.slice(0, 1);
    if (!files.length) { noteFile(key, { error: `Up to ${MAX_FILES} files here.` }); return; }
    noteFile(key, null);
    setUploading((u) => ({ ...u, [key]: true }));
    const stored = [];
    try {
      for (const file of files) {
        const up = await post({
          token, action: 'upload-url', sectionKey: sk, fieldKey: f.key,
          fileName: file.name, size: file.size, mime: file.type || null,
        });
        const put = await fetch(up.signedUrl, {
          method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file,
        });
        if (!put.ok) throw new Error(`Could not upload ${file.name}. Check your signal and try again.`);
        stored.push({ name: up.name, path: up.path, size: file.size, mime: file.type || null });
      }
    } catch (e) {
      if (e.status === 409) { toSubmitted(); return; }
      noteFile(key, { error: e.message || 'Could not upload. Check your signal and try again.' });
    } finally {
      setUploading((u) => ({ ...u, [key]: false }));
    }
    // Whatever finished uploading is kept and saved, even if a later file failed.
    if (stored.length) {
      const latest = answersRef.current[sk]?.[f.key];
      const base = Array.isArray(latest) ? latest : latest ? [latest] : [];
      setValue(sk, f.key, f.multiple ? [...base, ...stored] : stored[0], 'now');
    }
  };

  const removeFile = (sk, f, path) => {
    const key = keyOf(sk, f.key);
    const v = answersRef.current[sk]?.[f.key];
    const list = Array.isArray(v) ? v : v ? [v] : [];
    if (f.multiple) removedPaths.current[key] = new Set([...(removedPaths.current[key] || []), path]);
    setValue(sk, f.key, f.multiple ? list.filter((x) => x.path !== path) : null, 'now');
  };

  // A photo of an ID has to be readable by a person at the payments provider.
  // Small is only a nudge: a sharp crop can still be fine.
  const checkPhotoSize = (key, url) => {
    const img = new Image();
    img.onload = () => {
      if (thumbsRef.current[key]?.url !== url) return;
      if (Math.max(img.naturalWidth, img.naturalHeight) < 1000) {
        noteFile(key, { warning: 'This photo looks small. Check the words on it are sharp.' });
      }
    };
    img.src = url;
  };

  // ID photos: one file, checked here before anything is asked of the server,
  // uploaded straight into the private bucket, and shown back from the phone's
  // own copy. The customer's file name never leaves the phone, because it often
  // has their name in it.
  const uploadSecure = async (sk, f, file) => {
    if (!file) return;
    const key = keyOf(sk, f.key);
    const mime = mimeOf(file);
    if (!SECURE_MIME.includes(mime)) { noteFile(key, { error: 'Choose a JPG, PNG or PDF.' }); return; }
    if (!file.size) { noteFile(key, { error: 'That file is empty. Choose another.' }); return; }
    if (file.size > MAX_SECURE_BYTES) { noteFile(key, { error: 'That file is over 10MB. Try a smaller photo.' }); return; }
    noteFile(key, null);
    setUploading((u) => ({ ...u, [key]: true }));
    try {
      const up = await post({ token, action: 'upload-url', sectionKey: sk, fieldKey: f.key, mime, size: file.size });
      const put = await fetch(up.signedUrl, { method: 'PUT', headers: { 'Content-Type': mime }, body: file });
      if (!put.ok) throw new Error('Could not upload. Check your signal and try again.');
      const url = URL.createObjectURL(file);
      const old = thumbsRef.current[key];
      if (old) URL.revokeObjectURL(old.url);
      thumbsRef.current = { ...thumbsRef.current, [key]: { url, pdf: mime === 'application/pdf' } };
      setThumbs(thumbsRef.current);
      const ext = mime === 'application/pdf' ? 'pdf' : mime === 'image/png' ? 'png' : 'jpg';
      setValue(sk, f.key, { path: up.path, name: up.name || `${labelOf(f, ctxFor())}.${ext}`, size: file.size, mime }, 'now');
      if (mime !== 'application/pdf') checkPhotoSize(key, url);
    } catch (e) {
      if (e.status === 409) { toSubmitted(); return; }
      noteFile(key, { error: e.message || 'Could not upload. Check your signal and try again.' });
    } finally {
      setUploading((u) => ({ ...u, [key]: false }));
    }
  };

  // ── Moving around and sending ─────────────────────────────────────────────

  const jumpTo = (m) => {
    const i = GROUPS.findIndex((g) => g.key === GROUP_OF[m.sectionKey]);
    if (i >= 0) setTab(i);
    setTimeout(() => {
      const el = document.getElementById(`q-${m.sectionKey}-${m.fieldKey}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      else window.scrollTo({ top: 0, behavior: 'smooth' });
    }, 60);
  };

  const goTab = (i) => {
    setTab(i);
    window.scrollTo({ top: 0 });
    if (dirty.current.size) pump();
  };

  const gapsNow = () => missingRequired(answersRef.current, ctxFor())
    .filter((m) => isV2() || !SECURE_SECTIONS.has(m.sectionKey));

  // The first secure answer still sitting in its box. After a flush that is one
  // the server would not keep (checked for the other country's questions, say),
  // so it is not held, and the summary must not say it is.
  const firstUnheld = () => {
    const a = answersRef.current;
    const c = ctxFor();
    for (const s of SECTIONS) {
      const f = visibleFields(s, a, c).find((x) => x.secure && !isEmpty(x, a[s.key]?.[x.key]));
      if (f) return { sectionKey: s.key, fieldKey: f.key };
    }
    return null;
  };

  const submit = async () => {
    if (submitting) return;
    setSendError('');
    setSubmitting(true);
    try {
      // An upload still going (a sharper passport photo on a slow signal) goes
      // in first, or the pack would be sent with the photo it was replacing.
      await waitForUploads();
      if (submittedRef.current) return;
      let gaps = gapsNow();
      if (gaps.length) { setShowMissing(true); jumpTo(gaps[0]); return; }
      if (isV2()) {
        const saved = await flush();
        if (submittedRef.current) return;
        if (!saved) throw new Error('Not sent yet. Some answers have not saved. Check your signal and press Send again.');
        // Another phone may have changed the pack since this one loaded: a
        // table plan added, the ID type switched. Take the pack as it is
        // stored now, and check and summarise that, not this page's old copy.
        const fresh = await post({ token, action: 'load' });
        if (fresh.submitted) { toSubmitted(); return; }
        adopt(fresh, { keepUnsent: true });
        const stuck = firstUnheld();
        if (stuck) {
          setShowMissing(true);
          jumpTo(stuck);
          setSendError('One answer did not save. Check the highlighted answer.');
          return;
        }
        gaps = gapsNow();
        if (gaps.length) { setShowMissing(true); jumpTo(gaps[0]); return; }
      }
      // An older function holds nothing securely, so against one the summary
      // must not claim anything is "held securely" either.
      const a = isV2() ? answersRef.current : withoutSecure(answersRef.current);
      const c = ctxFor(a);
      const payload = { token, action: 'submit', summary: summarize(a, c), files: allFiles(a, c) };
      // A v2 function submits what it has saved. An older one only knows what it is sent.
      if (!isV2()) payload.answers = a;
      await post(payload);
      toSubmitted();
    } catch (e) {
      if (e.status === 409) toSubmitted();
      else setSendError(e.message || 'Not sent yet. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  // ── Load, and the page hiding ─────────────────────────────────────────────

  // Takes what load returned as the page's answers, held list and venue.
  // keepUnsent keeps secure answers still in their boxes: they never reached
  // the server, so they are not in what it sent back, and the customer needs
  // to see them to fix them.
  const adopt = (d, { keepUnsent = false } = {}) => {
    const raw = d.answers && typeof d.answers === 'object' ? d.answers : {};
    // Underscore keys are the server's bookkeeping, not answers: _held gets
    // its own state, and nothing starting with _ is ever sent back.
    const clean = Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith('_')));
    if (keepUnsent) {
      const a = answersRef.current;
      for (const s of SECTIONS) {
        for (const f of s.fields) {
          const v = a[s.key]?.[f.key];
          if (f.secure && f.type !== 'file' && !isEmpty(f, v)) clean[s.key] = { ...(clean[s.key] || {}), [f.key]: v };
        }
      }
    }
    const e = {
      v: Number(d.v) || 0,
      venue: d.venue || '',
      venue_address: d.venue_address || '',
      region: d.region || raw._meta?.region || 'UK',
      sent_to: d.sent_to || '',
      prefill_name: d.prefill_name || '',
    };
    envRef.current = e;
    answersRef.current = clean;
    heldRef.current = (d.held && typeof d.held === 'object' ? d.held : raw._held) || {};
    heldAt.current = raw._meta?.saved_at || heldAt.current;
    setEnv(e);
    setAnswers(clean);
    setHeld(heldRef.current);
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const d = await post({ token, action: 'load' });
        if (!alive) return;
        adopt(d);
        submittedRef.current = !!d.submitted;
        setState({ loading: false, error: '', submitted: !!d.submitted });
      } catch (err) {
        if (alive) setState({ loading: false, error: err.message, submitted: false });
      }
    })();
    return () => { alive = false; };
  }, [token]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') saveOnHide();
      else if (dirty.current.size) pump();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', saveOnHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', saveOnHide);
      clearTimeout(debounce.current);
      clearTimeout(retry.current.timer);
      Object.values(thumbsRef.current).forEach((t) => URL.revokeObjectURL(t.url));
      thumbsRef.current = {};
    };
    // Registered once. Everything these call works from refs, so the first
    // render's copies stay correct.
  }, []);

  // ── What the page shows ───────────────────────────────────────────────────

  const ctx = useMemo(() => ctxFor(answers, held, env), [answers, held, env]);
  const legacy = env.v < 2;
  const missingAll = useMemo(() => missingRequired(answers, ctx), [answers, ctx]);
  // A secure answer the server would not keep looks answered in its box, but
  // nothing is held. It counts against its tab and the progress bar, so the
  // customer is pointed at it instead of told everything is answered.
  const refusedGaps = useMemo(() => {
    const out = [];
    for (const key of Object.keys(refused)) {
      const [sk, fk] = key.split('.');
      const s = SECTIONS.find((x) => x.key === sk);
      const f = s && visibleFields(s, answers, ctx).find((x) => x.key === fk);
      if (!f || isEmpty(f, answers[sk]?.[fk]) || missingAll.some((m) => m.sectionKey === sk && m.fieldKey === fk)) continue;
      out.push({ sectionKey: sk, section: titleOf(s, ctx), fieldKey: fk, field: labelOf(f, ctx), reason: 'invalid', required: isRequired(f, ctx) });
    }
    return out;
  }, [refused, answers, ctx, missingAll]);
  const missing = useMemo(() => {
    const base = legacy ? missingAll.filter((m) => !SECURE_SECTIONS.has(m.sectionKey)) : missingAll;
    return refusedGaps.length && !legacy ? [...base, ...refusedGaps] : base;
  }, [missingAll, legacy, refusedGaps]);
  const prog = useMemo(() => {
    const p = progress(answers, ctx);
    if (!legacy) return { ...p, done: p.done - refusedGaps.filter((g) => g.required).length };
    // The bank and representative questions are not on screen, so they
    // neither count nor hold the bar back.
    let required = 0;
    let owed = 0;
    for (const s of SECTIONS) {
      if (!SECURE_SECTIONS.has(s.key)) continue;
      for (const f of visibleFields(s, answers, ctx)) {
        if (f.type === 'terms' || !isRequired(f, ctx)) continue;
        required += 1;
        if (missingAll.some((m) => m.sectionKey === s.key && m.fieldKey === f.key)) owed += 1;
      }
    }
    return { required: p.required - required, done: p.done - (required - owed) };
  }, [answers, ctx, legacy, missingAll, refusedGaps]);

  if (state.loading) return <Frame><div className="py-24 text-center text-slate-400 text-sm">Loading…</div></Frame>;
  if (state.error) return (
    <Frame><div className="py-20 text-center">
      <div className="text-4xl mb-3">🔒</div>
      <div className="text-slate-700 max-w-sm mx-auto">{state.error}</div>
    </div></Frame>
  );
  if (state.submitted) return (
    <Frame><div className="py-20 text-center">
      <div className="w-16 h-16 rounded-full bg-emerald-100 text-emerald-600 text-3xl flex items-center justify-center mx-auto mb-5">✓</div>
      <h1 className="text-2xl font-bold text-slate-900 mb-2">That's everything, thank you</h1>
      <p className="text-slate-600 text-[15px] max-w-md mx-auto leading-relaxed">
        Your pack is with our team{env.venue ? <> for <strong>{env.venue}</strong></> : null}. We'll be in touch if
        anything needs clarifying, and you'll hear from us with next steps shortly.
      </p>
      <div className="mt-8 text-left">
        {/* A name only. The representative's email and phone never go into a booking link. */}
        <BookingInvite venue={env.venue} prefill={{
          name: env.prefill_name || str(answers?.company?.contact_name) || str(answers?.signoff?.full_name),
        }} />
      </div>
    </div></Frame>
  );

  const group = GROUPS[tab];
  const sections = visibleSections(group.key, answers, ctx).filter((s) => !(legacy && s.key === 'representative'));
  const owedIn = (groupKey) => missing.filter((m) => GROUP_OF[m.sectionKey] === groupKey).length;
  const pct = prog.required ? Math.round((prog.done / prog.required) * 100) : 100;

  const renderField = (section, f) => {
    const sk = section.key;
    const key = keyOf(sk, f.key);
    const v = (answers[sk] || {})[f.key];
    const label = labelOf(f, ctx);
    const hint = hintOf(f, ctx);
    const required = isRequired(f, ctx);
    const inputId = `in-${sk}-${f.key}`;
    const labelId = `lb-${sk}-${f.key}`;
    const noteId = `nt-${sk}-${f.key}`;

    // The declaration itself: read-only, and deliberately set apart so it does
    // not read as another question to fill in.
    if (f.type === 'terms') {
      return (
        <div key={f.key} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500 mb-2">{label}</div>
          <ol className="space-y-2 text-[14px] text-slate-700 leading-relaxed list-decimal pl-4 marker:text-slate-400">
            {f.clauses.map((c, i) => <li key={i}>{c}</li>)}
          </ol>
        </div>
      );
    }

    const gap = showMissing && missing.some((m) => m.sectionKey === sk && m.fieldKey === f.key && m.reason === 'missing');

    if (f.type === 'confirm') {
      return (
        <div key={f.key} id={`q-${sk}-${f.key}`} className="scroll-mt-24">
          <label className={`flex gap-3 p-3.5 rounded-xl border cursor-pointer transition ${
            v === true ? 'bg-emerald-50 border-emerald-300' : gap ? 'bg-red-50/40 border-red-300' : 'bg-slate-50 border-slate-200 hover:border-slate-400'}`}>
            <input type="checkbox" checked={v === true} onChange={(e) => setValue(sk, f.key, e.target.checked)}
              className="mt-0.5 w-5 h-5 accent-emerald-600 shrink-0" />
            <span className="min-w-0">
              <span className="block text-[15px] font-semibold text-slate-800 leading-snug">
                {label}{required && <span className="text-red-500 ml-0.5">*</span>}
              </span>
              {hint && <span className="block text-[13px] text-slate-500 mt-1 whitespace-pre-line">{hint}</span>}
            </span>
          </label>
          {gap && <p className="mt-1.5 text-[13px] font-medium text-red-600">Still needed.</p>}
        </div>
      );
    }

    // A card face held for a different ID type is not held for this one.
    const heldEntry = f.secure ? heldEntryOf(section, f, ctx) : null;
    const heldHint = heldEntry && typeof heldEntry === 'object' ? heldEntry.hint : '';
    // Never folded while the box is in use: re-editing a date just saved
    // empties it for a moment, and the save's answer arriving then must not
    // pull the boxes out from under the customer's fingers.
    const collapsed = !!heldEntry && f.type !== 'file' && isEmpty(f, v) && !editing[key]
      && focusKey !== key && !dobStarted[key];
    const reopened = !!heldEntry && f.type !== 'file' && !collapsed;
    const issue = collapsed ? null
      : f.type === 'dob' && isEmpty(f, v) && dobStarted[key] ? { error: 'Check the date.' }
        : fieldIssue(f, v, ctx);
    const shown = touched[key] || showMissing;
    const notKept = !collapsed && !!refused[key];
    const bad = !!((shown && issue?.error) || gap || notKept);
    const echo = echoOf(f, ctx);
    const chips = !collapsed && isEmpty(f, v) && f.type !== 'file' && f.type !== 'dob' ? suggestOf(f, ctx) : [];
    const fileNote = fileNotes[key];
    const common = {
      id: inputId,
      'aria-invalid': bad || undefined,
      'aria-describedby': noteId,
      onFocus: () => enter(sk, f),
      onBlur: (e) => leave(sk, f, e),
      autoFocus: editing[key] === 'focus',
    };
    const labelTarget = ['text', 'textarea', 'email', 'tel', 'digits'].includes(f.type);

    let control = null;
    if (collapsed) {
      control = <Held hint={heldHint} onChange={() => setEditing((e) => ({ ...e, [key]: 'focus' }))} />;
    } else if (f.type === 'text' || f.type === 'email' || f.type === 'tel') {
      control = (
        <input {...common} {...keyboardFor(key, f.type)}
          type={f.type} inputMode={f.type === 'text' ? undefined : f.type}
          autoComplete={autofillFor(key, ctx)} maxLength={MAX_CHARS}
          className={inputClass(bad)} value={v ?? ''}
          onChange={(e) => setValue(sk, f.key, e.target.value)} />
      );
    } else if (f.type === 'textarea') {
      control = (
        <textarea {...common} {...keyboardFor(key, f.type)} rows={4}
          autoComplete={autofillFor(key, ctx)} maxLength={MAX_CHARS}
          className={`${inputClass(bad)} resize-y leading-relaxed`} value={v ?? ''}
          onChange={(e) => setValue(sk, f.key, e.target.value)} />
      );
    } else if (f.type === 'digits') {
      // Bare digits while typing, so the cursor never jumps over a hyphen;
      // formatted (12-34-56) once they leave the box. Every digit is kept, so
      // one too many shows its error instead of quietly becoming a number.
      control = (
        <input {...common} type="text" inputMode="numeric" pattern="[0-9]*"
          autoComplete="off" autoCorrect="off" spellCheck={false}
          className={`${inputClass(bad)} tabular-nums tracking-wide`}
          value={focusKey === key ? String(v ?? '') : isEmpty(f, v) ? '' : formatOf(f, v, ctx)}
          onChange={(e) => setValue(sk, f.key, digitsOf(e.target.value).slice(0, MAX_DIGITS))} />
      );
    } else if (f.type === 'dob') {
      control = (
        <DobInput key={`${key}-${resetGen[key] || 0}`} idBase={inputId} labelId={labelId}
          value={v} order={dobOrder(ctx)} autoFill={ctx.individual} invalid={bad}
          autoFocus={editing[key] === 'focus'}
          onFocus={() => enter(sk, f)} onLeave={(e) => leave(sk, f, e)}
          onChange={(ymd, started) => {
            setDobStarted((d) => (!!d[key] === started ? d : { ...d, [key]: started }));
            setValue(sk, f.key, ymd);
          }} />
      );
    } else if (f.type === 'choice') {
      control = (
        <div role="radiogroup" aria-labelledby={labelId} className="flex flex-wrap gap-2">
          {optionsOf(f, ctx).map((o) => {
            const on = v === o.value;
            return (
              <button key={String(o.value)} type="button" role="radio" aria-checked={on}
                onClick={() => setValue(sk, f.key, on ? '' : o.value)}
                className={`min-h-[44px] px-4 rounded-xl text-[15px] font-semibold border transition ${
                  on ? 'bg-slate-900 text-white border-slate-900'
                    : gap ? 'bg-white text-slate-700 border-red-300' : 'bg-white text-slate-700 border-slate-300 hover:border-slate-500'}`}>
                {o.label}
              </button>
            );
          })}
        </div>
      );
    } else if (f.type === 'file' && f.secure) {
      const local = v?.path ? v : null;
      const thumb = thumbs[key];
      const busy = !!uploading[key];
      const picker = (
        <input type="file" className="sr-only" accept={SECURE_ACCEPT} disabled={busy}
          onChange={(e) => { track(uploadSecure(sk, f, e.target.files?.[0])); e.target.value = ''; }} />
      );
      control = local || heldEntry ? (
        <div className="flex items-center gap-3 p-2 bg-white border border-slate-200 rounded-xl">
          <div className="w-16 h-16 rounded-lg overflow-hidden bg-slate-100 flex items-center justify-center shrink-0">
            {thumb && !thumb.pdf ? <img src={thumb.url} alt="" className="w-full h-full object-cover" />
              : thumb?.pdf ? <FileText className="w-7 h-7 text-slate-500" aria-hidden />
                : <Lock className="w-6 h-6 text-slate-400" aria-hidden />}
          </div>
          <div className="flex-1 min-w-0 text-[14px] font-semibold leading-snug">
            {busy ? <span className="text-slate-500">Uploading…</span>
              : local ? <span className="text-slate-600">Uploaded. Saving securely…</span>
                : <span className="text-emerald-800">Saved securely</span>}
          </div>
          <label className={`shrink-0 min-h-[44px] px-4 flex items-center rounded-xl border text-[15px] font-semibold transition ${
            busy ? 'border-slate-200 text-slate-400' : 'border-slate-300 text-slate-800 cursor-pointer hover:border-slate-900'}`}>
            {picker}Replace
          </label>
        </div>
      ) : (
        <label className={`flex items-center justify-center gap-2 min-h-[56px] px-4 border-2 border-dashed rounded-xl transition ${
          busy ? 'border-slate-200 text-slate-400' : bad ? 'border-red-300 text-slate-700 cursor-pointer' : 'border-slate-300 text-slate-700 hover:border-slate-900 hover:text-slate-900 cursor-pointer'}`}>
          {picker}
          <Camera className="w-5 h-5 shrink-0" aria-hidden />
          <span className="text-[15px] font-semibold">{busy ? 'Uploading…' : 'Add a photo or PDF'}</span>
        </label>
      );
    } else if (f.type === 'file') {
      const files = Array.isArray(v) ? v : v ? [v] : [];
      const busy = !!uploading[key];
      const full = f.multiple && files.length >= MAX_FILES;
      control = (
        <div>
          {files.length > 0 && (
            <div className="space-y-1.5 mb-2">
              {files.map((file) => (
                <div key={file.path} className="flex items-center gap-2.5 pl-3 pr-1 py-1 min-h-[48px] bg-slate-50 border border-slate-200 rounded-xl">
                  <Paperclip className="w-4 h-4 text-slate-400 shrink-0" aria-hidden />
                  <span className="text-[14px] text-slate-800 truncate flex-1 min-w-0">{file.name}</span>
                  <span className="text-[11px] text-slate-400 font-mono shrink-0">{((file.size || 0) / 1048576).toFixed(1)}MB</span>
                  <button type="button" aria-label={`Remove ${file.name}`} onClick={() => removeFile(sk, f, file.path)}
                    className="shrink-0 w-10 h-10 flex items-center justify-center rounded-lg text-slate-400 hover:text-red-600 hover:bg-white">
                    <X className="w-5 h-5" aria-hidden />
                  </button>
                </div>
              ))}
            </div>
          )}
          {!full && (
            <label className={`flex items-center justify-center gap-2 min-h-[52px] px-4 border-2 border-dashed rounded-xl transition ${
              busy ? 'border-slate-200 text-slate-400' : bad ? 'border-red-300 text-slate-700 cursor-pointer' : 'border-slate-300 text-slate-600 hover:border-slate-900 hover:text-slate-900 cursor-pointer'}`}>
              <input type="file" className="sr-only" multiple={!!f.multiple} disabled={busy}
                onChange={(e) => { track(uploadFiles(sk, f, e.target.files)); e.target.value = ''; }} />
              <span className="text-[15px] font-semibold">
                {busy ? 'Uploading…' : files.length ? '+ Add another file' : 'Choose file'}
              </span>
            </label>
          )}
        </div>
      );
    }

    return (
      <div key={f.key} id={`q-${sk}-${f.key}`} className="scroll-mt-24">
        {labelTarget && !collapsed
          ? <label id={labelId} htmlFor={inputId} className="block text-[15px] font-semibold text-slate-800 leading-snug">
              {label}{required && <span className="text-red-500 ml-0.5">*</span>}
            </label>
          : <div id={labelId} className="text-[15px] font-semibold text-slate-800 leading-snug">
              {label}{required && <span className="text-red-500 ml-0.5">*</span>}
            </div>}
        {hint && <p className="text-[13px] text-slate-500 mt-1 whitespace-pre-line leading-relaxed">{hint}</p>}
        {/* A same-as question shows the answer it would reuse, so Yes is an informed tap. */}
        {echo && (
          <div className="mt-2 pl-3 border-l-[3px] border-slate-300 text-[14px] text-slate-600 whitespace-pre-line leading-snug break-words line-clamp-4">
            {echo}
          </div>
        )}
        <div className="mt-2">{control}</div>
        {chips.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-2">
            {chips.map((c) => (
              <button key={c.value} type="button" onClick={() => pick(sk, f, c.value)}
                className="max-w-full truncate min-h-[40px] px-3.5 rounded-full border border-slate-300 bg-white text-[14px] font-medium text-slate-700 hover:border-slate-900 hover:text-slate-900 transition">
                {c.label}
              </button>
            ))}
          </div>
        )}
        <div id={noteId}>
          {reopened && isEmpty(f, v) && (
            <p className="mt-1.5 text-[13px] text-slate-500">Your saved answer stays until you enter a new one.</p>
          )}
          {collapsed && heldWarnings[key] && (
            <p className="mt-1.5 text-[13px] font-medium text-amber-deep">{heldWarnings[key]}</p>
          )}
          {notKept && <p className="mt-1.5 text-[13px] font-medium text-red-600">This did not save. Check it and try again.</p>}
          {!collapsed && padNotes[key] && <p className="mt-1.5 text-[13px] font-medium text-amber-deep">{padNotes[key]}</p>}
          {shown && issue?.error ? <p className="mt-1.5 text-[13px] font-medium text-red-600">{issue.error}</p>
            : gap ? <p className="mt-1.5 text-[13px] font-medium text-red-600">Still needed.</p>
              : shown && issue?.warning ? <p className="mt-1.5 text-[13px] font-medium text-amber-deep">{issue.warning}</p>
                : null}
          {fileNote?.error && <p className="mt-1.5 text-[13px] font-medium text-red-600">{fileNote.error}</p>}
          {fileNote?.warning && <p className="mt-1.5 text-[13px] font-medium text-amber-deep">{fileNote.warning}</p>}
        </div>
      </div>
    );
  };

  return (
    <Frame>
      {/* Header: what this is, who it's for, how far through */}
      <div className="pt-7 pb-4">
        <h1 className="text-[26px] leading-tight font-bold text-slate-900">Onboarding pack</h1>
        <p className="text-[15px] text-slate-600 mt-1">
          {env.venue ? <>Setting up <span className="font-semibold text-slate-800">{env.venue}</span>. </> : null}
          {legacy ? null : 'It saves as you go, so you can stop and come back.'}
        </p>
        <p className="mt-3 px-3.5 py-2.5 rounded-xl bg-white border border-slate-200 text-[14px] text-slate-700 leading-snug">
          <span className="font-semibold text-slate-900">Have ready:</span> photo ID for the legal representative (a passport is best) and your business bank details.
        </p>
        <div className="mt-4 flex items-center gap-3">
          <div className="flex-1 h-2 bg-slate-200 rounded-full overflow-hidden">
            <div className="h-full bg-emerald-500 rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
          </div>
          <span className="text-xs font-semibold text-slate-500 tabular-nums shrink-0">{pct}%</span>
        </div>
        {!legacy && <SaveLine status={saveStatus} region={env.region} />}
      </div>

      {/* One tab per group. The whole map of the form. */}
      <div className="sticky top-0 z-10 -mx-4 px-4 py-2 bg-slate-100/95 backdrop-blur">
        <div className="flex gap-1 p-1 bg-slate-200/70 rounded-xl">
          {GROUPS.map((g, i) => {
            const owed = owedIn(g.key);
            const active = i === tab;
            return (
              <button key={g.key} type="button" onClick={() => goTab(i)} aria-current={active ? 'step' : undefined}
                className={`flex-1 min-w-0 min-h-[44px] px-1 py-1 rounded-lg transition flex flex-col items-center justify-center gap-0.5 ${
                  active ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}>
                <span className="text-[13px] font-semibold leading-4 truncate max-w-full">{g.short}</span>
                {owed > 0
                  ? <span className="min-w-[18px] h-4 px-1 rounded-full bg-amber text-ink text-[10px] font-bold leading-4 text-center">{owed}</span>
                  : <Check className="w-3.5 h-3.5 text-emerald-600" aria-label="All answered" />}
              </button>
            );
          })}
        </div>
      </div>

      <p className="text-[14px] text-slate-500 mt-3 mb-3">{group.blurb}</p>

      {/* Everything in this group, one scroll */}
      <div className="space-y-3 pb-32">
        {sections.map((section) => {
          if (legacy && section.key === 'bank') return <Updating key="bank" />;
          const sectionHint = sectionHintOf(section, ctx);
          return (
            <section key={section.key} className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 shadow-sm">
              <h2 className="text-[16px] font-bold text-slate-900">{titleOf(section, ctx)}</h2>
              {sectionHint && <p className="text-[13px] text-slate-500 mt-1 whitespace-pre-line leading-relaxed">{sectionHint}</p>}
              <div className="space-y-5 mt-4">
                {visibleFields(section, answers, ctx).map((f) => renderField(section, f))}
              </div>
            </section>
          );
        })}

        {tab === GROUPS.length - 1 && (
          <BookingInvite venue={env.venue} compact prefill={{
            name: str(answers?.company?.contact_name) || str(answers?.signoff?.full_name),
          }} />
        )}

        {showMissing && missing.length > 0 && (
          <div className="p-4 bg-amber/10 border border-amber/40 rounded-2xl">
            <div className="text-[15px] font-bold text-amber-deep mb-1">Still needed before you can send</div>
            <ul className="text-[14px] text-slate-800">
              {missing.map((m) => (
                <li key={`${m.sectionKey}.${m.fieldKey}`}>
                  <button type="button" onClick={() => jumpTo(m)} className="w-full text-left py-1.5 leading-snug hover:underline">
                    <span className="text-amber-deep">{m.section}:</span> {m.field}{m.reason === 'invalid' ? ' (check this answer)' : ''}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* One action, always reachable */}
      <div className="fixed bottom-0 left-0 right-0 z-20 bg-white/95 backdrop-blur border-t border-slate-200 px-4 pt-3"
        style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}>
        <div className="max-w-2xl mx-auto flex items-center gap-3">
          <div className="text-[13px] text-slate-500 min-w-0 flex-1 leading-snug">
            {sendError ? <span className="text-red-600 font-medium">{sendError}</span>
              : !legacy && saveStatus?.kind === 'offline' ? <span className="text-amber-deep font-medium">Not saved yet. We'll keep trying.</span>
                : missing.length === 0 ? <span className="text-emerald-700 font-semibold">Everything's answered</span>
                  : <>{missing.length} still needed{owedIn(group.key) === 0 ? ', on another tab' : ''}</>}
          </div>
          {tab < GROUPS.length - 1 ? (
            <button type="button" onClick={() => goTab(tab + 1)}
              className="min-h-[44px] px-5 rounded-xl text-[15px] font-bold bg-slate-900 text-white hover:bg-slate-800 shrink-0">
              Next: {GROUPS[tab + 1].short}
            </button>
          ) : (
            <button type="button" disabled={submitting} onClick={submit}
              className="min-h-[44px] px-5 rounded-xl text-[15px] font-bold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 shrink-0">
              {submitting ? (Object.values(uploading).some(Boolean) ? 'Waiting for your upload…' : 'Sending…') : 'Send to our team'}
            </button>
          )}
        </div>
      </div>
    </Frame>
  );
}

// 16px text on purpose: iOS zooms the whole page into any box set smaller.
const inputClass = (bad) => `w-full px-3.5 py-3 bg-white border rounded-xl text-[16px] text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 ${
  bad ? 'border-red-400 focus:border-red-500 focus:ring-red-500/15' : 'border-slate-300 focus:border-slate-900 focus:ring-slate-900/10'}`;

// Three boxes rather than <input type=date>: Safari greys today's date into an
// empty date box, and a calendar is a slow way to reach 1978. The date is
// passed up as YYYY-MM-DD only once all three are filled, so a half typed date
// is never saved or checked as if it were a real one.
const DOB_PARTS = {
  day: { label: 'Day', max: 2, placeholder: 'DD', autofill: 'bday-day', width: 'w-[4.5rem]' },
  month: { label: 'Month', max: 2, placeholder: 'MM', autofill: 'bday-month', width: 'w-[4.5rem]' },
  year: { label: 'Year', max: 4, placeholder: 'YYYY', autofill: 'bday-year', width: 'w-[6.5rem]' },
};

function DobInput({ idBase, labelId, value, order, autoFill, invalid, autoFocus, onFocus, onChange, onLeave }) {
  const initial = (() => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    return m ? { year: m[1], month: m[2], day: m[3] } : { day: '', month: '', year: '' };
  })();
  const [parts, setParts] = useState(initial);
  // Autofill can fill all three boxes before a re-render, so each change builds
  // on the latest parts rather than the ones this render saw.
  const partsRef = useRef(initial);
  const refs = { day: useRef(null), month: useRef(null), year: useRef(null) };

  const update = (part, raw) => {
    const d = raw.replace(/\D/g, '').slice(0, DOB_PARTS[part].max);
    const before = partsRef.current[part];
    const next = { ...partsRef.current, [part]: d };
    partsRef.current = next;
    setParts(next);
    const complete = next.day && next.month && next.year.length === 4;
    onChange(complete ? `${next.year}-${next.month.padStart(2, '0')}-${next.day.padStart(2, '0')}` : '',
      !!(next.day || next.month || next.year));
    // On to the next box once this one cannot take another digit: two digits,
    // or a first digit no day (4 to 9) or month (2 to 9) can start with.
    const i = order.indexOf(part);
    const full = d.length === DOB_PARTS[part].max
      || (part === 'day' && /^[4-9]$/.test(d)) || (part === 'month' && /^[2-9]$/.test(d));
    if (full && d.length > before.length && i < order.length - 1) refs[order[i + 1]].current?.focus();
  };

  const back = (part) => (e) => {
    const i = order.indexOf(part);
    if (e.key === 'Backspace' && !partsRef.current[part] && i > 0) refs[order[i - 1]].current?.focus();
  };

  return (
    <div role="group" aria-labelledby={labelId} className="flex gap-3" onFocus={onFocus}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) onLeave(e); }}>
      {order.map((part, i) => {
        const p = DOB_PARTS[part];
        return (
          <div key={part} className={p.width}>
            <label htmlFor={`${idBase}-${part}`} className="block text-[13px] font-medium text-slate-600 mb-1">{p.label}</label>
            <input id={`${idBase}-${part}`} ref={refs[part]} type="text" inputMode="numeric" pattern="[0-9]*"
              maxLength={p.max} placeholder={p.placeholder} autoComplete={autoFill ? p.autofill : 'off'}
              autoFocus={autoFocus && i === 0} aria-invalid={invalid || undefined}
              className={`${inputClass(invalid)} text-center tabular-nums px-2`} value={parts[part]}
              onChange={(e) => update(part, e.target.value)} onKeyDown={back(part)} />
          </div>
        );
      })}
    </div>
  );
}

function Held({ hint, onChange }) {
  return (
    <div className="flex items-center gap-2.5 pl-3.5 pr-1.5 py-1.5 min-h-[52px] bg-emerald-50 border border-emerald-200 rounded-xl">
      <Lock className="w-4 h-4 text-emerald-700 shrink-0" aria-hidden />
      <span className="flex-1 min-w-0 text-[15px] font-semibold text-emerald-900">
        Saved securely{hint ? `, ending ${hint}` : ''}
      </span>
      <button type="button" onClick={onChange}
        className="shrink-0 min-h-[40px] px-3 rounded-lg text-[15px] font-semibold text-emerald-800 underline underline-offset-2 hover:bg-emerald-100">
        Change
      </button>
    </div>
  );
}

function SaveLine({ status, region }) {
  const base = 'mt-2 min-h-[20px] text-[13px] leading-5';
  if (!status) return <div className={base} />;
  if (status.kind === 'saving') return <div className={`${base} text-slate-500`}>Saving…</div>;
  if (status.kind === 'saved') {
    return (
      <div className={`${base} text-slate-500 flex items-center gap-1`}>
        <Check className="w-3.5 h-3.5 text-emerald-600" aria-hidden />Saved {clock(status.at, region)}
      </div>
    );
  }
  if (status.kind === 'offline') {
    return <div className={`${base} font-medium text-amber-deep`}>Not saved yet. Check your signal, we'll keep trying.</div>;
  }
  return <div className={`${base} font-medium text-amber-deep`}>Not saved. {status.message}</div>;
}

// Shown instead of the bank and representative cards while the server is
// older than this page. Better a short wait than bank details somewhere unsafe.
function Updating() {
  return (
    <section className="bg-white border border-amber/40 rounded-2xl p-4 sm:p-5 shadow-sm">
      <h2 className="text-[16px] font-bold text-slate-900">Bank and ID details</h2>
      <p className="text-[14px] text-slate-600 mt-1 leading-relaxed">This part is being updated. Please try again in a few minutes.</p>
    </section>
  );
}

function Frame({ children }) {
  return (
    <div className="min-h-screen bg-slate-100">
      <div className="max-w-2xl mx-auto px-4">{children}</div>
    </div>
  );
}

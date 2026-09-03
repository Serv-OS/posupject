/* One parser for the whole product: the inline add row and the command bar.
 *
 * The acceptance criterion is "creating a task from any list takes one line of
 * typing and one keystroke", so this turns
 *
 *   Chase Hardie invoice @duncan #Alfred Works !high fri
 *
 * into a task with an owner, a project, a priority and a due date, and a title
 * of "Chase Hardie invoice".
 *
 * The rule that matters most: IT NEVER FAILS. An unmatched token is left in the
 * title as ordinary words. Someone typing "email @ 3pm about #2 invoices" gets a
 * task called exactly that, not an error and not a silent mis-assignment. A
 * parser that refuses input is worse than no parser, because it turns one
 * keystroke back into a form.
 *
 * Matching is case-insensitive and prefix-based, and AMBIGUITY IS NOT RESOLVED
 * BY GUESSING: if "@a" matches two people the token stays as text and the field
 * is left empty, so nobody silently gets someone else's work.
 */

import { PRIORITIES, PRIORITY_LABEL } from './priority.js';

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Date words, resolved against `now` in LOCAL time — "today" must mean today
 *  where the person is sitting, not in UTC. Returns { date, length } where
 *  length is how many words were consumed, or null. */
export function parseDate(words, i, now = new Date()) {
  const w = (words[i] || '').toLowerCase().replace(/[.,]$/, '');
  const next = (words[i + 1] || '').toLowerCase().replace(/[.,]$/, '');
  const at = (n) => { const d = new Date(now); d.setDate(d.getDate() + n); return iso(d); };

  if (w === 'today') return { date: at(0), length: 1 };
  if (w === 'tomorrow' || w === 'tmr') return { date: at(1), length: 1 };

  // "next week" / "next friday"
  if (w === 'next') {
    if (next === 'week') return { date: at(7), length: 2 };
    const di = DAYS.findIndex(d => d.startsWith(next) && next.length >= 3);
    if (di !== -1) {
      const delta = ((di - now.getDay() + 7) % 7) || 7;
      return { date: at(delta + 7), length: 2 };
    }
  }

  // A weekday name means the NEXT one. "fri" typed on a Friday means next
  // Friday, not today — otherwise a task typed in the morning is already due.
  const di = DAYS.findIndex(d => d.startsWith(w) && w.length >= 3);
  if (di !== -1) {
    const delta = ((di - now.getDay() + 7) % 7) || 7;
    return { date: at(delta), length: 1 };
  }

  // "11 sep" / "11 september" / "sep 11"
  const dayNum = /^(\d{1,2})(st|nd|rd|th)?$/.exec(w);
  if (dayNum) {
    const mi = MONTHS.findIndex(m => next.startsWith(m));
    if (mi !== -1) return { date: dateFor(Number(dayNum[1]), mi, now), length: 2 };
  }
  const mi = MONTHS.findIndex(m => w.startsWith(m) && w.length >= 3);
  if (mi !== -1) {
    const n2 = /^(\d{1,2})(st|nd|rd|th)?$/.exec(next);
    if (n2) return { date: dateFor(Number(n2[1]), mi, now), length: 2 };
  }
  return null;
}

// A bare day and month with no year means the NEXT one: "11 sep" typed in
// December is next year, not ten months ago.
function dateFor(day, monthIndex, now) {
  let y = now.getFullYear();
  const candidate = new Date(y, monthIndex, day);
  if (iso(candidate) < iso(now)) y += 1;
  return iso(new Date(y, monthIndex, day));
}

const prefixMatches = (list, text, nameOf) => {
  const q = text.toLowerCase();
  if (!q) return [];
  const exact = list.filter(x => (nameOf(x) || '').toLowerCase() === q);
  if (exact.length) return exact;
  return list.filter(x => (nameOf(x) || '').toLowerCase().startsWith(q));
};

/**
 * @param input    the raw line
 * @param ctx      { members, projects, presets } — presets pre-fill from where
 *                 it was opened (a project page, a phase, a ticket)
 * @returns { title, owner_id, project_id, phase, priority, due_date, matched }
 */
export function parseQuickAdd(input, ctx = {}, now = new Date()) {
  const { members = [], projects = [], presets = {} } = ctx;
  const out = {
    title: '', owner_id: null, project_id: null, phase: null,
    priority: null, due_date: null, matched: [],
    ...presets,
  };
  const words = String(input || '').split(/\s+/).filter(Boolean);
  const kept = [];

  const nameOfMember = (m) => m.display_name || (m.email || '').split('@')[0];

  for (let i = 0; i < words.length; i++) {
    const w = words[i];

    if (w.startsWith('@') && w.length > 1) {
      const hits = prefixMatches(members, w.slice(1), nameOfMember);
      if (hits.length === 1) { out.owner_id = hits[0].id; out.matched.push({ type: 'owner', text: w, label: nameOfMember(hits[0]) }); continue; }
      kept.push(w); continue;   // none or several: leave it as words, assign nobody
    }

    if (w.startsWith('#') && w.length > 1) {
      // A project name can be several words, so try the longest run first.
      let best = null;
      for (let n = Math.min(5, words.length - i); n >= 1; n--) {
        const text = [w.slice(1), ...words.slice(i + 1, i + n)].join(' ');
        const hits = prefixMatches(projects, text, p => p.name);
        if (hits.length === 1) { best = { project: hits[0], length: n }; break; }
      }
      if (best) {
        out.project_id = best.project.id;
        out.matched.push({ type: 'project', text: `#${best.project.name}`, label: best.project.name });
        i += best.length - 1;
        // A phase only makes sense once a project matched, and only if that
        // project actually uses phases.
        const after = words[i + 1];
        const phases = best.project.phases || [];
        if (after && phases.length) {
          const ph = prefixMatches(phases.map(x => ({ name: x })), after, p => p.name);
          if (ph.length === 1) { out.phase = ph[0].name; out.matched.push({ type: 'phase', text: after, label: ph[0].name }); i += 1; }
        }
        continue;
      }
      kept.push(w); continue;
    }

    if (w.startsWith('!') && w.length > 1) {
      const q = w.slice(1).toLowerCase();
      // By NAME, never by P-number: the stored codes are off by one from the doc.
      const hit = PRIORITIES.find(p => PRIORITY_LABEL[p].toLowerCase().startsWith(q));
      if (hit) { out.priority = hit; out.matched.push({ type: 'priority', text: w, label: PRIORITY_LABEL[hit] }); continue; }
      kept.push(w); continue;
    }

    const d = parseDate(words, i, now);
    if (d) {
      out.due_date = d.date;
      out.matched.push({ type: 'due', text: words.slice(i, i + d.length).join(' '), label: d.date });
      i += d.length - 1;
      continue;
    }

    kept.push(w);
  }

  out.title = kept.join(' ').replace(/\s+/g, ' ').trim();
  return out;
}

/** The row actually written to Supabase. Kept separate so the parser stays pure
 *  and the insert shape is obvious at the call site. */
export function quickAddRow(parsed, profileId) {
  return {
    title: parsed.title,
    owner_id: parsed.owner_id || null,
    project_id: parsed.project_id || null,
    phase: parsed.phase || null,
    priority: parsed.priority || 'P2',
    due_date: parsed.due_date || null,
    status: 'todo',
    created_by: profileId || null,
  };
}

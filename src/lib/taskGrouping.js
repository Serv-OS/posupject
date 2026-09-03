/* Grouping a task list, as pure functions.
 *
 * Screen 02 asks for one grouping control with four options, and a group header
 * that always carries progress "so a project reads as a unit inside a flat
 * list". The choice of buckets is the whole design, so it lives here and is
 * tested, rather than being re-derived inside a render.
 *
 * Two rules that matter more than they look:
 *
 * Due-date buckets are computed from the DATE, never from status. A task that
 * is overdue and in progress is still overdue; grouping it under "in progress"
 * is how a late job stops looking late.
 *
 * Every grouping keeps an explicit "none" bucket, always last. Tasks with no
 * project, no assignee or no date are the ones most likely to be forgotten, so
 * they get a labelled home rather than vanishing from a grouped view.
 */

import { PRIORITIES, PRIORITY_LABEL } from './priority.js';

/** Local calendar day, not UTC: "due today" must mean today where the user is. */
export const dayKey = (d) => {
  const x = d instanceof Date ? d : new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};

export const DUE_BUCKETS = ['overdue', 'today', 'this_week', 'later', 'none'];
export const DUE_LABEL = {
  overdue: 'Overdue', today: 'Due today', this_week: 'Later this week',
  later: 'Later', none: 'No date',
};

/** Which due bucket a task falls in, relative to `now`. */
export function dueBucket(task, now = new Date()) {
  const due = task?.due_date;
  if (!due) return 'none';
  const today = dayKey(now);
  const key = String(due).slice(0, 10);
  if (key < today) return 'overdue';
  if (key === today) return 'today';
  // "This week" ends on Sunday. A Friday task seen on Friday is today, not
  // this week, so the buckets never double-count.
  const end = new Date(now);
  const daysToSunday = (7 - end.getDay()) % 7;
  end.setDate(end.getDate() + daysToSunday);
  return key <= dayKey(end) ? 'this_week' : 'later';
}

/** Done / total for a set of tasks — what a group header shows. */
export function progressOf(tasks = []) {
  const total = tasks.length;
  const done = tasks.filter(t => t.status === 'done').length;
  const blocked = tasks.filter(t => t.status === 'blocked').length;
  const inProgress = tasks.filter(t => t.status === 'in_progress').length;
  return { total, done, blocked, inProgress, pct: total ? Math.round((done / total) * 100) : 0 };
}

/**
 * Group tasks for display.
 * @param tasks   the already-filtered list
 * @param by      'project' | 'assignee' | 'due' | 'priority'
 * @param lookups { projects, members }
 * @returns [{ key, label, tasks, progress, sub? }] — order is the display order
 */
export function groupTasks(tasks = [], by = 'due', lookups = {}, now = new Date()) {
  const { projects = [], members = [] } = lookups;
  const nameOf = (id) => {
    const m = members.find(x => x.id === id);
    return m ? (m.display_name || (m.email || '').split('@')[0]) : null;
  };

  const buckets = new Map();
  const push = (key, label, t) => {
    if (!buckets.has(key)) buckets.set(key, { key, label, tasks: [] });
    buckets.get(key).tasks.push(t);
  };

  for (const t of tasks) {
    if (by === 'project') {
      const p = projects.find(x => x.id === t.project_id);
      push(p ? p.id : '__none', p ? p.name : 'No project', t);
    } else if (by === 'assignee') {
      push(t.owner_id || '__none', nameOf(t.owner_id) || 'Unassigned', t);
    } else if (by === 'priority') {
      push(t.priority || '__none', PRIORITY_LABEL[t.priority] || 'No priority', t);
    } else {
      const b = dueBucket(t, now);
      push(b, DUE_LABEL[b], t);
    }
  }

  const out = [...buckets.values()].map(g => ({ ...g, progress: progressOf(g.tasks) }));

  // Order is part of the design, not incidental. Due runs most-urgent first,
  // priority runs Critical to Low, and the rest are alphabetical — with the
  // "none" bucket pinned last in every mode.
  const rank = (g) => {
    if (g.key === '__none') return Number.MAX_SAFE_INTEGER;
    if (by === 'due') return DUE_BUCKETS.indexOf(g.key);
    if (by === 'priority') return PRIORITIES.indexOf(g.key);
    return 0;
  };
  out.sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    return (by === 'due' || by === 'priority') ? 0 : a.label.localeCompare(b.label);
  });

  // Phase sub-headers, but only inside a project group and only where the
  // project actually uses phases. Flat by default, per the spec's flag.
  if (by === 'project') {
    for (const g of out) {
      const proj = projects.find(p => p.id === g.key);
      const order = proj?.phases || [];
      if (!order.length && !g.tasks.some(t => t.phase)) continue;
      const seen = new Map();
      for (const t of g.tasks) {
        const k = t.phase || '__nophase';
        if (!seen.has(k)) seen.set(k, { key: k, label: t.phase || 'Unphased', tasks: [] });
        seen.get(k).tasks.push(t);
      }
      g.sub = [...seen.values()]
        .map(s => ({ ...s, progress: progressOf(s.tasks) }))
        .sort((a, b) => {
          if (a.key === '__nophase') return 1;
          if (b.key === '__nophase') return -1;
          const ia = order.indexOf(a.label), ib = order.indexOf(b.label);
          return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
        });
    }
  }

  return out;
}

/** The second line on a row — shown ONLY when there is something to say. */
export function rowSubtitle(task, lookups = {}) {
  const { projects = [], subtaskCount = 0 } = lookups;
  const bits = [];
  if (task?.status === 'blocked') {
    bits.push(task.blocked_reason ? `Blocked — ${task.blocked_reason}` : 'Blocked');
  }
  if (subtaskCount > 0) bits.push(`${subtaskCount} subtask${subtaskCount === 1 ? '' : 's'}`);
  const p = projects.find(x => x.id === task?.project_id);
  if (p) bits.push(p.name);
  return bits.length ? bits.join(' · ') : null;
}

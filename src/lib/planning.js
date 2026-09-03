/* Dates for the timeline and the calendar, as pure functions.
 *
 * Everything here works in LOCAL calendar days — a due date is a date, not an
 * instant, and "this week" has to mean the week where the person is sitting.
 * Nothing touches the DOM or the database, so it is tested directly.
 */

export const dayKey = (d) => {
  const x = d instanceof Date ? d : new Date(String(d).length === 10 ? d + 'T00:00:00' : d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};
export const fromKey = (k) => new Date(String(k).slice(0, 10) + 'T00:00:00');
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

/** Monday of the week containing d. */
export function startOfWeek(d) {
  const x = new Date(d); x.setHours(0, 0, 0, 0);
  const dow = (x.getDay() + 6) % 7;   // Mon=0 … Sun=6
  return addDays(x, -dow);
}

/** ISO 8601 week number — W36 is the same W36 the rest of the business uses. */
export function isoWeek(d) {
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dow = x.getUTCDay() || 7;
  x.setUTCDate(x.getUTCDate() + 4 - dow);
  const y0 = new Date(Date.UTC(x.getUTCFullYear(), 0, 1));
  return Math.ceil(((x - y0) / 86400000 + 1) / 7);
}

/** N consecutive week columns starting from the week containing `from`. */
export function weekColumns(from, n = 6) {
  const start = startOfWeek(from);
  const nowWeek = startOfWeek(new Date()).getTime();
  return Array.from({ length: n }, (_, i) => {
    const s = addDays(start, i * 7);
    return { start: s, end: addDays(s, 7), label: `W${isoWeek(s)}`, now: s.getTime() === nowWeek };
  });
}
/** N consecutive month columns from the month containing `from`. */
export function monthColumns(from, n = 6) {
  const nowM = `${new Date().getFullYear()}-${new Date().getMonth()}`;
  return Array.from({ length: n }, (_, i) => {
    const s = new Date(from.getFullYear(), from.getMonth() + i, 1);
    return { start: s, end: new Date(s.getFullYear(), s.getMonth() + 1, 1), label: s.toLocaleDateString('en-GB', { month: 'short' }), now: `${s.getFullYear()}-${s.getMonth()}` === nowM };
  });
}
export function rangeLabel(cols) {
  const a = cols[0].start, b = addDays(cols[cols.length - 1].end, -1);
  const ma = a.toLocaleDateString('en-GB', { month: 'short' }), mb = b.toLocaleDateString('en-GB', { month: 'short' });
  return a.getFullYear() === b.getFullYear() ? `${ma} – ${mb} ${b.getFullYear()}` : `${ma} ${a.getFullYear()} – ${mb} ${b.getFullYear()}`;
}

/** Where a span sits across a range, as left/width percentages, clipped. */
export function spanPercent(start, end, rangeStart, rangeEnd) {
  const total = rangeEnd - rangeStart;
  const s = Math.max(start, rangeStart), e = Math.min(end, rangeEnd);
  if (e <= s || total <= 0) return null;
  return { left: ((s - rangeStart) / total) * 100, width: ((e - s) / total) * 100 };
}

/**
 * A bar is DERIVED, never stored: it spans the earliest start_date (or created
 * date) to the latest due_date of the tasks in that phase, and takes the coral
 * treatment if any of them is overdue or blocked. A project with no phases
 * draws one bar for the whole project, so the timeline works before anyone
 * adopts phases. Nothing dated at all draws a one-week "Not started".
 */
export function phaseSpans(project, tasks, now = new Date()) {
  const today = dayKey(now);
  const phases = project?.phases || [];
  const groups = phases.length
    ? phases.map(name => ({ name, tasks: tasks.filter(t => t.phase === name) })).concat(
        tasks.some(t => !t.phase || !phases.includes(t.phase)) ? [{ name: 'Unphased', tasks: tasks.filter(t => !t.phase || !phases.includes(t.phase)) }] : [])
    : [{ name: project?.name || 'Project', tasks }];

  return groups.map(g => {
    const starts = g.tasks.map(t => t.start_date || (t.created_at ? dayKey(t.created_at) : null)).filter(Boolean).sort();
    const ends = g.tasks.map(t => t.due_date).filter(Boolean).sort();
    const open = g.tasks.filter(t => t.status !== 'done');
    const blocked = open.filter(t => t.status === 'blocked').length;
    const overdue = open.filter(t => t.due_date && t.due_date < today).length;
    const done = g.tasks.length > 0 && open.length === 0;
    const active = open.some(t => t.status === 'in_progress');
    let start = starts.length ? fromKey(starts[0]) : (project?.created_at ? fromKey(dayKey(project.created_at)) : startOfWeek(now));
    let end = ends.length ? addDays(fromKey(ends[ends.length - 1]), 1) : addDays(start, 7);
    if (end <= start) end = addDays(start, 7);
    const tone = blocked || overdue ? 'coral' : done ? 'done' : active ? 'primary' : starts.length ? 'amber' : 'none';
    const label = g.tasks.length === 0 ? `${g.name} · nothing yet` : tone === 'none' && !ends.length ? `${g.name} · not started` : blocked ? `${g.name} · ${blocked} blocked` : g.name;
    return { name: g.name, start, end, tone, label, blocked, overdue, count: g.tasks.length, done: g.tasks.length - open.length };
  });
}

/**
 * Month grid: rows of day cells, Monday first, weekdays only unless asked.
 * Cells outside the month are kept (dimmed by the caller) so rows stay whole.
 */
export function monthGrid(year, month, includeWeekend = false) {
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const gridStart = startOfWeek(first);
  const rows = [];
  let cur = gridStart;
  while (cur <= last || rows.length === 0) {
    const row = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(cur, i);
      if (includeWeekend || i < 5) row.push({ date: d, key: dayKey(d), inMonth: d.getMonth() === month });
    }
    rows.push(row);
    cur = addDays(cur, 7);
    if (cur > last) break;
  }
  return rows;
}

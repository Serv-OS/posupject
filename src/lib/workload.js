/* Workload across people — screen 07.
 *
 * The question is "who is drowning and who is free", and the honest answer is
 * not a task count. Ten tasks due next month is a lighter week than three
 * overdue, so the bar is composed of overdue / in progress / to do rather than
 * one number, and it is scaled AGAINST THE BUSIEST PERSON, not against a fixed
 * ceiling nobody agreed. A bar that is always half full teaches you nothing.
 *
 * Unassigned is always a row. Work nobody owns is the most likely to be missed,
 * so hiding it when the list happens to be empty would remove the one thing
 * this screen exists to surface.
 */

import { dueBucket } from './taskGrouping.js';

export const STALL_DAYS = 5;

/** Has nothing happened here for long enough to be worth a nudge? */
export function isStalled(item, now = new Date(), days = STALL_DAYS) {
  if (!item?.updated_at || item.status === 'done') return false;
  return (now - new Date(item.updated_at)) / 86400000 >= days;
}

/**
 * @param items    work_items rows (any type)
 * @param members  profiles
 * @returns rows sorted busiest first, with Unassigned always present
 */
export function workloadRows(items = [], members = [], now = new Date()) {
  const open = items.filter(i => i.status !== 'done');
  const byOwner = new Map();
  const bucket = (id) => {
    const k = id || '__none';
    if (!byOwner.has(k)) byOwner.set(k, []);
    return byOwner.get(k);
  };
  for (const i of open) bucket(i.owner_id).push(i);

  const nameOf = (id) => {
    const m = members.find(x => x.id === id);
    return m ? (m.display_name || (m.email || '').split('@')[0]) : 'Unknown';
  };

  const rows = [];
  for (const m of members) {
    const mine = byOwner.get(m.id) || [];
    rows.push(buildRow(m.id, nameOf(m.id), mine, now));
  }
  // Always present, even at zero.
  rows.push(buildRow(null, 'Unassigned', byOwner.get('__none') || [], now));

  const busiest = Math.max(1, ...rows.map(r => r.total));
  for (const r of rows) r.scale = r.total / busiest;

  // Busiest first, but a row with overdue work outranks a bigger row with none:
  // being late matters more than being loaded.
  rows.sort((a, b) => (b.overdue - a.overdue) || (b.total - a.total) || a.name.localeCompare(b.name));
  return rows;
}

function buildRow(id, name, items, now) {
  const overdue = items.filter(i => dueBucket({ due_date: i.due_at ? String(i.due_at).slice(0, 10) : null }, now) === 'overdue').length;
  const inProgress = items.filter(i => i.status === 'in_progress').length;
  const blocked = items.filter(i => i.status === 'blocked').length;
  const todo = items.length - inProgress - blocked;
  return {
    id, name, items,
    total: items.length,
    overdue, inProgress, blocked,
    todo: Math.max(0, todo),
    stalled: items.filter(i => isStalled(i, now)),
    scale: 0,
  };
}

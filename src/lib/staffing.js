// Shared helpers for the staffing module.

export const isoDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Monday of the week containing `d`
export function mondayOf(d) {
  const x = new Date(d); x.setHours(0, 0, 0, 0);
  const dow = (x.getDay() + 6) % 7; // 0 = Monday
  x.setDate(x.getDate() - dow);
  return x;
}

export function weekDays(monday) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday); d.setDate(d.getDate() + i); return d;
  });
}

export const DOW_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export const fmtDayNum = (d) => d.getDate();
export const fmtRange = (m) => {
  const end = new Date(m); end.setDate(end.getDate() + 6);
  const o = { day: 'numeric', month: 'short' };
  return `${m.toLocaleDateString('en-GB', o)} – ${end.toLocaleDateString('en-GB', o)}`;
};

// hours between 'HH:MM' strings (handles same-day only)
export function shiftHours(start, finish) {
  const [sh, sm] = (start || '0:0').split(':').map(Number);
  const [fh, fm] = (finish || '0:0').split(':').map(Number);
  let mins = (fh * 60 + fm) - (sh * 60 + sm);
  if (mins < 0) mins += 24 * 60;
  return mins / 60;
}

// Does an approved time-off row cover this iso date?
export function timeOffOnDate(rows, userId, iso) {
  return rows.find(r => r.user_id === userId && r.start_date <= iso && r.end_date >= iso) || null;
}

// Whole-day count between two iso dates inclusive
export function daysBetween(startIso, endIso) {
  const s = new Date(startIso + 'T00:00:00'), e = new Date(endIso + 'T00:00:00');
  return Math.max(1, Math.round((e - s) / 86400000) + 1);
}

// Leave balance for one user this year from their time_off rows (holiday only).
export function leaveBalance(timeOffRows, userId, entitlement) {
  const todayIso = isoDate(new Date());
  // The comment above always said "this year"; the code counted every year it
  // could see. Harmless while nothing in the past could be logged — but now
  // that holiday CAN be backfilled, last year's fortnight must not drain this
  // year's allowance. Scoped by the year the leave starts in.
  const thisYear = todayIso.slice(0, 4);
  let taken = 0, booked = 0;
  for (const r of timeOffRows) {
    if (r.user_id !== userId || r.type !== 'holiday' || r.status !== 'approved') continue;
    if (String(r.start_date).slice(0, 4) !== thisYear) continue;
    if (r.start_date <= todayIso) taken += Number(r.days || 0);
    else booked += Number(r.days || 0);
  }
  const entitled = Number(entitlement ?? 28);
  return { entitled, taken, booked, remaining: Math.max(0, entitled - taken - booked) };
}

// Is a person assignable to an area? (area allows their department, and they cover it)
export function isAssignable(profile, area) {
  if (!area) return true;
  const deptOk = !area.allowed_department_ids?.length || (profile.department_id && area.allowed_department_ids.includes(profile.department_id));
  const covers = !profile.coverable_area_ids?.length ? true : profile.coverable_area_ids.includes(area.id);
  // If a person has no coverable areas set, treat them as coverable-for-all (pragmatic default)
  return deptOk && covers;
}

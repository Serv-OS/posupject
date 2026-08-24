// Availability maths for the booking page.
//
// The whole problem in one sentence: the host works 9 to 5 in California, the
// booker is in the UK, and the two countries change their clocks on different
// dates. So a working day is stored as WALL CLOCK plus a zone ("09:00" in
// America/Los_Angeles) and only becomes an instant on a specific date. Doing it
// the other way round — storing an offset, or a fixed UTC time — is correct for
// about ten months a year and quietly wrong for the other two.
//
// No libraries: Intl carries the full IANA database, which is the same data a
// date library would be wrapping.

/** How far the zone is from UTC at a given instant, in ms (LA in summer: -7h). */
export function offsetMsAt(ts: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(ts))) p[part.type] = part.value;
  // What the clock in that zone reads, re-read as if it were UTC.
  const asIfUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asIfUtc - ts;
}

/**
 * The instant at which a zone's clock reads this wall time.
 * Iterates because the offset depends on the answer: on a DST changeover the
 * first guess lands in the wrong side of the transition, and one correction
 * settles it.
 */
export function wallTimeToUtc(
  y: number, m: number, d: number, hh: number, mm: number, timeZone: string,
): number {
  const target = Date.UTC(y, m - 1, d, hh, mm);
  let ts = target;
  for (let i = 0; i < 3; i++) {
    const next = target - offsetMsAt(ts, timeZone);
    if (next === ts) break;
    ts = next;
  }
  return ts;
}

/** The calendar date and weekday a zone is on at a given instant. */
export function dateInZone(ts: number, timeZone: string): { y: number; m: number; d: number; dow: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(ts))) p[part.type] = part.value;
  const dows: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { y: +p.year, m: +p.month, d: +p.day, dow: dows[p.weekday] ?? 0 };
}

export interface Busy { start: number; end: number }
export interface SlotConfig {
  timezone: string;
  hours: Record<string, [string, string][]>;   // "0".."6" -> [["09:00","17:00"]]
  durationMins: number;
  slotStepMins: number;
  bufferMins: number;
  minNoticeHrs: number;
  maxDaysAhead: number;
}

const HHMM = (s: string): [number, number] => {
  const [h, m] = String(s).split(":").map((x) => parseInt(x, 10));
  return [h || 0, m || 0];
};

/**
 * Free slot start instants (ms UTC) between from and to.
 * Busy periods are widened by the buffer on BOTH sides, so a meeting that ends
 * at 10:00 does not offer a 10:00 slot when the host wants breathing room.
 */
export function generateSlots(
  cfg: SlotConfig, busy: Busy[], fromTs: number, toTs: number, nowTs: number,
): number[] {
  const durMs = cfg.durationMins * 60000;
  const stepMs = Math.max(5, cfg.slotStepMins) * 60000;
  const bufMs = cfg.bufferMins * 60000;
  const earliest = nowTs + cfg.minNoticeHrs * 3600000;
  const horizon = nowTs + cfg.maxDaysAhead * 86400000;

  const blocked = busy
    .filter((b) => b.end > b.start)
    .map((b) => ({ start: b.start - bufMs, end: b.end + bufMs }));

  const out: number[] = [];
  // Walk day by day in the HOST's zone. Stepping 24h from a midday anchor keeps
  // the date correct across a DST change, where a day is 23 or 25 hours long.
  let cursor = fromTs;
  const seenDays = new Set<string>();
  while (cursor <= toTs) {
    const { y, m, d, dow } = dateInZone(cursor, cfg.timezone);
    const key = `${y}-${m}-${d}`;
    if (!seenDays.has(key)) {
      seenDays.add(key);
      for (const [openStr, closeStr] of (cfg.hours[String(dow)] || [])) {
        const [oh, om] = HHMM(openStr);
        const [ch, cm] = HHMM(closeStr);
        const open = wallTimeToUtc(y, m, d, oh, om, cfg.timezone);
        const close = wallTimeToUtc(y, m, d, ch, cm, cfg.timezone);
        for (let s = open; s + durMs <= close; s += stepMs) {
          if (s < fromTs || s > toTs) continue;
          if (s < earliest || s > horizon) continue;
          const e = s + durMs;
          if (blocked.some((b) => s < b.end && e > b.start)) continue;
          out.push(s);
        }
      }
    }
    cursor += 12 * 3600000;   // half-day steps: never skips a short DST day
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

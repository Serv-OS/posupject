import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { parseDay, fmtDay, today, toDayISO, daysFromToday, isPastDay } from './day.js';

/* These run in Los Angeles on purpose. That is where the bug showed up: a date
 * column holds '2026-09-30', and the old `new Date(value)` read it as UTC
 * midnight, which is 17:00 on the 29th in California. Every plain date in the
 * CRM came out a day early. Running the suite in a zone behind UTC is what
 * stops that coming back. */
const realTz = process.env.TZ;
beforeAll(() => { process.env.TZ = 'America/Los_Angeles'; });
afterAll(() => { process.env.TZ = realTz; });

describe('the bug this file exists for', () => {
  it('reproduces the old behaviour, so we know the zone is really applied', () => {
    expect(new Date('2026-09-30').getDate()).toBe(29);
    expect(new Date('2026-09-30').toLocaleDateString('en-GB')).toBe('29/09/2026');
  });

  it('keeps the day the database sent', () => {
    expect(fmtDay('2026-09-30', { day: '2-digit', month: '2-digit', year: 'numeric' })).toBe('30/09/2026');
    // Node writes 'Sept' where some browsers write 'Sep'. The day is the point.
    expect(fmtDay('2026-09-30')).toMatch(/^30 Sept? 26$/);
    expect(fmtDay('2026-01-01')).toBe('1 Jan 26');
    expect(fmtDay('2026-12-31')).toBe('31 Dec 26');
  });
});

describe('parseDay', () => {
  it('puts a plain date at local midnight', () => {
    const d = parseDay('2026-09-30');
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 8, 30, 0]);
  });

  it('leaves a real timestamp alone, because that IS an instant', () => {
    expect(parseDay('2026-09-30T02:00:00Z').getDate()).toBe(29); // 19:00 on the 29th in LA
  });

  it('passes a Date through and refuses rubbish', () => {
    const d = new Date(2026, 8, 30);
    expect(parseDay(d)).toBe(d);
    for (const v of [null, undefined, '', '   ', 'not a date', new Date('x')]) expect(parseDay(v)).toBeNull();
  });
});

describe('fmtDay', () => {
  it('shows nothing for nothing, and honours a chosen empty marker', () => {
    expect(fmtDay(null)).toBe('');
    expect(fmtDay('')).toBe('');
    expect(fmtDay(null, undefined, 'en-GB', '—')).toBe('—');
  });

  it('takes a locale, for the US side of the business', () => {
    expect(fmtDay('2026-09-30', { day: 'numeric', month: 'long', year: 'numeric' }, 'en-US')).toBe('September 30, 2026');
  });
});

describe('today, toDayISO and comparisons', () => {
  it('today is local midnight', () => {
    const t = today();
    const n = new Date();
    expect([t.getHours(), t.getMinutes(), t.getDate()]).toEqual([0, 0, n.getDate()]);
  });

  it('toDayISO gives the local day, not the UTC one', () => {
    // 23:30 in LA is already tomorrow in UTC. toISOString() would jump a day.
    const lateEvening = new Date(2026, 8, 30, 23, 30);
    expect(toDayISO(lateEvening)).toBe('2026-09-30');
    expect(lateEvening.toISOString().slice(0, 10)).toBe('2026-10-01');
    expect(toDayISO('2026-09-30')).toBe('2026-09-30');
    expect(toDayISO(null)).toBe('');
  });

  it('counts whole days from today', () => {
    const iso = (d) => toDayISO(new Date(today().getTime() + d * 86400000));
    expect(daysFromToday(iso(0))).toBe(0);
    expect(daysFromToday(iso(1))).toBe(1);
    expect(daysFromToday(iso(-3))).toBe(-3);
    expect(daysFromToday(null)).toBeNull();
  });

  it('is only overdue once the day has passed', () => {
    const iso = (d) => toDayISO(new Date(today().getTime() + d * 86400000));
    expect(isPastDay(iso(-1))).toBe(true);
    expect(isPastDay(iso(0))).toBe(false); // due today is not overdue
    expect(isPastDay(iso(1))).toBe(false);
    expect(isPastDay(null)).toBe(false);
  });
});

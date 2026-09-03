import { describe, it, expect } from 'vitest';
import { isoWeek, startOfWeek, weekColumns, monthGrid, phaseSpans, spanPercent, dayKey } from './planning.js';

const WED = new Date('2026-09-02T09:00:00');   // Wednesday, ISO week 36

describe('weeks', () => {
  it('starts the week on Monday', () => {
    expect(dayKey(startOfWeek(WED))).toBe('2026-08-31');
    expect(dayKey(startOfWeek(new Date('2026-09-06T12:00:00')))).toBe('2026-08-31');   // Sunday still belongs to that week
    expect(dayKey(startOfWeek(new Date('2026-09-07T00:00:00')))).toBe('2026-09-07');
  });
  it('numbers weeks the ISO way, so W36 matches the business calendar', () => {
    expect(isoWeek(WED)).toBe(36);
    expect(isoWeek(new Date('2026-01-01T00:00:00'))).toBe(1);
    expect(isoWeek(new Date('2027-01-01T00:00:00'))).toBe(53);   // 2026 has 53 ISO weeks
  });
  it('lays out six consecutive week columns with the current one flagged', () => {
    const cols = weekColumns(WED, 6);
    expect(cols).toHaveLength(6);
    expect(cols[0].label).toBe('W36');
    expect(cols[5].label).toBe('W41');
    expect(cols.filter(c => c.now).length).toBeLessThanOrEqual(1);
  });
});

describe('spanPercent', () => {
  const r0 = new Date('2026-08-31T00:00:00').getTime(), r1 = new Date('2026-10-12T00:00:00').getTime();
  it('maps a span to left/width inside the range', () => {
    const p = spanPercent(new Date('2026-08-31T00:00:00').getTime(), new Date('2026-09-14T00:00:00').getTime(), r0, r1);
    expect(p.left).toBe(0);
    expect(Math.round(p.width)).toBe(33);
  });
  it('clips to the range and drops spans wholly outside it', () => {
    expect(spanPercent(new Date('2026-06-01').getTime(), new Date('2026-06-10').getTime(), r0, r1)).toBeNull();
    const p = spanPercent(new Date('2026-08-01').getTime(), new Date('2026-09-07T00:00:00').getTime(), r0, r1);
    expect(p.left).toBe(0);
  });
});

describe('monthGrid', () => {
  it('gives weekday-only rows by default, Monday first', () => {
    const g = monthGrid(2026, 8);   // September 2026 starts on a Tuesday
    expect(g[0]).toHaveLength(5);
    expect(g[0][0].key).toBe('2026-08-31');
    expect(g[0][0].inMonth).toBe(false);
    expect(g[0][1].key).toBe('2026-09-01');
  });
  it('adds Saturday and Sunday when asked', () => {
    expect(monthGrid(2026, 8, true)[0]).toHaveLength(7);
  });
  it('covers every day of the month', () => {
    const keys = monthGrid(2026, 8, true).flat().map(c => c.key);
    expect(keys).toContain('2026-09-30');
    expect(keys).toContain('2026-09-01');
  });
});

describe('phaseSpans', () => {
  const project = { name: 'Adyen Onboarding', phases: ['Account setup', 'Go live'], created_at: '2026-08-28T10:00:00Z' };
  const t = (o) => ({ status: 'todo', created_at: '2026-08-31T09:00:00Z', ...o });

  it('derives a bar per phase from its tasks and colours a blocked one coral', () => {
    const spans = phaseSpans(project, [
      t({ phase: 'Account setup', status: 'done', due_date: '2026-09-05' }),
      t({ phase: 'Account setup', status: 'in_progress', due_date: '2026-09-02' }),
      t({ phase: 'Go live', status: 'blocked', due_date: '2026-09-12' }),
      t({ phase: 'Go live', due_date: '2026-09-12' }),
    ], WED);
    expect(spans.map(s => s.name)).toEqual(['Account setup', 'Go live']);
    expect(spans[0].tone).toBe('primary');
    expect(spans[1].tone).toBe('coral');
    expect(spans[1].label).toBe('Go live · 1 blocked');
    expect(dayKey(spans[0].start)).toBe('2026-08-31');
    expect(dayKey(spans[0].end)).toBe('2026-09-06');     // day after the latest due date
  });

  it('draws one bar for a project with no phases', () => {
    const spans = phaseSpans({ name: 'Leeds install', phases: [] }, [t({ due_date: '2026-09-17' })], WED);
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('Leeds install');
  });

  it('marks a phase with nothing dated as not started, one week wide', () => {
    const spans = phaseSpans({ name: 'Entrade House', phases: [], created_at: '2026-09-01T00:00:00Z' }, [], WED);
    expect(spans[0].tone).toBe('none');
    expect(spans[0].label).toMatch(/nothing yet/);
    expect((spans[0].end - spans[0].start) / 86400000).toBe(7);
  });

  it('is coral when anything is overdue, even if nothing is blocked', () => {
    const spans = phaseSpans({ name: 'X', phases: [] }, [t({ due_date: '2026-08-20' })], WED);
    expect(spans[0].tone).toBe('coral');
    expect(spans[0].overdue).toBe(1);
  });
});

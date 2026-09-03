import { describe, it, expect } from 'vitest';
import { workloadRows, isStalled } from './workload.js';

const NOW = new Date('2026-09-02T09:00:00');
const day = (n) => new Date(NOW.getTime() + n * 86400000).toISOString();
const w = (o) => ({ status: 'todo', updated_at: day(0), ...o });
const MEMBERS = [{ id: 'u1', display_name: 'Duncan' }, { id: 'u2', display_name: 'Mike' }];

describe('workloadRows', () => {
  it('always shows Unassigned, even with nothing in it', () => {
    const rows = workloadRows([], MEMBERS, NOW);
    expect(rows.map(r => r.name)).toContain('Unassigned');
    expect(rows.find(r => r.name === 'Unassigned').total).toBe(0);
  });

  it('ignores done work — it is not load', () => {
    const rows = workloadRows([w({ owner_id: 'u1', status: 'done' })], MEMBERS, NOW);
    expect(rows.find(r => r.id === 'u1').total).toBe(0);
  });

  it('splits the bar into overdue, in progress and to do', () => {
    const rows = workloadRows([
      w({ owner_id: 'u1', due_at: day(-3) }),
      w({ owner_id: 'u1', status: 'in_progress' }),
      w({ owner_id: 'u1' }),
      w({ owner_id: 'u1', status: 'blocked' }),
    ], MEMBERS, NOW);
    const d = rows.find(r => r.id === 'u1');
    expect(d).toMatchObject({ total: 4, overdue: 1, inProgress: 1, blocked: 1, todo: 2 });
  });

  // A bar against a fixed ceiling teaches nothing; against the busiest it does.
  it('scales against the busiest person', () => {
    const rows = workloadRows([
      w({ owner_id: 'u1' }), w({ owner_id: 'u1' }), w({ owner_id: 'u1' }), w({ owner_id: 'u1' }),
      w({ owner_id: 'u2' }), w({ owner_id: 'u2' }),
    ], MEMBERS, NOW);
    expect(rows.find(r => r.id === 'u1').scale).toBe(1);
    expect(rows.find(r => r.id === 'u2').scale).toBe(0.5);
  });

  it('never divides by zero when nobody has anything', () => {
    expect(workloadRows([], MEMBERS, NOW).every(r => r.scale === 0)).toBe(true);
  });

  // Being late beats being loaded.
  it('puts a person with overdue work above a busier person without', () => {
    const rows = workloadRows([
      w({ owner_id: 'u2', due_at: day(-1) }),
      w({ owner_id: 'u1' }), w({ owner_id: 'u1' }), w({ owner_id: 'u1' }),
    ], MEMBERS, NOW);
    expect(rows[0].id).toBe('u2');
  });
});

describe('isStalled', () => {
  it('flags work untouched for five days', () => {
    expect(isStalled(w({ updated_at: day(-6) }), NOW)).toBe(true);
    expect(isStalled(w({ updated_at: day(-2) }), NOW)).toBe(false);
  });
  it('never flags finished work', () => {
    expect(isStalled(w({ updated_at: day(-30), status: 'done' }), NOW)).toBe(false);
  });
  it('copes with a missing timestamp', () => {
    expect(isStalled({ status: 'todo' }, NOW)).toBe(false);
  });
});

describe('the bar adds up', () => {
  // A person whose work is entirely blocked must not draw an empty bar.
  it('overdue + blocked + in progress + to do covers every open item', () => {
    const rows = workloadRows([
      w({ owner_id: 'u1', status: 'blocked' }),
      w({ owner_id: 'u1', status: 'blocked' }),
    ], MEMBERS, NOW);
    const r = rows.find(x => x.id === 'u1');
    expect(r.total).toBe(2);
    expect(r.blocked).toBe(2);
    expect(r.overdue + r.blocked + r.inProgress + r.todo).toBe(r.total);
  });

  it('holds for a mixed load too', () => {
    const rows = workloadRows([
      w({ owner_id: 'u1', due_at: day(-2) }),
      w({ owner_id: 'u1', status: 'in_progress' }),
      w({ owner_id: 'u1', status: 'blocked' }),
      w({ owner_id: 'u1' }),
    ], MEMBERS, NOW);
    const r = rows.find(x => x.id === 'u1');
    expect(r.overdue + r.blocked + r.inProgress + r.todo).toBeGreaterThanOrEqual(r.total);
  });
});

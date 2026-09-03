import { describe, it, expect } from 'vitest';
import { dueBucket, groupTasks, progressOf, rowSubtitle, DUE_LABEL } from './taskGrouping.js';

// A Wednesday, so "this week" has room either side of it.
const NOW = new Date('2026-09-02T09:00:00');
const t = (o) => ({ id: Math.random().toString(36).slice(2), status: 'todo', priority: 'P2', ...o });

describe('dueBucket', () => {
  it('reads yesterday, today and later correctly', () => {
    expect(dueBucket(t({ due_date: '2026-09-01' }), NOW)).toBe('overdue');
    expect(dueBucket(t({ due_date: '2026-09-02' }), NOW)).toBe('today');
    expect(dueBucket(t({ due_date: '2026-09-04' }), NOW)).toBe('this_week');
    expect(dueBucket(t({ due_date: '2026-09-06' }), NOW)).toBe('this_week');  // Sunday
    expect(dueBucket(t({ due_date: '2026-09-07' }), NOW)).toBe('later');      // Monday
    expect(dueBucket(t({}), NOW)).toBe('none');
  });

  // The rule that stops a late job looking on-track.
  it('is decided by the date, never by status', () => {
    const late = t({ due_date: '2026-08-20', status: 'in_progress' });
    expect(dueBucket(late, NOW)).toBe('overdue');
    expect(dueBucket({ ...late, status: 'blocked' }, NOW)).toBe('overdue');
  });

  it('does not let today leak into this week', () => {
    // Seen on a Friday, a Friday task is today — counted once, not twice.
    const friday = new Date('2026-09-04T09:00:00');
    expect(dueBucket(t({ due_date: '2026-09-04' }), friday)).toBe('today');
  });
});

describe('groupTasks', () => {
  const projects = [{ id: 'p1', name: 'Alfred Works' }, { id: 'p2', name: 'Bali Cafe' }];
  const members = [{ id: 'u1', display_name: 'Duncan' }, { id: 'u2', display_name: 'Mike' }];

  it('groups by due with the urgent bucket first and No date last', () => {
    const g = groupTasks([
      t({ due_date: '2026-09-20' }), t({}), t({ due_date: '2026-08-01' }), t({ due_date: '2026-09-02' }),
    ], 'due', {}, NOW);
    expect(g.map(x => x.label)).toEqual([DUE_LABEL.overdue, DUE_LABEL.today, DUE_LABEL.later, DUE_LABEL.none]);
  });

  it('groups by project, alphabetically, with No project last', () => {
    const g = groupTasks([t({ project_id: 'p2' }), t({}), t({ project_id: 'p1' })], 'project', { projects }, NOW);
    expect(g.map(x => x.label)).toEqual(['Alfred Works', 'Bali Cafe', 'No project']);
  });

  it('groups by assignee and always keeps Unassigned', () => {
    const g = groupTasks([t({ owner_id: 'u2' }), t({}), t({ owner_id: 'u1' })], 'assignee', { members }, NOW);
    expect(g.map(x => x.label)).toEqual(['Duncan', 'Mike', 'Unassigned']);
  });

  // Priority shows names, never P-numbers.
  it('groups by priority in severity order, using the names', () => {
    const g = groupTasks([t({ priority: 'P3' }), t({ priority: 'P0' }), t({ priority: 'P2' })], 'priority', {}, NOW);
    expect(g.map(x => x.label)).toEqual(['Critical', 'Standard', 'Low']);
  });

  it('carries progress on every group header', () => {
    const g = groupTasks([
      t({ project_id: 'p1', status: 'done' }), t({ project_id: 'p1', status: 'done' }),
      t({ project_id: 'p1', status: 'blocked' }), t({ project_id: 'p1' }),
    ], 'project', { projects }, NOW);
    expect(g[0].progress).toMatchObject({ total: 4, done: 2, blocked: 1, pct: 50 });
  });

  it('loses no task, whatever the grouping', () => {
    const tasks = [t({ project_id: 'p1', owner_id: 'u1', due_date: '2026-09-02', priority: 'P0' }),
                   t({}), t({ owner_id: 'u2' }), t({ due_date: '2026-08-01' })];
    for (const by of ['project', 'assignee', 'due', 'priority']) {
      const total = groupTasks(tasks, by, { projects, members }, NOW).reduce((n, g) => n + g.tasks.length, 0);
      expect(total, `grouping by ${by} dropped a task`).toBe(tasks.length);
    }
  });

  it('is flat by default and only adds phases where a project uses them', () => {
    const flat = groupTasks([t({ project_id: 'p1' })], 'project', { projects }, NOW);
    expect(flat[0].sub).toBeUndefined();

    const phased = [{ id: 'p1', name: 'Alfred Works', phases: ['Survey', 'Install'] }];
    const g = groupTasks([
      t({ project_id: 'p1', phase: 'Install' }), t({ project_id: 'p1', phase: 'Survey' }), t({ project_id: 'p1' }),
    ], 'project', { projects: phased }, NOW);
    // Project's own order, with unphased work last rather than first.
    expect(g[0].sub.map(s => s.label)).toEqual(['Survey', 'Install', 'Unphased']);
  });
});

describe('progressOf', () => {
  it('handles an empty group without dividing by zero', () => {
    expect(progressOf([])).toMatchObject({ total: 0, done: 0, pct: 0 });
  });
});

describe('rowSubtitle', () => {
  const projects = [{ id: 'p1', name: 'Alfred Works' }];
  it('says nothing when there is nothing to say', () => {
    expect(rowSubtitle(t({}), {})).toBeNull();
  });
  it('leads with the blocker, because that is what stops the work', () => {
    const s = rowSubtitle(t({ status: 'blocked', blocked_reason: 'waiting on parts', project_id: 'p1' }), { projects });
    expect(s.startsWith('Blocked — waiting on parts')).toBe(true);
  });
  it('still says blocked when no reason was given', () => {
    expect(rowSubtitle(t({ status: 'blocked' }), {})).toBe('Blocked');
  });
  it('mentions subtasks and the project', () => {
    expect(rowSubtitle(t({ project_id: 'p1' }), { projects, subtaskCount: 3 })).toBe('3 subtasks · Alfred Works');
  });
});

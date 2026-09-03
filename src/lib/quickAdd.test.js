import { describe, it, expect } from 'vitest';
import { parseQuickAdd, parseDate, quickAddRow } from './quickAdd.js';

const NOW = new Date('2026-09-02T09:00:00');   // a Wednesday
const CTX = {
  members: [
    { id: 'u1', display_name: 'Duncan' },
    { id: 'u2', display_name: 'Mike' },
    { id: 'u3', display_name: 'Michelle' },
  ],
  projects: [
    { id: 'p1', name: 'Alfred Works', phases: ['Survey', 'Install'] },
    { id: 'p2', name: 'Bali Cafe' },
  ],
};

describe('the whole line', () => {
  it('pulls out owner, project, priority and date, leaving a clean title', () => {
    const r = parseQuickAdd('Chase Hardie invoice @duncan #Alfred Works !high fri', CTX, NOW);
    expect(r.title).toBe('Chase Hardie invoice');
    expect(r.owner_id).toBe('u1');
    expect(r.project_id).toBe('p1');
    expect(r.priority).toBe('P1');
    expect(r.due_date).toBe('2026-09-04');
  });

  it('takes a phase after a project that has them', () => {
    const r = parseQuickAdd('Measure up #Alfred Works Survey', CTX, NOW);
    expect(r.project_id).toBe('p1');
    expect(r.phase).toBe('Survey');
    expect(r.title).toBe('Measure up');
  });

  it('does not invent a phase for a project without any', () => {
    const r = parseQuickAdd('Call back #Bali Cafe Survey', CTX, NOW);
    expect(r.project_id).toBe('p2');
    expect(r.phase).toBeNull();
    expect(r.title).toBe('Call back Survey');
  });
});

describe('it never fails', () => {
  it('leaves unmatched tokens as plain words', () => {
    const r = parseQuickAdd('email @ 3pm about #2 invoices', CTX, NOW);
    expect(r.title).toBe('email @ 3pm about #2 invoices');
    expect(r.owner_id).toBeNull();
    expect(r.project_id).toBeNull();
  });

  // The one that protects people: a guess here assigns someone else's work.
  it('refuses to choose between two people who both match', () => {
    const r = parseQuickAdd('Ring back @mi', CTX, NOW);
    expect(r.owner_id).toBeNull();
    expect(r.title).toBe('Ring back @mi');
  });

  it('takes an exact name over a longer one that starts the same', () => {
    expect(parseQuickAdd('x @mike', CTX, NOW).owner_id).toBe('u2');
  });

  it('handles an empty line and stray symbols', () => {
    expect(parseQuickAdd('', CTX, NOW).title).toBe('');
    expect(parseQuickAdd('   ', CTX, NOW).title).toBe('');
    expect(parseQuickAdd('@ # !', CTX, NOW).title).toBe('@ # !');
  });
});

describe('dates', () => {
  it('reads today and tomorrow', () => {
    expect(parseQuickAdd('a today', CTX, NOW).due_date).toBe('2026-09-02');
    expect(parseQuickAdd('a tomorrow', CTX, NOW).due_date).toBe('2026-09-03');
  });

  // Typed on a Wednesday, "wed" means next Wednesday — a task is never born late.
  it('a weekday means the NEXT one, never today', () => {
    expect(parseQuickAdd('a wed', CTX, NOW).due_date).toBe('2026-09-09');
    expect(parseQuickAdd('a fri', CTX, NOW).due_date).toBe('2026-09-04');
  });

  it('reads next week and next friday', () => {
    expect(parseQuickAdd('a next week', CTX, NOW).due_date).toBe('2026-09-09');
    expect(parseQuickAdd('a next fri', CTX, NOW).due_date).toBe('2026-09-11');
  });

  it('reads a day and month either way round', () => {
    expect(parseQuickAdd('a 11 sep', CTX, NOW).due_date).toBe('2026-09-11');
    expect(parseQuickAdd('a sep 11', CTX, NOW).due_date).toBe('2026-09-11');
    expect(parseQuickAdd('a 11th september', CTX, NOW).due_date).toBe('2026-09-11');
  });

  // A bare date already gone means next year, not ten months ago.
  it('rolls a past day-and-month into next year', () => {
    expect(parseDate(['1', 'aug'], 0, NOW).date).toBe('2027-08-01');
  });

  it('strips the date words from the title', () => {
    expect(parseQuickAdd('Send the quote 11 sep', CTX, NOW).title).toBe('Send the quote');
  });
});

describe('priority', () => {
  it('is set by name, never by the stored code', () => {
    expect(parseQuickAdd('a !critical', CTX, NOW).priority).toBe('P0');
    expect(parseQuickAdd('a !low', CTX, NOW).priority).toBe('P3');
    expect(parseQuickAdd('a !standard', CTX, NOW).priority).toBe('P2');
  });
  it('ignores a P-number, which would be off by one from the doc', () => {
    const r = parseQuickAdd('a !P1', CTX, NOW);
    expect(r.priority).toBeNull();
    expect(r.title).toBe('a !P1');
  });
});

describe('context presets', () => {
  it('pre-fills from where it was opened, and typing still wins', () => {
    const presets = { project_id: 'p2', owner_id: 'u1' };
    const r = parseQuickAdd('Do a thing', { ...CTX, presets }, NOW);
    expect(r.project_id).toBe('p2');
    const r2 = parseQuickAdd('Do a thing #Alfred Works', { ...CTX, presets }, NOW);
    expect(r2.project_id).toBe('p1');
  });
});

describe('quickAddRow', () => {
  it('defaults priority to Standard and status to todo', () => {
    const row = quickAddRow(parseQuickAdd('Just a title', CTX, NOW), 'me');
    expect(row).toMatchObject({ title: 'Just a title', priority: 'P2', status: 'todo', created_by: 'me' });
    expect(row.due_date).toBeNull();
  });
});
